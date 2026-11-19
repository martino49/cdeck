import type { WatchdogState } from '@shared/types'
import { Badge, Button, Card } from './ui'

const win = window.cdeck

export function WatchdogPanel({ watchdog }: { watchdog: WatchdogState | null }) {
  if (!watchdog) return null
  return (
    <Card
      title="Watchdog"
      right={<Badge tone={watchdog.running ? 'ok' : 'neutral'} pulse={watchdog.running}>{watchdog.running ? 'running' : 'stopped'}</Badge>}
    >
      <div className="mb-1.5 flex gap-3 font-mono text-[11px] text-dim">
        <span>checks: {watchdog.checks}</span>
        <span>reconnects: {watchdog.reconnects}</span>
        {watchdog.lastTarget && <span className="truncate">target: {watchdog.lastTarget}</span>}
      </div>
      <div className="min-h-[2.2em] text-[12px]">
        <span className="text-dim">last: </span>
        <span className="font-mono">{watchdog.lastAction}</span>
      </div>
      {watchdog.lastError && <div className="mt-1 font-mono text-[11px] text-err">{watchdog.lastError}</div>}
      <div className="mt-2 flex gap-2">
        {watchdog.running ? (
          <Button size="sm" variant="danger" onClick={() => void win.watchdog.stop()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void win.watchdog.start()}>
            Start
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void win.watchdog.once()}>
          Run once
        </Button>
      </div>
    </Card>
  )
}
