import { spawn, type ChildProcess } from 'node:child_process'
import type { ScrcpyProfile, ScrcpySession } from '@shared/types'
import { resolveScrcpyPath } from './adb'

export const PROFILES: ScrcpyProfile[] = [
  {
    id: 'daily',
    name: 'Daily (USB, screen off)',
    description: 'Screen off while mirroring, stays awake, real keyboard/mouse via UHID. Best for all-day coding.',
    args: ['--turn-screen-off', '--stay-awake', '--keyboard=uhid', '--mouse=uhid']
  },
  {
    id: 'wireless',
    name: 'Wireless (low bandwidth)',
    description: 'Reduced resolution/bitrate/fps for Wi-Fi, keeps the phone active without a cable.',
    args: ['--turn-screen-off', '--keep-active', '-b2M', '-m800', '--max-fps=30']
  },
  {
    id: 'cover',
    name: 'Cover screen (Flip6)',
    description: 'Mirrors only the 3.4" cover window at its native size, orientation locked. Adjust --crop if your cover dims differ.',
    args: ['--turn-screen-off', '-m748', '--crop=720:748:0:0', '--capture-orientation=@0', '-b4M']
  },
  {
    id: 'quality',
    name: 'Quality (video/UI review)',
    description: 'High bitrate H.265 at 60fps for design review and screen recording.',
    args: ['--video-codec=h265', '-b12M', '--max-fps=60']
  },
  {
    id: 'plain',
    name: 'Plain (vanilla defaults)',
    description: 'No flags. Use when a flag is causing trouble on your OEM build.',
    args: []
  }
]

export function profile(id: string): ScrcpyProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0]
}

const sessions = new Map<number, { child: ChildProcess; session: ScrcpySession }>()

export interface LaunchResult {
  ok: boolean
  session?: ScrcpySession
  error?: string
}

export function launchScrcpy(serial: string, profileId: string, extraArgs: string[] = []): LaunchResult {
  const { path: scrcpy } = resolveScrcpyPath()
  if (!scrcpy) return { ok: false, error: 'scrcpy not found. Install it from the Tools panel.' }
  const args = ['-s', serial, '--window-title', `CDeck :: ${serial}`, ...profile(profileId).args, ...extraArgs]
  const child = spawn(scrcpy, args, { windowsHide: false, stdio: 'ignore' })
  const pid = child.pid ?? -1
  const session: ScrcpySession = {
    pid,
    serial,
    profile: profileId,
    startedAt: Date.now()
  }
  child.on('error', (err) => {
    sessions.delete(pid)
  })
  child.on('exit', () => {
    sessions.delete(pid)
  })
  sessions.set(pid, { child, session })
  return { ok: true, session }
}

export function stopScrcpy(pid: number): boolean {
  const entry = sessions.get(pid)
  if (!entry) return false
  entry.child.kill()
  sessions.delete(pid)
  return true
}

export function stopAllScrcpy(): void {
  for (const pid of [...sessions.keys()]) stopScrcpy(pid)
}

export function listSessions(): ScrcpySession[] {
  return [...sessions.values()].map((s) => s.session)
}