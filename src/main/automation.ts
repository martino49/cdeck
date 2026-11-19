import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Macro, MacroStep, SuiteResult } from '@shared/types'
import { adbRaw as adb, adbShell, screencap } from './adb'
import { centerOf, clearCrashBuffer, crashCountSince, currentPackage, dumpUi, findNodes, matchNode } from './ui-hierarchy'
import log from './log'

const ANDROID_KEYS: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  MENU: 82,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  ENTER: 66,
  DEL: 67,
  SPACE: 62,
  TAB: 61,
  APP_SWITCH: 187
}

export interface AutomationEvents {
  onStep?: (result: { index: number; type: string; ok: boolean; detail: string; at: number }) => void
  onSuite?: (result: SuiteResult) => void
  onLog?: (message: string) => void
}

function artifactsDir(macroId: string): string {
  const dir = path.join(app.getPath('userData'), 'artifacts', `${macroId}-${Date.now()}`)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* best effort */
  }
  return dir
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function evalAssertText(serial: string, contains: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const nodes = await dumpUi(serial)
    if (nodes.some((n) => matchNode(n, { text: contains }) || n.contentDesc.toLowerCase().includes(contains.toLowerCase()))) {
      return { ok: true, detail: `found "${contains}"` }
    }
    last = `${nodes.length} nodes on screen`
    await sleep(600)
  }
  return { ok: false, detail: `"${contains}" not found within ${timeoutMs}ms (${last})` }
}

async function evalAssertApp(serial: string, pkg: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs
  let current = ''
  while (Date.now() < deadline) {
    current = (await currentPackage(serial)) ?? ''
    if (current === pkg) return { ok: true, detail: `foreground is ${pkg}` }
    await sleep(500)
  }
  return { ok: false, detail: `expected ${pkg}, saw ${current || 'unknown'}` }
}

async function runStep(serial: string, step: MacroStep, index: number, dir: string): Promise<{ ok: boolean; detail: string; artifacts: string[] }> {
  const artifacts: string[] = []
  switch (step.type) {
    case 'tap': {
      const res = await adbShell(serial, `input tap ${Math.round(step.x)} ${Math.round(step.y)}`)
      return { ok: res.ok, detail: `tap ${Math.round(step.x)},${Math.round(step.y)}`, artifacts }
    }
    case 'swipe': {
      const res = await adbShell(serial, `input swipe ${step.x1} ${step.y1} ${step.x2} ${step.y2} ${step.durationMs}`)
      return { ok: res.ok, detail: `swipe ${step.x1},${step.y1} → ${step.x2},${step.y2} (${step.durationMs}ms)`, artifacts }
    }
    case 'key': {
      const code = ANDROID_KEYS[step.key.toUpperCase()]
      if (code == null) return { ok: false, detail: `unknown key ${step.key}`, artifacts }
      const res = await adbShell(serial, `input keyevent ${code}`)
      return { ok: res.ok, detail: `key ${step.key}`, artifacts }
    }
    case 'text': {
      const escaped = step.text.replace(/ /g, '%s').replace(/["'`$\\]/g, '')
      const res = await adbShell(serial, `input text "${escaped}"`)
      return { ok: res.ok, detail: `text ${step.text.length} chars`, artifacts }
    }
    case 'wait': {
      await sleep(Math.min(Math.max(step.ms, 0), 120000))
      return { ok: true, detail: `waited ${step.ms}ms`, artifacts }
    }
    case 'assertText': {
      const r = await evalAssertText(serial, step.contains, step.timeoutMs ?? 5000)
      if (!r.ok) {
        const shot = await screencap(serial)
        if (shot.ok && shot.file) artifacts.push(shot.file)
      }
      return { ok: r.ok, detail: r.detail, artifacts }
    }
    case 'assertApp':
      return { ...(await evalAssertApp(serial, step.package, step.timeoutMs ?? 5000)), artifacts }
    case 'assertNoCrash': {
      const windowMs = step.windowMs ?? 1500
      const before = await crashCountSince(serial)
      await sleep(windowMs)
      const after = await crashCountSince(serial)
      const ok = after <= before
      if (!ok) {
        const shot = await screencap(serial)
        if (shot.ok && shot.file) artifacts.push(shot.file)
      }
      return { ok, detail: ok ? `no crash in ${windowMs}ms` : 'FATAL EXCEPTION appeared', artifacts }
    }
    case 'screenshot': {
      const shot = await screencap(serial)
      if (shot.ok && shot.file) {
        artifacts.push(shot.file)
        return { ok: true, detail: `screenshot ${path.basename(shot.file)}`, artifacts }
      }
      return { ok: false, detail: shot.error ?? 'screenshot failed', artifacts }
    }
    default:
      return { ok: false, detail: `unsupported step (index ${index})`, artifacts }
  }
}

export async function runMacro(macro: Macro, serial: string, events: AutomationEvents = {}): Promise<SuiteResult> {
  const startedAt = Date.now()
  const dir = artifactsDir(macro.id)
  const steps: SuiteResult['steps'] = []
  const artifacts: string[] = []
  log.info('automation: run start', { macro: macro.name, serial, steps: macro.steps.length })

  if (macro.steps.some((s) => s.type === 'assertNoCrash')) {
    await clearCrashBuffer(serial).catch(() => undefined)
  }

  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i]
    let result = { ok: false, detail: 'not executed', artifacts: [] as string[] }
    try {
      result = await runStep(serial, step, i, dir)
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : String(e), artifacts: [] }
    }
    const record = { index: i, type: step.type, ok: result.ok, detail: result.detail, at: Date.now() }
    steps.push(record)
    artifacts.push(...result.artifacts)
    events.onStep?.(record)
    events.onLog?.(`step ${i + 1}/${macro.steps.length} ${step.type}: ${result.ok ? 'ok' : 'FAIL'} — ${result.detail}`)
    if (!result.ok) break
  }

  const ok = steps.every((s) => s.ok) && steps.length === macro.steps.length
  const result: SuiteResult = {
    macroId: macro.id,
    name: macro.name,
    ok,
    startedAt,
    durationMs: Date.now() - startedAt,
    steps,
    artifacts
  }
  try {
    writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2))
  } catch {
    /* best effort */
  }
  events.onSuite?.(result)
  log.info('automation: run done', { macro: macro.name, ok, steps: steps.length })
  return result
}

