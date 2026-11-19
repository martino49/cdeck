export interface DeviceInfo {
  serial: string
  state: string
  model?: string
  product?: string
  device?: string
  transportId?: string
  transport?: 'usb' | 'tcpip'
}

export interface ToolInfo {
  name: 'adb' | 'scrcpy' | 'platform-tools'
  present: boolean
  path: string | null
  version: string | null
  source: 'custom' | 'bundled' | 'path'
  downloadedBytes?: number
  totalBytes?: number
  stage?: string
}

export interface MdnsService {
  instance: string
  type: string
  host: string
  port: number
  raw: string
}

export interface NetworkInfo {
  phoneIp: string | null
  phoneSsid: string | null
  wifiEnabled: boolean | null
  wifiConnected: boolean | null
  laptopSsid: string | null
  laptopIps: string[]
  sameNetwork: boolean | null
}

export interface PingResult {
  ip: string
  reachable: boolean
  avgMs: number | null
}

export interface WirelessSetupResult {
  ok: boolean
  ip: string | null
  port: number
  steps: string[]
  error: string | null
}

export interface LastWireless {
  serial: string
  ip: string
  port: number
  deviceSerial?: string | null
}

export interface WirelessTarget {
  host: string
  port: number
  instance: string
  deviceSerial: string | null
}

export interface DeviceProfile {
  alias?: string
  tags?: string[]
  tunnels?: number[]
  scrcpyProfile?: string
  autoMirror?: boolean
}

export interface DeviceGroup {
  id: string
  name: string
  members: string[]
}

export interface IntentEntry {
  uri: string
  pkg?: string | null
  at: number
}

export type MacroStep =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string }
  | { type: 'wait'; ms: number }
  | { type: 'assertText'; contains: string; timeoutMs?: number }
  | { type: 'assertApp'; package: string; timeoutMs?: number }
  | { type: 'assertNoCrash'; windowMs?: number }
  | { type: 'screenshot'; label?: string }

export interface Macro {
  id: string
  name: string
  deviceSerial?: string | null
  steps: MacroStep[]
  createdAt: number
  updatedAt: number
}

export interface AuditEntry {
  at: number
  action: string
  target: string
  detail?: string
}

export interface FileEntryLike {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: string
}

export interface UiNodeLike {
  text: string
  resourceId: string
  className: string
  contentDesc: string
  package: string
  bounds: [number, number, number, number]
  clickable: boolean
  scrollable: boolean
}

export interface SuiteResult {
  macroId: string
  name: string
  ok: boolean
  startedAt: number
  durationMs: number
  steps: Array<{ index: number; type: string; ok: boolean; detail: string; at: number }>
  artifacts: string[]
}

export interface ScrcpyProfile {
  id: string
  name: string
  description: string
  args: string[]
}

export interface ScrcpySession {
  pid: number
  serial: string
  profile: string
  startedAt: number
}

export interface ReverseResult {
  port: number
  ok: boolean
  error?: string
}

export interface WatchdogState {
  running: boolean
  lastAction: string
  lastError: string | null
  reconnects: number
  checks: number
  lastTarget: string | null
}

export interface Settings {
  deviceSerial: string | null
  tunnels: number[]
  scrcpyProfile: string
  scrcpyExtra: string[]
  watchdogEnabled: boolean
  watchdogIntervalSec: number
  customAdbPath: string | null
  customScrcpyPath: string | null
  updateRepo: string | null
  minimizeToTray: boolean
  autoMirror: boolean
  shortcutsEnabled: boolean
  startOnLogin: boolean
  launchMinimized: boolean
  theme: 'dark' | 'light' | 'system'
  uiZoom: number
  localApiEnabled: boolean
  localApiPort: number
  onboarded: boolean
}

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

export interface ViewportInfo {
  size: string
  density: string
}

export interface UpdateInfo {
  version: string
  current: string
  newer: boolean
  size: number | null
  downloadUrl: string | null
  notes: string
  publishedAt: string | null
  error?: string
}

export const cdeck_API = 'cdeck' as const
