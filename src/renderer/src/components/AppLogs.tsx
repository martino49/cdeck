import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card } from './ui'
import { showToast } from '../lib/toast'
import { cn } from '../lib/utils'

const win = window.cdeck

function lineTone(line: string): string {
  if (line.includes('[error]')) return 'text-err'
  if (line.includes('[warn]')) return 'text-warn'
  if (line.includes('[info]')) return 'text-ok'
  return 'text-dim'
}

export function AppLogs({ autoRefresh }: { autoRefresh?: boolean }) {
  const [text, setText] = useState('')
  const [meta, setMeta] = useState({ bytes: 0, path: '' })
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [loading, setLoading] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)

  const load = async () => {
    const res = await win.logs.read().catch(() => ({ ok: false, text: 'failed to read', bytes: 0 }))
    setLoading(false)
    setText(res.text)
    setMeta({ bytes: res.bytes, path: await win.logs.path().catch(() => '') })
  }

  useEffect(() => {
    void load()
    if (!autoRefresh) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [autoRefresh])

  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text, follow])

  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  const visible = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines

  return (
    <Card
      title="App logs"
      right={
        <div className="flex items-center gap-2">
          <Badge tone={meta.bytes > 8 * 1024 * 1024 ? 'warn' : 'neutral'}>
            {Math.max(1, Math.round(meta.bytes / 1024))} KB
          </Badge>
          <Badge tone="neutral" pulse={autoRefresh}>
            {autoRefresh ? 'live' : 'manual'}
          </Badge>
        </div>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          className="min-w-[200px] flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5"
          placeholder="filter (e.g. error, watchdog, scrcpy)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="flex items-center gap-1 text-[11px] text-dim">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow
        </label>
        <Button size="sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void win.logs.open()}>
          Open folder
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(visible.join('\n')).then(() => showToast('success', 'Log copied'))
          }}
        >
          Copy visible
        </Button>
      </div>
      <pre
        ref={preRef}
        className="max-h-[58vh] overflow-auto rounded-md border border-line bg-panel2 p-2 font-mono text-[11.5px] leading-[1.5]"
      >
        {visible.length === 0
          ? loading
            ? 'loading…'
            : 'No log lines yet.'
          : visible.map((l, i) => (
              <div key={i} className={cn('whitespace-pre-wrap break-all', lineTone(l))}>
                {l}
              </div>
            ))}
      </pre>
      <div className="mt-1.5 truncate text-[10px] text-dim" title={meta.path}>
        {meta.path}
      </div>
    </Card>
  )
}