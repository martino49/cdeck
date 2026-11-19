import { adb, adbShell } from './adb.js'

export interface UiNode {
  text: string
  resourceId: string
  className: string
  contentDesc: string
  package: string
  bounds: [number, number, number, number]
  clickable: boolean
}

const REMOTE_DUMP = '/sdcard/cdeck-mcp-ui.xml'

function attr(raw: string, name: string): string {
  const m = raw.match(new RegExp(`${name}="([^"]*)"`))
  return m ? m[1] : ''
}

export function parseBounds(v: string): [number, number, number, number] {
  const m = v.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0, 0]
}

export function parseUiXml(xml: string): UiNode[] {
  const out: UiNode[] = []
  const re = /<node\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1]
    out.push({
      text: attr(raw, 'text'),
      resourceId: attr(raw, 'resource-id'),
      className: attr(raw, 'class'),
      contentDesc: attr(raw, 'content-desc'),
      package: attr(raw, 'package'),
      bounds: parseBounds(attr(raw, 'bounds')),
      clickable: attr(raw, 'clickable') === 'true'
    })
  }
  return out
}

export async function dumpUi(serial: string): Promise<UiNode[]> {
  await adbShell(serial, `uiautomator dump ${REMOTE_DUMP}`, 30000)
  const res = await adb(['-s', serial, 'exec-out', 'cat', REMOTE_DUMP], 20000)
  return res.ok && res.stdout.length > 20 ? parseUiXml(res.stdout) : []
}

export interface UiQuery {
  text?: string
  resourceId?: string
  className?: string
  contentDesc?: string
  clickableOnly?: boolean
}

export function matchNode(n: UiNode, q: UiQuery): boolean {
  const inc = (v: string, needle?: string) => !needle || v.toLowerCase().includes(needle.toLowerCase())
  if (q.clickableOnly && !n.clickable) return false
  const textHit = inc(n.text, q.text) || inc(n.contentDesc, q.text)
  return textHit && inc(n.resourceId, q.resourceId) && inc(n.className, q.className) && inc(n.contentDesc, q.contentDesc)
}

export function centerOf(n: UiNode): { x: number; y: number } {
  const [x1, y1, x2, y2] = n.bounds
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
}

export async function findNodes(serial: string, q: UiQuery): Promise<UiNode[]> {
  return (await dumpUi(serial)).filter((n) => matchNode(n, q))
}

export async function waitFor(serial: string, q: UiQuery, timeoutMs: number): Promise<{ found: boolean; elapsedMs: number; node?: UiNode }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const nodes = (await dumpUi(serial)).filter((n) => matchNode(n, q))
    if (nodes.length > 0) return { found: true, elapsedMs: Date.now() - start, node: nodes[0] }
    await new Promise((r) => setTimeout(r, 600))
  }
  return { found: false, elapsedMs: Date.now() - start }
}

export async function currentPackage(serial: string): Promise<string | null> {
  const res = await adbShell(serial, 'dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp"')
  return res.stdout.match(/mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/}\s]+)/)?.[1] ?? res.stdout.match(/([a-zA-Z][\w.]+)\//)?.[1] ?? null
}