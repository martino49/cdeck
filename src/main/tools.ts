import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import type { ToolInfo } from '@shared/types'
import { binRoot, run, resolveAdbPath, resolveScrcpyPath } from './adb'

export interface ToolProgress {
  tool: 'adb' | 'platform-tools' | 'scrcpy'
  stage: 'resolving' | 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  receivedBytes: number
  totalBytes: number
  message?: string
}

type ProgressCb = (p: ToolProgress) => void

export async function migrateLegacyBin(): Promise<void> {
  const legacy = path.join(app.getPath('appData'), 'droidlink', 'bin')
  if (!existsSync(legacy)) return
  try {
    for (const name of ['scrcpy', 'platform-tools']) {
      const from = path.join(legacy, name)
      const to = path.join(binRoot(), name)
      if (existsSync(from) && !existsSync(to)) await cp(from, to, { recursive: true })
    }
  } catch {
    /* best effort; the Tools page can re-download */
  }
}

function cacheDir(): string {
  return path.join(binRoot(), 'cache')
}

function ensureDirs(): void {
  for (const d of [binRoot(), cacheDir()]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

function fetchText(url: string, redirects = 0): Promise<string> {
  return new Promise((resolveP, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' })
    let body = ''
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      res.on('data', (chunk) => {
        body += chunk.toString('utf8')
      })
      res.on('end', () => resolveP(body))
    })
    req.on('error', (err) => {
      if (redirects < 3 && /redirect|30[12378]/i.test(err.message)) {
        setTimeout(() => fetchText(url, redirects + 1).then(resolveP, reject), 500)
        return
      }
      reject(err)
    })
    req.end()
  })
}

