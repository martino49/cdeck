import { Play, RefreshCw, Smartphone, Usb, Wifi } from 'lucide-react'
import type { DeviceInfo } from '@shared/types'
import { Badge, Button } from './ui'

export function TopBar({
  devices,
  activeDevice,
  onSelectDevice,
  onStartSession,
  onRefresh,
  busy
}: {
  devices: DeviceInfo[]
  activeDevice: DeviceInfo | null
  onSelectDevice: (serial: string) => void
  onStartSession: () => void
  onRefresh: () => void
  busy: boolean
}) {
  const ready = activeDevice?.state === 'device'
  return (
    <header className="flex items-center gap-3 border-b border-line bg-panel px-3.5 py-2">
      <div className="flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Smartphone className="h-4 w-4" strokeWidth={2} />
        </div>
        <span className="text-[13px] font-semibold tracking-tight">CDeck</span>
      </div>

      <div className="mx-1 h-5 w-px bg-line" />

      {devices.length === 0 ? (
        <span className="text-[12px] text-dim">No device connected</span>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={activeDevice?.serial ?? ''}
            onChange={(e) => onSelectDevice(e.target.value)}
            className="max-w-[280px] rounded-md border border-line bg-panel2 px-2 py-1 text-[12px]"
          >
            {devices.map((d) => (
              <option key={d.serial} value={d.serial}>
                {(d.model ?? d.serial) + (d.state === 'device' ? '' : ` (${d.state})`)}
              </option>
            ))}
          </select>
          {activeDevice && (
            <>
              <Badge tone={ready ? 'ok' : 'warn'} pulse={!ready}>
                {activeDevice.state}
              </Badge>
              <Badge>
                <span className="flex items-center gap-1">
                  {activeDevice.transport === 'tcpip' ? <Wifi className="h-3 w-3" /> : <Usb className="h-3 w-3" />}
                  {activeDevice.transport === 'tcpip' ? 'Wi-Fi' : 'USB'}
                </span>
              </Badge>
            </>
          )}
        </div>
      )}

      <div className="flex-1" />

      <Button variant="ghost" size="sm" onClick={onRefresh} title="Refresh (F5)">
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
      <Button variant="primary" onClick={onStartSession} disabled={!ready || busy} title="Tunnels + mirror + logcat in one click">
        <Play className="h-3.5 w-3.5" />
        Start Session
      </Button>
    </header>
  )
}