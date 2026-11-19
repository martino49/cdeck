import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type {
  CommandResult,
  DeviceInfo,
  MdnsService,
  NetworkInfo,
  PingResult,
  ReverseResult,
  WirelessSetupResult,
  WirelessTarget
} from '@shared/types'
import { loadStore } from './store'
import { run } from './process'

export { run }

export function binRoot(): string {
  return path.join(app.getPath('userData'), 'bin')
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return null
}

function findOneLevelDeep(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null
  const direct = path.join(dir, name)
  if (existsSync(direct)) return direct
  return firstExisting(readdirSync(dir).map((entry) => path.join(dir, entry, name)))
}

export function whichCmdSync(name: string): string | null {
  const which = process.platform === 'win32' ? 'where.exe' : 'which'
  const res = spawnSync(which, [name], { encoding: 'utf8', windowsHide: true })
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/)[0].trim()
    return first || null
  }
  return null
}

export function resolveAdbPath(): { path: string | null; source: 'custom' | 'bundled' | 'path' } {
  const { settings } = loadStore()
  if (settings.customAdbPath && existsSync(settings.customAdbPath)) {
    return { path: settings.customAdbPath, source: 'custom' }
  }
  const scrcpyAdb = firstExisting([path.join(binRoot(), 'scrcpy', 'adb.exe')])
  if (scrcpyAdb) return { path: scrcpyAdb, source: 'bundled' }
  const ptAdb = findOneLevelDeep(path.join(binRoot(), 'platform-tools'), 'adb.exe')
  if (ptAdb) return { path: ptAdb, source: 'bundled' }
  const fromPath = whichCmdSync('adb')
  if (fromPath) return { path: fromPath, source: 'path' }
  return { path: null, source: 'path' }
}

export function resolveScrcpyPath(): { path: string | null; source: 'custom' | 'bundled' | 'path' } {
  const { settings } = loadStore()
  if (settings.customScrcpyPath && existsSync(settings.customScrcpyPath)) {
    return { path: settings.customScrcpyPath, source: 'custom' }
  }
  const bundled = findOneLevelDeep(path.join(binRoot(), 'scrcpy'), 'scrcpy.exe')
  if (bundled) return { path: bundled, source: 'bundled' }
  const fromPath = whichCmdSync('scrcpy')
  if (fromPath) return { path: fromPath, source: 'path' }
  return { path: null, source: 'path' }
}

export async function adbVersion(): Promise<string | null> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return null
  const res = await run(adb, ['version'])
  const m = res.stdout.match(/Version ([\d.]+-[\w.-]+)/)
  return m ? m[1] : res.stdout.split('\n')[0]?.trim() || null
}

function adbArgs(serial: string | null, args: string[]): string[] {
  return serial ? ['-s', serial, ...args] : args
}

export { shell as adbShell }

export function adbRaw(args: string[], timeoutMs = 30000): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, args, timeoutMs)
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return []
  const res = await run(adb, ['devices', '-l'])
  if (!res.ok) return []
  const devices: DeviceInfo[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('List of devices')) continue
    const parts = t.split(/\s+/)
    if (parts.length < 2) continue
    const serial = parts[0]
    const state = parts[1]
    const info: DeviceInfo = {
      serial,
      state,
      transport: serial.includes(':') || serial.startsWith('adb-') ? 'tcpip' : 'usb'
    }
    const model = t.match(/model:(\S+)/)
    const product = t.match(/product:(\S+)/)
    const deviceName = t.match(/device:(\S+)/)
    const transportId = t.match(/transport_id:(\S+)/)
    if (model) info.model = model[1]
    if (product) info.product = product[1]
    if (deviceName) info.device = deviceName[1]
    if (transportId) info.transportId = transportId[1]
    devices.push(info)
  }
  return devices
}

