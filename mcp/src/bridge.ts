import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface AppBridge {
  url: string
  token: string
}

export function findAppBridge(): AppBridge | null {
  try {
    const appData = process.env.APPDATA
    if (!appData) return null
    const file = path.join(appData, 'cdeck', 'cdeck.json')
    if (!existsSync(file)) return null
    const store = JSON.parse(readFileSync(file, 'utf8')) as {
      settings?: { localApiEnabled?: boolean; localApiPort?: number }
      apiToken?: string
    }
    if (!store.settings?.localApiEnabled || !store.apiToken) return null
    const port = store.settings.localApiPort ?? 7799
    return { url: `http://127.0.0.1:${port}`, token: store.apiToken }
  } catch {
    return null
  }
}

export async function bridgeGet(bridge: AppBridge, route: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${bridge.url}${route}`, {
      headers: { 'x-cdeck-token': bridge.token },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

export async function bridgePost(bridge: AppBridge, route: string, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const res = await fetch(`${bridge.url}${route}`, {
      method: 'POST',
      headers: { 'x-cdeck-token': bridge.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

export async function bridgeScreenshot(bridge: AppBridge, serial: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${bridge.url}/screenshot?serial=${encodeURIComponent(serial)}`, {
      headers: { 'x-cdeck-token': bridge.token },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}