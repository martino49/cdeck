import path, { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
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
  WatchdogState,
  WirelessSetupResult,
  CommandResult
} from '@shared/types'
import * as adb from './adb'
import { clearToolCache, ensurePlatformTools, ensureScrcpy, migrateLegacyBin, toolStatuses, type ToolProgress } from './tools'
import { PROFILES, launchScrcpy, listSessions, stopAllScrcpy, stopScrcpy } from './scrcpy'
import * as mirror from './mirror'
import { startLocalApi, type LocalApi } from './api'
import { runMacro, runSuite, type AutomationEvents } from './automation'
import { bugBundle, deleteFile, listDir, makeDir, pullFile, pushFile, renameFile } from './files'
import { Watchdog } from './watchdog'
import { loadStore, recordAudit, saveStore, updateProfile } from './store'
import { killTrackedTree, trackedPids } from './process'
import log, { setupLogging, logFilePath } from './log'
import { createTray, destroyTray, updateTray } from './tray'
import { clearNotifyKey, notify, resetNotifyState } from './notify'
import { checkForUpdate } from './update'
import { attachStatePersistence, getWindowState, loadAllState } from './windows'
import { allowOrigin, GuardError, isPort, isSerial, isText, senderWebContents } from './ipc-guard'
import { runSelftest, selftestReportPath, selftestRequested } from './selftest'
import { parseRunnerArgs, runHeadlessSuite, runnerExitMessage } from './runner'

app.enableSandbox()
app.setAppUserModelId('dev.cdeck.app')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  void boot()
}

const windows = new Map<string, BrowserWindow>()
let mainWindow: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null
let pollIntervalMs = 4000
let previousDevices: DeviceInfo[] = []
let quitting = false
let localApi: LocalApi | null = null

async function restartLocalApi(): Promise<void> {
  const { settings, apiToken } = loadStore()
  if (localApi) {
    await localApi.close().catch(() => undefined)
    localApi = null
  }
  if (!settings.localApiEnabled) return
  try {
    localApi = await startLocalApi(settings.localApiPort, apiToken, {
      status: async () => ({
        version: app.getVersion(),
        devices: await adb.listDevices(),
        selected: loadStore().settings.deviceSerial,
        lastWireless: loadStore().lastWireless,
        mirror: mirror.mirrorStats(),
        platform: process.platform
      }),
      devices: () => adb.listDevices(),
      wireless: (deviceSerial) => adb.discoverWirelessTarget(deviceSerial).then(async (fresh) => {
        if (!fresh) return { ok: false, target: null, detail: 'no wireless-debugging service advertised' }
        const target = `${fresh.host}:${fresh.port}`
        const res = await adb.adbConnect(target)
        const state = await adb.adbGetState(target)
        return { ok: state === 'device', target, detail: (res.stdout || res.stderr).trim() }
      }),
      pair: async (target, code) => {
        const res = await adb.adbPair(target, code)
        recordAudit('pair', target, res.stdout || res.stderr)
        return { ok: res.ok, detail: (res.stdout || res.stderr).trim() }
      },
      connect: async (target) => {
        const res = await adb.adbConnect(target)
        recordAudit('connect', target, res.stdout || res.stderr)
        return { ok: res.ok, detail: (res.stdout || res.stderr).trim() }
      },
      screenshot: (serial) => adb.screencap(serial).then(async (r) => {
        if (!r.ok || !r.file) return { ok: false, error: r.error }
        const { readFileSync } = await import('node:fs')
        return { ok: true, data: readFileSync(r.file) }
      }),
      intent: async (serial, uri, pkg) => {
        const res = await adb.amStartDeepLink(serial, uri, pkg ?? undefined)
        recordAudit('intent', serial, uri)
        return { ok: res.ok, detail: (res.stdout || res.stderr).trim() }
      },
      installApk: async (serial, file) => {
        const res = await adb.installApk(serial, file)
        recordAudit('install', serial, file)
        return { ok: res.ok, detail: (res.stdout || res.stderr).trim() }
      },
      macros: async () => loadStore().macros,
      runMacro: async (id, serial) => {
        const macro = loadStore().macros.find((m) => m.id === id)
        if (!macro) return { ok: false, detail: 'macro not found' }
        const devices = await adb.listDevices()
        const target = serial ?? settings.deviceSerial ?? devices.find((d) => d.state === 'device')?.serial
        if (!target) return { ok: false, detail: 'no device' }
        const result = await runMacro(macro, target)
        broadcast('automation:suite', result)
        return { ok: result.ok, detail: `${result.steps.filter((s) => s.ok).length}/${result.steps.length} steps passed` }
      },
      action: async (name, payload) => {
        const serial = String(payload.serial ?? loadStore().settings.deviceSerial ?? '')
        const devices = await adb.listDevices()
        const target = serial || devices.find((d) => d.state === 'device')?.serial
        if (!target) return { ok: false, detail: 'no device' }
        const num = (k: string) => (typeof payload[k] === 'number' ? Math.round(payload[k] as number) : 0)
        switch (name) {
          case 'tap': {
            const res = await adb.inputTap(target, num('x'), num('y'))
            return { ok: res.ok, detail: `tap ${num('x')},${num('y')}` }
          }
          case 'swipe': {
            const res = await adb.inputSwipe(target, num('x1'), num('y1'), num('x2'), num('y2'), num('durationMs') || 300)
            return { ok: res.ok, detail: 'swipe' }
          }
          case 'key': {
            const res = await adb.inputKeyEvent(target, String(payload.key ?? ''))
            return { ok: res.ok, detail: `key ${payload.key}` }
          }
          case 'text': {
            const res = await adb.inputText(target, String(payload.text ?? ''))
            return { ok: res.ok, detail: 'text' }
          }
          case 'launch': {
            const res = await adb.amStartMain(target, String(payload.package ?? ''))
            recordAudit('launch', target, String(payload.package ?? ''))
            return { ok: res.ok, detail: (res.stdout || res.stderr).trim() }
          }
          case 'stop': {
            const res = await adb.amForceStop(target, String(payload.package ?? ''))
            recordAudit('stop', target, String(payload.package ?? ''))
            return { ok: res.ok, detail: (res.stdout || res.stderr).trim() }
          }
          case 'screenPower': {
            const res = await adb.screenPower(target)
            return { ok: res.ok, detail: 'toggled' }
          }
          case 'reboot': {
            const res = await adb.rebootDevice(target, 'device')
            recordAudit('reboot', target)
            return { ok: res.ok, detail: 'rebooting' }
          }
          case 'shell': {
            const cmd = String(payload.command ?? '')
            if (!cmd) return { ok: false, detail: 'command required' }
            const res = await adb.shell(target, cmd)
            recordAudit('shell', target, cmd)
            return { ok: res.ok, detail: (res.stdout || res.stderr).slice(0, 4000) }
          }
          default:
            return { ok: false, detail: `unknown action "${name}"` }
        }
      }
    })
    log.info('local api listening', { url: localApi.url, clients: localApi.clientCount() })
  } catch (err) {
    log.warn('local api failed to start', { error: String(err) })
    localApi = null
  }
}

