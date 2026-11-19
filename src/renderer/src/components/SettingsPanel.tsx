import { useEffect, useState } from 'react'
import type { Settings, UpdateInfo } from '@shared/types'
import { Button, Card, Field, Switch } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

interface Props {
  settings: Settings | null
  patchSettings: (patch: Partial<Settings>) => Promise<void>
}

export function SettingsPanel({ settings, patchSettings }: Props) {
  const [adbPath, setAdbPath] = useState('')
  const [scrcpyPath, setScrcpyPath] = useState('')
  const [extra, setExtra] = useState('')
  const [interval, setInterval] = useState('')
  const [repo, setRepo] = useState('')
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    if (!settings) return
    setAdbPath(settings.customAdbPath ?? '')
    setScrcpyPath(settings.customScrcpyPath ?? '')
    setExtra(settings.scrcpyExtra.join(' '))
    setInterval(String(settings.watchdogIntervalSec))
    setRepo(settings.updateRepo ?? '')
  }, [settings])

  useEffect(() => win.onUpdateAvailable(setUpdate), [])

  if (!settings) return null

  const saveAdb = async () => patchSettings({ customAdbPath: adbPath.trim() || null })
  const saveScrcpy = async () => patchSettings({ customScrcpyPath: scrcpyPath.trim() || null })
  const saveExtra = async () => patchSettings({ scrcpyExtra: extra.split(/\s+/).map((s) => s.trim()).filter(Boolean) })
  const saveRepo = async () => patchSettings({ updateRepo: repo.trim() || null })

  const checkUpdate = async () => {
    setChecking(true)
    const info = await win.update.check()
    setChecking(false)
    setUpdate(info)
    if (!info.newer && !info.error) showToast('success', `You're on the latest (${info.current})`)
    if (info.error) showToast('error', 'Update check failed', info.error)
  }

  return (
    <>
    <Card title="Settings">
      <Field label="Custom adb path" hint="Leave empty to auto-detect (bundled → PATH).">
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]" value={adbPath} onChange={(e) => setAdbPath(e.target.value)} placeholder="auto-detect" />
          <Button size="sm" onClick={() => void saveAdb()}>Save</Button>
        </div>
      </Field>
      <Field label="Custom scrcpy path" hint="Leave empty to auto-detect.">
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]" value={scrcpyPath} onChange={(e) => setScrcpyPath(e.target.value)} placeholder="auto-detect" />
          <Button size="sm" onClick={() => void saveScrcpy()}>Save</Button>
        </div>
      </Field>
      <Field label="Extra scrcpy flags" hint="Appended to every launch, e.g. --max-fps=60 --no-audio">
        <div className="flex gap-2">
          <input className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="—" />
          <Button size="sm" onClick={() => void saveExtra()}>Save</Button>
        </div>
      </Field>

      <div className="mt-2 space-y-2 border-t border-line pt-3">
        <Switch checked={settings.watchdogEnabled} onChange={(v) => void patchSettings({ watchdogEnabled: v })} label="Watchdog (auto-reconnect + tunnels)" />
        <div className="flex items-center gap-2">
          <input
            className="w-14 rounded-md border border-line bg-panel2 px-2 py-1 font-mono"
            value={interval}
            onChange={(e) => setInterval(e.target.value.replace(/\D/g, ''))}
          />
          <span className="text-[12px] text-dim">seconds between checks (min 2)</span>
          <Button size="sm" onClick={() => { const n = Number(interval); if (n >= 2) void patchSettings({ watchdogIntervalSec: n }) }}>Save</Button>
        </div>
        <Switch checked={settings.autoMirror} onChange={(v) => void patchSettings({ autoMirror: v })} label="Auto-mirror on device connect" />
        <Switch checked={settings.minimizeToTray} onChange={(v) => void patchSettings({ minimizeToTray: v })} label="Close to tray instead of quitting" />
        <Switch checked={settings.shortcutsEnabled} onChange={(v) => void patchSettings({ shortcutsEnabled: v })} label="Keyboard shortcuts" />
      </div>

      <div className="mt-3 space-y-2 border-t border-line pt-3">
        <div className="text-[11px] uppercase tracking-wide text-dim">Updates</div>
        <Field label="GitHub repository" hint="owner/name where releases are published, e.g. gsync/cdeck">
          <div className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="not configured" />
            <Button size="sm" onClick={() => void saveRepo()}>Save</Button>
          </div>
        </Field>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void checkUpdate()} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
          {update?.newer && update.downloadUrl && (
            <Button size="sm" variant="primary" onClick={() => void win.app.openExternal(update.downloadUrl!)}>
              Download {update.version}
            </Button>
          )}
        </div>
        {update && !update.newer && !update.error && <div className="text-[11px] text-ok">Up to date ({update.current})</div>}
        {update?.error && <div className="text-[11px] text-err">{update.error}</div>}
        {update?.newer && <div className="text-[11px] text-warn">Version {update.version} available — published {update.publishedAt?.slice(0, 10)}</div>}
      </div>

      <div className="mt-3 flex gap-2 border-t border-line pt-3">
        <Button size="sm" variant="ghost" onClick={() => void win.logs.open()}>
          View logs
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void win.captures.openFolder()}>
          Captures folder
        </Button>
      </div>
    </Card>

    <Card title="Startup & appearance">
      <div className="space-y-1">
        <div className="flex items-center gap-3 border-b border-line py-1.5">
          <Switch checked={settings?.startOnLogin ?? false} onChange={(v) => void patchSettings({ startOnLogin: v })} label="Start on login" />
          <span className="flex-1 text-[11px] text-dim">Launch CDeck automatically when you sign in</span>
        </div>
        <div className="flex items-center gap-3 border-b border-line py-1.5">
          <Switch checked={settings?.launchMinimized ?? false} onChange={(v) => void patchSettings({ launchMinimized: v })} label="Start minimized to tray" />
          <span className="flex-1 text-[11px] text-dim">Keep the watchdog running without a window in the way</span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Theme" hint="Applies immediately">
          <select
            className="rounded-md border border-line bg-panel2 px-2 py-1.5 text-[12px]"
            value={settings?.theme ?? 'dark'}
            onChange={(e) => void patchSettings({ theme: e.target.value as Settings['theme'] })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Field>
        <Field label={`UI zoom (${Math.round((settings?.uiZoom ?? 1) * 100)}%)`} hint="0.75×–1.5×">
          <input
            type="range"
            min={0.75}
            max={1.5}
            step={0.05}
            value={settings?.uiZoom ?? 1}
            onChange={(e) => void patchSettings({ uiZoom: Number(e.target.value) })}
          />
        </Field>
        <Button size="sm" variant="ghost" onClick={() => void patchSettings({ onboarded: false })} title="Show the first-run wizard again">
          Re-run onboarding
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText('%APPDATA%\\CDeck\\cdeck.json').then(() => showToast('success', 'Path copied'))}>
          Copy settings path
        </Button>
        <span className="text-[11px] text-dim">Back up or move your setup by copying %APPDATA%\CDeck\cdeck.json</span>
      </div>
    </Card>

    <LocalApiCard settings={settings} patchSettings={patchSettings} />
    <AuditCard />
    </>
  )
}

