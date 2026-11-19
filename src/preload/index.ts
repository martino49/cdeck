import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  CommandResult,
  DeviceInfo,
  LastWireless,
  MdnsService,
  NetworkInfo,
  PingResult,
  ReverseResult,
  ScrcpyProfile,
  ScrcpySession,
  Settings,
  ToolInfo,
  UpdateInfo,
  WatchdogState,
  WirelessSetupResult
} from '@shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  tools: {
    status: (): Promise<ToolInfo[]> => invoke('tools:status'),
    installScrcpy: (): Promise<{ ok: boolean; error?: string }> => invoke('tools:installScrcpy'),
    installPlatformTools: (): Promise<{ ok: boolean; error?: string }> => invoke('tools:installPlatformTools'),
    clearCache: (): Promise<{ ok: boolean; error?: string }> => invoke('tools:clearCache')
  },
  adb: {
    devices: (): Promise<DeviceInfo[]> => invoke('adb:devices'),
    mdns: (): Promise<MdnsService[]> => invoke('adb:mdns'),
    pair: (target: string, code: string): Promise<CommandResult> => invoke('adb:pair', target, code),
    connect: (target: string): Promise<CommandResult> => invoke('adb:connect', target),
    disconnect: (serial: string): Promise<CommandResult> => invoke('adb:disconnect', serial),
    tcpip: (port: number): Promise<CommandResult> => invoke('adb:tcpip', port),
    netInfo: (serial?: string | null): Promise<NetworkInfo> => invoke('adb:netInfo', serial ?? null),
    ping: (ip: string): Promise<PingResult> => invoke('adb:ping', ip),
    wirelessSetup: (serial: string, port?: number): Promise<WirelessSetupResult> => invoke('adb:wirelessSetup', serial, port ?? 5555),
    lastWireless: (): Promise<LastWireless | null> => invoke('adb:lastWireless'),
    rediscoverWireless: (deviceSerial?: string | null): Promise<{ ok: boolean; target: string | null; detail: string }> =>
      invoke('adb:rediscoverWireless', deviceSerial ?? null),
    reverseList: (serial: string): Promise<string[]> => invoke('adb:reverseList', serial),
    ensureReverse: (serial: string, ports: number[]): Promise<ReverseResult[]> => invoke('adb:ensureReverse', serial, ports),
    removeReverse: (serial: string, port: number): Promise<CommandResult> => invoke('adb:removeReverse', serial, port),
    shell: (serial: string, command: string): Promise<CommandResult> => invoke('adb:shell', serial, command),
    uninstall: (serial: string, pkg: string): Promise<CommandResult> => invoke('adb:uninstall', serial, pkg),
    installApk: (serial: string): Promise<CommandResult> => invoke('adb:installApk', serial)
  },
  device: {
    viewport: (serial: string): Promise<{ size: string; density: string }> => invoke('device:viewport', serial),
    setViewport: (
      serial: string,
      opts: { width?: number; height?: number; dpi?: number }
    ): Promise<{ ok: boolean; errors: string[] }> => invoke('device:setViewport', serial, opts.width ?? null, opts.height ?? null, opts.dpi ?? null),
    resetViewport: (serial: string): Promise<CommandResult> => invoke('device:resetViewport', serial),
    info: (serial: string): Promise<DeviceInfoResult> => invoke('device:info', serial),
    settingsGet: (serial: string, namespace: string, key: string): Promise<CommandResult> =>
      invoke('device:settingsGet', serial, namespace, key),
    settingsPut: (serial: string, namespace: string, key: string, value: string): Promise<CommandResult> =>
      invoke('device:settingsPut', serial, namespace, key, value),
    battery: (serial: string, op: 'get' | 'level15' | 'level5' | 'ac' | 'unplug' | 'reset'): Promise<CommandResult> =>
      invoke('device:battery', serial, op),
    screenshot: (serial: string): Promise<{ ok: boolean; file?: string; error?: string }> => invoke('device:captureScreenshot', serial),
    record: (serial: string, seconds: number): Promise<{ ok: boolean; file?: string; error?: string }> =>
      invoke('device:captureRecord', serial, seconds),
    reboot: (serial: string, mode: 'device' | 'recovery' | 'bootloader' | 'fastboot'): Promise<CommandResult> =>
      invoke('device:reboot', serial, mode),
    restartAdb: (): Promise<CommandResult> => invoke('device:restartAdb'),
    screenPower: (serial: string): Promise<CommandResult> => invoke('device:screenPower', serial),
    uptime: (serial: string): Promise<string | null> => invoke('device:uptime', serial),
    bugreport: (serial: string): Promise<{ ok: boolean; file?: string; error?: string }> => invoke('device:bugreport', serial),
    dumpsys: (serial: string, service: string): Promise<CommandResult> => invoke('device:dumpsys', serial, service),
    dumpsysServices: (serial: string): Promise<string[]> => invoke('device:dumpsysServices', serial),
    perf: (serial: string): Promise<{ cpu: string; mem: string }> => invoke('device:perf', serial),
    netToggle: (serial: string, target: 'wifi' | 'data' | 'airplane', on: boolean): Promise<CommandResult> =>
      invoke('device:netToggle', serial, target, on)
  },
  apps: {
    list: (serial: string, thirdPartyOnly?: boolean): Promise<{ ok: boolean; packages: string[] }> =>
      invoke('apps:list', serial, thirdPartyOnly),
    launchable: (serial: string): Promise<string[]> => invoke('apps:launchable', serial),
    pid: (serial: string, pkg: string): Promise<string | null> => invoke('apps:pid', serial, pkg),
    info: (serial: string, pkg: string): Promise<{ version: string; targetSdk: string; minSdk: string; permissions: string[] }> =>
      invoke('apps:info', serial, pkg),
    grant: (serial: string, pkg: string, permission: string): Promise<CommandResult> => invoke('apps:grant', serial, pkg, permission),
    revoke: (serial: string, pkg: string, permission: string): Promise<CommandResult> => invoke('apps:revoke', serial, pkg, permission),
    appops: (serial: string, pkg: string, op: string, mode: string): Promise<CommandResult> => invoke('apps:appops', serial, pkg, op, mode),
    start: (serial: string, pkg: string): Promise<CommandResult> => invoke('apps:start', serial, pkg),
    stop: (serial: string, pkg: string): Promise<CommandResult> => invoke('apps:stop', serial, pkg),
    clear: (serial: string, pkg: string): Promise<CommandResult> => invoke('apps:clear', serial, pkg),
    path: (serial: string, pkg: string): Promise<CommandResult> => invoke('apps:path', serial, pkg),
    deeplink: (serial: string, uri: string, pkg?: string | null): Promise<CommandResult> =>
      invoke('apps:deeplink', serial, uri, pkg ?? null)
  },
  scrcpy: {
    profiles: (): Promise<ScrcpyProfile[]> => invoke('scrcpy:profiles'),
    launch: (serial: string, profileId: string): Promise<{ ok: boolean; session?: ScrcpySession; error?: string }> =>
      invoke('scrcpy:launch', serial, profileId),
    stop: (pid: number): Promise<boolean> => invoke('scrcpy:stop', pid),
    sessions: (): Promise<ScrcpySession[]> => invoke('scrcpy:sessions')
  },
  mirror: {
    start: (
      serial: string,
      opts?: { maxSize?: number; maxFps?: number; videoBitRate?: number; turnScreenOff?: boolean; stayAwake?: boolean; forward?: boolean }
    ): Promise<{ ok: boolean; error?: string }> => invoke('mirror:start', serial, opts ?? {}),
    stop: (): Promise<void> => invoke('mirror:stop'),
    stats: (): Promise<{ serial: string; width: number; height: number; startedAt: number } | null> => invoke('mirror:stats')
  },
  watchdog: {
    state: (): Promise<WatchdogState> => invoke('watchdog:state'),
    start: (): Promise<void> => invoke('watchdog:start'),
    stop: (): Promise<void> => invoke('watchdog:stop'),
    once: (): Promise<WatchdogState> => invoke('watchdog:once')
  },
  settings: {
    get: (): Promise<Settings> => invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => invoke('settings:set', patch)
  },
  logcat: {
    openWindow: (serial: string): Promise<void> => invoke('logcat:openWindow', serial),
    start: (serial: string): Promise<{ id: string; error?: string }> => invoke('logcat:start', serial),
    startBuffers: (serial: string, buffers: string[]): Promise<{ id: string; error?: string }> =>
      invoke('logcat:startBuffers', serial, buffers),
    stop: (id: string): Promise<void> => invoke('logcat:stop', id)
  },
  net: {
    probe: (port: number): Promise<{ ok: boolean; detail: string }> => invoke('net:probe', port)
  },
  selftest: {
    run: (): Promise<{ code: number; path: string }> => invoke('selftest:run')
  },
  profiles: {
    get: (): Promise<Record<string, import('@shared/types').DeviceProfile>> => invoke('profiles:get'),
    set: (serial: string, patch: import('@shared/types').DeviceProfile): Promise<import('@shared/types').DeviceProfile> =>
      invoke('profiles:set', serial, patch)
  },
  groups: {
    list: (): Promise<import('@shared/types').DeviceGroup[]> => invoke('groups:list'),
    save: (groups: import('@shared/types').DeviceGroup[]): Promise<import('@shared/types').DeviceGroup[]> => invoke('groups:save', groups)
  },
  intents: {
    list: (): Promise<import('@shared/types').IntentEntry[]> => invoke('intents:list'),
    add: (uri: string, pkg?: string | null): Promise<import('@shared/types').IntentEntry[]> => invoke('intents:add', uri, pkg ?? null),
    clear: (): Promise<void> => invoke('intents:clear')
  },
  macros: {
    list: (): Promise<import('@shared/types').Macro[]> => invoke('macros:list'),
    save: (macro: import('@shared/types').Macro): Promise<import('@shared/types').Macro[]> => invoke('macros:save', macro),
    remove: (id: string): Promise<import('@shared/types').Macro[]> => invoke('macros:delete', id)
  },
  audit: {
    list: (): Promise<import('@shared/types').AuditEntry[]> => invoke('audit:list'),
    clear: (): Promise<void> => invoke('audit:clear'),
    record: (action: string, target: string, detail?: string): Promise<void> => invoke('audit:record', action, target, detail ?? null)
  },
  api: {
    info: (): Promise<{ enabled: boolean; port: number; url: string; running: boolean; clients: number; token: string }> => invoke('api:info')
  },
  paths: {
    forFile: (file: File): string | null => {
      try {
        return webUtils.getPathForFile(file) || null
      } catch {
        return null
      }
    }
  },
  files: {
    listDir: (serial: string, dir: string): Promise<{ ok: boolean; entries: import('@shared/types').FileEntryLike[]; error?: string }> =>
      invoke('files:listDir', serial, dir),
    pushViaDialog: (serial: string, remoteDir: string): Promise<{ ok: boolean; detail: string }> => invoke('files:push', serial, remoteDir),
    pushPaths: (serial: string, remoteDir: string, paths: string[]): Promise<{ ok: boolean; detail: string }> =>
      invoke('files:pushPaths', serial, remoteDir, paths),
    pullViaDialog: (serial: string, remotePath: string): Promise<{ ok: boolean; detail: string }> => invoke('files:pull', serial, remotePath),
    remove: (serial: string, remote: string): Promise<{ ok: boolean; detail: string }> => invoke('files:delete', serial, remote),
    rename: (serial: string, from: string, to: string): Promise<{ ok: boolean; detail: string }> => invoke('files:rename', serial, from, to),
    mkdir: (serial: string, dir: string): Promise<{ ok: boolean; detail: string }> => invoke('files:mkdir', serial, dir),
    bundle: (serial: string, withBugreport: boolean): Promise<{ ok: boolean; file?: string; error?: string }> =>
      invoke('files:bundle', serial, withBugreport),
    save: (name: string, contents: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      invoke('files:save', name, contents)
  },
  broadcast: {
    run: (
      action: 'screenshot' | 'reboot' | 'shell' | 'screenPower' | 'key' | 'launch' | 'install',
      payload: Record<string, unknown>
    ): Promise<Array<{ serial: string; ok: boolean; detail: string }>> => invoke('broadcast:run', action, payload),
    install: (serials: string[]): Promise<{ ok: boolean; detail: string; results: Array<{ serial: string; ok: boolean; detail: string }> }> =>
      invoke('broadcast:install', serials)
  },
  ui: {
    dump: (serial: string): Promise<import('@shared/types').UiNodeLike[]> => invoke('ui:dump', serial),
    find: (serial: string, query: Record<string, unknown>): Promise<import('@shared/types').UiNodeLike[]> => invoke('ui:find', serial, query)
  },
  automation: {
    run: (macroId: string, serial?: string | null): Promise<import('@shared/types').SuiteResult> => invoke('automation:run', macroId, serial ?? null),
    runSuite: (ids: string[] | null, serial?: string | null): Promise<import('@shared/types').SuiteResult[]> =>
      invoke('automation:runSuite', ids, serial ?? null),
    toMaestro: (macroId: string): Promise<string> => invoke('automation:toMaestro', macroId),
    fromMaestro: (text: string, name: string): Promise<import('@shared/types').Macro[]> => invoke('automation:fromMaestro', text, name),
    report: (results: import('@shared/types').SuiteResult[], format: 'html' | 'junit'): Promise<{ ok: boolean; path?: string }> =>
      invoke('automation:report', results, format)
  },
  logs: {
    path: (): Promise<string> => invoke('logs:path'),
    open: (): Promise<void> => invoke('logs:open'),
    read: (maxBytes?: number): Promise<{ ok: boolean; text: string; bytes: number }> => invoke('logs:read', maxBytes ?? null)
  },

  captures: {
    openFolder: (): Promise<void> => invoke('captures:openFolder')
  },
  update: {
    check: (): Promise<UpdateInfo> => invoke('update:check')
  },
  app: {
    openExternal: (url: string): Promise<void> => invoke('app:openExternal', url)
  }
}

