import type { IpcMainEvent, WebContents } from 'electron'

const SERIAL_RE = /^[\w.\-:+]{1,64}$/
const PORT_RE = /^\d{1,5}$/

export function isSerial(value: unknown): value is string {
  return typeof value === 'string' && SERIAL_RE.test(value)
}

export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
}

export function isText(value: unknown, maxLen = 4000): value is string {
  return typeof value === 'string' && value.length <= maxLen
}

export class GuardError extends Error {}

const allowedPrefixes = new Set<string>()

export function allowOrigin(url: string): void {
  try {
    const u = new URL(url)
    allowedPrefixes.add(u.origin === 'null' ? '' : u.origin)
  } catch {
    allowedPrefixes.add(url)
  }
}

export function trustedSender(event: IpcMainEvent): boolean {
  const frame = event.senderFrame
  if (!frame) return false
  if (allowedPrefixes.size === 0) return false
  try {
    const u = new URL(frame.url)
    const origin = u.origin === 'null' ? '' : u.origin
    return allowedPrefixes.has(origin)
  } catch {
    return false
  }
}

export function senderWebContents(event: { sender: unknown }): WebContents | null {
  const wc = event.sender as WebContents | null
  if (wc && typeof wc.send === 'function') return wc
  return null
}

export { PORT_RE }
