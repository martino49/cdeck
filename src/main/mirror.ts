import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app, MessageChannelMain } from 'electron'
import type { MessagePortMain, WebContents } from 'electron'
import { resolveAdbPath } from './adb'
import { run } from './process'
import { loadStore, saveStore } from './store'
import log from './log'

const REMOTE_JAR = '/data/local/tmp/cdeck-scrcpy-server'

let framesSeen = 0
let sizeLogged = false

export interface MirrorStartOptions {
  maxSize?: number
  maxFps?: number
  videoBitRate?: number
  turnScreenOff?: boolean
  stayAwake?: boolean
  forward?: boolean
}

interface EmbeddedMirror {
  serial: string
  scid: number
  forward: boolean
  child: ChildProcess | null
  server: net.Server | null
  listenPort: number
  videoSocket: net.Socket | null
  controlSocket: net.Socket | null
  port: MessagePortMain | null
  stopping: boolean
  startedAt: number
  width: number
  height: number
}

let current: EmbeddedMirror | null = null
const videoReaders = new WeakMap<EmbeddedMirror, Reader>()
const controlReaders = new WeakMap<EmbeddedMirror, Reader>()

function findScrcpyServer(): { path: string; version: string } | null {
  const candidates: string[] = []
  const root = path.join(app.getPath('userData'), 'bin', 'scrcpy')
  if (existsSync(root)) {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (dir.isDirectory()) candidates.push(path.join(root, dir.name, 'scrcpy-server'))
    }
  }
  try {
    const { settings } = loadStore()
    if (settings.customScrcpyPath) {
      candidates.push(path.join(path.dirname(settings.customScrcpyPath), 'scrcpy-server'))
    }
  } catch {
    /* store not ready */
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      const m = c.match(/scrcpy-win(?:64)?-v?([\d.]+)/i) ?? c.match(/scrcpy[\\/]([\d.]+)[\\/]/)
      return { path: c, version: m ? m[1] : '' }
    }
  }
  return null
}

class Reader {
  private buf: Buffer = Buffer.alloc(0)
  constructor(private sock: net.Socket) {
    sock.on('data', (d: Buffer) => {
      this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d])
    })
  }
  pushFront(bytes: Buffer): void {
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([bytes, this.buf])
  }
  async readExactly(n: number, timeoutMs = 15000): Promise<Buffer | null> {
    const deadline = Date.now() + timeoutMs
    while (this.buf.length < n) {
      if (current === null || current.stopping) return null
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 5))
    }
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }
}

function post(session: EmbeddedMirror, msg: unknown): void {
  try {
    session.port?.postMessage(msg)
  } catch {
    /* port closed */
  }
}

export function isMirroring(): boolean {
  return current !== null && current.videoSocket !== null
}

export function mirrorStats(): { serial: string; width: number; height: number; startedAt: number } | null {
  if (!current || !current.videoSocket) return null
  return { serial: current.serial, width: current.width, height: current.height, startedAt: current.startedAt }
}

async function pumpVideo(session: EmbeddedMirror, reader: Reader): Promise<void> {
  const sock = session.videoSocket
  if (!sock) return
  const codecId = await reader.readExactly(4)
  if (!codecId) {
    log.warn('embedded mirror: no codec id received')
    return
  }
  const id = codecId.toString('latin1')
  post(session, { type: 'codec', id })
  log.info('embedded mirror: codec', { id })
  if (id !== 'h264') {
    log.warn('embedded mirror: unexpected codec', { id })
    return
  }
  const sizeMeta = await reader.readExactly(8)
  if (sizeMeta) {
    const w = sizeMeta.readUInt32BE(0)
    const h = sizeMeta.readUInt32BE(4)
    if (w > 0 && h > 0) {
      session.width = w
      session.height = h
      post(session, { type: 'size', width: w, height: h })
      if (!sizeLogged) {
        sizeLogged = true
        log.info('embedded mirror: stream size', { width: w, height: h })
      }
    }
  }
  const PTS_CONFIG = 1n << 63n
  const PTS_KEY = 1n << 62n
  for (;;) {
    if (!current || current.stopping || sock.destroyed) return
    const header = await reader.readExactly(12)
    if (!header) return
    const ptsRaw = header.readBigUInt64BE(0)
    const isConfig = (ptsRaw & PTS_CONFIG) !== 0n
    const isKey = (ptsRaw & PTS_KEY) !== 0n
    const pts = Number(ptsRaw & 0x3fffffffffffffffn)
    const size = header.readUInt32BE(8)
    const payload = await reader.readExactly(size)
    if (!payload) return
    const copy = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer
    post(session, { type: 'frame', isConfig, isKey, pts, data: copy })
    framesSeen += 1
    if (framesSeen === 1) log.info('embedded mirror: first frame', { isConfig, isKey, bytes: copy.byteLength })
    if (framesSeen % 300 === 0) log.info('embedded mirror: streaming', { frames: framesSeen })
  }
}

