import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { DeviceInfo } from '@shared/types'
import log from './log'

export interface TrayHandlers {
  onShow: () => void
  onPair: () => void
  onMirror: () => void
}

let tray: Tray | null = null

function iconPath(): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'assets', 'tray.ico'),
    path.join(app.getAppPath(), 'build', 'assets', 'tray.ico')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function buildMenu(devices: DeviceInfo[], handlers: TrayHandlers) {
  const deviceItems =
    devices.length > 0
      ? devices.map((d) => ({
          label: `${d.model || d.serial} (${d.state})`,
          enabled: d.state === 'device',
          click: () => handlers.onMirror()
        }))
      : [{ label: 'No devices connected', enabled: false }]
  return Menu.buildFromTemplate([
    { label: 'CDeck', enabled: false },
    { type: 'separator' },
    { label: 'Devices', submenu: deviceItems },
    { type: 'separator' },
    { label: 'Pair new device…', click: handlers.onPair },
    { label: 'Mirror…', click: handlers.onMirror },
    { label: 'Show window', click: handlers.onShow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

export function createTray(handlers: TrayHandlers): void {
  if (tray) return
  const icon = iconPath()
  if (!icon) {
    log.warn('tray icon not found; tray disabled')
    return
  }
  try {
    tray = new Tray(nativeImage.createFromPath(icon))
  } catch (err) {
    log.warn('tray creation failed', err)
    tray = null
    return
  }
  tray.setToolTip('CDeck')
  tray.setContextMenu(buildMenu([], handlers))
  tray.on('click', () => handlers.onShow())
}

export function updateTray(devices: DeviceInfo[], handlers: TrayHandlers): void {
  if (!tray) return
  const connected = devices.filter((d) => d.state === 'device').length
  tray.setToolTip(connected > 0 ? `CDeck - ${connected} device${connected > 1 ? 's' : ''} connected` : 'CDeck - no devices')
  tray.setContextMenu(buildMenu(devices, handlers))
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}