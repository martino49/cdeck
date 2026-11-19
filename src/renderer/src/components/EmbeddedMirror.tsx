import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { Badge, Button, Card } from './ui'
import { showToast } from '../lib/toast'
import { recordStep } from './AutomationPanel'

const win = window.cdeck

const ANDROID_KEYS: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  APP_SWITCH: 187,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66
}

function parseSps(pkt: Uint8Array): string | null {
  let idx = -1
  for (let i = 0; i < pkt.length - 6; i++) {
    if (pkt[i] === 0 && pkt[i + 1] === 0 && pkt[i + 2] === 0 && pkt[i + 3] === 1 && (pkt[i + 4] & 0x1f) === 7) {
      idx = i
      break
    }
  }
  if (idx < 0) return null
  const s = pkt.subarray(idx + 5)
  if (s.length < 4) return null
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `avc1.${hex(s[1])}${hex(s[2])}${hex(s[3])}`
}

function touchMessage(action: number, pointerId: bigint, x: number, y: number, w: number, h: number): ArrayBuffer {
  const b = new ArrayBuffer(32)
  const v = new DataView(b)
  v.setUint8(0, 0x02)
  v.setUint8(1, action)
  v.setBigUint64(2, pointerId)
  v.setUint32(10, x)
  v.setUint32(14, y)
  v.setUint16(18, w)
  v.setUint16(20, h)
  v.setUint16(22, 0xffff)
  v.setUint32(24, 0)
  v.setUint32(28, 0)
  return b
}

function keyMessage(action: 'down' | 'up', keycode: number): ArrayBuffer {
  const b = new ArrayBuffer(14)
  const v = new DataView(b)
  v.setUint8(0, 0x00)
  v.setUint8(1, action === 'down' ? 0 : 1)
  v.setUint32(2, keycode)
  return b
}

function textMessage(text: string): ArrayBuffer {
  const body = new TextEncoder().encode(text.slice(0, 300))
  const b = new ArrayBuffer(5 + body.length)
  const v = new DataView(b)
  v.setUint8(0, 0x01)
  v.setUint32(1, body.length)
  new Uint8Array(b, 5).set(body)
  return b
}

function screenPowerMessage(on: boolean): ArrayBuffer {
  const b = new ArrayBuffer(2)
  new DataView(b).setUint8(1, on ? 1 : 0)
  return b
}

function getClipboardMessage(): ArrayBuffer {
  const b = new ArrayBuffer(2)
  const v = new DataView(b)
  v.setUint8(0, 0x08)
  v.setUint8(1, 1)
  return b
}

const MOUSE_ID = -1n

