import { useEffect, useState } from 'react'
import type { DeviceInfo, ReverseResult, Settings } from '@shared/types'
import { Button, Card, Badge } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

interface Props {
  settings: Settings | null
  serial: string | null
  results: Record<number, ReverseResult>
  patchSettings: (patch: Partial<Settings>) => Promise<void>
  activeSerial?: string | null
}

export function TunnelPanel({ settings, serial, results, patchSettings, activeSerial }: Props) {
  const [newPort, setNewPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<Record<number, string>>({})
  const ports = settings?.tunnels ?? []

  const addPort = async () => {
    const port = Number(newPort)
    if (!port || port < 1 || port > 65535 || ports.includes(port)) return
    setBusy(true)
    await patchSettings({ tunnels: [...ports, port] })
    setNewPort('')
    setBusy(false)
  }

  const removePort = async (port: number) => {
    setBusy(true)
    if (serial) await win.adb.removeReverse(serial, port)
    await patchSettings({ tunnels: ports.filter((p) => p !== port) })
    setBusy(false)
  }

  const assertNow = async () => {
    if (!serial || ports.length === 0) return
    setBusy(true)
    const resultsNow = await win.adb.ensureReverse(serial, ports)
    setBusy(false)
    const failed = resultsNow.filter((r) => !r.ok)
    if (failed.length === 0) showToast('success', `Tunnels active on ${serial}`)
    else showToast('error', 'Some tunnels failed', failed.map((f) => `tcp:${f.port} ${f.error ?? ''}`).join('; '))
  }

  const probePort = async (p: number) => {
    setProbe((prev) => ({ ...prev, [p]: 'testing…' }))
    const res = await win.net.probe(p)
    setProbe((prev) => ({ ...prev, [p]: res.detail }))
  }

  return (
    <Card
      title="Reverse tunnels"
      right={<Badge tone={serial ? 'ok' : 'neutral'}>{serial ? 'device online' : 'device offline'}</Badge>}
    >
      <div className="mb-2 text-[11px] text-dim">
        Phone → laptop. Your app calls <span className="font-mono">localhost:PORT</span> on the phone and lands on this laptop. Rules vanish when
        the transport drops — the watchdog re-asserts them.
      </div>
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {ports.map((p) => {
            const r = results[p]
            return (
              <tr key={p} className="border-t border-line">
                <td className="py-1.5 font-mono">localhost:{p}</td>
                <td className="py-1.5">
                  {r === undefined ? (
                    <Badge>pending</Badge>
                  ) : r.ok ? (
                    <Badge tone="ok">active</Badge>
                  ) : (
                    <Badge tone="err" >failed</Badge>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  <Button size="sm" variant="ghost" onClick={() => void probePort(p)} title="Test whether this laptop is listening on the port">
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void removePort(p)} disabled={busy} aria-label={`Remove port ${p}`}>
                    ✕
                  </Button>
                  {probe[p] && <span className="ml-1 text-[10px] text-dim">{probe[p]}</span>}
                </td>
              </tr>
            )
          })}
          {ports.length === 0 && (
            <tr>
              <td className="py-2 text-dim" colSpan={3}>
                No tunnels configured yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2">
        <input
          className="w-20 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono"
          placeholder="port"
          value={newPort}
          onChange={(e) => setNewPort(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addPort()
          }}
        />
        <Button size="sm" onClick={() => void addPort()} disabled={busy || !newPort}>
          Add
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={() => void assertNow()} disabled={busy || !serial}>
          Assert now
        </Button>
      </div>
    </Card>
  )
}

export function RadioPanel({ activeDevice }: { activeDevice: DeviceInfo | null }) {
  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const [busy, setBusy] = useState('')
  const [state, setState] = useState({ wifi: false, data: false, airplane: false })

  const read = async () => {
    if (!serial) return
    const res = await win.adb.shell(serial, 'dumpsys wifi | grep -m1 "Wi-Fi is"; dumpsys connectivity | grep -m1 "mAirplaneMode"; settings get global mobile_data').catch(() => null)
    if (!res) return
    const wifi = /Wi-Fi is enabled/.test(res.stdout)
    const airplane = /AIRPLANE_MODE_ON/.test(res.stdout)
    setState({ wifi, data: !airplane, airplane })
  }

  useEffect(() => {
    void read()
  }, [serial])

  const toggle = async (target: 'wifi' | 'data' | 'airplane', on: boolean) => {
    if (!serial) return
    setBusy(target + on)
    const res = await win.device.netToggle(serial, target, on)
    setBusy('')
    if (res.ok) {
      showToast('success', `${target} ${on ? 'on' : 'off'}`, res.stdout.trim())
      await new Promise((r) => setTimeout(r, 1500))
      await read()
    } else {
      showToast('error', `${target} toggle failed`, res.stderr.trim())
    }
  }

  return (
    <Card title="Radios" right={<span className="text-[11px] text-dim">svc / cmd connectivity</span>}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={state.wifi ? 'primary' : 'default'} disabled={!serial || busy !== ''} onClick={() => void toggle('wifi', !state.wifi)}>
          Wi-Fi {state.wifi ? 'on' : 'off'}
        </Button>
        <Button size="sm" variant={state.data ? 'primary' : 'default'} disabled={!serial || busy !== ''} onClick={() => void toggle('data', !state.data)}>
          Mobile data {state.data ? 'on' : 'off'}
        </Button>
        <Button size="sm" variant={state.airplane ? 'primary' : 'danger'} disabled={!serial || busy !== ''} onClick={() => void toggle('airplane', !state.airplane)}>
          Airplane {state.airplane ? 'on' : 'off'}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void read()} disabled={!serial}>
          Refresh
        </Button>
      </div>
      <div className="mt-1.5 text-[11px] text-dim">
        Turning Wi-Fi off can drop a wireless adb connection — the watchdog retries automatically if it reconnects.
      </div>
    </Card>
  )
}