function downloadFile(url: string, dest: string, onProgress?: ProgressCb, tool: ToolProgress['tool'] = 'scrcpy'): Promise<string> {
  return new Promise((resolveP, reject) => {
    const req = net.request({ method: 'GET', url, redirect: 'follow' })
    let received = 0
    const total = 0
    const tmp = `${dest}.part`
    const file = createWriteStream(tmp)
    req.on('response', (res) => {
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`))
        return
      }
      const len = Number(res.headers['content-length'] ?? 0)
      res.on('data', (chunk) => {
        received += chunk.byteLength
        file.write(chunk)
        onProgress?.({ tool, stage: 'downloading', receivedBytes: received, totalBytes: len || total })
      })
      res.on('end', () => {
        file.end(() => {
          renameSync(tmp, dest)
          resolveP(dest)
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function extractZip(zip: string, destDir: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const tar = spawn('tar', ['-xf', zip, '-C', destDir], { windowsHide: true })
    let stderr = ''
    tar.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    tar.on('error', () => reject(new Error('tar.exe not available (Windows 10 1803+ ships it)')))
    tar.on('exit', (code) => {
      if (code === 0) resolveP()
      else reject(new Error(`extraction failed: ${stderr.trim()}`))
    })
  })
}

async function latestScrcpyAssetUrl(): Promise<string> {
  const fallback = 'https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-win64-v5.0.1.zip'
  try {
    const body = await fetchText('https://api.github.com/repos/Genymobile/scrcpy/releases/latest')
    const json = JSON.parse(body) as { assets?: Array<{ name: string; browser_download_url: string }>; tag_name?: string }
    const assets = json.assets ?? []
    const arch = process.arch === 'arm64' ? 'win64' : 'win64'
    const pick =
      assets.find((a) => new RegExp(`^scrcpy-${arch}-v.*\\.zip$`, 'i').test(a.name)) ??
      assets.find((a) => /^scrcpy-win64-v.*\.zip$/i.test(a.name)) ??
      assets.find((a) => /\.zip$/.test(a.name) && /win/i.test(a.name))
    if (pick) return pick.browser_download_url
  } catch {
    /* fall through to pinned fallback */
  }
  return fallback
}

export interface EnsureResult {
  ok: boolean
  path?: string
  error?: string
}

export async function ensureScrcpy(onProgress?: ProgressCb): Promise<EnsureResult> {
  const { path: existing } = resolveScrcpyPath()
  if (existing) {
    onProgress?.({ tool: 'scrcpy', stage: 'done', receivedBytes: 0, totalBytes: 0, message: 'already available' })
    return { ok: true, path: existing }
  }
  ensureDirs()
  const destDir = path.join(binRoot(), 'scrcpy')
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  try {
    onProgress?.({ tool: 'scrcpy', stage: 'resolving', receivedBytes: 0, totalBytes: 0 })
    const url = await latestScrcpyAssetUrl()
    const zip = path.join(cacheDir(), 'scrcpy.zip')
    onProgress?.({ tool: 'scrcpy', stage: 'downloading', receivedBytes: 0, totalBytes: 0 })
    await downloadFile(url, zip, onProgress, 'scrcpy')
    onProgress?.({ tool: 'scrcpy', stage: 'extracting', receivedBytes: 0, totalBytes: 0 })
    await extractZip(zip, destDir)
    onProgress?.({ tool: 'scrcpy', stage: 'verifying', receivedBytes: 0, totalBytes: 0 })
    const exe = path.join(destDir, 'scrcpy.exe')
    if (!existsSync(exe)) {
      return { ok: false, error: `extracted but scrcpy.exe not found in ${destDir}` }
    }
    onProgress?.({ tool: 'scrcpy', stage: 'done', receivedBytes: 0, totalBytes: 0, message: destDir })
    return { ok: true, path: exe }
  } catch (err) {
    onProgress?.({ tool: 'scrcpy', stage: 'error', receivedBytes: 0, totalBytes: 0, message: String(err) })
    return { ok: false, error: String(err) }
  }
}

export async function ensurePlatformTools(onProgress?: ProgressCb): Promise<EnsureResult> {
  ensureDirs()
  const destDir = path.join(binRoot(), 'platform-tools')
  try {
    onProgress?.({ tool: 'platform-tools', stage: 'downloading', receivedBytes: 0, totalBytes: 0 })
    const zip = path.join(cacheDir(), 'platform-tools.zip')
    const url = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'
    await downloadFile(url, zip, onProgress, 'platform-tools')
    onProgress?.({ tool: 'platform-tools', stage: 'extracting', receivedBytes: 0, totalBytes: 0 })
    await extractZip(zip, destDir)
    onProgress?.({ tool: 'platform-tools', stage: 'verifying', receivedBytes: 0, totalBytes: 0 })
    const adbExe = path.join(destDir, 'platform-tools', 'adb.exe')
    if (!existsSync(adbExe)) {
      return { ok: false, error: `extracted but adb.exe not found under ${destDir}` }
    }
    onProgress?.({ tool: 'platform-tools', stage: 'done', receivedBytes: 0, totalBytes: 0, message: destDir })
    return { ok: true, path: adbExe }
  } catch (err) {
    onProgress?.({ tool: 'platform-tools', stage: 'error', receivedBytes: 0, totalBytes: 0, message: String(err) })
    return { ok: false, error: String(err) }
  }
}

export async function toolStatuses(): Promise<ToolInfo[]> {
  const adbInfo = resolveAdbPath()
  const scrcpyInfo = resolveScrcpyPath()
  const adbVer = adbInfo.path ? await run(adbInfo.path, ['version']) : null
  const scrcpyVer = scrcpyInfo.path ? await run(scrcpyInfo.path, ['--version']) : null
  const parseVer = (res: { stdout: string } | null): string | null => {
    if (!res) return null
    const m = res.stdout.match(/(?:Version|scrcpy)\s+(\S+)/i)
    return m ? m[1] : res.stdout.split(/\r?\n/)[0]?.trim() || null
  }
  const sizeOf = (p: string | null): number | undefined => {
    if (!p) return undefined
    try {
      return statSync(p).size / (1024 * 1024)
    } catch {
      return undefined
    }
  }
  return [
    {
      name: 'adb',
      present: Boolean(adbInfo.path),
      path: adbInfo.path,
      version: parseVer(adbVer),
      source: adbInfo.source
    },
    {
      name: 'scrcpy',
      present: Boolean(scrcpyInfo.path),
      path: scrcpyInfo.path,
      version: parseVer(scrcpyVer),
      source: scrcpyInfo.source,
      downloadedBytes: sizeOf(scrcpyInfo.path)
    }
  ]
}

export function clearToolCache(): { ok: boolean; error?: string } {
  try {
    const dir = cacheDir()
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