export interface DeviceInfoResult {
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

function subscribe(channel: string, cb: (payload: never) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload as never)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const subscriptions = {
  onDevicesChanged: (cb: (devices: DeviceInfo[]) => void) => subscribe('devices:changed', cb),
  onAutomationStep: (cb: (r: { index: number; type: string; ok: boolean; detail: string; at: number }) => void) =>
    subscribe('automation:step', cb),
  onAutomationSuite: (cb: (r: import('@shared/types').SuiteResult) => void) => subscribe('automation:suite', cb),
  onMirrorPort: (cb: (port: MessagePort) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: MessageEvent) => cb(ev.ports[0])
    ipcRenderer.on('mirror:port', handler)
    return () => ipcRenderer.removeListener('mirror:port', handler)
  },
  onToolsProgress: (cb: (p: { tool: string; stage: string; receivedBytes: number; totalBytes: number; message?: string }) => void) =>
    subscribe('tools:progress', cb),
  onWatchdogState: (cb: (state: WatchdogState) => void) => subscribe('watchdog:state', cb),
  onWatchdogTunnels: (cb: (d: { results: ReverseResult[]; serial: string }) => void) => subscribe('watchdog:tunnels', cb),
  onLogcatBatch: (cb: (d: { serial: string; lines: string[] }) => void) => subscribe('logcat:batch', cb),
  onLogcatExit: (cb: (d: { serial: string; code: number | null }) => void) => subscribe('logcat:exit', cb),
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => subscribe('update:available', cb),
  onTrayAction: (cb: (d: { action: string }) => void) => subscribe('tray:action', cb)
}

export type cdeckApi = typeof api

contextBridge.exposeInMainWorld('cdeck', { ...api, ...subscriptions })