export async function runSuite(macros: Macro[], serial: string, events: AutomationEvents = {}): Promise<SuiteResult[]> {
  const results: SuiteResult[] = []
  for (const macro of macros) {
    results.push(await runMacro(macro, serial, events))
  }
  return results
}

export function toMaestroYaml(macro: Macro): string {
  const lines: string[] = [`appId: ${macro.deviceSerial ? '// set appId' : 'com.example.app'}`, '---']
  for (const step of macro.steps) {
    switch (step.type) {
      case 'tap':
        lines.push(`- tapOn:\n    point: "${Math.round(step.x)},${Math.round(step.y)}"`)
        break
      case 'swipe':
        lines.push(`- swipe:\n    start: "${step.x1},${step.y1}"\n    end: "${step.x2},${step.y2}"\n    duration: ${step.durationMs}`)
        break
      case 'key':
        lines.push(`- pressKey: ${step.key}`)
        break
      case 'text':
        lines.push(`- inputText: "${step.text.replace(/"/g, '\\"')}"`)
        break
      case 'wait':
        lines.push(`- waitForAnimationToEnd:\n    timeout: ${step.ms}`)
        break
      case 'assertText':
        lines.push(`- assertVisible: "${step.contains.replace(/"/g, '\\"')}"`)
        break
      case 'assertApp':
        lines.push(`- assertVisible: "${step.package}"`)
        break
      case 'assertNoCrash':
        lines.push('- assertVisible: "// no crash expected"')
        break
      case 'screenshot':
        lines.push(`- takeScreenshot: ${step.label ?? macro.id}`)
        break
    }
  }
  return lines.join('\n') + '\n'
}

