import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DeviceInfo, ReverseResult, ScrcpySession, Settings, ToolInfo, WatchdogState } from '@shared/types'
import { ToolsPanel } from './components/ToolsPanel'
import { DeviceSection } from './components/DeviceSection'
import { MirrorPanel } from './components/MirrorPanel'
import { RadioPanel, TunnelPanel } from './components/TunnelPanel'
import { WatchdogPanel } from './components/WatchdogPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { DevicePanel } from './components/DevicePanel'
import { AppsPanel } from './components/AppsPanel'
import { CheatSheet } from './components/CheatSheet'
import { LogcatView } from './components/LogcatView'
import { AppLogs } from './components/AppLogs'
import { FilesPanel } from './components/FilesPanel'
import { AutomationPanel } from './components/AutomationPanel'
import { FleetPanel } from './components/FleetPanel'
import { DebugPanel } from './components/DebugPanel'
import { Sidebar, type PageId } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Badge, Button, Kbd, Modal } from './components/ui'
import { showToast } from './lib/toast'
import { tinykeys } from 'tinykeys'

const win = window.cdeck

export function App() {
  if (window.location.hash.startsWith('#/logcat')) return <LogcatView />

  const [page, setPage] = useState<PageId>(() => (localStorage.getItem('cdeck:page') as PageId) || 'home')
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('cdeck:nav') === '1')
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [watchdog, setWatchdog] = useState<WatchdogState | null>(null)
  const [tunnelResults, setTunnelResults] = useState<Record<number, ReverseResult>>({})
  const [sessions, setSessions] = useState<ScrcpySession[]>([])
  const [cheatOpen, setCheatOpen] = useState(false)
  const [traySignal, setTraySignal] = useState(0)
  const [sessionBusy, setSessionBusy] = useState(false)

  useEffect(() => localStorage.setItem('cdeck:page', page), [page])
  useEffect(() => localStorage.setItem('cdeck:nav', navCollapsed ? '1' : '0'), [navCollapsed])

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'dark'
  }, [settings?.theme])

  useEffect(() => {
    document.documentElement.style.fontSize = `${Math.round((settings?.uiZoom ?? 1) * 100)}%`
  }, [settings?.uiZoom])

  const refreshAll = useCallback(async () => {
    const [s, t, wd, ss] = await Promise.all([win.settings.get(), win.tools.status(), win.watchdog.state(), win.scrcpy.sessions()])
    setSettings(s)
    setTools(t)
    setWatchdog(wd)
    setSessions(ss)
  }, [])

  useEffect(() => {
    const offs: Array<() => void> = [
      win.onDevicesChanged(setDevices),
      win.onWatchdogState(setWatchdog),
      win.onWatchdogTunnels(({ results }) =>
        setTunnelResults((prev) => {
          const next = { ...prev }
          for (const r of results) next[r.port] = r
          return next
        })
      ),
      win.onTrayAction((d) => {
        if (d.action === 'mirror') {
          setPage('mirror')
          setTraySignal((n) => n + 1)
        }
        if (d.action === 'pair') {
          setPage('home')
          setTraySignal((n) => n + 1)
        }
      })
    ]
    void refreshAll()
    const timer = setInterval(() => {
      void win.tools.status().then(setTools)
      void win.scrcpy.sessions().then(setSessions)
      void win.watchdog.state().then(setWatchdog)
    }, 5000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
    }
  }, [refreshAll])

  useEffect(() => {
    if (devices.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !devices.some((d) => d.serial === selected)) {
      const first = devices.find((d) => d.state === 'device') ?? devices[0]
      setSelected(first.serial)
      void win.settings.set({ deviceSerial: first.serial })
    }
  }, [devices, selected])

  useEffect(() => {
    if (!settings?.shortcutsEnabled) return
    return tinykeys(window, {
      '?': (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        setCheatOpen((v) => !v)
      },
      escape: () => setCheatOpen(false),
      '$mod+m': (e: KeyboardEvent) => {
        e.preventDefault()
        setPage('mirror')
        setTraySignal((n) => n + 1)
      },
      '$mod+l': (e: KeyboardEvent) => {
        e.preventDefault()
        if (selected) void win.logcat.openWindow(selected)
      },
      '$mod+1': () => setPage('home'),
      '$mod+2': () => setPage('mirror'),
      '$mod+3': () => setPage('device'),
      '$mod+4': () => setPage('apps'),
      '$mod+5': () => setPage('logs'),
      f5: (e: KeyboardEvent) => {
        e.preventDefault()
        void refreshAll()
      }
    })
  }, [settings?.shortcutsEnabled, selected, refreshAll])

  const activeDevice = useMemo(() => devices.find((d) => d.serial === selected) ?? null, [devices, selected])

  const selectDevice = async (serial: string | null) => {
    setSelected(serial)
    await win.settings.set({ deviceSerial: serial })
    setSettings(await win.settings.get())
  }

  const patchSettings = async (patch: Partial<Settings>) => {
    setSettings(await win.settings.set(patch))
  }

  const startSession = async () => {
    if (!activeDevice || activeDevice.state !== 'device') return
    const serial = activeDevice.serial
    setSessionBusy(true)
    try {
      const results = await win.adb.ensureReverse(serial, settings?.tunnels ?? [])
      const mirror = await win.scrcpy.launch(serial, settings?.scrcpyProfile ?? 'daily')
      const tunnelsOk = results.filter((r) => r.ok).length
      if (mirror.ok) showToast('success', 'Session started', `mirror + ${tunnelsOk}/${results.length} tunnel(s)`)
      else showToast('error', 'Mirror failed', mirror.error ?? 'unknown error')
      setSessions(await win.scrcpy.sessions())
      setPage('mirror')
    } finally {
      setSessionBusy(false)
    }
  }

  const adb = tools.find((t) => t.name === 'adb')

  const formPage = (children: ReactNode) => (
    <div className="scroll-stable h-full overflow-y-auto p-4">
      <div className="fade-in mx-auto max-w-3xl space-y-3.5">{children}</div>
    </div>
  )

  const renderPage = () => {
    switch (page) {
      case 'home':
        return formPage(
          <>
            <DeviceSection devices={devices} selected={selected} activeDevice={activeDevice} onSelect={selectDevice} traySignal={traySignal} />
            <FleetPanel devices={devices} activeDevice={activeDevice} />
          </>
        )
      case 'mirror':
        return formPage(
          <MirrorPanel
            activeDevice={activeDevice}
            settings={settings}
            patchSettings={patchSettings}
            sessions={sessions}
            refreshSessions={() => void win.scrcpy.sessions().then(setSessions)}
            launchSignal={traySignal}
          />
        )
      case 'device':
        return formPage(
          <>
            <DevicePanel activeDevice={activeDevice} />
            <DebugPanel activeDevice={activeDevice} />
          </>
        )
      case 'apps':
        return formPage(<AppsPanel activeDevice={activeDevice} />)
      case 'logs':
        return (
          <div className="h-full p-3">
            <div className="h-full overflow-hidden rounded-lg border border-line bg-panel">
              <LogcatView serial={activeDevice?.serial} />
            </div>
          </div>
        )
      case 'files':
        return formPage(<FilesPanel activeDevice={activeDevice} />)
      case 'automate':
        return formPage(<AutomationPanel activeDevice={activeDevice} />)
      case 'applogs':
        return formPage(<AppLogs autoRefresh />)
      case 'network':
        return formPage(
          <>
            <TunnelPanel
              settings={settings}
              serial={activeDevice?.state === 'device' ? activeDevice.serial : null}
              results={tunnelResults}
              patchSettings={patchSettings}
            />
            <RadioPanel activeDevice={activeDevice} />
            <WatchdogPanel watchdog={watchdog} />
          </>
        )
      case 'tools':
        return formPage(<ToolsPanel tools={tools} refresh={() => void win.tools.status().then(setTools)} />)
      case 'settings':
        return formPage(<SettingsPanel settings={settings} patchSettings={patchSettings} />)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        devices={devices}
        activeDevice={activeDevice}
        onSelectDevice={(s) => void selectDevice(s)}
        onStartSession={() => void startSession()}
        onRefresh={() => void refreshAll()}
        busy={sessionBusy}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar page={page} onNavigate={setPage} collapsed={navCollapsed} onToggle={() => setNavCollapsed((v) => !v)} />
        <main className="min-w-0 flex-1 overflow-hidden">{renderPage()}</main>
      </div>
      <footer className="app-drag-none flex h-[26px] items-center gap-3 border-t border-line bg-panel px-3.5 text-xs text-dim">
        <span className="font-mono tabular-nums">adb {adb?.version ?? '—'}</span>
        <span className="max-w-[240px] truncate font-mono text-2xs" title={adb?.path ?? ''}>
          {adb?.path ?? 'not found'}
        </span>
        {watchdog && (
          <Badge tone={watchdog.running ? 'ok' : 'neutral'} pulse={watchdog.running}>
            watchdog {watchdog.running ? 'on' : 'off'}
          </Badge>
        )}
        <div className="flex-1" />
        {settings?.shortcutsEnabled && (
          <>
            <span className="flex items-center gap-1 text-2xs">
              <Kbd>Ctrl K</Kbd> search
            </span>
            <span className="flex items-center gap-1 text-2xs">
              <Kbd>?</Kbd> shortcuts
            </span>
            <span className="flex items-center gap-1 text-2xs">
              <Kbd>F5</Kbd> refresh
            </span>
          </>
        )}
        <span className="font-mono tabular-nums text-2xs">{Math.round((settings?.uiZoom ?? 1) * 100)}%</span>
      </footer>
      <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />
      <Onboarding
        open={settings !== null && !settings.onboarded}
        deviceCount={devices.length}
        tools={tools}
        onDone={() => void patchSettings({ onboarded: true })}
        onNavigate={setPage}
      />
    </div>
  )
}