export async function mdnsServices(): Promise<MdnsService[]> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return []
  const res = await run(adb, ['mdns', 'services'])
  if (!res.ok) return []
  const out: MdnsService[] = []
  const re = /^(\S+)\s+(\S+?)\s+(\d+\.\d+\.\d+\.\d+):(\d+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(res.stdout)) !== null) {
    out.push({ instance: m[1], type: m[2], host: m[3], port: Number(m[4]), raw: m[0] })
  }
  return out
}

export function adbPair(target: string, code: string): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, ['pair', target, code.trim()])
}

export function adbConnect(target: string): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, ['connect', target])
}

export function adbDisconnect(serial: string): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, ['disconnect', serial])
}

export function adbTcpip(port: number): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, ['tcpip', String(port)])
}

async function phoneWifiIp(serial: string): Promise<string | null> {
  const addr = await shell(serial, 'ip -f inet addr show wlan0')
  const inet = addr.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/)
  if (inet) return inet[1]
  const route = await shell(serial, 'ip route')
  const src = route.stdout.match(/wlan0[^\n]*?src (\d+\.\d+\.\d+\.\d+)/)
  return src ? src[1] : null
}

export interface WifiStatus {
  enabled: boolean | null
  connected: boolean
  ssid: string | null
  ip: string | null
}

export async function wifiStatus(serial: string): Promise<WifiStatus> {
  const status = await shell(serial, 'cmd wifi status')
  let enabled: boolean | null = null
  let connected = false
  let ssid: string | null = null
  let ip: string | null = null
  if (status.ok) {
    if (/Wifi is disabled/.test(status.stdout)) enabled = false
    else if (/Wifi is enabled/.test(status.stdout)) enabled = true
    const connectedMatch = status.stdout.match(/Wifi is connected to "([^"]+)"/)
    if (connectedMatch) {
      connected = true
      ssid = connectedMatch[1]
    } else {
      const ssidMatch = status.stdout.match(/SSID: "([^"]+)"/)
      if (ssidMatch) ssid = ssidMatch[1]
    }
    const ipMatch = status.stdout.match(/IP: \/(\d+\.\d+\.\d+\.\d+)/)
    if (ipMatch) ip = ipMatch[1]
  }
  if (!ip) ip = await phoneWifiIp(serial).catch(() => null)
  return { enabled, connected, ssid, ip }
}

export async function ensureWifi(
  serial: string,
  waitMs = 25000
): Promise<{ ok: boolean; ip: string | null; ssid: string | null; steps: string[] }> {
  const steps: string[] = []
  let state = await wifiStatus(serial)
  steps.push(`wi-fi status: ${state.enabled === false ? 'off' : state.connected ? `connected to ${state.ssid}` : 'on, not connected'}`)
  if (state.enabled === false) {
    steps.push('running: svc wifi enable')
    await shell(serial, 'svc wifi enable')
  }
  if (!state.connected || !state.ip) {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      state = await wifiStatus(serial)
      if (state.connected && state.ip) break
    }
    steps.push(`after waiting: ${state.connected ? `connected to ${state.ssid}` : 'still not connected'}`)
  }
  return { ok: Boolean(state.connected && state.ip), ip: state.ip, ssid: state.ssid, steps }
}

export function laptopNetwork(): { ssid: string | null; ips: string[] } {
  let ssid: string | null = null
  const res = spawnSync('netsh', ['wlan', 'show', 'interfaces'], { encoding: 'utf8', windowsHide: true })
  if (res.status === 0 && res.stdout) {
    const m = res.stdout.match(/^\s*SSID\s*:\s*(.+)$/m)
    if (m) ssid = m[1].trim()
  }
  const ips: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') ips.push(a.address)
    }
  }
  return { ssid, ips }
}

export async function pingHost(ip: string): Promise<PingResult> {
  const res = await run('ping.exe', ['-n', '2', '-w', '1500', ip], 10000)
  const avg = res.stdout.match(/Average\s*=\s*(\d+)\s*ms/i)
  return { ip, reachable: res.ok, avgMs: avg ? Number(avg[1]) : null }
}

