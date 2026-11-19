import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AuditEntry, DeviceGroup, DeviceProfile, IntentEntry, LastWireless, Macro, Settings } from '@shared/types'

export interface StoreShape {
  settings: Settings
  lastTarget: string | null
  lastWireless: LastWireless | null
  devices: Record<string, DeviceProfile>
  groups: DeviceGroup[]
  intents: IntentEntry[]
  macros: Macro[]
  audit: AuditEntry[]
  apiToken: string
  tunnelModes: Record<string, 'reverse' | 'forward'>
}

function randomToken(): string {
  let out = ''
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  for (let i = 0; i < 40; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

const defaults: Settings = {
  deviceSerial: null,
  tunnels: [3000, 5432, 8080],
  scrcpyProfile: 'daily',
  scrcpyExtra: [],
  watchdogEnabled: true,
  watchdogIntervalSec: 5,
  customAdbPath: null,
  customScrcpyPath: null,
  updateRepo: null,
  minimizeToTray: true,
  autoMirror: false,
  shortcutsEnabled: true,
  startOnLogin: false,
  launchMinimized: false,
  theme: 'dark',
  uiZoom: 1,
  localApiEnabled: false,
  localApiPort: 7799,
  onboarded: false
}

function legacyFile(): string {
  return path.join(app.getPath('appData'), 'droidlink', 'droidlink.json')
}

function file(): string {
  return path.join(app.getPath('userData'), 'cdeck.json')
}

function migrateLegacyStore(): void {
  try {
    if (!existsSync(file()) && existsSync(legacyFile())) {
      copyFileSync(legacyFile(), file())
    }
  } catch {
    /* first run under the new name keeps defaults */
  }
}

export function loadStore(): StoreShape {
  migrateLegacyStore()
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<StoreShape>
      const lw = parsed.lastWireless
      const lastWireless =
        lw && typeof lw.ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(lw.ip) && typeof lw.port === 'number'
          ? { serial: String(lw.serial ?? ''), ip: lw.ip, port: lw.port, deviceSerial: lw.deviceSerial ?? null }
          : null
      return {
        settings: { ...defaults, ...(parsed.settings ?? {}) },
        lastTarget: parsed.lastTarget ?? null,
        lastWireless,
        devices: parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        intents: Array.isArray(parsed.intents) ? parsed.intents.slice(0, 100) : [],
        macros: Array.isArray(parsed.macros) ? parsed.macros : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit.slice(-500) : [],
        apiToken: typeof parsed.apiToken === 'string' && parsed.apiToken.length >= 20 ? parsed.apiToken : randomToken(),
        tunnelModes: parsed.tunnelModes && typeof parsed.tunnelModes === 'object' ? (parsed.tunnelModes as Record<string, 'reverse' | 'forward'>) : {}
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { settings: { ...defaults }, lastTarget: null, lastWireless: null, devices: {}, groups: [], intents: [], macros: [], audit: [], apiToken: randomToken(), tunnelModes: {} }
}

export function saveStore(store: StoreShape): void {
  try {
    const trimmed: StoreShape = { ...store, audit: store.audit.slice(-500), intents: store.intents.slice(0, 100) }
    writeFileSync(file(), JSON.stringify(trimmed, null, 2))
  } catch {
    /* best effort persistence */
  }
}

export function recordAudit(action: string, target: string, detail?: string): void {
  try {
    const store = loadStore()
    store.audit.push({ at: Date.now(), action, target, detail })
    if (store.audit.length > 500) store.audit = store.audit.slice(-500)
    saveStore(store)
  } catch {
    /* audit is best-effort */
  }
}

export function profileFor(serial: string): DeviceProfile {
  return loadStore().devices[serial] ?? {}
}

export function updateProfile(serial: string, patch: Partial<DeviceProfile>): DeviceProfile {
  const store = loadStore()
  const next = { ...(store.devices[serial] ?? {}), ...patch }
  store.devices[serial] = next
  saveStore(store)
  return next
}

export const defaultSettings = defaults