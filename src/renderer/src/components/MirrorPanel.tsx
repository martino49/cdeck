import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceInfo, ScrcpyProfile, ScrcpySession, Settings } from '@shared/types'
import { Button, Card, Empty, Switch } from './ui'
import { showToast } from '../lib/toast'
import { cn } from '../lib/utils'
import { EmbeddedMirror } from './EmbeddedMirror'

const win = window.cdeck

interface Props {
  activeDevice: DeviceInfo | null
  settings: Settings | null
  patchSettings: (patch: Partial<Settings>) => Promise<void>
  sessions: ScrcpySession[]
  refreshSessions: () => void
  launchSignal: number
}

export function MirrorPanel({ activeDevice, settings, patchSettings, sessions, refreshSessions, launchSignal }: Props) {
  const [profiles, setProfiles] = useState<ScrcpyProfile[]>([])
  const [message, setMessage] = useState('')
  const [recording, setRecording] = useState(false)
  const [embedded, setEmbedded] = useState(false)
  const [autoPicked, setAutoPicked] = useState<string | null>(null)
  const autoRef = useRef<string | null>(null)

  useEffect(() => {
    void win.scrcpy.profiles().then(setProfiles)
  }, [])

  useEffect(() => {
    if (!activeDevice || profiles.length === 0) return
    if (autoRef.current === activeDevice.serial) return
    autoRef.current = activeDevice.serial
    const pick = activeDevice.transport === 'tcpip' ? 'wireless' : 'daily'
    setAutoPicked(profiles.some((p) => p.id === pick) ? pick : null)
    void patchSettings({ scrcpyProfile: pick })
  }, [activeDevice, profiles, patchSettings])

  useEffect(() => {
    if (launchSignal > 0 && activeDevice) {
      void launch(settings?.scrcpyProfile ?? profiles[0]?.id ?? 'daily')
    }
  }, [launchSignal])

  const ready = activeDevice?.state === 'device'
  const currentProfile = profiles.find((p) => p.id === settings?.scrcpyProfile) ?? profiles[0]

  const embeddedOpts = useMemo((): { maxSize?: number; maxFps?: number; videoBitRate?: number; turnScreenOff?: boolean; stayAwake?: boolean } => {
    const args = currentProfile?.args ?? []
    const opts: { maxSize?: number; maxFps?: number; videoBitRate?: number; turnScreenOff?: boolean; stayAwake?: boolean } = {}
    for (const a of args) {
      const m1 = a.match(/^-m(\d+)$/)
      if (m1) opts.maxSize = Number(m1[1])
      const m2 = a.match(/^-b([\d.]+)([MK])$/)
      if (m2) opts.videoBitRate = Number(m2[1]) * (m2[2] === 'M' ? 1000000 : 1000)
      const m3 = a.match(/^--max-fps=(\d+)$/)
      if (m3) opts.maxFps = Number(m3[1])
    }
    if (args.includes('--turn-screen-off')) opts.turnScreenOff = true
    if (args.includes('--stay-awake')) opts.stayAwake = true
    return opts
  }, [currentProfile])

  async function launch(profileId: string) {
    if (!activeDevice) return
    const res = await win.scrcpy.launch(activeDevice.serial, profileId)
    if (res.ok && res.session) {
      setMessage(`mirroring ${activeDevice.serial} (pid ${res.session.pid})`)
      refreshSessions()
    } else {
      setMessage(res.error ?? 'launch failed')
      showToast('error', 'Mirror failed', res.error)
    }
  }

  const installApk = async () => {
    if (!activeDevice) return
    const res = await win.adb.installApk(activeDevice.serial)
    setMessage(`install: ${(res.stdout || res.stderr).trim() || (res.ok ? 'OK' : 'failed')}`)
  }

  const openLogcat = async () => {
    if (!activeDevice) return
    await win.logcat.openWindow(activeDevice.serial)
  }

  const screenshot = async () => {
    if (!activeDevice) return
    const res = await win.device.screenshot(activeDevice.serial)
    if (res.ok) {
      setMessage(`screenshot → ${res.file}`)
      showToast('success', 'Screenshot captured', res.file)
      await win.captures.openFolder()
    } else {
      showToast('error', 'Screenshot failed', res.error)
    }
  }

  const record = async (seconds: number) => {
    if (!activeDevice) return
    setRecording(true)
    setMessage(`recording ${seconds}s…`)
    const res = await win.device.record(activeDevice.serial, seconds)
    setRecording(false)
    if (res.ok) {
      setMessage(`recording → ${res.file}`)
      showToast('success', 'Recording captured', res.file)
      await win.captures.openFolder()
    } else {
      showToast('error', 'Recording failed', res.error)
    }
  }

  return (
    <Card
      title="Mirror"
      right={
        <span className="text-[11px] text-dim">
          {profiles.length === 0 ? 'scrcpy not installed — see Tools' : 'scrcpy ready-to-launch profiles'}
        </span>
      }
    >
      {ready && (
        <div className="mb-3 flex items-center gap-2">
          <Switch checked={embedded} onChange={setEmbedded} label="Embed in app (instead of a separate window)" />
        </div>
      )}
      {embedded && ready && <EmbeddedMirror serial={activeDevice.serial} opts={embeddedOpts} />}
      {profiles.length === 0 ? (
        <Empty title="scrcpy is not installed yet" hint="Install it from the Tools page, or add its path in Settings." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border border-line bg-panel2 px-2 py-1.5"
              value={settings?.scrcpyProfile ?? currentProfile?.id}
              onChange={(e) => {
                setAutoPicked(null)
                void patchSettings({ scrcpyProfile: e.target.value })
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {autoPicked && (
              <span className="text-[10px] uppercase tracking-wide text-accent" title="Selected automatically from the connection method">
                auto
              </span>
            )}
            <Button variant="primary" onClick={() => void launch(settings?.scrcpyProfile ?? currentProfile.id)} disabled={!ready}>
              Mirror device
            </Button>
            <Button onClick={() => void installApk()} disabled={!ready}>
              Install APK…
            </Button>
            <Button onClick={() => void openLogcat()} disabled={!ready}>
              Logcat
            </Button>
          </div>
          {currentProfile && (
            <button
              className="mt-1.5 rounded border border-line px-1.5 py-0.5 text-[11px] text-dim hover:border-accent hover:text-fg"
              title={`${currentProfile.description}\n\n$ scrcpy -s <serial> ${currentProfile.args.join(' ')}${settings && settings.scrcpyExtra.length > 0 ? ` ${settings.scrcpyExtra.join(' ')}` : ''}`}
            >
              What this profile does
            </button>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <span className="text-[11px] uppercase tracking-wide text-dim">Captures</span>
            <Button size="sm" onClick={() => void screenshot()} disabled={!ready}>
              Screenshot
            </Button>
            <Button size="sm" onClick={() => void record(15)} disabled={!ready || recording}>
              Record 15s
            </Button>
            <Button size="sm" onClick={() => void record(30)} disabled={!ready || recording}>
              Record 30s
            </Button>
            {recording && <span className="status-pulse text-[11px] text-warn">recording…</span>}
          </div>
        </>
      )}
      {message && <div className={cn('mt-2 font-mono text-[11px]', message.startsWith('mirroring') ? 'text-ok' : 'text-dim')}>{message}</div>}
      {sessions.length > 0 && (
        <table className="mt-2 w-full border-collapse text-[12px]">
          <tbody>
            {sessions.map((s) => (
              <tr key={s.pid} className="border-t border-line">
                <td className="py-1.5">{s.profile}</td>
                <td className="py-1.5 font-mono text-[11px] text-dim">{s.serial}</td>
                <td className="py-1.5 font-mono text-[11px] text-dim">pid {s.pid}</td>
                <td className="py-1.5 text-right">
                  <Button size="sm" variant="danger" onClick={() => void win.scrcpy.stop(s.pid).then(refreshSessions)}>
                    Stop
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
