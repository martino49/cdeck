import { Notification, BrowserWindow } from 'electron'
import log from './log'

const shown = new Set<string>()

export interface NotifyOptions {
  key: string
  title: string
  body: string
  silent?: boolean
  sticky?: boolean
}

export function notify(opts: NotifyOptions): void {
  if (shown.has(opts.key)) return
  shown.add(opts.key)
  if (!Notification.isSupported()) return
  const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
  if (focused) return
  try {
    const n = new Notification({
      id: opts.key,
      title: opts.title,
      body: opts.body,
      silent: opts.silent ?? false,
      timeoutType: opts.sticky ? 'never' : 'default'
    })
    n.on('failed', (_e, err) => log.warn('notification failed', err))
    n.show()
  } catch (err) {
    log.warn('notification threw', err)
  }
}

export function clearNotifyKey(key: string): void {
  shown.delete(key)
}

export function resetNotifyState(): void {
  shown.clear()
}