const watchdog = new Watchdog({
  onState: (state: WatchdogState) => broadcast('watchdog:state', state),
  onTunnels: (results: ReverseResult[], serial: string) => broadcast('watchdog:tunnels', { results, serial })
})

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

async function boot(): Promise<void> {
  app.on('second-instance', () => {
    const main = windows.get('main')
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
    }
  })

  await app.whenReady()
  setupLogging()
  loadAllState()
  await migrateLegacyBin()
  const { settings } = loadStore()

  if (selftestRequested()) {
    const code = await runSelftest()
    app.exit(code)
    return
  }

  const runnerArgs = parseRunnerArgs(process.argv)
  if (runnerArgs) {
    const code = await runHeadlessSuite(runnerArgs)
    log.info('headless suite finished', { code, reason: runnerExitMessage(code) })
    app.exit(code)
    return
  }

  createWindow('main')
  createTray({
    onShow: () => showMain(),
    onPair: () => {
      showMain()
      broadcast('tray:action', { action: 'pair' })
    },
    onMirror: () => {
      showMain()
      broadcast('tray:action', { action: 'mirror' })
    }
  })

  registerIpc()
  await restartLocalApi()
  applyLoginItem(settings.startOnLogin)
  void refreshDevices(true)
  setTimeout(() => void autoConnectWireless(), 3000)
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => void refreshDevices(false), pollIntervalMs)
  if (settings.watchdogEnabled) watchdog.start()

  const checkUpdates = async () => {
    if (!loadStore().settings.updateRepo) return
    const info = await checkForUpdate()
    if (info?.newer) {
      notify({ key: 'update', title: `CDeck ${info.version} available`, body: 'Open Settings → Updates to download.' })
      broadcast('update:available', info)
    }
  }
  setTimeout(() => void checkUpdates(), 15000)
  setInterval(() => void checkUpdates(), 6 * 60 * 60 * 1000)
}

function applyLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
  } catch (err) {
    log.warn('setLoginItemSettings failed', { error: String(err) })
  }
}

function showMain(): void {
  const main = windows.get('main')
  if (!main || main.isDestroyed()) {
    createWindow('main')
    return
  }
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

function createWindow(id: 'main' | 'logcat'): BrowserWindow {
  const existing = windows.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }
  const state = getWindowState(
    id,
    id === 'main' ? { width: 1180, height: 820, maximized: false } : { width: 900, height: 640, maximized: false }
  )
  const hash = id === 'logcat' ? '#/logcat' : ''
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'CDeck',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  attachStatePersistence(win, id)
  windows.set(id, win)

  win.once('ready-to-show', () => {
    win.show()
    const url = win.webContents.getURL()
    if (url) allowOrigin(url)
  })
  win.webContents.on('did-finish-load', () => allowOrigin(win.webContents.getURL()))

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }

  win.on('close', (e) => {
    const { settings } = loadStore()
    if (quitting || !settings.minimizeToTray || id !== 'main') return
    e.preventDefault()
    win.hide()
  })
  win.on('session-end', () => {
    void killTrackedTree()
  })
  win.on('query-session-end', () => {
    void killTrackedTree()
  })
  win.on('closed', () => windows.delete(id))

  if (id === 'main') mainWindow = win
  return win
}