function pumpControl(session: EmbeddedMirror): void {
  const reader = controlReaders.get(session)
  if (!reader) return
  const tick = async () => {
    while (current === session && !session.stopping) {
      const head = await reader.readExactly(5, 3600000)
      if (!head) return
      const type = head[0]
      if (type !== 0x00) continue
      const len = head.readUInt32BE(1)
      const body = await reader.readExactly(len, 10000)
      if (!body) return
      post(session, { type: 'clipboard', text: body.toString('utf8') })
    }
  }
  void tick()
}

export async function startEmbeddedMirror(
  sender: WebContents,
  serial: string,
  options: MirrorStartOptions = {}
): Promise<{ ok: boolean; error?: string }> {
  await stopEmbeddedMirror()

  const { path: adb } = resolveAdbPath()
  if (!adb) return { ok: false, error: 'adb not found' }
  const server = findScrcpyServer()
  if (!server) return { ok: false, error: 'scrcpy-server not found — install scrcpy from the Tools page first' }
  const version = server.version || '5.0.1'

  const store = loadStore()
  const deviceKey = store.lastWireless?.deviceSerial ?? serial
  const preferred = options.forward ? 'forward' : store.tunnelModes[deviceKey] ?? 'auto'

  let lastError = 'unknown failure'
  const modes: Array<'reverse' | 'forward'> = preferred === 'forward' ? ['forward'] : preferred === 'reverse' ? ['reverse'] : ['reverse', 'forward']
  for (const mode of modes) {
    if (mode === 'reverse') {
      const probe = await probeAbstractListener(serial)
      if (probe === false) {
        log.info('embedded mirror: adbd does not bind reverse abstract sockets; skipping to forward tunnel', { serial })
        continue
      }
    }
    const res = await attemptSession(sender, serial, server, version, options, mode === 'forward')
    if (res.ok) {
      if (mode === 'forward' && preferred !== 'forward') {
        const s = loadStore()
        s.tunnelModes[deviceKey] = 'forward'
        saveStore(s)
        log.info('embedded mirror: remembered forward tunnel for this device', { deviceKey })
      }
      return { ok: true }
    }
    lastError = res.error ?? 'failed'
  }
  return { ok: false, error: lastError }
}

async function probeAbstractListener(serial: string): Promise<boolean> {
  const probeName = `cdeckprobe_${Math.floor(Math.random() * 0x7fffffff).toString(16)}`
  const rule = await run(adbPath(), ['-s', serial, 'reverse', `localabstract:${probeName}`, 'tcp:27199']).catch(() => null)
  if (!rule?.ok) {
    await run(adbPath(), ['-s', serial, 'reverse', '--remove', `localabstract:${probeName}`]).catch(() => undefined)
    return true
  }
  const unix = await run(adbPath(), ['-s', serial, 'shell', 'cat /proc/net/unix'], 10000).catch(() => null)
  await run(adbPath(), ['-s', serial, 'reverse', '--remove', `localabstract:${probeName}`]).catch(() => undefined)
  if (!unix?.ok) return true
  return unix.stdout.split(/\r?\n/).some((l) => l.includes(`@${probeName}`) || l.includes(probeName))
}

function adbPath(): string {
  return resolveAdbPath().path ?? 'adb'
}

