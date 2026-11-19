import { useEffect, useState } from 'react'
import type { ToolInfo } from '@shared/types'
import { Badge, Button, Card } from './ui'
import { showToast } from '../lib/toast'
import { formatBytes } from '../lib/utils'

const win = window.cdeck

export function ToolsPanel({ tools, refresh }: { tools: ToolInfo[]; refresh: () => void }) {
  const [progress, setProgress] = useState<{ stage: string; received: number; total: number; message?: string } | null>(null)
  const [selfResult, setSelfResult] = useState<string>('')

  useEffect(() => {
    return win.onToolsProgress((p) => {
      if (p.stage === 'done' || p.stage === 'error') {
        setProgress(null)
        refresh()
        if (p.stage === 'error') showToast('error', 'Tool install failed', p.message)
      } else {
        setProgress({ stage: p.stage, received: p.receivedBytes, total: p.totalBytes, message: p.message })
      }
    })
  }, [refresh])

  const adb = tools.find((t) => t.name === 'adb')
  const scrcpy = tools.find((t) => t.name === 'scrcpy')
  const pct = progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0

  const toolLine = (name: string, info: ToolInfo | undefined) => (
    <div className="mb-1">
      <div className="font-mono text-[12px]">
        {name}:{' '}
        {info?.present ? (
          <span className="text-ok">
            {info.version} <span className="text-dim">({info.source})</span>
          </span>
        ) : (
          <span className="text-err">not installed</span>
        )}
      </div>
      {info?.path && <div className="truncate text-[10px] text-dim" title={info.path}>{info.path}</div>}
    </div>
  )

  return (
    <Card
      title="Tools"
      right={
        <Button size="sm" variant="ghost" onClick={() => void win.tools.clearCache().then(refresh)}>
          Clear cache
        </Button>
      }
    >
      {toolLine('adb', adb)}
      {toolLine('scrcpy', scrcpy)}
      {progress && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-[11px] text-dim">
            <span>
              {progress.stage} {progress.message && <span className="font-mono">({progress.message})</span>}
            </span>
            {progress.total > 0 && <span>{formatBytes(progress.received)} / {formatBytes(progress.total)}</span>}
          </div>
          {progress.total > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
              <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {!scrcpy?.present && (
          <Button size="sm" variant="primary" onClick={() => void win.tools.installScrcpy()} disabled={Boolean(progress)}>
            Install scrcpy
          </Button>
        )}
        {!adb?.present && (
          <Button size="sm" onClick={() => void win.tools.installPlatformTools()} disabled={Boolean(progress)}>
            Install platform-tools
          </Button>
        )}
        <Badge tone="neutral">auto-download on first run</Badge>
      </div>
      {adb?.present && scrcpy?.present && (
        <div className="mt-2 text-[11px] text-ok">All tools present. CDeck never conflicts with Android Studio's adb — it pins its own copy.</div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          onClick={async () => {
            const res = await win.selftest.run()
            setSelfResult(`${res.code === 0 ? 'PASS' : 'FAIL'} — report at ${res.path}`)
            showToast(res.code === 0 ? 'success' : 'error', res.code === 0 ? 'Self-test passed' : 'Self-test reported failures', res.path)
          }}
        >
          Run self-test
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void win.logs.open()}>
          Open logs
        </Button>
        {selfResult && <span className="text-[11px] text-dim">{selfResult}</span>}
      </div>
    </Card>
  )
}
