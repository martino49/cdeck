import { useEffect, useRef, useState } from 'react'
import type { DeviceInfo } from '@shared/types'
import { Badge, Button, Card, Field } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

const OVERRIDES: Array<{ label: string; namespace: string; key: string; on: string; off: string; hint: string }> = [
  { label: 'Show layout bounds', namespace: 'global', key: 'debug_layout', on: '1', off: '0', hint: 'Draws boxes around every view — spot padding and clip bugs instantly' },
  { label: 'Font scale 1.3×', namespace: 'system', key: 'font_scale', on: '1.3', off: '1.0', hint: 'Accessibility / large-text layout testing' },
  { label: 'Force RTL layout', namespace: 'global', key: 'debug_force_rtl', on: '1', off: '0', hint: 'Mirror the UI for Arabic/Hebrew review' },
  { label: 'Pointer location', namespace: 'system', key: 'pointer_location', on: '1', off: '0', hint: 'Overlay showing touch coordinates' }
]

const COMMON_APPOPS: Array<{ label: string; op: string }> = [
  { label: 'Camera access', op: 'android:camera' },
  { label: 'Location', op: 'android:fine_location' },
  { label: 'Microphone', op: 'android:record_audio' },
  { label: 'Clipboard read', op: 'android:read_clipboard' },
  { label: 'Overlay window', op: 'android:system_alert_window' }
]

interface Sample {
  at: number
  cpu: number
  mem: number
}

function Spark({ data, max, color, label }: { data: number[]; max: number; color: string; label: string }) {
  const w = 260
  const h = 36
  const points = data
    .map((v, i) => `${(i / Math.max(data.length - 1, 1)) * w},${h - Math.min(v / max, 1) * h}`)
    .join(' ')
  const last = data.length > 0 ? data[data.length - 1] : 0
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-dim">
        <span>{label}</span>
        <span className="font-mono">{last.toFixed(1)}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-full">
        <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
      </svg>
    </div>
  )
}