export async function networkOverview(serial: string | null): Promise<NetworkInfo> {
  const lap = laptopNetwork()
  const base: NetworkInfo = {
    phoneIp: null,
    phoneSsid: null,
    wifiEnabled: null,
    wifiConnected: null,
    laptopSsid: lap.ssid,
    laptopIps: lap.ips,
    sameNetwork: null
  }
  if (!serial) return base
  const wifi = await wifiStatus(serial).catch(() => null)
  if (!wifi) return base
  const sameNetwork =
    wifi.ssid && lap.ssid ? wifi.ssid.trim().toLowerCase() === lap.ssid.trim().toLowerCase() : null
  return {
    ...base,
    phoneIp: wifi.connected ? wifi.ip : null,
    phoneSsid: wifi.ssid,
    wifiEnabled: wifi.enabled,
    wifiConnected: wifi.connected,
    sameNetwork
  }
}

export async function wirelessSetup(serial: string, port = 5555): Promise<WirelessSetupResult> {
  const { path: adb } = resolveAdbPath()
  const steps: string[] = []
  if (!adb) return { ok: false, ip: null, port, steps, error: 'adb not found' }

  const wifi = await ensureWifi(serial)
  steps.push(...wifi.steps)
  if (!wifi.ok || !wifi.ip) {
    return { ok: false, ip: null, port, steps, error: 'phone has no Wi-Fi connection — turn Wi-Fi on and join a network' }
  }
  if (wifi.ssid) {
    const lap = laptopNetwork()
    if (lap.ssid && wifi.ssid.trim().toLowerCase() !== lap.ssid.trim().toLowerCase()) {
      return {
        ok: false,
        ip: wifi.ip,
        port,
        steps,
        error: `phone is on "${wifi.ssid}" but this PC is on "${lap.ssid}" — put both on the same network`
      }
    }
  }

  const tcp = await run(adb, ['-s', serial, 'tcpip', String(port)])
  steps.push(`adb tcpip ${port}: ${(tcp.stdout || tcp.stderr).trim()}`)
  if (!tcp.ok) return { ok: false, ip: wifi.ip, port, steps, error: tcp.stderr.trim() || 'tcpip failed' }
  const ip = wifi.ip ?? (await phoneWifiIp(serial).catch(() => null))
  if (!ip) return { ok: false, ip: null, port, steps, error: 'could not read the phone Wi-Fi IP' }
  const ping = await pingHost(ip)
  steps.push(`ping ${ip}: ${ping.reachable ? `${ping.avgMs ?? 0}ms` : 'unreachable'}`)
  const conn = await run(adb, ['connect', `${ip}:${port}`], 15000)
  steps.push(`connect ${ip}:${port}: ${(conn.stdout || conn.stderr).trim()}`)
  const state = await adbGetState(`${ip}:${port}`)
  steps.push(`state: ${state ?? 'unknown'}`)
  const ok = state === 'device'
  return { ok, ip, port, steps, error: ok ? null : conn.stderr.trim() || conn.stdout.trim() || 'connect failed' }
}

export function serialFromMdnsInstance(instance: string): string | null {
  const m = instance.match(/^adb-(.+?)-[A-Za-z0-9]{6}$/)
  return m ? m[1] : null
}

export async function discoverWirelessTarget(deviceSerial?: string | null): Promise<WirelessTarget | null> {
  const services = await mdnsServices()
  const connects = services.filter((s) => s.type.includes('tls-connect'))
  if (connects.length === 0) return null
  const match = deviceSerial ? connects.find((s) => s.instance.includes(deviceSerial) || s.raw.includes(deviceSerial)) : undefined
  const pick = match ?? connects[0]
  return { host: pick.host, port: pick.port, instance: pick.instance, deviceSerial: serialFromMdnsInstance(pick.instance) }
}

export async function deviceSerialNumber(serial: string): Promise<string | null> {
  const res = await shell(serial, 'getprop ro.serialno')
  const s = res.stdout.trim()
  return /^[A-Za-z0-9]{6,}$/.test(s) ? s : null
}

export function disconnectAll(): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, ['disconnect'])
}

