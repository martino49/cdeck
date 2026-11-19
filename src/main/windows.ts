import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import log from './log'

interface WinState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

type AllState = Record<string, WinState>

function stateFile(): string {
  return path.join(app.getPath('userData'), 'windows.json')
}

let cache: AllState = {}
let timer: NodeJS.Timeout | null = null

export function loadAllState(): AllState {
  try {
    if (existsSync(stateFile())) {
      cache = JSON.parse(readFileSync(stateFile(), 'utf8')) as AllState
    }
  } catch (err) {
    log.warn('window state unreadable', err)
    cache = {}
  }
  return cache
}

export function saveWindowState(id: string, state: WinState): void {
  cache = { ...cache, [id]: state }
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      const tmp = `${stateFile()}.tmp`
      mkdirSync(path.dirname(stateFile()), { recursive: true })
      writeFileSync(tmp, JSON.stringify(cache, null, 2))
      renameSync(tmp, stateFile())
    } catch (err) {
      log.warn('window state save failed', err)
    }
  }, 500)
}

export function getWindowState(id: string, def: WinState): WinState {
  const saved = cache[id]
  if (!saved) return def
  try {
    const point = { x: saved.x ?? 0, y: saved.y ?? 0 }
    const wa = screen.getDisplayNearestPoint(point).workArea
    const width = Math.min(Math.max(saved.width, 640), wa.width)
    const height = Math.min(Math.max(saved.height, 480), wa.height)
    return { ...saved, width, height, maximized: Boolean(saved.maximized) }
  } catch {
    return saved
  }
}

export function attachStatePersistence(win: BrowserWindow, id: string): void {
  const persist = () => {
    if (win.isDestroyed()) return
    const b = win.getBounds()
    saveWindowState(id, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
  }
  win.on('resized', persist)
  win.on('moved', persist)
  win.on('close', persist)
}
