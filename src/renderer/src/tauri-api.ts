import { invoke } from '@tauri-apps/api/core'
import type { CommandResult, DeviceInfo, MdnsService } from '@shared/types'

// Tauri injects this into the webview at runtime; declared here because the
// @tauri-apps/api types do not expose it.
declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
// Tauri bridge for the CDeck renderer.
//
// Phase 1 of the Electron -> Tauri port: the React UI keeps calling
// `window.cdeck.*` exactly as before, but the calls now go through Tauri
// `invoke` instead of Electron IPC. The `adb` and `tools` sections are live
// in Rust (src-tauri/src/adb.rs). Sections that have not been ported yet
// return safe empty values so the interface still renders; they are replaced
// module by module.

const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> => {
  // Wait for Tauri internals to be injected into the window
  for (let i = 0; i < 100; i++) {
    if (window.__TAURI_INTERNALS__) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!window.__TAURI_INTERNALS__) {
    console.error(`[tauri] __TAURI_INTERNALS__ not available for "${cmd}"`)
    return undefined
  }
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    console.error(`[tauri] invoke "${cmd}" failed:`, e)
    return undefined
  }
}

const STUB = 'not ported to Tauri yet'

const notOk = (why: string): CommandResult => ({
  ok: false,
  stdout: '',
  stderr: why,
  code: null
})

const noop = (): void => undefined
const unsubscribed = (_cb?: any): (() => void) => () => undefined

export type ToolInfo = {
  name: 'adb' | 'scrcpy' | 'platform-tools'
  present: boolean
  version: string | null
  path: string | null
  source: string
}

const adbApi = {
  devices: async (): Promise<DeviceInfo[]> => (await call<DeviceInfo[]>('adb_devices')) ?? [],
  mdns: async (): Promise<MdnsService[]> => (await call<MdnsService[]>('adb_mdns')) ?? [],
  pair: async (target: string, code: string): Promise<CommandResult> =>
    (await call<CommandResult>('adb_pair', { target, code })) ?? notOk(STUB),
  connect: async (target: string): Promise<CommandResult> =>
    (await call<CommandResult>('adb_connect', { target })) ?? notOk(STUB),
  disconnect: async (serial: string): Promise<CommandResult> =>
    (await call<CommandResult>('adb_disconnect', { serial })) ?? notOk(STUB),
  tcpip: (_port?: number): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  netInfo: (): Promise<{ phoneIp: string | null; phoneSsid: string | null; wifiEnabled: boolean | null; wifiConnected: boolean | null }> =>
    Promise.resolve({ phoneIp: null, phoneSsid: null, wifiEnabled: null, wifiConnected: null }),
  ping: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  wirelessSetup: (): Promise<{ ok: boolean; target: string | null; detail: string }> =>
    Promise.resolve({ ok: false, target: null, detail: STUB }),
  lastWireless: (): Promise<{ serial: string; ip: string; port: number; deviceSerial?: string | null } | null> =>
    Promise.resolve(null),
  rediscoverWireless: (): Promise<{ ok: boolean; target: string | null; detail: string }> =>
    Promise.resolve({ ok: false, target: null, detail: STUB }),
  reverseList: async (serial: string): Promise<string[]> => (await call<string[]>('adb_reverse_list', { serial })) ?? [],
  ensureReverse: async (serial: string, ports: number[]): Promise<Array<{ serial: string; port: number; ok: boolean; detail: string }>> =>
    (await call<Array<{ serial: string; port: number; ok: boolean; detail: string }>>('adb_ensure_reverse', { serial, ports })) ?? [],
  removeReverse: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  shell: async (serial: string, command: string): Promise<CommandResult> =>
    (await call<CommandResult>('adb_shell', { serial, command })) ?? notOk(STUB),
  uninstall: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  installApk: (): Promise<CommandResult> => Promise.resolve(notOk(STUB))
}