export function adbGetState(serial: string): Promise<string | null> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve(null)
  return run(adb, ['-s', serial, 'get-state']).then((res) => (res.ok ? res.stdout.trim() : res.stderr.trim() || null))
}

export function shell(serial: string, command: string, timeoutMs = 60000): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, adbArgs(serial, ['shell', command]), timeoutMs)
}

export function reverseList(serial: string): Promise<string[]> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve([])
  return run(adb, adbArgs(serial, ['reverse', '--list'])).then((res) =>
    res.ok ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
  )
}

export async function ensureReverse(serial: string, ports: number[]): Promise<ReverseResult[]> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return ports.map((port) => ({ port, ok: false, error: 'adb not found' }))
  await run(adb, adbArgs(serial, ['reverse', '--remove-all']))
  const results: ReverseResult[] = []
  for (const port of ports) {
    const res = await run(adb, adbArgs(serial, ['reverse', `tcp:${port}`, `tcp:${port}`]))
    results.push({ port, ok: res.ok, error: res.ok ? undefined : res.stderr.trim() })
  }
  return results
}

export function removeReverse(serial: string, port: number): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, adbArgs(serial, ['reverse', '--remove', `tcp:${port}`]))
}

export function installApk(serial: string, file: string): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, adbArgs(serial, ['install', '-r', '-t', file]), 180000)
}

export function uninstall(serial: string, pkg: string): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, adbArgs(serial, ['uninstall', pkg]))
}

export function getprop(serial: string, props: string[]): Promise<CommandResult> {
  return shell(serial, props.map((p) => `getprop ${p}`).join(' && echo "|" && '))
}

export function wmSize(serial: string): Promise<CommandResult> {
  return shell(serial, 'wm size')
}

export function wmDensity(serial: string): Promise<CommandResult> {
  return shell(serial, 'wm density')
}

export function wmSetSize(serial: string, w: number, h: number): Promise<CommandResult> {
  return shell(serial, `wm size ${w}x${h}`)
}

export function wmSetDensity(serial: string, dpi: number): Promise<CommandResult> {
  return shell(serial, `wm density ${dpi}`)
}

export function wmReset(serial: string): Promise<CommandResult> {
  return shell(serial, 'wm size reset && wm density reset')
}

export function settingsGet(serial: string, namespace: string, key: string): Promise<CommandResult> {
  return shell(serial, `settings get ${namespace} ${key}`)
}

export function settingsPut(serial: string, namespace: string, key: string, value: string): Promise<CommandResult> {
  return shell(serial, `settings put ${namespace} ${key} ${value}`)
}

export function batteryGet(serial: string): Promise<CommandResult> {
  return shell(serial, 'dumpsys battery')
}

export function batterySetLevel(serial: string, level: number): Promise<CommandResult> {
  return shell(serial, `dumpsys battery set level ${level}`)
}

export function batterySetAc(serial: string, on: boolean): Promise<CommandResult> {
  return shell(serial, `dumpsys battery set ac ${on ? 1 : 0}`)
}

export function batteryUnplug(serial: string): Promise<CommandResult> {
  return shell(serial, 'dumpsys battery unplug')
}

export function batteryReset(serial: string): Promise<CommandResult> {
  return shell(serial, 'dumpsys battery reset')
}

const CAPTURES = () => path.join(app.getPath('userData'), 'captures')

function ensureCaptures(): string {
  const dir = CAPTURES()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function captureName(prefix: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(ensureCaptures(), `${prefix}-${stamp}.${ext}`)
}

export async function screencap(serial: string): Promise<{ ok: boolean; file?: string; error?: string }> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return { ok: false, error: 'adb not found' }
  const file = captureName('screenshot', 'png')
  return new Promise((resolveP) => {
    execFile(
      adb,
      adbArgs(serial, ['exec-out', 'screencap', '-p']),
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err) {
          resolveP({ ok: false, error: String(err.message) })
          return
        }
        try {
          writeFileSync(file, stdout as unknown as Buffer)
          resolveP({ ok: true, file })
        } catch (writeErr) {
          resolveP({ ok: false, error: String(writeErr) })
        }
      }
    )
  })
}

