import { useCallback, useEffect, useState } from 'react'
import type { DeviceInfo } from '@shared/types'
import { Badge, Button, Card, Modal, Switch } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

interface DeviceInfoResult {
  model: string
  manufacturer: string
  release: string
  sdk: string
  fingerprint: string
  screen: string
  density: string
  batteryLevel: number | null
  charging: boolean | null
}

interface Props {
  activeDevice: DeviceInfo | null
}

const VIEWPORT_PRESETS: Array<{ label: string; width: number; height: number; note: string }> = [
  { label: 'Flip6 cover screen', width: 720, height: 748, note: '3.4" cover display' },
  { label: 'Flip6 main screen', width: 1080, height: 2640, note: 'unfolded, native-ish' },
  { label: 'Compact phone', width: 360, height: 780, note: 'dp-ish small phone' },
  { label: 'Tablet', width: 1280, height: 800, note: 'large viewport class' }
]

const DEV_TOGGLES: Array<{ label: string; namespace: string; key: string; on: string; off: string; hint: string }> = [
  { label: 'Show touches', namespace: 'system', key: 'show_touches', on: '1', off: '0', hint: 'Visual feedback for taps while testing' },
  { label: 'Stay awake while charging', namespace: 'global', key: 'stay_on_while_plugged_in', on: '7', off: '0', hint: 'scrcpy -w also toggles this while it runs' },
  { label: "Don't keep activities", namespace: 'global', key: 'always_finish_activities', on: '1', off: '0', hint: 'Stress-test state save/restore' },
  { label: 'Animations 0.5×', namespace: 'global', key: 'animator_duration_scale', on: '0.5', off: '1', hint: 'Faster UI tests; toggle off to restore' },
  { label: 'Window animations 0.5×', namespace: 'global', key: 'window_animation_scale', on: '0.5', off: '1', hint: '' },
  { label: 'Transition animations 0.5×', namespace: 'global', key: 'transition_animation_scale', on: '0.5', off: '1', hint: '' }
]

