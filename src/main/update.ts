import { net, app } from 'electron'
import type { UpdateInfo } from '@shared/types'
import log from './log'
import { loadStore } from './store'

interface GitHubAsset {
  name: string
  size: number
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  body: string
  published_at: string
  html_url: string
  assets: GitHubAsset[]
}

async function fetchJson(url: string): Promise<GitHubRelease> {
  const res = await net.fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'cdeck', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
  return (await res.json()) as GitHubRelease
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const repo = loadStore().settings.updateRepo?.trim()
  const current = app.getVersion()
  if (!repo) {
    return {
      version: '',
      current,
      newer: false,
      size: null,
      downloadUrl: null,
      notes: '',
      publishedAt: null,
      error: 'No repository configured (Settings → Updates)'
    }
  }
  try {
    const latest = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`)
    const asset = (latest.assets ?? []).find((a) => /cdeck.*-setup\.exe$/i.test(a.name))
    const version = (latest.tag_name ?? '').replace(/^v/, '')
    return {
      version: version || 'unknown',
      current,
      newer: version !== current && version > current,
      size: asset?.size ?? null,
      downloadUrl: asset?.browser_download_url ?? latest.html_url,
      notes: latest.body ?? '',
      publishedAt: latest.published_at ?? null
    }
  } catch (err) {
    log.warn('update check failed', err)
    return {
      version: '',
      current,
      newer: false,
      size: null,
      downloadUrl: null,
      notes: '',
      publishedAt: null,
      error: String(err)
    }
  }
}