export async function screenRecord(
  serial: string,
  seconds: number
): Promise<{ ok: boolean; file?: string; error?: string }> {
  const remote = `/sdcard/cdeck-record-${Date.now()}.mp4`
  const rec = await shell(serial, `screenrecord --time-limit ${seconds} ${remote}`)
  const file = captureName('screenrecord', 'mp4')
  const { path: adb } = resolveAdbPath()
  if (!adb) return { ok: false, error: 'adb not found' }
  const pull = await run(adb, adbArgs(serial, ['pull', remote, file]), 180000)
  await run(adb, adbArgs(serial, ['shell', 'rm', remote])).catch(() => undefined)
  if (!pull.ok) return { ok: false, error: pull.stderr || rec.stderr || 'record failed' }
  return { ok: true, file }
}

export function listPackages(serial: string, thirdPartyOnly = true): Promise<CommandResult> {
  return shell(serial, thirdPartyOnly ? 'pm list packages -3' : 'pm list packages')
}

export function pmPath(serial: string, pkg: string): Promise<CommandResult> {
  return shell(serial, `pm path ${pkg}`)
}

export function pmClear(serial: string, pkg: string): Promise<CommandResult> {
  return shell(serial, `pm clear ${pkg}`)
}

export function pmEnable(serial: string, pkg: string, enable: boolean): Promise<CommandResult> {
  return shell(serial, `pm ${enable ? 'enable' : 'disable'} ${pkg}`)
}

export function amForceStop(serial: string, pkg: string): Promise<CommandResult> {
  return shell(serial, `am force-stop ${pkg}`)
}

export async function resolveLaunchActivity(serial: string, pkg: string): Promise<string | null> {
  const res = await shell(serial, `cmd package resolve-activity --brief ${pkg}`)
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^([a-zA-Z][\w.$\-]+\/[\w.$\-]+)$/)
    if (m) return m[1]
  }
  return null
}

export async function amStartMain(serial: string, pkg: string): Promise<CommandResult> {
  const comp = await resolveLaunchActivity(serial, pkg)
  if (!comp) {
    return {
      ok: false,
      stdout: '',
      stderr: `No launcher activity for ${pkg} — this package has no main screen (background, plugin, or input-method app).`,
      code: null
    }
  }
  return shell(serial, `am start -n ${comp}`)
}

export async function listLaunchablePackages(serial: string): Promise<string[]> {
  const res = await shell(serial, 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER', 120000)
  if (!res.ok) return []
  const out = new Set<string>()
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z][\w.$\-]*)\/[\w.$\-]*$/)
    if (m && !m[1].includes(':')) out.add(m[1])
  }
  return [...out].sort()
}

export function rebootDevice(serial: string, mode: 'device' | 'recovery' | 'bootloader' | 'fastboot'): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  const args = mode === 'device' ? ['-s', serial, 'reboot'] : ['-s', serial, 'reboot', mode]
  return run(adb, args, 15000)
}

export function killAdbServer(): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  return run(adb, ['kill-server'], 15000)
}

export function screenPower(serial: string): Promise<CommandResult> {
  return shell(serial, 'input keyevent 26')
}

export async function deviceUptime(serial: string): Promise<string | null> {
  const res = await shell(serial, 'uptime')
  const m = res.stdout.match(/up\s+([^,]+(?:,\s*\d+\s+\w+)?)/i)
  return m ? m[1].trim() : null
}