function Onboarding({
  open,
  deviceCount,
  tools,
  onDone,
  onNavigate
}: {
  open: boolean
  deviceCount: number
  tools: ToolInfo[]
  onDone: () => void
  onNavigate: (p: PageId) => void
}) {
  if (!open) return null
  const adb = tools.find((t) => t.name === 'adb')
  const scrcpy = tools.find((t) => t.name === 'scrcpy')
  const step = deviceCount > 0 ? 3 : adb?.present && scrcpy?.present ? 2 : 1
  return (
    <Modal open={open} onClose={onDone} title="Welcome to CDeck">
      <div className="space-y-3 text-[13px]">
        <p className="text-dim">
          CDeck turns a real Android phone into your dev/test device — mirroring, tunnels, logs, automation and an MCP
          server for AI agents, all local.
        </p>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={adb?.present ? 'text-ok' : 'text-warn'}>{adb?.present ? '✔' : '•'}</span>
            <span>
              adb {adb?.present ? `ready (${adb.version})` : 'missing — Tools page can install platform-tools'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={scrcpy?.present ? 'text-ok' : 'text-warn'}>{scrcpy?.present ? '✔' : '•'}</span>
            <span>
              scrcpy {scrcpy?.present ? `ready (${scrcpy.version})` : 'missing — Tools page downloads it automatically'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={deviceCount > 0 ? 'text-ok' : 'text-warn'}>{deviceCount > 0 ? '✔' : '•'}</span>
            <span>
              {deviceCount > 0 ? `${deviceCount} device(s) connected` : 'Connect over USB (allow the prompt) or use 1-Click Wireless on Home'}
            </span>
          </div>
        </div>
        {step === 1 && (
          <Button variant="primary" onClick={() => onNavigate('tools')}>
            Open Tools
          </Button>
        )}
        {step === 2 && (
          <Button variant="primary" onClick={() => onNavigate('home')}>
            Go to Devices
          </Button>
        )}
        {step === 3 && (
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => onNavigate('mirror')}>
              Open Mirror
            </Button>
            <Button variant="ghost" onClick={() => onNavigate('automate')}>
              See Automation
            </Button>
          </div>
        )}
        <div className="flex justify-end border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onDone}>
            Don't show again
          </Button>
        </div>
      </div>
    </Modal>
  )
}