export function DevicePanel({ activeDevice }: Props) {
  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const [info, setInfo] = useState<DeviceInfoResult | null>(null)
  const [toggles, setToggles] = useState<Record<string, string>>({})
  const [customW, setCustomW] = useState('')
  const [customH, setCustomH] = useState('')
  const [busyDiag, setBusyDiag] = useState('')
  const [perf, setPerf] = useState('')
  const [diagServices, setDiagServices] = useState<string[]>([])
  const [diagService, setDiagService] = useState('activity')
  const [dumpsysOut, setDumpsysOut] = useState('')
  const [dumpsysOpen, setDumpsysOpen] = useState(false)

  const loadServices = useCallback(async () => {
    if (!serial || diagServices.length > 0) return
    const list = await win.device.dumpsysServices(serial).catch(() => [] as string[])
    setDiagServices(list)
  }, [serial, diagServices.length])

  const captureBugreport = async () => {
    if (!serial) return
    setBusyDiag('bugreport')
    const res = await win.device.bugreport(serial)
    setBusyDiag('')
    if (res.ok) {
      showToast('success', 'Bugreport captured', res.file)
      await win.captures.openFolder()
    } else {
      showToast('error', 'Bugreport failed', res.error)
    }
  }

  const capturePerf = async () => {
    if (!serial) return
    setBusyDiag('perf')
    const res = await win.device.perf(serial).catch(() => ({ cpu: '', mem: '' }))
    setBusyDiag('')
    setPerf(`=== cpu ===\n${res.cpu}\n\n=== mem ===\n${res.mem}`)
  }

  const runDumpsys = async () => {
    if (!serial || !diagService) return
    setBusyDiag('dumpsys')
    const res = await win.device.dumpsys(serial, diagService)
    setBusyDiag('')
    setDumpsysOut(res.stdout || res.stderr)
    setDumpsysOpen(true)
  }

  const load = useCallback(async () => {
    if (!serial) {
      setInfo(null)
      setToggles({})
      return
    }
    const [deviceInfo, viewport] = await Promise.all([win.device.info(serial), win.device.viewport(serial)])
    setInfo(deviceInfo)
    setToggles((prev) => ({ ...prev, __size: viewport.size, __density: viewport.density }))
    const reads = await Promise.all(DEV_TOGGLES.map((t) => win.device.settingsGet(serial, t.namespace, t.key)))
    const next: Record<string, string> = {}
    DEV_TOGGLES.forEach((t, i) => {
      next[`${t.namespace}/${t.key}`] = reads[i].stdout.trim()
    })
    setToggles((prev) => ({ ...next, __size: viewport.size, __density: viewport.density }))
  }, [serial])

  useEffect(() => {
    void load()
  }, [load])

  const applyPreset = async (preset: (typeof VIEWPORT_PRESETS)[number]) => {
    if (!serial) return
    const res = await win.device.setViewport(serial, { width: preset.width, height: preset.height })
    if (res.ok) {
      showToast('success', `Viewport → ${preset.width}×${preset.height}`, preset.note)
      await load()
    } else {
      showToast('error', 'Viewport change failed', res.errors.join('; '))
    }
  }

  const battery = async (op: 'level15' | 'level5' | 'ac' | 'unplug' | 'reset') => {
    if (!serial) return
    const res = await win.device.battery(serial, op)
    if (op === 'reset') showToast('success', 'Battery restored to real values', res.stdout.trim())
    else if (!res.ok) showToast('error', 'Battery command failed', res.stderr)
    await load()
  }

  const setToggle = async (t: (typeof DEV_TOGGLES)[number], next: boolean) => {
    if (!serial) return
    const value = next ? t.on : t.off
    const res = await win.device.settingsPut(serial, t.namespace, t.key, value)
    if (res.ok) {
      setToggles((prev) => ({ ...prev, [`${t.namespace}/${t.key}`]: value }))
      if (next) showToast('info', `${t.label}: on`, `was "${toggles[`${t.namespace}/${t.key}`] ?? '?'}"`)
    } else {
      showToast('error', 'Toggle failed', res.stderr)
    }
  }

  return (
    <>
      <Card title="Device" right={serial ? <Badge tone="ok">online</Badge> : <Badge>offline</Badge>}>
        {!info && <div className="py-4 text-center text-dim">Connect a device to inspect it.</div>}
        {info && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[12px]">
            <div className="text-dim">model</div>
            <div className="truncate" title={info.model}>{info.model || '-'}</div>
            <div className="text-dim">android</div>
            <div>{info.release} (API {info.sdk})</div>
            <div className="text-dim">screen</div>
            <div>{toggles.__size ?? info.screen} · {toggles.__density ?? info.density}</div>
            <div className="text-dim">battery</div>
            <div>
              {info.batteryLevel ?? '-'}%{info.charging === null ? '' : info.charging ? ' · charging' : ' · on battery'}
            </div>
            <div className="col-span-2 truncate text-dim" title={info.fingerprint}>{info.fingerprint}</div>
          </div>
        )}
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={!serial}>
            Refresh
          </Button>
          {serial && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(info?.fingerprint ?? '')
                showToast('success', 'Build fingerprint copied')
              }}
            >
              Copy fingerprint
            </Button>
          )}
        </div>
      </Card>

      <Card title="Diagnostics" right={<span className="text-[11px] text-dim">adb bugreport / dumpsys</span>}>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void captureBugreport()} disabled={!serial || busyDiag === 'bugreport'}>
            {busyDiag === 'bugreport' ? 'Capturing bugreport (can take minutes)…' : 'Capture bugreport'}
          </Button>
          <Button size="sm" onClick={() => void capturePerf()} disabled={!serial || busyDiag === 'perf'}>
            Perf snapshot
          </Button>
          <div className="flex-1" />
          <select
            className="w-[220px] rounded-md border border-line bg-panel2 px-2 py-1.5"
            value={diagService}
            onChange={(e) => setDiagService(e.target.value)}
            onFocus={() => void loadServices()}
            title="dumpsys service"
          >
            {diagServices.length === 0 ? <option value="">loading services…</option> : null}
            {diagServices.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => void runDumpsys()} disabled={!serial || !diagService || busyDiag === 'dumpsys'}>
            Run dumpsys
          </Button>
        </div>
        {perf && (
          <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-line bg-panel2 p-2 font-mono text-[11px] text-dim">
            {perf}
          </pre>
        )}
      </Card>

      <Card title="Viewport & density" right={<span className="text-[11px] text-dim">wm size / wm density</span>}>
        <div className="mb-2 text-[11px] text-dim">
          Override the display to test layouts without folding the phone. Always reset afterwards.
        </div>
        <div className="flex flex-wrap gap-2">
          {VIEWPORT_PRESETS.map((p) => (
            <Button key={p.label} size="sm" onClick={() => void applyPreset(p)} disabled={!serial} title={p.note}>
              {p.label}
            </Button>
          ))}
          <Button size="sm" variant="danger" onClick={() => void win.device.resetViewport(serial!).then((r) => { if (r.ok) { showToast('success', 'Viewport reset'); void load() } })} disabled={!serial}>
            Reset
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input className="w-20 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono" placeholder="W" value={customW} onChange={(e) => setCustomW(e.target.value.replace(/\D/g, ''))} />
          <span className="text-dim">×</span>
          <input className="w-20 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono" placeholder="H" value={customH} onChange={(e) => setCustomH(e.target.value.replace(/\D/g, ''))} />
          <Button
            size="sm"
            onClick={() => {
              const w = Number(customW)
              const h = Number(customH)
              if (serial && w > 0 && h > 0) void win.device.setViewport(serial, { width: w, height: h }).then((r) => { if (r.ok) void load() })
            }}
            disabled={!serial || !customW || !customH}
          >
            Apply custom
          </Button>
        </div>
      </Card>

      <Card title="Battery simulation" right={<span className="text-[11px] text-dim">dumpsys battery</span>}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void battery('level15')} disabled={!serial}>15%</Button>
          <Button size="sm" onClick={() => void battery('level5')} disabled={!serial}>5%</Button>
          <Button size="sm" onClick={() => void battery('ac')} disabled={!serial}>Charging</Button>
          <Button size="sm" onClick={() => void battery('unplug')} disabled={!serial}>Unplugged</Button>
          <Button size="sm" variant="danger" onClick={() => void battery('reset')} disabled={!serial}>Reset to real battery</Button>
        </div>
      </Card>

      <Card title="Developer toggles" right={<span className="text-[11px] text-dim">settings put</span>}>
        <div className="space-y-1">
          {DEV_TOGGLES.map((t) => {
            const current = toggles[`${t.namespace}/${t.key}`] ?? ''
            const on = current === t.on
            return (
              <div key={`${t.namespace}/${t.key}`} className="flex items-center gap-3 border-b border-line py-1.5 last:border-0">
                <Switch checked={on} onChange={(v) => void setToggle(t, v)} label={t.label} />
                {t.hint && <span className="flex-1 truncate text-[11px] text-dim" title={t.hint}>{t.hint}</span>}
                <span className="font-mono text-[10px] text-dim">{current || 'unknown'}</span>
              </div>
            )
          })}
        </div>
      </Card>

      <Modal open={dumpsysOpen} onClose={() => setDumpsysOpen(false)} title={`dumpsys ${diagService}`}>
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-line bg-panel2 p-2 font-mono text-[11px]">{dumpsysOut}</pre>
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(dumpsysOut)}>
            Copy output
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDumpsysOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </>
  )
}