const toolsApi = {
  status: async (): Promise<ToolInfo[]> => {
    try {
      const [adb, scrcpy, adbVer, scrcpyVer] = await Promise.all([
        call<{ found: boolean; path: string | null; source: string }>('adb_locate'),
        call<{ found: boolean; path: string | null; source: string }>('scrcpy_locate'),
        call<string | null>('adb_version'),
        call<string | null>('scrcpy_version'),
      ])
      return [
        { name: 'adb', present: adb?.found ?? false, version: adbVer ?? null, path: adb?.path ?? null, source: adb?.source ?? 'not found' },
        { name: 'scrcpy', present: scrcpy?.found ?? false, version: scrcpyVer ?? null, path: scrcpy?.path ?? null, source: scrcpy?.source ?? 'not found' },
        { name: 'platform-tools', present: adb?.found ?? false, version: adbVer ?? null, path: adb?.path ?? null, source: adb?.source ?? 'not found' }
      ]
    } catch {
      return [{ name: 'adb', present: false, version: null, path: null, source: 'error' }, { name: 'scrcpy', present: false, version: null, path: null, source: 'error' }, { name: 'platform-tools', present: false, version: null, path: null, source: 'error' }]
    }
  },
  installScrcpy: (): Promise<{ ok: boolean; error?: string }> =>
    Promise.resolve({ ok: false, error: 'not ported to Tauri yet' }),
  installPlatformTools: (): Promise<{ ok: boolean; error?: string }> =>
    Promise.resolve({ ok: false, error: 'not ported to Tauri yet' }),
  clearCache: (): Promise<{ ok: boolean; error?: string }> =>
    Promise.resolve({ ok: false, error: 'not ported to Tauri yet' })
}

const settingsApi = {
  get: () =>
    Promise.resolve({
      deviceSerial: null,
      tunnels: [] as number[],
      scrcpyProfile: 'daily',
      scrcpyExtra: [] as string[],
      watchdogEnabled: false,
      watchdogIntervalSec: 30,
      customAdbPath: null,
      customScrcpyPath: null,
      updateRepo: null,
      minimizeToTray: true,
      autoMirror: false,
      shortcutsEnabled: true,
      startOnLogin: false,
      launchMinimized: false,
      theme: 'system',
      uiZoom: 1,
      localApiEnabled: false,
      localApiPort: 3210,
      onboarded: true
    }),
  set: (patch: Record<string, unknown>) =>
    Promise.resolve({ ...patch })
}

const deviceApi = {
  viewport: (): Promise<{ size: string; density: string }> => Promise.resolve({ size: '', density: '' }),
  setViewport: (): Promise<{ ok: boolean; errors: string[] }> => Promise.resolve({ ok: false, errors: [STUB] }),
  resetViewport: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  info: (): Promise<Record<string, unknown>> => Promise.resolve({}),
  settingsGet: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  settingsPut: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  battery: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  screenshot: (): Promise<{ ok: boolean; file?: string; error?: string }> =>
    Promise.resolve({ ok: false, error: STUB }),
  record: (): Promise<{ ok: boolean; file?: string; error?: string }> =>
    Promise.resolve({ ok: false, error: STUB }),
  reboot: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  restartAdb: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  screenPower: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  uptime: (): Promise<string | null> => Promise.resolve(null),
  bugreport: (): Promise<{ ok: boolean; file?: string; error?: string }> =>
    Promise.resolve({ ok: false, error: STUB }),
  dumpsys: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  dumpsysServices: (): Promise<string[]> => Promise.resolve([]),
  perf: (): Promise<{ cpu: string; mem: string }> => Promise.resolve({ cpu: '', mem: '' }),
  netToggle: (): Promise<CommandResult> => Promise.resolve(notOk(STUB))
}

