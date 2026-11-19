import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const LEVEL_COLORS: Record<string, string> = {
  V: 'text-dim',
  D: 'text-dim',
  I: 'text-accent',
  W: 'text-warn',
  E: 'text-err',
  F: 'text-err'
}

export interface ParsedLogLine {
  raw: string
  time: string
  pid: string
  level: string
  tag: string
  message: string
}

const THREADTIME_RE = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?)\s*:\s+([\s\S]*)$/

export function parseLogLine(raw: string): ParsedLogLine {
  const m = THREADTIME_RE.exec(raw)
  if (!m) {
    return { raw, time: '', pid: '', level: '', tag: '', message: raw }
  }
  return { raw, time: m[1], pid: m[2], level: m[4], tag: m[5], message: m[6] }
}

export function levelColor(level: string): string {
  return LEVEL_COLORS[level] ?? 'text-fg'
}