async function attemptSession(
  sender: WebContents,
  serial: string,
  server: { path: string; version: string },
  version: string,
  options: MirrorStartOptions,
  forward: boolean
): Promise<{ ok: boolean; error?: string; retryForward?: boolean }> {
  await stopEmbeddedMirror()

  const { path: adb } = resolveAdbPath()
  if (!adb) return { ok: false, error: 'adb not found' }

  const session: EmbeddedMirror = {
    serial,
    scid: Math.floor(Math.random() * 0x7fffffff) || 1,
    forward,
    child: null,
    server: null,
    listenPort: 0,
    videoSocket: null,
    controlSocket: null,
    port: null,
    stopping: false,
    startedAt: Date.now(),
    width: 0,
    height: 0
  }
  current = session
  framesSeen = 0
  sizeLogged = false
  const socketName = `scrcpy_${session.scid.toString(16).padStart(8, '0')}`

  try {
    const push = await run(adb, ['-s', serial, 'push', server.path, REMOTE_JAR], 60000)
    if (!push.ok) return { ok: false, error: `push failed: ${push.stderr.trim()}` }

    if (session.forward) {
      const fwd = await run(adb, ['-s', serial, 'forward', 'tcp:27183', `localabstract:${socketName}`], 15000)
      if (!fwd.ok) return { ok: false, error: `forward tunnel failed: ${fwd.stderr.trim()}` }
      session.listenPort = 27183
      log.info('embedded mirror: forward tunnel ready', { socketName })
    } else {
      session.server = net.createServer()
      await new Promise<void>((resolveP, rejectP) => {
        session.server!.once('error', rejectP)
        session.server!.listen(0, '127.0.0.1', () => resolveP())
      })
      const port = (session.server.address() as net.AddressInfo).port
      session.listenPort = port

      const rev = await run(adb, ['-s', serial, 'reverse', `localabstract:${socketName}`, `tcp:${port}`], 15000)
      if (!rev.ok) return { ok: false, error: `reverse tunnel failed: ${rev.stderr.trim()}` }
    }

    const serverArgs = [
      'CLASSPATH=' + REMOTE_JAR,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      version,
      `scid=${session.scid.toString(16)}`,
      'video=true',
      'audio=false',
      'control=true',
      'send_device_meta=false',
      'video_codec=h264',
      'log_level=warn'
    ]
    if (options.maxSize && options.maxSize > 0) serverArgs.push(`max_size=${options.maxSize}`)
    if (options.maxFps && options.maxFps > 0) serverArgs.push(`max_fps=${options.maxFps}`)
    if (options.videoBitRate && options.videoBitRate > 0) serverArgs.push(`video_bit_rate=${options.videoBitRate}`)
    if (session.forward) serverArgs.push('tunnel_forward=true')
    session.child = spawn(adb, ['-s', serial, 'shell', serverArgs.join(' ')], { windowsHide: true })
    let stderrBuf = ''
    session.child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString()
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000)
    })
    session.child.on('error', (err) => {
      log.warn('embedded mirror: server process error', { error: String(err), stderr: stderrBuf.slice(-800) })
    })
    session.child.on('exit', (code) => {
      if (current === session && !session.stopping) {
        log.warn('embedded mirror: server exited', {
          code,
          forward: session.forward,
          hint: session.forward ? undefined : "if the device's adbd cannot bind localabstract sockets, retry with forward tunnel mode",
          stderr: stderrBuf.slice(-800)
        })
      }
      if (!serverExited) serverExited = { code, stderr: stderrBuf }
    })

    let serverExited: { code: number | null; stderr: string } | null = null

    const accepted: net.Socket[] = []
    const watchServerAlive = async (): Promise<net.Socket> => {
      while (!serverExited) await new Promise((r) => setTimeout(r, 100))
      throw new Error(`scrcpy server exited before connecting: ${serverExited.stderr.slice(-500)}`)
    }
    const acceptOne = (): Promise<net.Socket> => {
      if (session.forward) {
        return new Promise<net.Socket>((resolveP, rejectP) => {
          const timer = setTimeout(() => rejectP(new Error('timed out waiting for the scrcpy server sockets (forward tunnel)')), 25000)
          const sock = net.connect({ host: '127.0.0.1', port: session.listenPort }, () => {
            clearTimeout(timer)
            accepted.push(sock)
            resolveP(sock)
          })
          sock.once('error', (err) => {
            clearTimeout(timer)
            rejectP(err)
          })
        })
      }
      return new Promise<net.Socket>((resolveP, rejectP) => {
        const timer = setTimeout(() => rejectP(new Error('timed out waiting for the scrcpy server sockets')), 20000)
        session.server!.once('connection', (s) => {
          clearTimeout(timer)
          accepted.push(s)
          resolveP(s)
        })
      })
    }

    const sockA = await Promise.race([acceptOne(), watchServerAlive()])
    const sockB = await Promise.race([acceptOne(), watchServerAlive()])
    const readerA = new Reader(sockA)
    const readerB = new Reader(sockB)
    if (session.forward) {
      const dummy = await readerA.readExactly(1, 3000)
      if (dummy) log.info('embedded mirror: discarded forward-tunnel dummy byte')
    }
    const peekA = await readerA.readExactly(4, 3000)
    const peekB = await readerB.readExactly(4, 3000)
    let videoReader: Reader
    let controlReader: Reader
    let videoSock: net.Socket
    let controlSock: net.Socket
    const codecOf = (b: Buffer | null) => (b && b.length === 4 ? b.toString('latin1') : null)
    if (codecOf(peekA) === 'h264') {
      videoReader = readerA
      controlReader = readerB
      videoSock = sockA
      controlSock = sockB
      if (peekA) readerA.pushFront(peekA)
    } else if (codecOf(peekB) === 'h264') {
      videoReader = readerB
      controlReader = readerA
      videoSock = sockB
      controlSock = sockA
      if (peekB) readerB.pushFront(peekB)
    } else {
      log.warn('embedded mirror: could not identify sockets by codec id; assuming first is video', {
        a: codecOf(peekA),
        b: codecOf(peekB)
      })
      videoReader = readerA
      controlReader = readerB
      videoSock = sockA
      controlSock = sockB
      if (peekA) readerA.pushFront(peekA)
    }
    session.videoSocket = videoSock
    session.controlSocket = controlSock
    videoReaders.set(session, videoReader)
    controlReaders.set(session, controlReader)
    pumpControl(session)
    log.info('embedded mirror connected', { serial, port: session.listenPort, forward: session.forward, socketName, videoFirst: videoSock === sockA })

    const channel = new MessageChannelMain()
    session.port = channel.port1
    channel.port1.on('message', (e: unknown) => {
      const msg = e as { control?: ArrayBuffer }
      if (msg?.control && session.controlSocket && !session.controlSocket.destroyed) {
        session.controlSocket.write(Buffer.from(msg.control))
      }
    })
    channel.port1.on('close', () => {
      void stopEmbeddedMirror()
    })
    if (!sender.isDestroyed()) sender.postMessage('mirror:port', null, [channel.port2])

    if (options.turnScreenOff) session.controlSocket.write(encodeScreenPower(false))
    if (options.stayAwake) await run(adb, ['-s', serial, 'shell', 'settings put global stay_on_while_plugged_in 3']).catch(() => undefined)

    void pumpVideo(session, videoReader)

    const cleanup = () => {
      void stopEmbeddedMirror()
    }
    session.videoSocket.on('close', () => {
      log.warn('embedded mirror: video socket closed')
      cleanup()
    })
    session.controlSocket.on('close', () => {
      log.warn('embedded mirror: control socket closed')
      cleanup()
    })
    session.videoSocket.on('close', cleanup)
    session.controlSocket.on('close', cleanup)

    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.warn('embedded mirror failed', { error: detail })
    await stopEmbeddedMirror()
    return { ok: false, error: detail }
  }
}