export function DebugPanel({ activeDevice }: { activeDevice: DeviceInfo | null }) {
  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const [samples, setSamples] = useState<Sample[]>([])
  const [sampling, setSampling] = useState(false)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [crashes, setCrashes] = useState<Array<{ app: string; snippet: string; at: number }>>([])
  const [appopsPkg, setAppopsPkg] = useState('')
  const [currentPkg, setCurrentPkg] = useState('')
  const [locale, setLocale] = useState('')
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!sampling || !serial) return
    const tick = async () => {
      const res = await win.device.perf(serial).catch(() => ({ cpu: '', mem: '' }))
      const cpu = Number((res.cpu.match(/([\d.]+)%?\s*(?:user|total)/) || [])[1] ?? (res.cpu.match(/CPU usage[^\n]*?([\d.]+)%/) || [])[1] ?? 0)
      const memMatch = res.mem.match(/TOTAL:\s*(\d+)/) ?? res.mem.match(/([\d,]+)K?\s*\/\s*([\d,]+)K/)
      const used = memMatch ? Number(memMatch[1].replace(/,/g, '')) : 0
      const total = res.mem.match(/TOTAL:\s*(\d+)/) ? Number((res.mem.match(/MemTotal:\s*(\d+)/) || [])[1] ?? 0) : 0
      const memPct = total > 0 ? (used / total) * 100 : Math.min(used / 100000, 100)
      setSamples((prev) => [...prev.slice(-59), { at: Date.now(), cpu, mem: memPct }])
    }
    void tick()
    timerRef.current = window.setInterval(() => void tick(), 2000)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [sampling, serial])

  useEffect(() => {
    if (!serial) return
    void (async () => {
      const keys = OVERRIDES.map((o) => `${o.namespace}/${o.key}`)
      const res = await win.device.settingsGet(serial, 'system', 'font_scale').catch(() => null)
      const next: Record<string, string> = {}
      if (res) next['system/font_scale'] = res.stdout.trim()
      setOverrides(next)
      void keys
      const ui = await win.ui.find(serial, {}).catch(() => [])
      const focused = ui.find((n) => n.package)
      if (focused) setCurrentPkg(focused.package)
    })()
  }, [serial])

  const setOverride = async (o: (typeof OVERRIDES)[number], on: boolean) => {
    if (!serial) return
    const value = on ? o.on : o.off
    const res = await win.device.settingsPut(serial, o.namespace, o.key, value)
    setOverrides((prev) => ({ ...prev, [`${o.namespace}/${o.key}`]: value }))
    showToast(res.ok ? 'success' : 'error', `${o.label} ${on ? 'on' : 'off'}`, res.ok ? value : res.stderr
      )
  }

  const loadCrashes = async () => {
    if (!serial) return
    const res = await win.device.dumpsys(serial, 'dropbox').catch(() => null)
    const list: Array<{ app: string; snippet: string; at: number }> = []
    if (res?.stdout) {
      const blocks = res.stdout.split(/(?=DropBox entry|^=====)/m).filter((b) => /FATAL EXCEPTION|data_app_crash/.test(b))
      for (const b of blocks.slice(-20)) {
        const app = b.match(/package_name="?([\w.]+)"?/) ?? b.match(/process="?([\w.]+)"?/)
        const exc = b.match(/(\w+(?:\.\w+)*(?:Exception|Error))[^\n]*/)
        list.push({ app: app?.[1] ?? 'unknown', snippet: exc?.[0] ?? b.slice(0, 120), at: Date.now() })
      }
    }
    const live = await win.device.dumpsys(serial, 'activity').catch(() => null)
    void live
    setCrashes(list.length > 0 ? list : [])
    if (list.length === 0) showToast('info', 'No crashes in dropbox', 'Recent crash/ANR entries appear here')
  }

  const applyAppops = async (op: string, mode: 'allow' | 'deny' | 'default') => {
    if (!serial || !appopsPkg.trim()) {
      showToast('error', 'Package required', 'Enter a package name')
      return
    }
    const res = await win.apps.appops(serial, appopsPkg.trim(), op, mode)
    showToast(res.ok ? 'success' : 'error', `appops ${mode}`, res.ok ? op : res.stderr)
  }

  const applyLocale = async () => {
    if (!serial || !locale.trim()) return
    const res = await win.device.settingsPut(serial, 'system', 'system_locales', locale.trim())
    showToast(res.ok ? 'success' : 'error', 'Locale set', res.ok ? `${locale.trim()} — reboot the device to apply` : res.stderr)
  }

  return (
    <>
      <Card
        title="Performance"
        right={
          <Button size="sm" variant={sampling ? 'danger' : 'default'} onClick={() => setSampling((v) => !v)} disabled={!serial}>
            {sampling ? 'Stop sampling' : 'Start sampling'}
          </Button>
        }
      >
        {samples.length < 2 ? (
          <div className="text-[12px] text-dim">
            {serial ? 'Start sampling to plot CPU and memory pressure (2 s interval).' : 'Connect a device to sample performance.'}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Spark data={samples.map((s) => s.cpu)} max={100} color="var(--accent)" label="CPU %" />
            <Spark data={samples.map((s) => s.mem)} max={100} color="var(--warn)" label="Memory %" />
          </div>
        )}
      </Card>

      <Card title="Crash & ANR triage" right={<Button size="sm" variant="ghost" onClick={() => void loadCrashes()} disabled={!serial}>Scan dropbox</Button>}>
        {crashes.length === 0 ? (
          <div className="text-[12px] text-dim">Scan the device dropbox for fatal exceptions and ANR entries, grouped by app.</div>
        ) : (
          <div className="max-h-48 overflow-y-auto space-y-1">
            {crashes.map((c, i) => (
              <div key={i} className="rounded border border-line bg-panel2 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <Badge tone="err">crash</Badge>
                  <span className="font-mono text-[12px]">{c.app}</span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-dim">{c.snippet}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Layout & locale overrides" right={<span className="text-[11px] text-dim">settings put</span>}>
        <div className="space-y-1">
          {OVERRIDES.map((o) => {
            const value = overrides[`${o.namespace}/${o.key}`] ?? ''
            const on = value === o.on
            return (
              <div key={`${o.namespace}/${o.key}`} className="flex items-center gap-3 border-b border-line py-1.5 last:border-0">
                <input type="checkbox" checked={on} onChange={(e) => void setOverride(o, e.target.checked)} disabled={!serial} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{o.label}</div>
                  <div className="truncate text-[11px] text-dim" title={o.hint}>
                    {o.hint}
                  </div>
                </div>
                <span className="font-mono text-[10px] text-dim">{value || '—'}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Field label="Locales" hint="e.g. ar-EG (RTL) or fr-FR — needs a reboot; combine with Force RTL for quick checks">
            <input
              className="w-40 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              placeholder="en-US"
            />
          </Field>
          <Button size="sm" onClick={() => void applyLocale()} disabled={!serial || !locale.trim()}>
            Set locale
          </Button>
        </div>
      </Card>

      <Card title="App-ops control" right={<span className="text-[11px] text-dim">appops set</span>}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            className="min-w-[200px] flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]"
            value={appopsPkg}
            onChange={(e) => setAppopsPkg(e.target.value)}
            placeholder={currentPkg || 'com.example.app'}
          />
          <Button size="sm" variant="ghost" onClick={() => setAppopsPkg(currentPkg)} disabled={!currentPkg}>
            Use foreground
          </Button>
        </div>
        <div className="max-h-40 overflow-y-auto space-y-1">
          {COMMON_APPOPS.map((o) => (
            <div key={o.op} className="flex flex-wrap items-center gap-2 rounded border border-line bg-panel2 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px]" title={o.op}>
                {o.label}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void applyAppops(o.op, 'allow')} disabled={!serial}>
                allow
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void applyAppops(o.op, 'deny')} disabled={!serial}>
                deny
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void applyAppops(o.op, 'default')} disabled={!serial}>
                default
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}