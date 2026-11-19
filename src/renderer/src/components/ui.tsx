import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '../lib/utils'

type Variant = 'primary' | 'default' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-bg border-accent hover:brightness-110 active:brightness-95',
  default: 'bg-panel2 text-fg border-line hover:border-line-strong active:brightness-95',
  ghost: 'bg-transparent text-dim border-transparent hover:text-fg hover:bg-hover active:brightness-95',
  danger: 'bg-transparent text-err border-err/60 hover:bg-err-soft active:brightness-95'
}

export function Button({ variant = 'default', size = 'md', className, ...rest }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-ctl)] border font-medium whitespace-nowrap transition-[background-color,border-color,filter,transform,opacity] duration-[var(--dur-fast)] ease-out active:scale-[.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100',
        size === 'sm' ? 'h-[26px] px-2 text-xs' : 'h-[30px] px-3 text-base',
        VARIANTS[variant],
        className
      )}
      {...rest}
    />
  )
}

export function Card({ title, right, children, className }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-[var(--radius-card)] border border-line bg-panel shadow-1', className)}>
      {title && (
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-2xs font-semibold uppercase tracking-[0.04em] text-dim">{title}</h2>
          <div className="flex-1" />
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  pulse,
  dot,
  mono
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'accent'
  pulse?: boolean
  dot?: boolean
  mono?: boolean
}) {
  const tones: Record<string, string> = {
    neutral: 'border-line text-dim',
    ok: 'border-ok/30 text-ok bg-ok-soft',
    warn: 'border-warn/30 text-warn bg-warn-soft',
    err: 'border-err/30 text-err bg-err-soft',
    accent: 'border-accent/30 text-accent bg-accent-soft'
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-xs tabular-nums',
        tones[tone],
        mono && 'font-mono'
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {pulse && <span className="status-pulse inline-block h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-4 w-8 rounded-full border transition-colors duration-[var(--dur-mid)] ease-out',
          checked ? 'bg-accent border-accent' : 'bg-panel2 border-line'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-bg transition-all duration-[var(--dur-mid)] ease-[cubic-bezier(.34,1.56,.64,1)]',
            checked ? 'left-4.5' : 'left-0.5'
          )}
        />
      </button>
      <span className="text-base">{label}</span>
    </label>
  )
}

export function Empty({ icon, title, hint, action, link }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode; link?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      {icon && (
        <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-card)] border border-line bg-panel2 text-dim [&_svg]:h-5 [&_svg]:w-5 [&_svg]:stroke-[1.75]">
          {icon}
        </div>
      )}
      <div className="text-sub font-semibold text-fg">{title}</div>
      {hint && <div className="max-w-sm text-sm text-dim">{hint}</div>}
      {action && <div className="mt-1.5 flex items-center gap-2">{action}</div>}
      {link && !action && <div className="mt-1.5 text-xs text-dim">{link}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[3px] border border-line bg-panel2 px-1.5 py-0.5 font-mono text-2xs text-dim">{children}</kbd>
  )
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="py-1.5">
      <label className="text-base font-medium text-fg" htmlFor={htmlFor}>
        {label}
      </label>
      {hint && <div className="mt-0.5 text-xs text-dim">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  )
}

export function Skeleton({ w, h, className }: { w?: number | string; h?: number | string; className?: string }) {
  return <div className={cn('skeleton', className)} style={{ width: w ?? '100%', height: h ?? 14 }} />
}

export function TableSkeleton({ rows = 6, cols = 3 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} h={12} className={c === cols - 1 ? 'w-16' : 'flex-1'} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function DataTable({
  columns,
  rows,
  empty,
  onRowClick,
  maxHeight
}: {
  columns: Array<{ key: string; label: string; align?: 'left' | 'right'; mono?: boolean }>
  rows: Array<{ key: string; cells: ReactNode[] }>
  empty?: ReactNode
  onRowClick?: (key: string) => void
  maxHeight?: string
}) {
  return (
    <div className={cn('scroll-stable overflow-auto rounded-[var(--radius-card)] border border-line bg-panel', maxHeight ?? 'max-h-[55vh]')}>
      <table className="w-full border-collapse text-sm" data-table>
        <thead>
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'sticky top-0 z-10 bg-panel px-2.5 py-2 text-2xs font-semibold text-dim',
                  c.align === 'right' ? 'text-right' : 'text-left',
                  c.mono && 'font-mono'
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? empty ?? (
                <tr>
                  <td colSpan={columns.length} className="px-2.5 py-6 text-center text-sm text-dim">
                    Nothing here yet.
                  </td>
                </tr>
              )
            : rows.map((r) => (
                <tr
                  key={r.key}
                  onClick={onRowClick ? () => onRowClick(r.key) : undefined}
                  className="border-b border-line last:border-0 hover:bg-hover [&:nth-child(even)]:bg-hover"
                >
                  {r.cells.map((cell, i) => (
                    <td
                      key={columns[i]?.key ?? i}
                      className={cn(
                        'px-2.5 py-1.5 align-middle',
                        columns[i]?.align === 'right' ? 'text-right tabular-nums' : 'text-left',
                        columns[i]?.mono && 'font-mono'
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--backdrop)] p-6 backdrop-blur-[8px]" onClick={onClose}>
      <div
        className="pop-in w-full max-w-lg rounded-[var(--radius-card)] border border-line bg-panel shadow-3"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center border-b border-line px-4 py-3">
          <h2 className="text-sub font-semibold text-fg">{title}</h2>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
            Esc
          </Button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <footer className="border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} autoFocus>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="text-sm text-dim">{message}</div>
    </Modal>
  )
}