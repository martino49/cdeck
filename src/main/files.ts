import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { adbRaw, shell, screencap, listPackages, deviceUptime } from './adb'
import { run } from './process'
import log from './log'

export interface FileEntry {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: string
}

const SAFE_ROOTS = ['/sdcard', '/storage', '/data/local/tmp', '/system/etc']

export function isSafeDevicePath(p: string): boolean {
  const norm = p.replace(/\/+/g, '/')
  if (!norm.startsWith('/')) return false
  if (norm.includes('..')) return false
  return SAFE_ROOTS.some((root) => norm === root || norm.startsWith(root + '/'))
}

export async function listDir(serial: string, dir: string): Promise<{ ok: boolean; entries: FileEntry[]; error?: string }> {
  if (!isSafeDevicePath(dir)) return { ok: false, entries: [], error: 'path outside allowed roots' }
  const res = await shell(serial, `ls -la ${dir.replace(/ /g, '\\ ')}`, 30000)
  if (!res.ok && res.stdout.trim().length === 0) return { ok: false, entries: [], error: res.stderr.trim() || 'ls failed' }
  const entries: FileEntry[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('total ') || t.startsWith('ls:')) continue
    const parts = t.split(/\s+/)
    if (parts.length < 8) continue
    const perms = parts[0]
    const size = Number(parts[4]) || 0
    const date = parts[5]
    const time = parts[6]
    const name = parts.slice(7).join(' ')
    if (name === '.' || name === '..') continue
    if (name.includes(' -> ')) continue
    const isDir = perms.startsWith('d')
    entries.push({
      name,
      path: `${dir.replace(/\/$/, '')}/${name}`,
      dir: isDir,
      size,
      mtime: `${date} ${time}`
    })
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return { ok: true, entries }
}

export function pushFile(serial: string, local: string, remote: string): Promise<{ ok: boolean; detail: string }> {
  if (!isSafeDevicePath(remote)) return Promise.resolve({ ok: false, detail: 'destination outside allowed roots' })
  return adbRaw(['-s', serial, 'push', local, remote], 300000).then((r) => ({ ok: r.ok, detail: (r.stdout || r.stderr).trim() }))
}

export function pullFile(serial: string, remote: string, local: string): Promise<{ ok: boolean; detail: string }> {
  return adbRaw(['-s', serial, 'pull', remote, local], 300000).then((r) => ({ ok: r.ok, detail: (r.stdout || r.stderr).trim() }))
}

export function deleteFile(serial: string, remote: string): Promise<{ ok: boolean; detail: string }> {
  if (!isSafeDevicePath(remote)) return Promise.resolve({ ok: false, detail: 'path outside allowed roots' })
  return shell(serial, `rm -rf "${remote}"`).then((r) => ({ ok: r.ok, detail: (r.stdout || r.stderr).trim() }))
}

export function renameFile(serial: string, from: string, to: string): Promise<{ ok: boolean; detail: string }> {
  if (!isSafeDevicePath(from) || !isSafeDevicePath(to)) return Promise.resolve({ ok: false, detail: 'path outside allowed roots' })
  return shell(serial, `mv "${from}" "${to}"`).then((r) => ({ ok: r.ok, detail: (r.stdout || r.stderr).trim() }))
}

export function makeDir(serial: string, dir: string): Promise<{ ok: boolean; detail: string }> {
  if (!isSafeDevicePath(dir)) return Promise.resolve({ ok: false, detail: 'path outside allowed roots' })
  return shell(serial, `mkdir -p "${dir}"`).then((r) => ({ ok: r.ok, detail: (r.stdout || r.stderr).trim() }))
}

export async function bugBundle(serial: string, includeBugreport: boolean): Promise<{ ok: boolean; file?: string; error?: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const staging = path.join(app.getPath('userData'), 'staging', `bundle-${stamp}`)
  const outDir = path.join(app.getPath('userData'), 'captures')
  try {
    mkdirSync(staging, { recursive: true })
    mkdirSync(outDir, { recursive: true })
  } catch (err) {
    return { ok: false, error: String(err) }
  }

  const settle = async (name: string, work: Promise<unknown>, timeoutMs = 120000): Promise<void> => {
    await Promise.race([work.catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))])
    void name
  }

  const props = ['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.build.fingerprint']
  const [info, logcat, battery, uptime, packages] = await Promise.all([
    shell(serial, props.map((p) => `getprop ${p}`).join(';')),
    adbRaw(['-s', serial, 'logcat', '-d', '-v', 'threadonly', '-t', '4000'], 60000),
    shell(serial, 'dumpsys battery'),
    deviceUptime(serial),
    listPackages(serial, true)
  ])
  writeFileSync(path.join(staging, 'device-info.txt'), `model: ${info.stdout.split('\n')[0]?.trim()}\n${props.join('\n')}\n\n${info.stdout}`)
  writeFileSync(path.join(staging, 'logcat.txt'), logcat.stdout)
  writeFileSync(path.join(staging, 'battery.txt'), battery.stdout)
  writeFileSync(path.join(staging, 'uptime.txt'), uptime ?? 'unknown')
  writeFileSync(path.join(staging, 'packages.txt'), packages.stdout)
  writeFileSync(
    path.join(staging, 'perf.txt'),
    `${(await shell(serial, 'dumpsys cpuinfo | head -15')).stdout}\n\n${(await shell(serial, 'dumpsys meminfo | head -12')).stdout}`
  )
  const shot = await screencap(serial)
  if (shot.ok && shot.file) {
    try {
      writeFileSync(path.join(staging, 'screenshot.png'), readFileSync(shot.file))
    } catch {
      /* screenshot copy is best effort */
    }
  }
  writeFileSync(path.join(staging, 'meta.json'), JSON.stringify({ serial, at: new Date().toISOString(), appVersion: app.getVersion() }, null, 2))

  if (includeBugreport) {
    await settle('bugreport', adbRaw(['-s', serial, 'bugreport', path.join(staging, 'bugreport.zip')], 600000), 600000)
  }

  const out = path.join(outDir, `bundle-${stamp}.zip`)
  const tar = await run('tar.exe', ['-a', '-c', '-f', out, '-C', staging, '.'], 120000)
  try {
    rmSync(staging, { recursive: true, force: true })
  } catch {
    /* cleanup best effort */
  }
  if (!tar.ok || !existsSync(out)) return { ok: false, error: tar.stderr.trim() || 'zip failed' }
  return { ok: true, file: out }
}

export function capturesDir(): string {
  return path.join(app.getPath('userData'), 'captures')
}

export function statLocal(file: string): { size: number } | null {
  try {
    return { size: statSync(file).size }
  } catch {
    return null
  }
}

export function logBundleFailure(err: unknown): void {
  log.warn('bundle failed', { error: String(err) })
}