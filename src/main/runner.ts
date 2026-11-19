import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { SuiteResult } from '@shared/types'
import { listDevices } from './adb'
import { fromMaestroYaml, runSuite, toHtmlReport, toJUnit } from './automation'
import { loadStore } from './store'
import log from './log'

export interface RunnerArgs {
  target: string
  serial: string | null
  outputDir: string
  format: 'junit' | 'html' | 'json' | 'all'
}

export const EXIT = {
  pass: 0,
  testFailure: 1,
  infraFailure: 2,
  badArgs: 3
} as const

export function parseRunnerArgs(argv: string[]): RunnerArgs | null {
  const suiteIndex = argv.indexOf('--run-suite')
  if (suiteIndex === -1) return null
  const target = argv[suiteIndex + 1]
  if (!target || target.startsWith('--')) return null
  const serialIndex = argv.indexOf('--serial')
  const outIndex = argv.indexOf('--output')
  const fmtIndex = argv.indexOf('--format')
  const fmt = fmtIndex > -1 ? argv[fmtIndex + 1] : 'all'
  return {
    target,
    serial: serialIndex > -1 && argv[serialIndex + 1] && !argv[serialIndex + 1].startsWith('--') ? argv[serialIndex + 1] : null,
    outputDir: outIndex > -1 && argv[outIndex + 1] && !argv[outIndex + 1].startsWith('--') ? argv[outIndex + 1] : path.join(process.cwd(), 'cdeck-results'),
    format: fmt === 'junit' || fmt === 'html' || fmt === 'json' ? fmt : 'all'
  }
}

function writeArtifacts(results: SuiteResult[], args: RunnerArgs): string[] {
  const dir = path.resolve(args.outputDir)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const put = (name: string, data: string) => {
    const file = path.join(dir, name)
    writeFileSync(file, data)
    written.push(file)
  }
  if (args.format === 'json' || args.format === 'all') put('results.json', JSON.stringify(results, null, 2))
  if (args.format === 'junit' || args.format === 'all') put('junit.xml', toJUnit(results))
  if (args.format === 'html' || args.format === 'all') put('report.html', toHtmlReport(results))
  return written
}

export async function runHeadlessSuite(args: RunnerArgs): Promise<number> {
  let flows: import('@shared/types').Macro[] = []

  const resolveSerial = async (): Promise<string | null> => {
    if (args.serial) return args.serial
    const devices = await listDevices()
    const usable = devices.filter((d) => d.state === 'device')
    if (usable.length === 0) {
      log.error('headless runner: no device connected', { devices: devices.map((d) => `${d.serial}=${d.state}`) })
      return null
    }
    return usable[0].serial
  }

  const serial = await resolveSerial()
  if (!serial) {
    console.error(`cdeck: infrastructure failure - no device connected (exit ${EXIT.infraFailure})`)
    return EXIT.infraFailure
  }

  if (existsSync(args.target)) {
    const name = path.basename(args.target).replace(/\.(ya?ml)$/i, '')
    flows = [fromMaestroYaml(readFileSync(args.target, 'utf8'), name)]
  } else {
    const macros = loadStore().macros
    const macro = macros.find((m) => m.id === args.target || m.name === args.target)
    if (!macro) {
      console.error(`cdeck: not a file or saved macro: ${args.target} (exit ${EXIT.badArgs})`)
      return EXIT.badArgs
    }
    flows = [macro]
  }

  const runResults = await runSuite(flows, serial, {
    onStep: (r) => console.log(`  [${r.index + 1}] ${r.type}: ${r.ok ? 'ok' : 'FAIL'} — ${r.detail}`),
    onSuite: () => undefined,
    onLog: (m) => console.log(`  ${m}`)
  })
  const written = writeArtifacts(runResults, args)
  const passed = runResults.filter((r) => r.ok).length
  console.log(`cdeck: ${passed}/${runResults.length} flow(s) passed — ${args.format} written to ${path.resolve(args.outputDir)}`)
  for (const f of written) console.log(`  ${f}`)
  return passed === runResults.length && runResults.length > 0 ? EXIT.pass : EXIT.testFailure
}

export function runnerExitMessage(code: number): string {
  switch (code) {
    case EXIT.pass:
      return 'all flows passed'
    case EXIT.testFailure:
      return 'one or more assertions failed'
    case EXIT.infraFailure:
      return 'infrastructure failure (device/adb)'
    default:
      return 'invalid arguments or suite not found'
  }
}

export function runnerLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'runner.log')
}