function openLogcatWindow(serial: string): void {
  const existing = [...windows.values()].find(
    (w) => !w.isDestroyed() && w.webContents.getURL().includes(`serial=${encodeURIComponent(serial)}`)
  )
  if (existing) {
    existing.focus()
    return
  }
  let target: BrowserWindow | undefined = windows.get('logcat')
  if (!target || target.isDestroyed()) {
    target = createWindow('logcat')
  }
  const hash = `#/logcat?serial=${encodeURIComponent(serial)}`
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void target.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${hash}`)
  } else {
    void target.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
  target.focus()
}

async function autoConnectWireless(): Promise<void> {
  const { lastWireless } = loadStore()
  if (!lastWireless) return
  const devices = await adb.listDevices()
  if (devices.some((d) => d.state === 'device')) return
  const stored = `${lastWireless.ip}:${lastWireless.port}`
  log.info('auto-connect last wireless target', { stored })
  const res = await adb.adbConnect(stored)
  if (res.ok && res.stdout.includes('connected')) {
    notify({ key: `wireless:${stored}`, title: 'Wireless device reconnected', body: stored })
    return
  }
  const fresh = await adb.discoverWirelessTarget(lastWireless.deviceSerial)
  if (!fresh) return
  const target = `${fresh.host}:${fresh.port}`
  if (target === stored) return
  log.info('wireless port rotated; reconnecting to freshly discovered target', { target })
  const retry = await adb.adbConnect(target)
  if (retry.ok && retry.stdout.includes('connected')) {
    notify({ key: `wireless:${target}`, title: 'Wireless device reconnected', body: `${target} (port had rotated)` })
  }
}

function rememberWireless(serial: string): void {
  const m = serial.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/)
  if (!m) return
  const store = loadStore()
  const next: LastWireless = { serial, ip: m[1], port: Number(m[2]), deviceSerial: store.lastWireless?.deviceSerial ?? null }
  if (store.lastWireless?.serial === serial && store.lastWireless.port === next.port) {
    void adb.deviceSerialNumber(serial).then((ds) => {
      if (!ds) return
      const s = loadStore()
      if (s.lastWireless && s.lastWireless.serial === serial && s.lastWireless.deviceSerial !== ds) {
        s.lastWireless.deviceSerial = ds
        saveStore(s)
      }
    })
    return
  }
  store.lastWireless = next
  saveStore(store)
  void adb.deviceSerialNumber(serial).then((ds) => {
    if (!ds) return
    const s = loadStore()
    if (s.lastWireless && s.lastWireless.serial === serial) {
      s.lastWireless.deviceSerial = ds
      saveStore(s)
    }
  })
}

async function refreshDevices(immediate: boolean): Promise<void> {
  try {
    const devices = await adb.listDevices()
    const { settings } = loadStore()
    const tracked = trackedPids()
    const hidden = windows.get('main')?.isVisible() === false
    pollIntervalMs = hidden && tracked.length === 0 ? 15000 : 4000

    const connectedNow = devices.filter((d) => d.state === 'device')
    const connectedBefore = previousDevices.filter((d) => d.state === 'device')
    for (const d of connectedNow) {
      const wasThere = connectedBefore.some((p) => p.serial === d.serial)
      if (!wasThere) {
        notify({ key: `connect:${d.serial}`, title: 'Device connected', body: d.model ?? d.serial })
        clearNotifyKey(`disconnect:${d.serial}`)
        if (d.transport === 'tcpip') rememberWireless(d.serial)
        if (settings.autoMirror) {
          const res = launchScrcpy(d.serial, settings.scrcpyProfile, settings.scrcpyExtra)
          if (!res.ok) notify({ key: `mirror:${d.serial}`, title: 'Auto-mirror failed', body: res.error ?? 'unknown' })
        }
      }
    }
    for (const d of connectedBefore) {
      const stillThere = connectedNow.some((p) => p.serial === d.serial)
      if (!stillThere) {
        const activeSessions = listSessions()
        if (activeSessions.some((s) => s.serial === d.serial)) {
          notify({ key: `disconnect:${d.serial}`, title: 'Device lost', body: 'A mirror or logcat stream was running on it.', sticky: true })
        }
        clearNotifyKey(`connect:${d.serial}`)
      }
    }
    previousDevices = devices
    broadcast('devices:changed', devices)
    localApi?.emit({ type: 'devices', devices, at: Date.now() })
    updateTray(devices, {
      onShow: () => showMain(),
      onPair: () => {
        showMain()
        broadcast('tray:action', { action: 'pair' })
      },
      onMirror: () => {
        showMain()
        broadcast('tray:action', { action: 'mirror' })
      }
    })
  } catch (err) {
    log.warn('device refresh failed', err)
  }
}

function requireSerial(value: unknown): string {
  if (!isSerial(value)) throw new GuardError(`invalid device id`)
  return value
}

function requireText(value: unknown, max = 4000): string {
  if (!isText(value, max)) throw new GuardError('invalid text payload')
  return value
}

function requirePort(value: unknown): number {
  if (!isPort(value)) throw new GuardError('invalid port')
  return value
}

function requireOptionalSerial(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return requireSerial(value)
}

function registerIpc(): void {
  ipcMain.handle('tools:status', async (): Promise<ToolInfo[]> => toolStatuses())
  ipcMain.handle('tools:installScrcpy', async (): Promise<{ ok: boolean; error?: string }> => {
    const res = await ensureScrcpy((p: ToolProgress) => broadcast('tools:progress', p))
    return { ok: res.ok, error: res.error }
  })
  ipcMain.handle('tools:installPlatformTools', async (): Promise<{ ok: boolean; error?: string }> => {
    const res = await ensurePlatformTools((p: ToolProgress) => broadcast('tools:progress', p))
    return { ok: res.ok, error: res.error }
  })
  ipcMain.handle('tools:clearCache', (): { ok: boolean; error?: string } => clearToolCache())

  ipcMain.handle('adb:devices', async (): Promise<DeviceInfo[]> => adb.listDevices())
  ipcMain.handle('adb:mdns', async (): Promise<MdnsService[]> => adb.mdnsServices())
  ipcMain.handle('adb:pair', (_e, target: unknown, code: unknown) =>
    adb.adbPair(requireText(target, 64).trim(), requireText(code, 16).replace(/\D/g, ''))
  )
  ipcMain.handle('adb:connect', (_e, target: unknown) => adb.adbConnect(requireText(target, 64).trim()))
  ipcMain.handle('adb:disconnect', (_e, serial: unknown) => adb.adbDisconnect(requireSerial(serial)))
  ipcMain.handle('adb:tcpip', (_e, port: unknown) => {
    const p = typeof port === 'number' && isPort(port) ? port : 5555
    return adb.adbTcpip(p)
  })
  ipcMain.handle('adb:netInfo', async (_e, serial: unknown): Promise<NetworkInfo> =>
    adb.networkOverview(requireOptionalSerial(serial))
  )
  ipcMain.handle('adb:ping', (_e, ip: unknown): Promise<PingResult> => {
    const ipStr = requireText(ip, 45).trim()
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipStr)) throw new GuardError('invalid ip')
    return adb.pingHost(ipStr)
  })
  ipcMain.handle('adb:wirelessSetup', (_e, serial: unknown, port: unknown): Promise<WirelessSetupResult> => {
    const p = typeof port === 'number' && isPort(port) ? port : 5555
    return adb.wirelessSetup(requireSerial(serial), p)
  })
  ipcMain.handle('adb:lastWireless', (): LastWireless | null => loadStore().lastWireless)
  ipcMain.handle('adb:rediscoverWireless', async (_e, deviceSerial: unknown) => {
    const wanted = typeof deviceSerial === 'string' ? deviceSerial : loadStore().lastWireless?.deviceSerial ?? null
    const fresh = await adb.discoverWirelessTarget(wanted)
    if (!fresh) return { ok: false, target: null, detail: 'No wireless-debugging service advertised. Turn Wireless debugging on, on the same Wi-Fi.' }
    const target = `${fresh.host}:${fresh.port}`
    const res = await adb.adbConnect(target)
    const state = await adb.adbGetState(target)
    return { ok: state === 'device', target, detail: (res.stdout || res.stderr).trim() }
  })
  ipcMain.handle('adb:reverseList', (_e, serial: unknown) => adb.reverseList(requireSerial(serial)))
  ipcMain.handle('adb:ensureReverse', (_e, serial: unknown, ports: unknown): Promise<ReverseResult[]> => {
    const list = Array.isArray(ports) ? ports.map(requirePort) : []
    return adb.ensureReverse(requireSerial(serial), list)
  })
  ipcMain.handle('adb:removeReverse', (_e, serial: unknown, port: unknown) => adb.removeReverse(requireSerial(serial), requirePort(port)))
  ipcMain.handle('adb:shell', (_e, serial: unknown, command: unknown): Promise<CommandResult> =>
    adb.shell(requireSerial(serial), requireText(command))
  )
  ipcMain.handle('adb:uninstall', (_e, serial: unknown, pkg: unknown) => adb.uninstall(requireSerial(serial), requireText(pkg, 200)))
  ipcMain.handle('adb:installApk', async (e, serial: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, {
      title: 'Select APK to install',
      filters: [{ name: 'Android packages', extensions: ['apk', 'apks'] }, { name: 'All files', extensions: ['*'] }]
    })
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, stdout: '', stderr: 'cancelled', code: null } satisfies CommandResult
    }
    return adb.installApk(requireSerial(serial), res.filePaths[0])
  })

  ipcMain.handle('device:viewport', (_e, serial: unknown) =>
    Promise.all([adb.wmSize(requireSerial(serial)), adb.wmDensity(requireSerial(serial))]).then(([size, density]) => ({
      size: size.stdout.trim(),
      density: density.stdout.trim()
    }))
  )
  ipcMain.handle('device:setViewport', (_e, serial: unknown, width: unknown, height: unknown, dpi: unknown) => {
    const s = requireSerial(serial)
    const runs: Array<Promise<CommandResult>> = []
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      runs.push(adb.wmSetSize(s, width, height))
    }
    if (typeof dpi === 'number' && dpi > 0) runs.push(adb.wmSetDensity(s, dpi))
    return Promise.all(runs).then((results) => ({ ok: results.every((r) => r.ok), errors: results.filter((r) => !r.ok).map((r) => r.stderr) }))
  })
  ipcMain.handle('device:resetViewport', (_e, serial: unknown) => adb.wmReset(requireSerial(serial)))
  ipcMain.handle('device:info', async (_e, serial: unknown) => {
    const s = requireSerial(serial)
    const props = [
      'ro.product.model',
      'ro.product.manufacturer',
      'ro.build.version.release',
      'ro.build.version.sdk',
      'ro.build.fingerprint'
    ]
    const propRes = await adb.shell(s, props.map((p) => `getprop ${p}`).join(';'))
    const values = propRes.stdout.split('\n').map((l) => l.trim())
    const map: Record<string, string> = {}
    props.forEach((p, i) => {
      map[p] = values[i] ?? ''
    })
    const size = await adb.wmSize(s)
    const density = await adb.wmDensity(s)
    const battery = await adb.batteryGet(s)
    const batteryMatch = battery.stdout.match(/level:\s*(\d+)/)
    const chargingMatch = battery.stdout.match(/AC powered:\s*(\w+)/)
    return {
      model: map['ro.product.model'],
      manufacturer: map['ro.product.manufacturer'],
      release: map['ro.build.version.release'],
      sdk: map['ro.build.version.sdk'],
      fingerprint: map['ro.build.fingerprint'],
      screen: size.stdout.trim(),
      density: density.stdout.trim(),
      batteryLevel: batteryMatch ? Number(batteryMatch[1]) : null,
      charging: chargingMatch ? chargingMatch[1] === 'true' : null
    }
  })

  ipcMain.handle('device:settingsGet', (_e, serial: unknown, namespace: unknown, key: unknown) =>
    adb.settingsGet(requireSerial(serial), requireText(namespace, 20), requireText(key, 80))
  )
  ipcMain.handle('device:settingsPut', (_e, serial: unknown, namespace: unknown, key: unknown, value: unknown) =>
    adb.settingsPut(requireSerial(serial), requireText(namespace, 20), requireText(key, 80), requireText(value, 80))
  )

  ipcMain.handle('device:battery', (e, serial: unknown, op: unknown) => {
    const s = requireSerial(serial)
    switch (op) {
      case 'level15':
        return adb.batterySetLevel(s, 15)
      case 'level5':
        return adb.batterySetLevel(s, 5)
      case 'ac':
        return adb.batterySetAc(s, true)
      case 'unplug':
        return adb.batteryUnplug(s)
      case 'reset':
        return adb.batteryReset(s)
      default:
        return adb.batteryGet(s)
    }
  })

  ipcMain.handle('device:captureScreenshot', async (_e, serial: unknown) => adb.screencap(requireSerial(serial)))
  ipcMain.handle('device:captureRecord', (_e, serial: unknown, seconds: unknown) =>
    adb.screenRecord(requireSerial(serial), typeof seconds === 'number' && seconds > 0 ? Math.min(seconds, 180) : 30)
  )
  ipcMain.handle('device:reboot', (_e, serial: unknown, mode: unknown) => {
    const m = mode === 'recovery' || mode === 'bootloader' || mode === 'fastboot' ? mode : 'device'
    return adb.rebootDevice(requireSerial(serial), m)
  })
  ipcMain.handle('device:restartAdb', async (): Promise<CommandResult> => {
    await adb.killAdbServer()
    return adb.listDevices().then(() => ({ ok: true, stdout: 'adb server restarted', stderr: '', code: 0 }))
  })
  ipcMain.handle('device:screenPower', (_e, serial: unknown) => adb.screenPower(requireSerial(serial)))
  ipcMain.handle('device:uptime', async (_e, serial: unknown) => adb.deviceUptime(requireSerial(serial)))
  ipcMain.handle('device:bugreport', async (_e, serial: unknown) => adb.bugreport(requireSerial(serial)))
  ipcMain.handle('device:dumpsys', (_e, serial: unknown, service: unknown) =>
    adb.dumpsysService(requireSerial(serial), requireText(service, 80))
  )
  ipcMain.handle('device:dumpsysServices', async (_e, serial: unknown) => adb.dumpsysServices(requireSerial(serial)))
  ipcMain.handle('device:perf', async (_e, serial: unknown) => {
    const [cpu, mem] = await Promise.all([adb.perfSnapshot(requireSerial(serial)), adb.memoryInfo(requireSerial(serial))])
    return { cpu: cpu.stdout.trim(), mem: mem.stdout.trim() }
  })
  ipcMain.handle('device:netToggle', (_e, serial: unknown, target: unknown, on: unknown) => {
    const t = target === 'wifi' || target === 'data' || target === 'airplane' ? target : 'wifi'
    return adb.networkToggle(requireSerial(serial), t, on === true)
  })

  ipcMain.handle('apps:list', (_e, serial: unknown, thirdPartyOnly: unknown) =>
    adb.listPackages(requireSerial(serial), thirdPartyOnly !== false).then((res) => ({
      ok: res.ok,
      packages: res.stdout
        .split(/\r?\n/)
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean)
        .sort()
    }))
  )
  ipcMain.handle('apps:launchable', (_e, serial: unknown) => adb.listLaunchablePackages(requireSerial(serial)))
  ipcMain.handle('apps:pid', (_e, serial: unknown, pkg: unknown) => adb.pidof(requireSerial(serial), requireText(pkg, 200)))
  ipcMain.handle('apps:info', async (_e, serial: unknown, pkg: unknown) =>
    adb.appInfo(requireSerial(serial), requireText(pkg, 200))
  )
  ipcMain.handle('apps:grant', (_e, serial: unknown, pkg: unknown, permission: unknown) =>
    adb.grantPermission(requireSerial(serial), requireText(pkg, 200), requireText(permission, 200))
  )
  ipcMain.handle('apps:revoke', (_e, serial: unknown, pkg: unknown, permission: unknown) =>
    adb.revokePermission(requireSerial(serial), requireText(pkg, 200), requireText(permission, 200))
  )
  ipcMain.handle('apps:appops', (_e, serial: unknown, pkg: unknown, op: unknown, mode: unknown) =>
    adb.appOpsSet(requireSerial(serial), requireText(pkg, 200), requireText(op, 200), requireText(mode, 40))
  )
  ipcMain.handle('apps:start', (_e, serial: unknown, pkg: unknown) => adb.amStartMain(requireSerial(serial), requireText(pkg, 200)))
  ipcMain.handle('apps:stop', (_e, serial: unknown, pkg: unknown) => adb.amForceStop(requireSerial(serial), requireText(pkg, 200)))
  ipcMain.handle('apps:clear', (_e, serial: unknown, pkg: unknown) => adb.pmClear(requireSerial(serial), requireText(pkg, 200)))
  ipcMain.handle('apps:path', (_e, serial: unknown, pkg: unknown) => adb.pmPath(requireSerial(serial), requireText(pkg, 200)))
  ipcMain.handle('apps:deeplink', (_e, serial: unknown, uri: unknown, pkg: unknown) =>
    adb.amStartDeepLink(requireSerial(serial), requireText(uri, 2000), requireOptionalSerial(pkg) ?? undefined)
  )

  ipcMain.handle('scrcpy:profiles', (): ScrcpyProfile[] => PROFILES)
  ipcMain.handle('scrcpy:launch', (_e, serial: unknown, profileId: unknown) => {
    const { settings } = loadStore()
    return launchScrcpy(requireSerial(serial), requireText(profileId, 40), settings.scrcpyExtra)
  })
  ipcMain.handle('scrcpy:stop', (_e, pid: unknown) => {
    if (typeof pid !== 'number') return false
    return stopScrcpy(pid)
  })
  ipcMain.handle('scrcpy:sessions', () => listSessions())
  ipcMain.handle('mirror:start', (e, serial: unknown, opts: unknown) => {
    const wc = senderWebContents(e)
    if (!wc) return Promise.resolve({ ok: false, error: 'no window' })
    const s = requireSerial(serial)
    const o = (opts ?? {}) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v) : 0)
    return mirror.startEmbeddedMirror(wc, s, {
      maxSize: num(o.maxSize),
      maxFps: num(o.maxFps),
      videoBitRate: num(o.videoBitRate),
      turnScreenOff: o.turnScreenOff === true,
      stayAwake: o.stayAwake === true,
      forward: o.forward === true
    })
  })
  ipcMain.handle('mirror:stop', async () => mirror.stopEmbeddedMirror())
  ipcMain.handle('mirror:stats', () => mirror.mirrorStats())

  ipcMain.handle('watchdog:state', (): WatchdogState => watchdog.getState())
  ipcMain.handle('watchdog:start', () => watchdog.start())
  ipcMain.handle('watchdog:stop', () => watchdog.stop())
  ipcMain.handle('watchdog:once', async (): Promise<WatchdogState> => {
    await watchdog.reconcile()
    return watchdog.getState()
  })

  ipcMain.handle('profiles:get', (): Record<string, import('@shared/types').DeviceProfile> => loadStore().devices)
  ipcMain.handle('profiles:set', (_e, serial: unknown, patch: unknown) => {
    const s = requireSerial(serial)
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
    const safe: import('@shared/types').DeviceProfile = {}
    if (typeof p.alias === 'string') safe.alias = p.alias.slice(0, 60)
    if (Array.isArray(p.tags)) safe.tags = p.tags.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 30)).slice(0, 12)
    if (Array.isArray(p.tunnels)) safe.tunnels = p.tunnels.filter(isPort)
    if (typeof p.scrcpyProfile === 'string') safe.scrcpyProfile = p.scrcpyProfile.slice(0, 40)
    if (typeof p.autoMirror === 'boolean') safe.autoMirror = p.autoMirror
    return updateProfile(s, safe)
  })
  ipcMain.handle('groups:list', (): import('@shared/types').DeviceGroup[] => loadStore().groups)
  ipcMain.handle('groups:save', (_e, groups: unknown) => {
    const store = loadStore()
    const list = Array.isArray(groups) ? groups : []
    store.groups = list
      .filter((g): g is Record<string, unknown> => Boolean(g) && typeof g === 'object')
      .map((g, i) => ({
        id: typeof g.id === 'string' && g.id ? g.id.slice(0, 40) : `g${Date.now()}-${i}`,
        name: typeof g.name === 'string' ? g.name.slice(0, 60) : `Group ${i + 1}`,
        members: Array.isArray(g.members) ? g.members.filter((m): m is string => typeof m === 'string').slice(0, 64) : []
      }))
      .slice(0, 50)
    saveStore(store)
    return store.groups
  })
  ipcMain.handle('intents:list', (): import('@shared/types').IntentEntry[] => loadStore().intents)
  ipcMain.handle('intents:add', (_e, uri: unknown, pkg: unknown) => {
    const store = loadStore()
    const entry = { uri: requireText(uri, 2000), pkg: typeof pkg === 'string' ? pkg.slice(0, 200) : null, at: Date.now() }
    store.intents = [entry, ...store.intents.filter((i) => !(i.uri === entry.uri && i.pkg === entry.pkg))].slice(0, 100)
    saveStore(store)
    return store.intents
  })
  ipcMain.handle('intents:clear', () => {
    const store = loadStore()
    store.intents = []
    saveStore(store)
  })
  ipcMain.handle('macros:list', (): import('@shared/types').Macro[] => loadStore().macros)
  ipcMain.handle('macros:save', (_e, macro: unknown) => {
    const m = macro as import('@shared/types').Macro
    if (!m || typeof m !== 'object' || !Array.isArray(m.steps)) return loadStore().macros
    const store = loadStore()
    const entry: import('@shared/types').Macro = {
      id: typeof m.id === 'string' && m.id ? m.id.slice(0, 60) : `m${Date.now()}`,
      name: typeof m.name === 'string' ? m.name.slice(0, 80) : 'Untitled',
      deviceSerial: typeof m.deviceSerial === 'string' ? m.deviceSerial : null,
      steps: m.steps.slice(0, 2000),
      createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
      updatedAt: Date.now()
    }
    store.macros = [entry, ...store.macros.filter((x) => x.id !== entry.id)].slice(0, 200)
    saveStore(store)
    return store.macros
  })
  ipcMain.handle('macros:delete', (_e, id: unknown) => {
    if (!isText(id, 60)) return loadStore().macros
    const store = loadStore()
    store.macros = store.macros.filter((m) => m.id !== id)
    saveStore(store)
    return store.macros
  })
  ipcMain.handle('audit:list', (): import('@shared/types').AuditEntry[] => loadStore().audit.slice(-200).reverse())
  ipcMain.handle('audit:clear', () => {
    const store = loadStore()
    store.audit = []
    saveStore(store)
  })
  ipcMain.handle('audit:record', (_e, action: unknown, target: unknown, detail: unknown) => {
    recordAudit(requireText(action, 60), requireText(target, 200), typeof detail === 'string' ? detail.slice(0, 300) : undefined)
  })

  ipcMain.handle('files:listDir', (_e, serial: unknown, dir: unknown) => listDir(requireSerial(serial), requireText(dir, 500)))
  ipcMain.handle('files:push', async (e, serial: unknown, remoteDir: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, { title: 'Select files to push', properties: ['openFile', 'multiSelections'] })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, detail: 'cancelled' }
    const s = requireSerial(serial)
    const dir = requireText(remoteDir, 500)
    const results: string[] = []
    for (const f of res.filePaths) {
      const r = await pushFile(s, f, `${dir.replace(/\/$/, '')}/${path.basename(f)}`)
      results.push(`${path.basename(f)}: ${r.ok ? 'ok' : r.detail}`)
      if (r.ok) recordAudit('push', s, `${f} → ${dir}`)
    }
    return { ok: results.every((l) => l.endsWith('ok')), detail: results.join('; ') }
  })
  ipcMain.handle('files:pull', async (e, serial: unknown, remotePath: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const remote = requireText(remotePath, 500)
    const res = await dialog.showSaveDialog(win!, { defaultPath: path.basename(remote) })
    if (res.canceled || !res.filePath) return { ok: false, detail: 'cancelled' }
    const r = await pullFile(requireSerial(serial), remote, res.filePath)
    if (r.ok) recordAudit('pull', String(serial), `${remote} → ${res.filePath}`)
    return r
  })
  ipcMain.handle('files:delete', (_e, serial: unknown, remote: unknown) => {
    const r = deleteFile(requireSerial(serial), requireText(remote, 500))
    recordAudit('delete', String(serial), String(remote))
    return r
  })
  ipcMain.handle('files:rename', (_e, serial: unknown, from: unknown, to: unknown) =>
    renameFile(requireSerial(serial), requireText(from, 500), requireText(to, 500))
  )
  ipcMain.handle('files:mkdir', (_e, serial: unknown, dir: unknown) => makeDir(requireSerial(serial), requireText(dir, 500)))
  ipcMain.handle('files:bundle', (_e, serial: unknown, withBugreport: unknown) =>
    bugBundle(requireSerial(serial), withBugreport === true)
  )
  ipcMain.handle('files:pushPaths', async (_e, serial: unknown, remoteDir: unknown, paths: unknown) => {
    const s = requireSerial(serial)
    const dir = requireText(remoteDir, 500)
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    const results: string[] = []
    for (const f of list) {
      const r = await pushFile(s, f, `${dir.replace(/\/$/, '')}/${path.basename(f)}`)
      results.push(`${path.basename(f)}: ${r.ok ? 'ok' : r.detail}`)
      if (r.ok) recordAudit('push', s, `${f} → ${dir}`)
    }
    return { ok: results.every((l) => l.endsWith('ok')), detail: results.join('; ') }
  })
  ipcMain.handle('broadcast:run', async (_e, action: unknown, payload: unknown) => {
    const name = requireText(action, 40)
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const devices = (await adb.listDevices()).filter((d) => d.state === 'device')
    const targets = Array.isArray(p.serials) && p.serials.length > 0 ? devices.filter((d) => (p.serials as string[]).includes(d.serial)) : devices
    const results: Array<{ serial: string; ok: boolean; detail: string }> = []
    for (const d of targets) {
      try {
        if (name === 'screenshot') {
          const r = await adb.screencap(d.serial)
          results.push({ serial: d.serial, ok: r.ok, detail: r.file ?? r.error ?? '' })
        } else if (name === 'reboot') {
          const r = await adb.rebootDevice(d.serial, 'device')
          results.push({ serial: d.serial, ok: r.ok, detail: 'rebooting' })
        } else if (name === 'shell') {
          const cmd = requireText(p.command, 2000)
          const r = await adb.shell(d.serial, cmd)
          results.push({ serial: d.serial, ok: r.ok, detail: (r.stdout || r.stderr).trim().slice(0, 300) })
        } else if (name === 'screenPower') {
          const r = await adb.screenPower(d.serial)
          results.push({ serial: d.serial, ok: r.ok, detail: 'toggled' })
        } else if (name === 'key') {
          const r = await adb.inputKeyEvent(d.serial, requireText(p.key, 30))
          results.push({ serial: d.serial, ok: r.ok, detail: `key ${p.key}` })
        } else if (name === 'launch') {
          const r = await adb.amStartMain(d.serial, requireText(p.package, 200))
          results.push({ serial: d.serial, ok: r.ok, detail: (r.stdout || r.stderr).trim().slice(0, 200) })
        } else if (name === 'install') {
          const file = requireText(p.file, 500)
          const r = await adb.installApk(d.serial, file)
          results.push({ serial: d.serial, ok: r.ok, detail: (r.stdout || r.stderr).trim().slice(0, 200) })
        } else {
          results.push({ serial: d.serial, ok: false, detail: `unknown action ${name}` })
        }
      } catch (err) {
        results.push({ serial: d.serial, ok: false, detail: String(err) })
      }
    }
    if (results.length > 0) recordAudit(`broadcast:${name}`, `${results.length} device(s)`, results.map((r) => `${r.serial}:${r.ok ? 'ok' : 'fail'}`).join(', '))
    return results
  })
  ipcMain.handle('broadcast:install', async (e, serials: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win!, {
      title: 'Select APK(s) for broadcast install',
      filters: [{ name: 'Android packages', extensions: ['apk', 'apks'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, detail: 'cancelled', results: [] }
    const devices = (await adb.listDevices()).filter((d) => d.state === 'device')
    const targets = Array.isArray(serials) && serials.length > 0 ? devices.filter((d) => (serials as string[]).includes(d.serial)) : devices
    const results: Array<{ serial: string; ok: boolean; detail: string }> = []
    for (const d of targets) {
      for (const f of res.filePaths) {
        const r = await adb.installApk(d.serial, f)
        results.push({ serial: d.serial, ok: r.ok, detail: `${path.basename(f)}: ${(r.stdout || r.stderr).trim().slice(0, 160)}` })
      }
    }
    recordAudit('broadcast:install', `${results.length} install(s)`, res.filePaths.map((f) => path.basename(f)).join(', '))
    return { ok: results.every((r) => r.ok), detail: `${results.filter((r) => r.ok).length}/${results.length} ok`, results }
  })
  ipcMain.handle('api:info', () => {
    const { settings, apiToken } = loadStore()
    return {
      enabled: settings.localApiEnabled,
      port: settings.localApiPort,
      url: localApi?.url ?? `http://127.0.0.1:${settings.localApiPort}`,
      running: localApi !== null,
      clients: localApi?.clientCount() ?? 0,
      token: apiToken
    }
  })

  ipcMain.handle('ui:dump', async (_e, serial: unknown) => {
    const { dumpUi } = await import('./ui-hierarchy')
    return dumpUi(requireSerial(serial))
  })
  ipcMain.handle('ui:find', async (_e, serial: unknown, query: unknown) => {
    const { findNodes } = await import('./ui-hierarchy')
    const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>
    return findNodes(requireSerial(serial), {
      text: typeof q.text === 'string' ? q.text : undefined,
      resourceId: typeof q.resourceId === 'string' ? q.resourceId : undefined,
      className: typeof q.className === 'string' ? q.className : undefined,
      contentDesc: typeof q.contentDesc === 'string' ? q.contentDesc : undefined,
      clickableOnly: q.clickableOnly === true
    })
  })

  ipcMain.handle('automation:run', async (_e, macroId: unknown, serial: unknown) => {
    const macro = loadStore().macros.find((m) => m.id === requireText(macroId, 60))
    if (!macro) throw new GuardError('macro not found')
    const devices = await adb.listDevices()
    const target = (typeof serial === 'string' ? serial : null) ?? devices.find((d) => d.state === 'device')?.serial
    if (!target) throw new GuardError('no device connected')
    const events: AutomationEvents = {
      onStep: (r) => broadcast('automation:step', r),
      onSuite: (r) => broadcast('automation:suite', r)
    }
    return runMacro(macro, target, events)
  })
  ipcMain.handle('automation:runSuite', async (_e, ids: unknown, serial: unknown) => {
    const store = loadStore()
    const list = Array.isArray(ids) ? store.macros.filter((m) => ids.includes(m.id)) : store.macros
    const devices = await adb.listDevices()
    const target = (typeof serial === 'string' ? serial : null) ?? devices.find((d) => d.state === 'device')?.serial
    if (!target) throw new GuardError('no device connected')
    const events: AutomationEvents = {
      onStep: (r) => broadcast('automation:step', r),
      onSuite: (r) => broadcast('automation:suite', r)
    }
    return runSuite(list, target, events)
  })
  ipcMain.handle('automation:toMaestro', async (_e, macroId: unknown) => {
    const { toMaestroYaml } = await import('./automation')
    const macro = loadStore().macros.find((m) => m.id === requireText(macroId, 60))
    if (!macro) throw new GuardError('macro not found')
    return toMaestroYaml(macro)
  })
  ipcMain.handle('automation:fromMaestro', async (_e, text: unknown, name: unknown) => {
    const { fromMaestroYaml } = await import('./automation')
    const store = loadStore()
    const macro = fromMaestroYaml(requireText(text, 200000), requireText(name, 80))
    store.macros = [macro, ...store.macros].slice(0, 200)
    saveStore(store)
    return store.macros
  })
  ipcMain.handle('automation:report', async (_e, results: unknown, format: unknown) => {
    const { toHtmlReport, toJUnit } = await import('./automation')
    const list = Array.isArray(results) ? (results as import('@shared/types').SuiteResult[]) : []
    const text = format === 'junit' ? toJUnit(list) : toHtmlReport(list)
    const name = format === 'junit' ? 'cdeck-results.xml' : 'cdeck-report.html'
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showSaveDialog(win, { defaultPath: name })
    if (res.canceled || !res.filePath) return { ok: false }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(res.filePath, text)
    return { ok: true, path: res.filePath }
  })

  ipcMain.handle('settings:get', (): Settings => ({ ...loadStore().settings }))
  ipcMain.handle('settings:set', (_e, patch: unknown): Settings => {
    const current = loadStore()
    const safePatch: Partial<Settings> = {}
    if (patch && typeof patch === 'object') {
      const p = patch as Partial<Settings>
      if (p.deviceSerial !== undefined) safePatch.deviceSerial = isSerial(p.deviceSerial) ? p.deviceSerial : null
      if (Array.isArray(p.tunnels)) safePatch.tunnels = p.tunnels.filter(isPort)
      if (typeof p.scrcpyProfile === 'string') safePatch.scrcpyProfile = p.scrcpyProfile.slice(0, 40)
      if (Array.isArray(p.scrcpyExtra)) safePatch.scrcpyExtra = p.scrcpyExtra.filter((a) => typeof a === 'string').slice(0, 20)
      if (typeof p.watchdogEnabled === 'boolean') safePatch.watchdogEnabled = p.watchdogEnabled
      if (typeof p.watchdogIntervalSec === 'number') safePatch.watchdogIntervalSec = Math.min(Math.max(Math.round(p.watchdogIntervalSec), 2), 600)
      if (p.customAdbPath !== undefined) safePatch.customAdbPath = typeof p.customAdbPath === 'string' ? p.customAdbPath.slice(0, 260) : null
      if (p.customScrcpyPath !== undefined) safePatch.customScrcpyPath = typeof p.customScrcpyPath === 'string' ? p.customScrcpyPath.slice(0, 260) : null
      if (p.updateRepo !== undefined) safePatch.updateRepo = typeof p.updateRepo === 'string' && /^[\w.\-]+\/[\w.\-]+$/.test(p.updateRepo) ? p.updateRepo : null
      if (typeof p.minimizeToTray === 'boolean') safePatch.minimizeToTray = p.minimizeToTray
      if (typeof p.autoMirror === 'boolean') safePatch.autoMirror = p.autoMirror
      if (typeof p.shortcutsEnabled === 'boolean') safePatch.shortcutsEnabled = p.shortcutsEnabled
      if (typeof p.startOnLogin === 'boolean') safePatch.startOnLogin = p.startOnLogin
      if (typeof p.launchMinimized === 'boolean') safePatch.launchMinimized = p.launchMinimized
      if (p.theme === 'dark' || p.theme === 'light' || p.theme === 'system') safePatch.theme = p.theme
      if (typeof p.uiZoom === 'number') safePatch.uiZoom = Math.min(Math.max(p.uiZoom, 0.75), 1.5)
      if (typeof p.localApiEnabled === 'boolean') safePatch.localApiEnabled = p.localApiEnabled
      if (typeof p.localApiPort === 'number' && isPort(p.localApiPort)) safePatch.localApiPort = p.localApiPort
      if (typeof p.onboarded === 'boolean') safePatch.onboarded = p.onboarded
    }
    const next = loadStore()
    next.settings = { ...next.settings, ...safePatch }
    saveStore(next)
    if (safePatch.watchdogEnabled !== undefined) {
      if (safePatch.watchdogEnabled) watchdog.start()
      else watchdog.stop()
    } else if (watchdog.getState().running && safePatch.watchdogIntervalSec !== undefined) {
      watchdog.stop()
      watchdog.start()
    }
    if (safePatch.startOnLogin !== undefined) applyLoginItem(safePatch.startOnLogin)
    if (safePatch.localApiEnabled !== undefined || safePatch.localApiPort !== undefined) {
      void restartLocalApi()
    }
    return { ...next.settings }
  })

  ipcMain.handle('logcat:openWindow', (_e, serial: unknown) => {
    requireSerial(serial)
    openLogcatWindow(serial as string)
  })
  ipcMain.handle('logcat:start', (e, serial: unknown) => {
    const s = requireSerial(serial)
    const wc = senderWebContents(e)
    try {
      const session = adb.startLogcat(
        s,
        (lines) => {
          if (wc && !wc.isDestroyed()) wc.send('logcat:batch', { serial: s, lines })
        },
        (code) => {
          if (wc && !wc.isDestroyed()) wc.send('logcat:exit', { serial: s, code })
        }
      )
      return { id: session.id }
    } catch (err) {
      return { id: '', error: String(err) }
    }
  })
  ipcMain.handle('logcat:stop', (_e, id: unknown) => {
    if (isText(id, 64)) adb.stopLogcat(id)
  })
  ipcMain.handle('logcat:startBuffers', (e, serial: unknown, buffers: unknown) => {
    const s = requireSerial(serial)
    const list = Array.isArray(buffers) ? buffers.filter((b): b is string => typeof b === 'string').slice(0, 8) : ['main']
    const wc = senderWebContents(e)
    try {
      const session = adb.startLogcatStream(
        s,
        list,
        (lines) => {
          if (wc && !wc.isDestroyed()) wc.send('logcat:batch', { serial: s, lines })
        },
        (code) => {
          if (wc && !wc.isDestroyed()) wc.send('logcat:exit', { serial: s, code })
        }
      )
      return { id: session.id }
    } catch (err) {
      return { id: '', error: String(err) }
    }
  })
  ipcMain.handle('net:probe', (_e, port: unknown) => adb.localhostProbe(requirePort(port)))
  ipcMain.handle('selftest:run', async () => {
    const code = await runSelftest()
    return { code, path: selftestReportPath() }
  })

  ipcMain.handle('logs:path', () => logFilePath())
  ipcMain.handle('logs:read', async (_e, maxBytes: unknown) => {
    const file = logFilePath()
    const limit = typeof maxBytes === 'number' && maxBytes > 0 ? Math.min(maxBytes, 8 * 1024 * 1024) : 512 * 1024
    try {
      const { readFileSync, statSync } = await import('node:fs')
      const size = statSync(file).size
      const start = Math.max(0, size - limit)
      const buf = readFileSync(file)
      const text = buf.subarray(start, size).toString('utf8')
      return { ok: true, text, bytes: size }
    } catch (err) {
      return { ok: false, text: String(err), bytes: 0 }
    }
  })
  ipcMain.handle('files:save', async (e, name: unknown, contents: unknown) => {
    const fileName = requireText(name, 120)
    const text = requireText(contents, 32 * 1024 * 1024)
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, { defaultPath: fileName })
    if (res.canceled || !res.filePath) return { ok: false }
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(res.filePath, text)
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle('logs:open', async () => {
    const file = logFilePath()
    if (await shell.openPath(file)) await shell.showItemInFolder(file)
  })
  ipcMain.handle('captures:openFolder', async () => {
    const dir = join(app.getPath('userData'), 'captures')
    await shell.openPath(dir)
  })
  ipcMain.handle('update:check', async (): Promise<import('@shared/types').UpdateInfo> => checkForUpdate())
  ipcMain.handle('app:openExternal', (_e, url: unknown) => {
    if (!isText(url, 500)) throw new GuardError('invalid url')
    return shell.openExternal(url)
  })
}

app.on('before-quit', () => {
  quitting = true
  watchdog.stop()
  stopAllScrcpy()
  void localApi?.close()
  void mirror.stopEmbeddedMirror()
  adb.stopAllLogcat()
  if (pollTimer) clearInterval(pollTimer)
  resetNotifyState()
  destroyTray()
})

app.on('window-all-closed', () => {})

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err)
  void killTrackedTree().then(() => {
    app.relaunch()
    app.exit(1)
  })
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason)
})