export async function stopEmbeddedMirror(): Promise<void> {
  const session = current
  if (!session) return
  current = null
  session.stopping = true
  try {
    session.port?.close()
  } catch {
    /* already closed */
  }
  session.videoSocket?.destroy()
  session.controlSocket?.destroy()
  session.child?.kill()
  session.server?.close()
  if (session.serial) {
    const { path: adb } = resolveAdbPath()
    if (adb) {
      const abstract = `localabstract:scrcpy_${session.scid.toString(16).padStart(8, '0')}`
      if (session.forward) {
        await run(adb, ['-s', session.serial, 'forward', '--remove', 'tcp:27183']).catch(() => undefined)
      } else {
        await run(adb, ['-s', session.serial, 'reverse', '--remove', abstract]).catch(() => undefined)
      }
      await run(adb, ['-s', session.serial, 'shell', 'rm', '-f', REMOTE_JAR]).catch(() => undefined)
    }
  }
  log.info('embedded mirror stopped', { serial: session.serial })
}

const SC_POINTER_ID_MOUSE = 'ffffffffffffffff'

function touchEvent(action: number, pointerId: bigint, x: number, y: number, w: number, h: number): Buffer {
  const b = Buffer.alloc(32)
  b.writeUInt8(0x02, 0)
  b.writeUInt8(action, 1)
  b.writeBigUInt64BE(pointerId, 2)
  b.writeUInt32BE(x, 10)
  b.writeUInt32BE(y, 14)
  b.writeUInt16BE(w, 18)
  b.writeUInt16BE(h, 20)
  b.writeUInt16BE(0xffff, 22)
  b.writeUInt32BE(0, 24)
  b.writeUInt32BE(0, 28)
  return b
}