export async function appInfo(serial: string, pkg: string): Promise<{ version: string; targetSdk: string; minSdk: string; permissions: string[] }> {
  const res = await shell(serial, `dumpsys package ${pkg}`)
  const version = res.stdout.match(/versionName=([^\s]+)/)?.[1] ?? res.stdout.match(/versionCode=(\d+)/)?.[1] ?? ''
  const targetSdk = res.stdout.match(/targetSdk=(\d+)/)?.[1] ?? ''
  const minSdk = res.stdout.match(/minSdk=(\d+)/)?.[1] ?? ''
  const permissions: string[] = []
  const gra = res.stdout.match(/requested permissions:([\s\S]*?)(?:\n\s*\n|install permissions:|runtime permissions:|User 0:)/i)
  if (gra) {
    for (const raw of gra[1].split('\n')) {
      const line = raw.trim()
      const m = line.match(/^([a-zA-Z][\w.]+\.permission\.[\w.]+)(?::\s*(.*))?$/)
      if (!m) continue
      const granted = /granted=true/.test(m[2] ?? '')
      permissions.push(`${m[1]}:granted=${granted}`)
    }
  }
  return { version, targetSdk, minSdk, permissions }
}

export function grantPermission(serial: string, pkg: string, permission: string): Promise<CommandResult> {
  return shell(serial, `pm grant ${pkg} ${permission}`)
}

export function revokePermission(serial: string, pkg: string, permission: string): Promise<CommandResult> {
  return shell(serial, `pm revoke ${pkg} ${permission}`)
}

export function appOpsSet(serial: string, pkg: string, op: string, mode: string): Promise<CommandResult> {
  return shell(serial, `appops set ${pkg} ${op} ${mode}`)
}

export function installUpdate(serial: string, file: string, downgrade: boolean): Promise<CommandResult> {
  const { path: adb } = resolveAdbPath()
  if (!adb) return Promise.resolve({ ok: false, stdout: '', stderr: 'adb not found', code: null })
  const args = ['-s', serial, 'install', '-r', '-t']
  if (downgrade) args.push('-d')
  args.push(file)
  return run(adb, args, 180000)
}

export async function bugreport(serial: string): Promise<{ ok: boolean; file?: string; error?: string }> {
  const file = captureName('bugreport', 'zip')
  const { path: adb } = resolveAdbPath()
  if (!adb) return { ok: false, error: 'adb not found' }
  const res = await run(adb, ['-s', serial, 'bugreport', file], 180000)
  if (!res.ok) return { ok: false, error: res.stderr.trim() || 'bugreport failed' }
  return { ok: true, file }
}

export function dumpsysService(serial: string, service: string): Promise<CommandResult> {
  return shell(serial, `dumpsys ${service}`, 60000)
}

export async function dumpsysServices(serial: string): Promise<string[]> {
  const res = await shell(serial, 'dumpsys -l')
  return res.ok ? res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort() : []
}

export function perfSnapshot(serial: string): Promise<CommandResult> {
  return shell(serial, 'dumpsys cpuinfo | head -12', 30000)
}

export function memoryInfo(serial: string): Promise<CommandResult> {
  return shell(serial, 'dumpsys meminfo | head -8', 30000)
}

export function networkToggle(serial: string, target: 'wifi' | 'data' | 'airplane', on: boolean): Promise<CommandResult> {
  const state = on ? 'enable' : 'disable'
  if (target === 'airplane') return shell(serial, `cmd connectivity airplane-mode ${on ? 'enable' : 'disable'}`)
  return shell(serial, `svc ${target} ${state}`)
}

export function startLogcatStream(
  serial: string,
  buffers: string[],
  onBatch: (lines: string[]) => void,
  onExit: (code: number | null) => void
): LogcatSession {
  const { path: adb } = resolveAdbPath()
  if (!adb) throw new Error('adb not found')
  const id = `${serial}-${Date.now()}`
  const args = ['-s', serial, 'logcat', '-v', 'threadtime']
  for (const b of buffers) args.push('-b', b)
  if (buffers.length === 0) args.push('-b', 'main')
  const child = spawn(adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let queue: string[] = []
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    if (queue.length === 0) return
    const lines = queue
    queue = []
    onBatch(lines)
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 100)
  }
  const handleData = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const l = line.replace(/\r$/, '')
      if (l.length > 0) queue.push(l)
    }
    if (queue.length >= 500) {
      if (timer) clearTimeout(timer)
      flush()
    } else {
      schedule()
    }
  }
  child.stdout?.on('data', handleData)
  child.stderr?.on('data', handleData)
  child.on('exit', (code) => {
    flush()
    onExit(code)
    logcatSessions.delete(id)
  })
  const session: LogcatSession = {
    id,
    serial,
    startedAt: Date.now(),
    stop: () => {
      if (timer) clearTimeout(timer)
      child.kill()
      logcatSessions.delete(id)
    }
  }
  logcatSessions.set(id, { child, session })
  return session
}