const appsApi = {
  list: (): Promise<{ ok: boolean; packages: string[] }> => Promise.resolve({ ok: false, packages: [] }),
  launchable: (): Promise<string[]> => Promise.resolve([]),
  pid: (): Promise<string | null> => Promise.resolve(null),
  info: (): Promise<{ version: string; targetSdk: string; minSdk: string; permissions: string[] }> =>
    Promise.resolve({ version: '', targetSdk: '', minSdk: '', permissions: [] }),
  grant: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  revoke: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  appops: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  start: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  stop: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  clear: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  path: (): Promise<CommandResult> => Promise.resolve(notOk(STUB)),
  deeplink: (): Promise<CommandResult> => Promise.resolve(notOk(STUB))
}

const scrcpyApi = {
  profiles: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  launch: (): Promise<{ ok: boolean; error?: string }> => Promise.resolve({ ok: false, error: STUB }),
  stop: (): Promise<boolean> => Promise.resolve(false),
  sessions: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([])
}

const mirrorApi = {
  start: (): Promise<{ ok: boolean; error?: string }> => Promise.resolve({ ok: false, error: STUB }),
  stop: (): Promise<void> => Promise.resolve(),
  stats: (): Promise<null> => Promise.resolve(null)
}

const watchdogApi = {
  state: (): Promise<Record<string, unknown>> =>
    Promise.resolve({ enabled: false, lastCheck: null, consecutiveFailures: 0, lastAction: null, connectedAt: null, lastTarget: null, devices: 0 }),
  start: (): Promise<void> => Promise.resolve(),
  stop: (): Promise<void> => Promise.resolve(),
  once: (): Promise<Record<string, unknown>> => Promise.resolve({ enabled: false })
}

const logcatApi = {
  openWindow: (serial: string): Promise<void> => {
    noop()
    return Promise.resolve()
  },
  start: (): Promise<{ id: string; error?: string }> => Promise.resolve({ id: '', error: STUB }),
  startBuffers: (): Promise<{ id: string; error?: string }> => Promise.resolve({ id: '', error: STUB }),
  stop: (): Promise<void> => Promise.resolve()
}

const netApi = {
  probe: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB })
}

const selftestApi = {
  run: async (): Promise<{ code: number; path: string; summary: string }> => {
    const r = await call<{ code: number; path: string; summary: string }>('run_selftest')
    if (!r) { return { code: 1, path: '', summary: 'self-test unavailable' } }
    return { code: r.code, path: r.path, summary: r.summary }
  }
}