export function encodeTap(x: number, y: number, w: number, h: number): Buffer[] {
  const id = BigInt('0x' + SC_POINTER_ID_MOUSE)
  return [touchEvent(0, id, x, y, w, h), touchEvent(1, id, x, y, w, h)]
}

export function encodeSwipe(x1: number, y1: number, x2: number, y2: number, w: number, h: number, steps = 12): Buffer[] {
  const id = BigInt('0x' + SC_POINTER_ID_MOUSE)
  const out = [touchEvent(0, id, x1, y1, w, h)]
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    out.push(touchEvent(2, id, Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), w, h))
  }
  out.push(touchEvent(1, id, x2, y2, w, h))
  return out
}

export function encodeKeycode(action: 'down' | 'up', keycode: number): Buffer {
  const b = Buffer.alloc(14)
  b.writeUInt8(0x00, 0)
  b.writeUInt8(action === 'down' ? 0 : 1, 1)
  b.writeUInt32BE(keycode, 2)
  b.writeUInt32BE(0, 6)
  b.writeUInt32BE(0, 10)
  return b
}

export function encodeTapKey(keycode: number): Buffer[] {
  return [encodeKeycode('down', keycode), encodeKeycode('up', keycode)]
}

export function encodeText(text: string): Buffer {
  const body = Buffer.from(text.slice(0, 300), 'utf8')
  const b = Buffer.alloc(5 + body.length)
  b.writeUInt8(0x01, 0)
  b.writeUInt32BE(body.length, 1)
  body.copy(b, 5)
  return b
}

export function encodeScreenPower(on: boolean): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt8(0x0a, 0)
  b.writeUInt8(on ? 1 : 0, 1)
  return b
}

export function encodeGetClipboard(): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt8(0x08, 0)
  b.writeUInt8(1, 1)
  return b
}

export function encodeSetClipboard(sequence: bigint, text: string, paste: boolean): Buffer {
  const body = Buffer.from(text, 'utf8')
  const b = Buffer.alloc(14 + body.length)
  b.writeUInt8(0x09, 0)
  b.writeBigUInt64BE(sequence, 1)
  b.writeUInt8(paste ? 1 : 0, 9)
  b.writeUInt32BE(body.length, 10)
  body.copy(b, 14)
  return b
}

const ANDROID_KEYS: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  MENU: 82,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66,
  DEL: 67,
  APP_SWITCH: 187
}

export function keycodeFor(name: string): number | null {
  return ANDROID_KEYS[name] ?? null
}

export async function stopAll(): Promise<void> {
  await stopEmbeddedMirror()
}