export function localhostProbe(port: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveP) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy()
      resolveP({ ok: true, detail: `127.0.0.1:${port} accepted a connection` })
    })
    sock.setTimeout(2500, () => {
      sock.destroy()
      resolveP({ ok: false, detail: `127.0.0.1:${port} timed out (nothing listening)` })
    })
    sock.on('error', (err: NodeJS.ErrnoException) => {
      resolveP({ ok: false, detail: `127.0.0.1:${port} → ${err.code === 'ECONNREFUSED' ? 'connection refused' : err.code}` })
    })
  })
}

export function amStartDeepLink(serial: string, uri: string, pkg?: string): Promise<CommandResult> {
  const component = pkg ? `-n ${pkg}` : ''
  return shell(serial, `am start -a android.intent.action.VIEW -d "${uri}" ${component}`.trim())
}

export function amBroadcast(serial: string, action: string): Promise<CommandResult> {
  return shell(serial, `am broadcast -a ${action}`)
}

export function inputTap(serial: string, x: number, y: number): Promise<CommandResult> {
  return shell(serial, `input tap ${x} ${y}`)
}

export function inputSwipe(serial: string, x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<CommandResult> {
  return shell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${ms}`)
}

export function inputText(serial: string, text: string): Promise<CommandResult> {
  const escaped = text.replace(/ /g, '%s')
  return shell(serial, `input text "${escaped}"`)
}

export function inputKeyEvent(serial: string, keycode: string): Promise<CommandResult> {
  return shell(serial, `input keyevent ${keycode}`)
}

export function pidof(serial: string, pkg: string): Promise<string | null> {
  return shell(serial, `pidof ${pkg}`).then((res) => {
    const pid = res.stdout.trim().split(/\s+/)[0]
    return pid && /^\d+$/.test(pid) ? pid : null
  })
}

export interface LogcatSession {
  id: string
  serial: string
  startedAt: number
  stop: () => void
}

const logcatSessions = new Map<string, { child: ChildProcess; session: LogcatSession }>()

export function startLogcat(
  serial: string,
  onBatch: (lines: string[]) => void,
  onExit: (code: number | null) => void
): LogcatSession {
  const { path: adb } = resolveAdbPath()
  if (!adb) throw new Error('adb not found')
  const id = `${serial}-${Date.now()}`
  const child = spawn(adb, adbArgs(serial, ['logcat', '-v', 'threadtime', '-b', 'main', '-b', 'system', '-b', 'crash']), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let queue: string[] = []
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    if (queue.length === 0) return
    const lines = queue
    queue = []
    onBatch(lines)
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 100)
  }
  const handleData = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    const parts = text.split('\n')
    for (const line of parts) {
      const l = line.replace(/\r$/, '')
      if (l.length > 0) queue.push(l)
    }
    if (queue.length >= 500) {
      if (timer) clearTimeout(timer)
      flush()
    } else {
      schedule()
    }
  }
  child.stdout?.on('data', handleData)
  child.stderr?.on('data', handleData)
  child.on('exit', (code) => {
    flush()
    onExit(code)
    logcatSessions.delete(id)
  })
  const session: LogcatSession = {
    id,
    serial,
    startedAt: Date.now(),
    stop: () => {
      if (timer) clearTimeout(timer)
      child.kill()
      logcatSessions.delete(id)
    }
  }
  logcatSessions.set(id, { child, session })
  return session
}

export function stopLogcat(id: string): void {
  logcatSessions.get(id)?.session.stop()
}

export function stopAllLogcat(): void {
  for (const { session } of [...logcatSessions.values()]) session.stop()
}
