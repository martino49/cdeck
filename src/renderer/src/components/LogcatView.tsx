import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Button } from './ui'
import { cn, levelColor, parseLogLine } from '../lib/utils'
import { showToast } from '../lib/toast'
import { tinykeys } from 'tinykeys'

const win = window.cdeck
const MAX_LINES = 20000

const BUFFERS: Record<string, string[]> = {
  main: ['main'],
  system: ['main', 'system'],
  crash: ['main', 'system', 'crash'],
  all: ['main', 'system', 'crash', 'events', 'radio', 'kernel']
}

const PRESETS: Array<{ label: string; pattern: string; hint: string }> = [
  { label: 'crashes', pattern: 'FATAL EXCEPTION|AndroidRuntime', hint: 'uncaught Java exceptions' },
  { label: 'ANRs', pattern: 'ANR in', hint: 'app not responding' },
  { label: 'low memory', pattern: 'onTrimMemory|LowMemoryKiller', hint: 'memory pressure' },
  { label: 'gc', pattern: 'GC freed|Background concurrent', hint: 'garbage collection churn' }
]

export function LogcatView({ serial: serialProp }: { serial?: string } = {}) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const serial = serialProp ?? params.get('serial') ?? ''
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [frozen, setFrozen] = useState<string[] | null>(null)
  const [running, setRunning] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [dropped, setDropped] = useState(0)
  const [buffer, setBuffer] = useState('crash')
  const [level, setLevel] = useState('')
  const listRef = useRef<VirtuosoHandle>(null)
  const streamRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offBatch = win.onLogcatBatch(({ lines: batch }) => {
      setLines((prev) => {
        const next = [...prev, ...batch]
        if (next.length > MAX_LINES) {
          setDropped((d) => d + next.length - MAX_LINES)
          return next.slice(next.length - MAX_LINES)
        }
        return next
      })
    })
    const offExit = win.onLogcatExit(() => {
      setRunning(false)
      setSessionId(null)
    })
    return () => {
      offBatch()
      offExit()
      if (sessionId) void win.logcat.stop(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (autoScroll && !frozen && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [lines, autoScroll, frozen])

  useEffect(() => {
    return tinykeys(window, {
      '$mod+p': (e: KeyboardEvent) => {
        e.preventDefault()
        setFrozen(frozen ? null : lines)
      },
      '$mod+d': () => setLines([]),
      '$mod+f': () => {
        const input = document.querySelector('input[placeholder^="filter"]') as HTMLInputElement | null
        input?.focus()
      }
    })
  }, [frozen, lines])

  const source = frozen ?? lines
  const visible = useMemo(() => {
    let out = source
    if (level) out = out.filter((l) => {
      const parsed = parseLogLine(l)
      if (!parsed.level) return false
      const order = ['V', 'D', 'I', 'W', 'E', 'F', 'S']
      return order.indexOf(parsed.level[0]) >= order.indexOf(level)
    })
    if (!filter) return out
    const f = filter.toLowerCase()
    return out.filter((l) => l.toLowerCase().includes(f))
  }, [source, filter, level])

  const toggle = async () => {
    if (running && sessionId) {
      await win.logcat.stop(sessionId)
      setRunning(false)
      setSessionId(null)
    } else if (serial) {
      const res = await win.logcat.startBuffers(serial, BUFFERS[buffer] ?? ['main'])
      if (res.id) {
        setSessionId(res.id)
        setRunning(true)
        setLines([])
      } else {
        showToast('error', 'Logcat failed', res.error)
      }
    }
  }

  const exportLines = async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const name = `logcat-${stamp}.log`
    const res = await win.files.save(name, visible.join('\n'))
    if (res.ok) showToast('success', 'Log exported', res.path ?? name)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <strong className="text-[13px]">logcat</strong>
        <span className="font-mono text-[11px] text-dim">{serial}</span>
        <Button variant={running ? 'danger' : 'primary'} size="sm" onClick={() => void toggle()}>
          {running ? 'Stop' : 'Start'}
        </Button>
        <Button size="sm" variant={frozen ? 'primary' : 'ghost'} onClick={() => setFrozen(frozen ? null : lines)}>
          {frozen ? 'Resume' : 'Pause'}
        </Button>
        <select
          className="rounded-md border border-line bg-panel2 px-1.5 py-1 text-[11px]"
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          title="Which device buffers to stream"
        >
          {Object.keys(BUFFERS).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-line bg-panel2 px-1.5 py-1 text-[11px]"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          title="Minimum log level"
        >
          <option value="">all levels</option>
          <option value="D">D and up</option>
          <option value="I">I and up</option>
          <option value="W">W and up</option>
          <option value="E">E and up</option>
        </select>
        <input
          className="w-56 rounded-md border border-line bg-panel2 px-2 py-1"
          placeholder="filter (substring)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={filter === p.pattern ? 'primary' : 'ghost'}
            title={`Only lines matching ${p.pattern} — ${p.hint}`}
            onClick={(e) => {
              e.currentTarget.blur()
              setFilter((f) => (f === p.pattern ? '' : p.pattern))
            }}
          >
            {p.label}
          </Button>
        ))}
        <label className="flex items-center gap-1 text-[11px] text-dim">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          follow
        </label>
        <div className="flex-1" />
        {dropped > 0 && <span className="text-[11px] text-warn">{dropped} lines dropped (ring buffer)</span>}
        <span className="font-mono text-[11px] text-dim">
          {visible.length}/{lines.length}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void exportLines()} disabled={visible.length === 0}>
          Export
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const text = visible.join('\n')
            void navigator.clipboard.writeText(text).then(() => undefined)
          }}
        >
          Copy visible
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setLines([]); setDropped(0) }}>
          Clear
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" ref={streamRef}>
        {visible.length === 0 ? (
          <div className="p-6 text-center text-dim">
            {running ? 'Streaming… no lines yet.' : 'Not running. Press Start to stream logcat for this device.'}
          </div>
        ) : (
          <Virtuoso
            ref={listRef}
            data={visible}
            increaseViewportBy={{ top: 200, bottom: 400 }}
            className="font-mono text-[12.5px] leading-[1.55]"
            itemContent={(_index, raw) => {
              const parsed = parseLogLine(raw)
              return (
                <div className="flex gap-2 px-3 hover:bg-panel2">
                  {parsed.time ? (
                    <>
                      <span className="shrink-0 text-dim tabular-nums">{parsed.time}</span>
                      <span className={cn('shrink-0', levelColor(parsed.level))}>{parsed.level}</span>
                      <span className="max-w-[180px] shrink-0 truncate text-dim" title={parsed.tag}>{parsed.tag}</span>
                      <span className="min-w-0 break-all">{parsed.message}</span>
                    </>
                  ) : (
                    <span className="min-w-0 break-all text-dim">{raw}</span>
                  )}
                </div>
              )
            }}
          />
        )}
      </div>
      {!autoScroll && (
        <div className="px-3 py-1 text-center text-[11px] text-dim">
          Follow off — showing the buffer from the moment you paused scrolling.
        </div>
      )}
    </div>
  )
}
