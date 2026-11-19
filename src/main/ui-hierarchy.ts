import { adbRaw as adb, adbShell } from './adb'
import type { UiNodeLike } from '@shared/types'

export type UiNode = UiNodeLike

const REMOTE_DUMP = '/sdcard/cdeck-ui-dump.xml'

function parseAttr(raw: string, name: string): string {
  const m = raw.match(new RegExp(`${name}="([^"]*)"`))
  return m ? m[1] : ''
}

export function parseBounds(value: string): [number, number, number, number] {
  const m = value.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  if (!m) return [0, 0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
}

export function parseUiXml(xml: string): UiNode[] {
  const nodes: UiNode[] = []
  const re = /<node\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1]
    nodes.push({
      text: parseAttr(raw, 'text'),
      resourceId: parseAttr(raw, 'resource-id'),
      className: parseAttr(raw, 'class'),
      contentDesc: parseAttr(raw, 'content-desc'),
      package: parseAttr(raw, 'package'),
      bounds: parseBounds(parseAttr(raw, 'bounds')),
      clickable: parseAttr(raw, 'clickable') === 'true',
      scrollable: parseAttr(raw, 'scrollable') === 'true'
    })
  }
  return nodes
}

export async function dumpUi(serial: string): Promise<UiNode[]> {
  const dump = await adbShell(serial, `uiautomator dump ${REMOTE_DUMP}`, 30000)
  if (!dump.ok && !dump.stdout.includes('dumped')) {
    return []
  }
  const res = await adb(['-s', serial, 'exec-out', 'cat', REMOTE_DUMP], 20000)
  if (!res.ok || res.stdout.length < 20) return []
  return parseUiXml(res.stdout)
}

export interface UiQuery {
  text?: string
  resourceId?: string
  className?: string
  contentDesc?: string
  clickableOnly?: boolean
}

export function matchNode(node: UiNode, q: UiQuery): boolean {
  if (q.clickableOnly && !node.clickable) return false
  const has = (value: string, needle?: string) => !needle || value.toLowerCase().includes(needle.toLowerCase())
  return (
    has(node.text, q.text) &&
    has(node.contentDesc, q.text && !node.text ? q.text : q.contentDesc) &&
    has(node.resourceId, q.resourceId) &&
    has(node.className, q.className) &&
    has(node.contentDesc, q.contentDesc)
  )
}

export async function findNodes(serial: string, q: UiQuery): Promise<UiNode[]> {
  const nodes = await dumpUi(serial)
  return nodes.filter((n) => matchNode(n, q))
}

export function centerOf(node: UiNode): { x: number; y: number } {
  const [x1, y1, x2, y2] = node.bounds
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

export async function currentPackage(serial: string): Promise<string | null> {
  const res = await adbShell(serial, 'dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp"')
  const focus = res.stdout.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/}\s]+)/)?.[1] ?? res.stdout.match(/([a-zA-Z][\w.]+)\//)?.[1]
  return focus ?? null
}

export async function crashCountSince(serial: string): Promise<number> {
  const res = await adb(['-s', serial, 'logcat', '-d', '-b', 'crash', '-t', '400'], 20000)
  if (!res.ok) return 0
  return (res.stdout.match(/FATAL EXCEPTION/g) ?? []).length
}

export async function clearCrashBuffer(serial: string): Promise<void> {
  await adb(['-s', serial, 'logcat', '-b', 'crash', '-c'], 10000)
}