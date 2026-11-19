import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { CommandResult } from '@shared/types'

const execFileAsync = promisify(execFile)

const tracked = new Set<ChildProcess>()

export function run(cmd: string, args: string[], timeoutMs = 30000): Promise<CommandResult> {
  return new Promise((resolveP) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        resolveP({
          ok: false,
          stdout: String(stdout ?? ''),
          stderr: killed ? `timed out after ${timeoutMs}ms: ${String(stderr ?? err.message)}` : String(stderr ?? err.message),
          code: typeof err.code === 'number' ? err.code : null
        })
      } else {
        resolveP({ ok: true, stdout: String(stdout), stderr: String(stderr), code: 0 })
      }
    })
  })
}

export function spawnTracked(cmd: string, args: string[], opts: { detached?: boolean; stdio?: 'ignore' | 'pipe' } = {}): ChildProcess {
  const child = spawn(cmd, args, {
    windowsHide: true,
    detached: opts.detached ?? false,
    stdio: opts.stdio ?? 'ignore'
  })
  tracked.add(child)
  child.on('exit', () => tracked.delete(child))
  return child
}

export function treeKill(pid: number): Promise<boolean> {
  return new Promise((resolveP) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
      resolveP(!err)
    })
  })
}

export async function killTrackedTree(): Promise<void> {
  const pids = [...tracked].map((c) => c.pid).filter((p): p is number => typeof p === 'number')
  tracked.clear()
  await Promise.all(pids.map((pid) => treeKill(pid)))
}

export function trackedPids(): number[] {
  return [...tracked].map((c) => c.pid).filter((p): p is number => typeof p === 'number')
}

const SHOTS_DIR = () => path.join(app.getPath('userData'), 'captures')

export function capturesDir(): string {
  return SHOTS_DIR()
}

export function uniqueCapturePath(ext: string, prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return path.join(SHOTS_DIR(), `${prefix}-${stamp}.${ext}`)
}

export async function writeBinary(file: string, data: Buffer): Promise<void> {
  writeFileSync(file, data)
}

export { execFileAsync }