export function fromMaestroYaml(text: string, name: string): Macro {
  const steps: MacroStep[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let m: RegExpMatchArray | null
    if ((m = line.match(/^- tapOn:/))) {
      const point = lines[i + 1]?.match(/point:\s*"?(\d+)\s*,\s*(\d+)"?/)
      if (point) steps.push({ type: 'tap', x: Number(point[1]), y: Number(point[2]) })
    } else if ((m = line.match(/^- swipe:/))) {
      const start = lines[i + 1]?.match(/start:\s*"?(\d+)\s*,\s*(\d+)"?/)
      const end = lines[i + 2]?.match(/end:\s*"?(\d+)\s*,\s*(\d+)"?/)
      const dur = lines[i + 3]?.match(/duration:\s*(\d+)/)
      if (start && end) {
        steps.push({
          type: 'swipe',
          x1: Number(start[1]),
          y1: Number(start[2]),
          x2: Number(end[1]),
          y2: Number(end[2]),
          durationMs: dur ? Number(dur[1]) : 300
        })
      }
    } else if ((m = line.match(/^- pressKey:\s*(\w+)/))) {
      steps.push({ type: 'key', key: m[1] })
    } else if ((m = line.match(/^- inputText:\s*"([^"]*)"/))) {
      steps.push({ type: 'text', text: m[1].replace(/\\"/g, '"') })
    } else if ((m = line.match(/^- assertVisible:\s*"([^"]*)"/))) {
      steps.push({ type: 'assertText', contains: m[1].replace(/\\"/g, '"') })
    } else if ((m = line.match(/^- takeScreenshot:\s*(\S+)/))) {
      steps.push({ type: 'screenshot', label: m[1] })
    } else if ((m = line.match(/^- waitForAnimationToEnd:/))) {
      const t = lines[i + 1]?.match(/timeout:\s*(\d+)/)
      steps.push({ type: 'wait', ms: t ? Number(t[1]) : 1000 })
    }
  }
  const now = Date.now()
  return { id: `m${now}`, name, deviceSerial: null, steps, createdAt: now, updatedAt: now }
}

export function toJUnit(results: SuiteResult[]): string {
  const failures = results.filter((r) => !r.ok).length
  const cases = results
    .map((r) => {
      const fail = r.steps.find((s) => !s.ok)
      return `    <testcase name="${escapeXml(r.name)}" classname="cdeck" time="${(r.durationMs / 1000).toFixed(3)}">${
        r.ok ? '' : `\n      <failure message="${escapeXml(fail?.detail ?? 'failed')}" />\n    `
      }</testcase>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cdeck" tests="${results.length}" failures="${failures}">\n${cases}\n</testsuite>\n`
}

export function toHtmlReport(results: SuiteResult[]): string {
  const rows = results
    .map(
      (r) => `<details ${r.ok ? '' : 'open'}><summary>${r.ok ? '✅' : '❌'} ${escapeHtml(r.name)} — ${(r.durationMs / 1000).toFixed(1)}s</summary>
<table>${r.steps
        .map(
          (s) =>
            `<tr><td>${s.index + 1}</td><td>${escapeHtml(s.type)}</td><td>${s.ok ? 'ok' : 'FAIL'}</td><td>${escapeHtml(s.detail)}</td></tr>`
        )
        .join('')}</table>${r.artifacts.length ? `<p>artifacts: ${r.artifacts.map((a) => escapeHtml(path.basename(a))).join(', ')}</p>` : ''}</details>`
    )
    .join('\n')
  return `<!doctype html><meta charset="utf-8"><title>CDeck test report</title><style>body{font:14px system-ui;margin:24px;background:#111;color:#eee}details{margin:8px 0;border:1px solid #333;border-radius:6px;padding:8px}table{border-collapse:collapse;margin-top:6px}td{border:1px solid #333;padding:3px 8px}</style><h1>CDeck test report</h1><p>${results.filter((r) => r.ok).length}/${results.length} passed</p>${rows}`
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c)
}
function escapeHtml(s: string): string {
  return escapeXml(s)
}

export interface RecorderContext {
  serial: string
  startedAt: number
  steps: MacroStep[]
}

export function macroFromSteps(name: string, serial: string | null, steps: MacroStep[]): Macro {
  const now = Date.now()
  return { id: `m${now}`, name, deviceSerial: serial, steps, createdAt: now, updatedAt: now }
}

export { findNodes, centerOf, dumpUi }