const profilesApi = {
  get: (): Promise<Record<string, unknown>> => Promise.resolve({}),
  set: (serial: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> =>
    Promise.resolve({ serial, ...patch })
}

const groupsApi = {
  list: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  save: (groups: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> => Promise.resolve(groups)
}

const intentsApi = {
  list: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  add: (uri: string): Promise<Array<Record<string, unknown>>> => Promise.resolve([{ uri }]),
  clear: (): Promise<void> => Promise.resolve()
}

const macrosApi = {
  list: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  save: (macro: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => Promise.resolve([macro]),
  remove: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([])
}

const auditApi = {
  list: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  clear: (): Promise<void> => Promise.resolve(),
  record: (): Promise<void> => Promise.resolve()
}

const apiApi = {
  info: (): Promise<{ enabled: boolean; port: number; url: string; running: boolean; clients: number; token: string }> =>
    Promise.resolve({ enabled: false, port: 0, url: '', running: false, clients: 0, token: '' })
}

const pathsApi = {
  forFile: (_file: File): string | null => null
}

const filesApi = {
  listDir: (): Promise<{ ok: boolean; entries: Array<Record<string, unknown>>; error?: string }> =>
    Promise.resolve({ ok: false, entries: [], error: STUB }),
  pushViaDialog: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  pushPaths: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  pullViaDialog: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  remove: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  rename: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  mkdir: (): Promise<{ ok: boolean; detail: string }> => Promise.resolve({ ok: false, detail: STUB }),
  bundle: (): Promise<{ ok: boolean; file?: string; error?: string }> =>
    Promise.resolve({ ok: false, error: STUB }),
  save: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    Promise.resolve({ ok: false, error: STUB })
}
const broadcastApi = {
  run: (): Promise<Array<{ serial: string; ok: boolean; detail: string }>> => Promise.resolve([]),
  install: (): Promise<{ ok: boolean; detail: string; results: Array<Record<string, unknown>> }> =>
    Promise.resolve({ ok: false, detail: STUB, results: [] })
}

const uiApi = {
  dump: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  find: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([])
}

const automationApi = {
  run: (): Promise<Record<string, unknown>> => Promise.resolve({ ok: false, steps: [], detail: STUB }),
  runSuite: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  toMaestro: (): Promise<string> => Promise.resolve(''),
  fromMaestro: (): Promise<Array<Record<string, unknown>>> => Promise.resolve([]),
  report: (): Promise<{ ok: boolean; path?: string }> => Promise.resolve({ ok: false })
}

const logsApi = {
  path: (): Promise<string> => Promise.resolve(''),
  open: (): Promise<void> => {
    noop()
    return Promise.resolve()
  },
  read: (): Promise<{ ok: boolean; text: string; bytes: number }> =>
    Promise.resolve({ ok: true, text: '', bytes: 0 })
}

const capturesApi = {
  openFolder: (): Promise<void> => {
    noop()
    return Promise.resolve()
  }
}

const updateApi = {
  check: (): Promise<{ version: string; current: string; newer: boolean; size: number | null; downloadUrl: string | null; notes: string; publishedAt: string | null; error?: string }> =>
    Promise.resolve({
      version: '',
      current: '',
      newer: false,
      size: null,
      downloadUrl: null,
      notes: STUB,
      publishedAt: null,
      error: STUB
    })
}

const appApi = {
  openExternal: (url: string): Promise<void> => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return Promise.resolve()
  }
}

const devtoolsApi = {
  open: async (): Promise<void> => { await call<void>('open_devtools') },
  close: async (): Promise<void> => { await call<void>('close_devtools') },
  toggle: async (): Promise<boolean> => (await call<boolean>('toggle_devtools')) ?? false,
  isOpen: async (): Promise<boolean> => (await call<boolean>('is_devtools_open')) ?? false
}

// F12 / Ctrl+Shift+I opens devtools - standard browser-style shortcut
window.addEventListener('keydown', (e) => {
  if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i'))) {
    e.preventDefault()
    void devtoolsApi.toggle()
  }
})

export const subscriptions = {
  onDevicesChanged: unsubscribed,
  onAutomationStep: unsubscribed,
  onAutomationSuite: unsubscribed,
  onMirrorPort: unsubscribed,
  onToolsProgress: unsubscribed,
  onWatchdogState: unsubscribed,
  onWatchdogTunnels: unsubscribed,
  onLogcatBatch: unsubscribed,
  onLogcatExit: unsubscribed,
  onUpdateAvailable: unsubscribed,
  onTrayAction: unsubscribed
}

export const api = {
  tools: toolsApi,
  adb: adbApi,
  device: deviceApi,
  apps: appsApi,
  scrcpy: scrcpyApi,
  mirror: mirrorApi,
  watchdog: watchdogApi,
  settings: settingsApi,
  logcat: logcatApi,
  net: netApi,
  selftest: selftestApi,
  profiles: profilesApi,
  groups: groupsApi,
  intents: intentsApi,
  macros: macrosApi,
  audit: auditApi,
  api: apiApi,
  paths: pathsApi,
  files: filesApi,
  broadcast: broadcastApi,
  ui: uiApi,
  automation: automationApi,
  logs: logsApi,
  captures: capturesApi,
  update: updateApi,
  app: appApi,
  devtools: devtoolsApi,
  ...subscriptions
}

export const cdeckApi = api as unknown as Window['cdeck']

;(window as unknown as { cdeck: Window['cdeck'] }).cdeck = cdeckApi