export function EmbeddedMirror({
  serial,
  opts
}: {
  serial: string
  opts?: { maxSize?: number; maxFps?: number; videoBitRate?: number; turnScreenOff?: boolean; stayAwake?: boolean; forward?: boolean }
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const decoderRef = useRef<VideoDecoder | null>(null)
  const pendingConfig = useRef<Uint8Array[]>([])
  const deviceSize = useRef({ w: 0, h: 0 })
  const framesRef = useRef(0)
  const optsKey = JSON.stringify(opts ?? {})
  const [status, setStatus] = useState<'starting' | 'running' | 'error' | 'stopped'>('starting')
  const [error, setError] = useState('')
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [fps, setFps] = useState(0)
  const [clipboard, setClipboard] = useState('')
  const [text, setText] = useState('')
  const [forward, setForward] = useState(false)
  const draggingRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })
  const downRef = useRef<{ x: number; y: number; at: number } | null>(null)

  const send = useCallback((buf: ArrayBuffer) => {
    const p = portRef.current
    if (p && !pendingClosed(p)) p.postMessage({ control: buf }, [buf])
  }, [])

  const stop = useCallback(async () => {
    portRef.current?.close()
    portRef.current = null
    try {
      decoderRef.current?.close()
    } catch {
      /* not started */
    }
    decoderRef.current = null
    await win.mirror.stop()
    setStatus('stopped')
  }, [])

  useEffect(() => {
    let disposed = false
    const off = win.onMirrorPort((port: MessagePort) => {
      if (disposed) {
        port.close()
        return
      }
      portRef.current = port
      port.onmessage = (e: MessageEvent) => {
        const msg = e.data as
          | { type: 'codec'; id: string }
          | { type: 'size'; width: number; height: number }
          | { type: 'frame'; isConfig: boolean; isKey: boolean; pts: number; data: ArrayBuffer }
          | { type: 'clipboard'; text: string }
        if (msg.type === 'codec') return
        if (msg.type === 'size') {
          deviceSize.current = { w: msg.width, h: msg.height }
          setSize({ w: msg.width, h: msg.height })
          return
        }
        if (msg.type === 'clipboard') {
          setClipboard(msg.text)
          return
        }
        const pkt = new Uint8Array(msg.data)
        const decoder = decoderRef.current
        if (!decoder) return
        if (msg.isConfig) {
          pendingConfig.current.push(pkt)
          if (decoder.state === 'unconfigured') {
            const codec = parseSps(pkt)
            if (codec) decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' })
          }
          return
        }
        if (decoder.state !== 'configured') return
        framesRef.current += 1
        let payload = pkt
        if (pendingConfig.current.length > 0) {
          if (!msg.isKey) return
          const parts = [...pendingConfig.current, pkt]
          const total = parts.reduce((a, b) => a + b.length, 0)
          payload = new Uint8Array(total)
          let o = 0
          for (const part of parts) {
            payload.set(part, o)
            o += part.length
          }
          pendingConfig.current = []
        }
        try {
          decoder.decode(new EncodedVideoChunk({ type: msg.isKey ? 'key' : 'delta', timestamp: msg.pts, data: payload }))
        } catch {
          /* decode hiccup; the next keyframe resynchronizes */
        }
      }
      port.start()
    })

    void (async () => {
      const res = await win.mirror.start(serial, { ...(opts ?? {}), forward })
      if (disposed) return
      if (!res.ok) {
        setStatus('error')
        setError(res.error ?? 'failed to start')
        return
      }
      const c = canvasRef.current
      if (c && 'VideoDecoder' in window) {
        const decoder = new VideoDecoder({
          output: (frame: VideoFrame) => {
            const ctx = c.getContext('2d')
            if (ctx) {
              try {
                ctx.drawImage(frame, 0, 0, c.width, c.height)
              } finally {
                frame.close()
              }
            } else {
              frame.close()
            }
          },
          error: () => setStatus('error')
        })
        decoderRef.current = decoder
      }
      setStatus('running')
    })()

    const ticker = setInterval(() => {
      setFps(framesRef.current)
      framesRef.current = 0
    }, 1000)

    return () => {
      disposed = true
      clearInterval(ticker)
      off()
      void win.mirror.stop()
    }
  }, [serial, optsKey, forward])

  const toDevice = (clientX: number, clientY: number) => {
    const c = canvasRef.current
    if (!c) return { x: 0, y: 0 }
    const r = c.getBoundingClientRect()
    const { w, h } = deviceSize.current
    return {
      x: Math.min(Math.max(Math.round(((clientX - r.left) / r.width) * w), 0), w - 1),
      y: Math.min(Math.max(Math.round(((clientY - r.top) / r.height) * h), 0), h - 1)
    }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!portRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    const p = toDevice(e.clientX, e.clientY)
    lastPosRef.current = p
    downRef.current = { ...p, at: Date.now() }
    const { w, h } = deviceSize.current
    send(touchMessage(0, MOUSE_ID, p.x, p.y, w, h))
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current || !portRef.current) return
    const p = toDevice(e.clientX, e.clientY)
    lastPosRef.current = p
    const { w, h } = deviceSize.current
    send(touchMessage(2, MOUSE_ID, p.x, p.y, w, h))
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!portRef.current) return
    draggingRef.current = false
    const p = toDevice(e.clientX, e.clientY)
    const { w, h } = deviceSize.current
    send(touchMessage(1, MOUSE_ID, p.x, p.y, w, h))
    const down = downRef.current
    if (down) {
      const dist = Math.hypot(p.x - down.x, p.y - down.y)
      if (dist < 24) recordStep({ type: 'tap', x: p.x, y: p.y })
      else recordStep({ type: 'swipe', x1: down.x, y1: down.y, x2: p.x, y2: p.y, durationMs: Math.max(Date.now() - down.at, 60) })
      downRef.current = null
    }
  }

  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!portRef.current) return
    const p = toDevice(e.clientX, e.clientY)
    const { w, h } = deviceSize.current
    const b = new ArrayBuffer(21)
    const v = new DataView(b)
    v.setUint8(0, 0x03)
    v.setUint32(1, p.x)
    v.setUint32(5, p.y)
    v.setUint16(9, w)
    v.setUint16(11, h)
    v.setInt16(13, 0)
    v.setInt16(15, e.deltaY > 0 ? 0x8000 : 0x7fff)
    v.setUint32(17, 0)
    send(b)
  }

  const tapKey = (name: string) => {
    const code = ANDROID_KEYS[name]
    if (code == null) return
    send(keyMessage('down', code))
    send(keyMessage('up', code))
  }

  const sendText = () => {
    if (!text.trim()) return
    send(textMessage(text))
    setText('')
  }

  const copyClipboard = async () => {
    send(getClipboardMessage())
    await new Promise((r) => setTimeout(r, 600))
    if (clipboard) {
      await navigator.clipboard.writeText(clipboard)
      showToast('success', 'Device clipboard copied', clipboard.slice(0, 60))
    }
  }

  return (
    <Card
      title="Embedded mirror"
      right={
        <div className="flex items-center gap-2">
          <Badge tone={status === 'running' ? 'ok' : status === 'error' ? 'err' : 'neutral'} pulse={status === 'starting'}>
            {status}
          </Badge>
          {size.w > 0 && (
            <span className="font-mono text-[11px] text-dim">
              {size.w}×{size.h}
            </span>
          )}
          {status === 'running' && <span className="font-mono text-[11px] text-dim">{fps} fps</span>}
        </div>
      }
    >
      {status === 'error' && <div className="mb-2 text-[12px] text-err">{error}</div>}
      <div className="overflow-hidden rounded-md border border-line bg-black">
        <canvas
          ref={canvasRef}
          width={size.w || 720}
          height={size.h || 1480}
          className="block h-[58vh] w-full touch-none select-none"
          style={{ objectFit: 'contain' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
        <label className="flex items-center gap-1 text-[11px] text-dim" title="Reverse: the phone dials out to this PC (default). Forward: this PC dials in — use it when the phone's adbd can't bind local sockets, e.g. some MIUI devices.">
          <input type="checkbox" checked={forward} onChange={(e) => setForward(e.target.checked)} disabled={status === 'running'} />
          forward tunnel
        </label>
        {Object.keys(ANDROID_KEYS).map((k) => (
          <Button key={k} size="sm" variant="ghost" onClick={() => tapKey(k)} disabled={!portRef.current}>
            {k.replace('_', ' ').toLowerCase()}
          </Button>
        ))}
        <input
          className="w-[180px] rounded-md border border-line bg-panel2 px-2 py-1"
          placeholder="type text…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendText()
          }}
        />
        <Button size="sm" onClick={sendText} disabled={!text.trim()}>
          Send
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyClipboard()} disabled={!portRef.current}>
          Copy device clipboard
        </Button>
        <Button size="sm" variant="ghost" onClick={() => send(screenPowerMessage(false))} disabled={!portRef.current}>
          Screen off
        </Button>
        <Button size="sm" variant="ghost" onClick={() => send(screenPowerMessage(true))} disabled={!portRef.current}>
          Screen on
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="danger" onClick={() => void stop()}>
          Stop
        </Button>
      </div>
      {clipboard && (
        <div className="mt-1.5 truncate text-[11px] text-dim" title={clipboard}>
          clipboard: {clipboard.slice(0, 80)}
        </div>
      )}
    </Card>
  )
}

function pendingClosed(port: MessagePort): boolean {
  try {
    port.postMessage({ type: 'ping' })
    return false
  } catch {
    return true
  }
}