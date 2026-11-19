import { Toaster, toast } from 'sonner'

const TOAST_CLASS =
  '!rounded-[var(--radius-card)] !border-line !bg-panel2 !text-fg !shadow-2 !font-sans !text-base'

const recent = new Map<string, number>()

export function showToast(kind: 'success' | 'error' | 'info', message: string, detail?: string): void {
  const key = `${kind}:${message}:${detail ?? ''}`
  const now = Date.now()
  const last = recent.get(key) ?? 0
  if (now - last < 1500) return
  recent.set(key, now)
  if (recent.size > 100) {
    for (const [k, t] of recent) if (now - t > 60000) recent.delete(k)
  }

  const options = {
    description: detail || undefined,
    duration: kind === 'error' ? 8000 : 4000,
    closeButton: kind === 'error'
  }
  if (kind === 'error') toast.error(message, options)
  else if (kind === 'success') toast.success(message, options)
  else toast(message, options)
}

export { Toaster, TOAST_CLASS }