function LocalApiCard({ settings, patchSettings }: { settings: Settings | null; patchSettings: (p: Partial<Settings>) => Promise<void> }) {
  const [info, setInfo] = useState<{ enabled: boolean; port: number; url: string; running: boolean; clients: number; token: string } | null>(null)
  useEffect(() => {
    void win.api.info().then(setInfo)
  }, [settings?.localApiEnabled, settings?.localApiPort])
  const config = info ? `URL: ${info.url}\nHeader: x-cdeck-token: ${info.token}\n\nGET  /status\nGET  /devices\nGET  /screenshot?serial=…\nGET  /events            (SSE state stream)\nPOST /wireless {"deviceSerial":"…"}\nPOST /pair {"target":"ip:port","code":"123456"}\nPOST /connect {"target":"ip:port"}\nPOST /intent {"serial":"…","uri":"https://…"}\nPOST /action {"action":"tap","serial":"…","x":100,"y":200}\nPOST /macro/run {"id":"…","serial":"…"}` : ''
  return (
    <Card title="Local API (companion app)" right={<span className="text-[11px] text-dim">{info?.running ? `live · ${info.clients} client(s)` : 'off'}</span>}>
      <div className="space-y-1">
        <div className="flex items-center gap-3 border-b border-line py-1.5">
          <Switch checked={settings?.localApiEnabled ?? false} onChange={(v) => void patchSettings({ localApiEnabled: v })} label="Enable localhost API" />
          <span className="flex-1 text-[11px] text-dim">127.0.0.1 only, token-protected. The phone companion app and other tools use this.</span>
        </div>
      </div>
      {settings?.localApiEnabled && (
        <>
          <div className="mt-3 flex items-end gap-2">
            <Field label="Port" hint="Loopback only">
              <input
                className="w-24 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]"
                defaultValue={settings.localApiPort}
                onBlur={(e) => void patchSettings({ localApiPort: Number(e.target.value) || 7799 })}
              />
            </Field>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!info) return
                void navigator.clipboard.writeText(`${info.url}/status?token=${info.token}`).then(() => showToast('success', 'Endpoint copied'))
              }}
            >
              Copy /status URL
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!info) return
                void navigator.clipboard.writeText(info.token).then(() => showToast('success', 'Token copied'))
              }}
            >
              Copy token
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(config).then(() => showToast('success', 'API reference copied'))}>
              Copy API reference
            </Button>
          </div>
          <pre className="mt-2 max-h-44 overflow-auto rounded-md border border-line bg-panel2 p-2 font-mono text-[10.5px] text-dim">{config}</pre>
        </>
      )}
    </Card>
  )
}

function AuditCard() {
  const [entries, setEntries] = useState<Array<{ at: number; action: string; target: string; detail?: string }>>([])
  const load = async () => setEntries(await win.audit.list())
  useEffect(() => {
    void load()
  }, [])
  return (
    <Card
      title="Action audit log"
      right={
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const text = entries.map((e) => `${new Date(e.at).toISOString()}  ${e.action}  ${e.target}  ${e.detail ?? ''}`).join('\n')
              void win.files.save('cdeck-audit.log', text).then((r) => r.ok && showToast('success', 'Audit exported', r.path))
            }}
            disabled={entries.length === 0}
          >
            Export
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void win.audit.clear().then(load)
            }}
            disabled={entries.length === 0}
          >
            Clear
          </Button>
        </div>
      }
    >
      {entries.length === 0 ? (
        <div className="text-[12px] text-dim">Every pairing, install, broadcast, shell and destructive action is recorded here (last 500).</div>
      ) : (
        <div className="max-h-44 overflow-y-auto font-mono text-[11px]">
          {entries.map((e, i) => (
            <div key={i} className="border-b border-line py-0.5 last:border-0">
              <span className="text-dim">{new Date(e.at).toLocaleString()}</span> <span className="text-accent">{e.action}</span>{' '}
              <span>{e.target}</span>
              {e.detail && <span className="text-dim"> — {e.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
