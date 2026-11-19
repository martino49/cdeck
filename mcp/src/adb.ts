import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function findAdb(): string {
  if (process.env.CDECK_ADB && existsSync(process.env.CDECK_ADB)) return process.env.CDECK_ADB
  const appData = process.env.APPDATA
  if (appData) {
    const bundled = path.join(appData, 'cdeck', 'bin', 'scrcpy', 'adb.exe')
    if (existsSync(bundled)) return bundled
  }
  return 'adb'
}

export const adbPath = findAdb()

export interface CmdResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

export async function adb(args: string[], timeoutMs = 30000): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
    return { ok: true, stdout: String(stdout), stderr: String(stderr), code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean }
    return {
      ok: false,
      stdout: String(e.stdout ?? ''),
      stderr: e.killed ? `timed out after ${timeoutMs}ms` : String(e.stderr ?? 'command failed'),
      code: typeof e.code === 'number' ? e.code : null
    }
  }
}

export async function adbBinary(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; data: Buffer; stderr: string }> {
  try {
    const { stdout } = await execFileAsync(adbPath, args, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      encoding: 'buffer'
    })
    return { ok: true, data: stdout as unknown as Buffer, stderr: '' }
  } catch (err) {
    const e = err as { stderr?: Buffer | string; killed?: boolean }
    return { ok: false, data: Buffer.alloc(0), stderr: e.killed ? `timed out after ${timeoutMs}ms` : String(e.stderr ?? 'command failed') }
  }
}

export function adbShell(serial: string, command: string, timeoutMs = 60000): Promise<CmdResult> {
  return adb(['-s', serial, 'shell', command], timeoutMs)
}

export interface Device {
  serial: string
  state: string
  model?: string
  product?: string
  device?: string
  transport: 'usb' | 'wifi'
}

export async function listDevices(): Promise<Device[]> {
  const res = await adb(['devices', '-l'])
  if (!res.ok) return []
  const out: Device[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('List of devices')) continue
    const parts = t.split(/\s+/)
    if (parts.length < 2) continue
    const serial = parts[0]
    out.push({
      serial,
      state: parts[1],
      model: t.match(/model:(\S+)/)?.[1],
      product: t.match(/product:(\S+)/)?.[1],
      device: t.match(/device:(\S+)/)?.[1],
      transport: serial.includes(':') || serial.startsWith('adb-') ? 'wifi' : 'usb'
    })
  }
  return out
}

export async function pickDevice(requested?: string): Promise<Device> {
  const devices = await listDevices()
  const usable = devices.filter((d) => d.state === 'device')
  if (requested) {
    const found = usable.find((d) => d.serial === requested)
    if (!found) {
      throw new Error(
        `Device "${requested}" is not available (state: ${devices.find((d) => d.serial === requested)?.state ?? 'not found'}). Call device_list first.`
      )
    }
    return found
  }
  if (usable.length === 0) {
    throw new Error(
      devices.length > 0
        ? `No usable device. Current states: ${devices.map((d) => `${d.serial}=${d.state}`).join(', ')}. An "unauthorized" device needs the Allow prompt accepted on the phone.`
        : 'No device connected. Plug in over USB with USB debugging on, or use a wireless target.'
    )
  }
  const preferred = process.env.CDECK_SERIAL ? usable.find((d) => d.serial === process.env.CDECK_SERIAL) : undefined
  return preferred ?? usable[0]
}

export const ANDROID_KEYS: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  MENU: 82,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  MUTE: 164,
  ENTER: 66,
  DEL: 67,
  SPACE: 62,
  TAB: 61,
  APP_SWITCH: 187,
  CAMERA: 27,
  PLAY_PAUSE: 85
}

export function localIps(): string[] {
  const ips: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') ips.push(a.address)
    }
  }
  return ips
}