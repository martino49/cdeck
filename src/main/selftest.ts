import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  adbVersion,
  batteryGet,
  listDevices,
  mdnsServices,
  resolveAdbPath,
  resolveScrcpyPath,
  shell,
  wmDensity,
  wmSize,
  reverseList,
  ensureReverse
} from './adb'
import { toolStatuses } from './tools'
import { Watchdog } from './watchdog'
import log from './log'

export interface SelftestCheck {
  name: string
  ok: boolean
  detail: string
}

export function selftestRequested(): boolean {
  return process.argv.includes('--selftest') || process.env.CDECK_SELFTEST === '1'
}

export function selftestReportPath(): string {
  return path.join(app.getPath('userData'), 'selftest.json')
}

export async function runSelftest(): Promise<number> {
  const checks: SelftestCheck[] = []
  const { settings } = await import('./store').then((m) => m.loadStore())

  const adbResolved = resolveAdbPath()
  checks.push({
    name: 'adb resolution',
    ok: Boolean(adbResolved.path),
    detail: `${adbResolved.path ?? 'none'} (${adbResolved.source})`
  })
  if (adbResolved.path) {
    const version = await adbVersion()
    checks.push({ name: 'adb version', ok: Boolean(version), detail: version ?? 'unknown' })
    const devices = await listDevices()
    checks.push({ name: 'adb devices', ok: true, detail: `${devices.length} device(s)` })
    const mdns = await mdnsServices()
    checks.push({ name: 'adb mdns', ok: true, detail: `${mdns.length} service(s)` })
    const live = devices.find((d) => d.state === 'device')
    if (live) {
      const state = await shell(live.serial, 'getprop ro.build.version.release')
      checks.push({ name: 'device shell', ok: state.ok, detail: state.stdout.trim() })
      const size = await wmSize(live.serial)
      const density = await wmDensity(live.serial)
      checks.push({ name: 'viewport', ok: size.ok, detail: `${size.stdout.trim()} / ${density.stdout.trim()}` })
      const battery = await batteryGet(live.serial)
      checks.push({ name: 'battery', ok: battery.ok, detail: battery.ok ? 'readable' : battery.stderr })
      const tunnels = settings.tunnels.length > 0 ? await ensureReverse(live.serial, settings.tunnels) : []
      const tunnelsOk = tunnels.every((t) => t.ok)
      checks.push({
        name: 'reverse tunnels',
        ok: tunnelsOk,
        detail: tunnels.map((t) => `tcp:${t.port} ${t.ok ? 'ok' : 'fail'}`).join(', ')
      })
      const listed = await reverseList(live.serial)
      checks.push({ name: 'reverse list', ok: true, detail: `${listed.length} rule(s)` })
    } else {
      checks.push({ name: 'device ops', ok: true, detail: 'skipped (no device in device state)' })
    }
  }

  const tools = await toolStatuses()
  for (const t of tools) {
    checks.push({ name: `tool ${t.name}`, ok: t.present, detail: `${t.version ?? 'unknown'} (${t.source})` })
  }

  let reconcile = 'skipped'
  try {
    const wd = new Watchdog({
      onState: () => undefined,
      onTunnels: () => undefined
    })
    await wd.reconcile()
    reconcile = wd.getState().lastAction
    wd.stop()
    checks.push({ name: 'watchdog reconcile', ok: true, detail: reconcile })
  } catch (err) {
    checks.push({ name: 'watchdog reconcile', ok: false, detail: String(err) })
  }

  const failed = checks.filter((c) => !c.ok)
  const report = {
    at: new Date().toISOString(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    checks,
    passed: checks.length - failed.length,
    total: checks.length
  }
  const dir = app.getPath('userData')
  const file = path.join(dir, 'selftest.json')
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, JSON.stringify(report, null, 2))
  } catch (err) {
    log.warn('selftest write failed', err)
  }
  log.info('selftest complete', { passed: report.passed, total: report.total, file })
  console.log(`selftest: ${report.passed}/${report.total} checks passed → ${file}`)
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`)
  }
  return failed.length === 0 ? 0 : 1
}
