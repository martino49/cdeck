import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

import { adb, adbBinary, adbShell, adbPath, ANDROID_KEYS, listDevices, pickDevice, type CmdResult } from './adb.js'
import { centerOf, currentPackage, dumpUi, findNodes, matchNode, waitFor } from './ui.js'
import { bridgeGet, bridgePost, bridgeScreenshot, findAppBridge } from './bridge.js'

const bridge = findAppBridge()

const SERVER_NAME = 'cdeck-mcp'
const SERVER_VERSION = '0.1.0'

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const err = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })
const ok = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: structured
})

function requireString(args: Record<string, unknown>, key: string, max = 400): string {
  const v = args[key]
  if (typeof v !== 'string' || v.trim().length === 0) throw new Error(`missing or invalid "${key}" (expected a non-empty string)`)
  return v.trim().slice(0, max)
}

function optionalString(args: Record<string, unknown>, key: string, max = 400): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : undefined
}

function optionalNumber(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const v = args[key]
  if (typeof v !== 'number' || Number.isNaN(v)) return fallback
  return Math.min(Math.max(Math.round(v), min), max)
}

const DENY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|mkfs|dd\s+if=/, why: 'destructive filesystem operation' },
  { re: /\bsu\b/, why: 'root escalation' },
  { re: /reboot\s+bootloader|fastboot\s+-w|pm\s+uninstall\s+(-k\s+)?android|pm\s+clear\s+com\.android\.(settings|systemui|launcher)/, why: 'device-breaking operation' },
  { re: /setprop\s+persist\.sys\.usb|svc\s+usb/, why: 'breaks the adb transport' }
]

function guardShell(command: string, riskAck: boolean): string | null {
  for (const p of DENY_PATTERNS) {
    if (p.re.test(command)) {
      if (!riskAck) return `Refused: ${p.why} ("${command}"). Re-run with risk_ack: true only if you are certain.`
      return null
    }
  }
  if (/\brm\b/.test(command) && !riskAck) return 'Refused: rm on a device is destructive. Re-run with risk_ack: true if sure.'
  return null
}

const TOOLS: ToolDef[] = [
  {
    name: 'device_list',
    description:
      'List connected Android devices with serial, model, state (device/unauthorized/offline) and transport (usb/wifi). Always call this first if unsure what is attached.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    handler: async () => {
      if (bridge) {
        const res = (await bridgeGet(bridge, '/devices')) as { devices?: Array<{ serial: string; model: string | null; state: string; transport: string }> } | null
        if (res?.devices) {
          const list = res.devices
          return ok(
            list.length === 0
              ? 'No devices connected. (via CDeck app)'
              : `${list.length} device(s) (via CDeck app, shared session):\n${list.map((d) => `- ${d.serial} | ${d.model ?? '?'} | ${d.state} | ${d.transport}`).join('\n')}`,
            { devices: list, source: 'cdeck-app' }
          )
        }
      }
      const devices = await listDevices()
      return ok(
        devices.length === 0 ? 'No devices connected.' : `${devices.length} device(s):\n${devices.map((d) => `- ${d.serial} | ${d.model ?? '?'} | ${d.state} | ${d.transport}`).join('\n')}`,
        { devices: devices.map((d) => ({ serial: d.serial, model: d.model ?? null, state: d.state, transport: d.transport })) }
      )
    }
  },
  {
    name: 'device_info',
    description: 'Get model, manufacturer, Android version, SDK level, screen size, density, battery for a device.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string', description: 'Device serial; defaults to the only connected device.' } }
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const props = ['ro.product.model', 'ro.product.manufacturer', 'ro.build.version.release', 'ro.build.version.sdk']
      const res = await adbShell(d.serial, props.map((p) => `getprop ${p}`).join(';'))
      const values = res.stdout.split('\n').map((l) => l.trim())
      const size = await adbShell(d.serial, 'wm size')
      const density = await adbShell(d.serial, 'wm density')
      const battery = await adbShell(d.serial, 'dumpsys battery')
      const info = {
        serial: d.serial,
        model: values[0] ?? '',
        manufacturer: values[1] ?? '',
        release: values[2] ?? '',
        sdk: values[3] ?? '',
        screen: size.stdout.trim(),
        density: density.stdout.trim(),
        batteryLevel: battery.stdout.match(/level:\s*(\d+)/)?.[1] ?? null,
        charging: battery.stdout.match(/AC powered:\s*(\w+)/)?.[1] === 'true'
      }
      return ok(JSON.stringify(info, null, 2), info)
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture the current screen as a PNG image (full device resolution). Call this after any state-changing action to verify the result. Coordinates for input_* tools are in device pixels matching this image.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string' } }
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      if (bridge) {
        const viaApp = await bridgeScreenshot(bridge, d.serial)
        if (viaApp && viaApp.length > 0) {
          return {
            content: [
              { type: 'image', data: viaApp.toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: `screenshot of ${d.serial} via CDeck app (${viaApp.length} bytes)` }
            ]
          }
        }
      }
      const res = await adbBinary(['-s', d.serial, 'exec-out', 'screencap', '-p'], 30000)
      if (!res.ok || res.data.length === 0) return err(`screenshot failed: ${res.stderr.trim()}`)
      return {
        content: [
          { type: 'image', data: res.data.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `screenshot of ${d.serial} (${res.data.length} bytes, device pixels = image pixels)` }
        ]
      }
    }
  },
  {
    name: 'input_tap',
    description: 'Tap the screen at device pixel coordinates (x, y). Get the pixel size from the screenshot you just took.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, serial: { type: 'string' } },
      required: ['x', 'y']
    },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const x = optionalNumber(args, 'x', 0, 100000, -1)
      const y = optionalNumber(args, 'y', 0, 100000, -1)
      if (x < 0 || y < 0) return err('x and y must be numbers in device pixels')
      const res = await adbShell(d.serial, `input tap ${x} ${y}`)
      return res.ok ? ok(`tapped ${x},${y}`) : err(res.stderr.trim())
    }
  },
  {
    name: 'input_swipe',
    description: 'Swipe/drag from (x1,y1) to (x2,y2) over durationMs (default 300).',
    inputSchema: {
      type: 'object',
      properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, durationMs: { type: 'number' }, serial: { type: 'string' } },
      required: ['x1', 'y1', 'x2', 'y2']
    },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const cmd = `input swipe ${optionalNumber(args, 'x1', 0, 100000, 0)} ${optionalNumber(args, 'y1', 0, 100000, 0)} ${optionalNumber(args, 'x2', 0, 100000, 0)} ${optionalNumber(args, 'y2', 0, 100000, 0)} ${optionalNumber(args, 'durationMs', 0, 20000, 300)}`
      const res = await adbShell(d.serial, cmd)
      return res.ok ? ok(`swiped ${cmd.split(' ').slice(2).join(' ')}`) : err(res.stderr.trim())
    }
  },
  {
    name: 'input_text',
    description: 'Type text into the focused field. Use input_key ENTER to submit.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, serial: { type: 'string' } }, required: ['text'] },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const text = requireString(args, 'text', 2000).replace(/ /g, '%s').replace(/["'`$\\]/g, '')
      const res = await adbShell(d.serial, `input text "${text}"`)
      return res.ok ? ok(`typed ${text.length} chars`) : err(res.stderr.trim())
    }
  },
  {
    name: 'input_key',
    description: 'Send a hardware key event. Keys: HOME, BACK, MENU, POWER, VOLUME_UP, VOLUME_DOWN, ENTER, DEL, SPACE, APP_SWITCH, CAMERA, PLAY_PAUSE.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', enum: Object.keys(ANDROID_KEYS) }, serial: { type: 'string' } }, required: ['key'] },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const key = requireString(args, 'key', 20).toUpperCase()
      const code = ANDROID_KEYS[key]
      if (code == null) return err(`unknown key "${key}". Valid: ${Object.keys(ANDROID_KEYS).join(', ')}`)
      const res = await adbShell(d.serial, `input keyevent ${code}`)
      return res.ok ? ok(`pressed ${key}`) : err(res.stderr.trim())
    }
  },
  {
    name: 'app_list',
    description: 'List installed packages, optionally only third-party ones.',
    inputSchema: { type: 'object', properties: { thirdPartyOnly: { type: 'boolean', default: true }, serial: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const res = await adbShell(d.serial, args.thirdPartyOnly === false ? 'pm list packages' : 'pm list packages -3')
      if (!res.ok) return err(res.stderr.trim())
      const packages = res.stdout.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort()
      return ok(`${packages.length} packages:\n${packages.join('\n')}`, { count: packages.length, packages: packages.slice(0, 500) })
    }
  },
  {
    name: 'app_start',
    description: 'Launch an installed app by package name (resolves its launcher activity, like the CDeck UI does).',
    inputSchema: { type: 'object', properties: { package: { type: 'string' }, serial: { type: 'string' } }, required: ['package'] },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const pkg = requireString(args, 'package', 200)
      const resolved = await adbShell(d.serial, `cmd package resolve-activity --brief ${pkg}`)
      const lines = resolved.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      const comp = lines.reverse().find((l) => /^[a-zA-Z][\w.$\-]+\/[\w.$\-]+$/.test(l))
      if (!comp) return err(`No launcher activity for ${pkg} — it has no main screen (background or plugin app).`)
      const res = await adbShell(d.serial, `am start -n ${comp}`)
      return res.ok ? ok(`started ${comp}`) : err(res.stderr.trim() || res.stdout.trim())
    }
  },
  {
    name: 'app_stop',
    description: 'Force-stop a running package.',
    inputSchema: { type: 'object', properties: { package: { type: 'string' }, serial: { type: 'string' } }, required: ['package'] },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const res = await adbShell(d.serial, `am force-stop ${requireString(args, 'package', 200)}`)
      return res.ok ? ok('force-stopped') : err(res.stderr.trim())
    }
  },
  {
    name: 'app_current',
    description: 'Get the package and activity currently in the foreground.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const res = await adbShell(d.serial, 'dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp"')
      const focus = res.stdout.match(/mCurrentFocus=[^\s]+ ({[^}]+})/)?.[1] ?? res.stdout.trim()
      const pkg = focus.match(/([a-zA-Z][\w.]+)\//)?.[1] ?? ''
      return ok(focus || 'no focused window', { component: focus || null, package: pkg || null })
    }
  },
  {
    name: 'app_info',
    description: 'Get an app version, target/min SDK and its requested runtime permissions.',
    inputSchema: { type: 'object', properties: { package: { type: 'string' }, serial: { type: 'string' } }, required: ['package'] },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const pkg = requireString(args, 'package', 200)
      const res = await adbShell(d.serial, `dumpsys package ${pkg}`)
      const permissions: string[] = []
      const section = res.stdout.match(/requested permissions:([\s\S]*?)(?:\n\s*\n|install permissions:|runtime permissions:|User 0:)/i)
      if (section) {
        for (const line of section[1].split('\n')) {
          const m = line.trim().match(/^([a-zA-Z][\w.]+\.permission\.[\w.]+)(?::\s*(.*))?$/)
          if (m) permissions.push(`${m[1]}:granted=${/granted=true/.test(m[2] ?? '')}`)
        }
      }
      const info = {
        package: pkg,
        version: res.stdout.match(/versionName=([^\s]+)/)?.[1] ?? res.stdout.match(/versionCode=(\d+)/)?.[1] ?? '',
        targetSdk: res.stdout.match(/targetSdk=(\d+)/)?.[1] ?? '',
        minSdk: res.stdout.match(/minSdk=(\d+)/)?.[1] ?? '',
        permissions
      }
      return ok(JSON.stringify(info, null, 2), info)
    }
  },
  {
    name: 'shell_exec',
    description:
      'Run one adb shell command on the device and return stdout+stderr+exit code. Destructive commands are refused unless risk_ack is true. Prefer the dedicated tools (input_*, app_*, logcat_get) whenever one fits.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run on the device (not prefixed with "adb").' },
        timeoutMs: { type: 'number', description: 'Timeout 1000–120000, default 30000.' },
        risk_ack: { type: 'boolean', description: 'Set true to acknowledge a command the server flagged as risky.' },
        serial: { type: 'string' }
      },
      required: ['command']
    },
    annotations: { openWorldHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const command = requireString(args, 'command', 2000)
      const blocked = guardShell(command, args.risk_ack === true)
      if (blocked) return err(blocked)
      const res: CmdResult = await adbShell(d.serial, command, optionalNumber(args, 'timeoutMs', 1000, 120000, 30000))
      return ok(JSON.stringify({ command, exitCode: res.code, stdout: res.stdout.slice(0, 100000), stderr: res.stderr.slice(0, 100000) }, null, 2), { exitCode: res.code })
    }
  },
  {
    name: 'logcat_get',
    description:
      'Return the most recent device log lines (bounded). Use level (V/D/I/W/E/F), tag, or contains filters to narrow. Streams not required.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'How many recent lines, 10–2000 (default 200).' },
        contains: { type: 'string', description: 'Substring filter.' },
        level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum level, default V.' },
        serial: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const count = optionalNumber(args, 'lines', 10, 2000, 200)
      const level = optionalString(args, 'level', 1) ?? 'V'
      const res = await adb(['-s', d.serial, 'logcat', '-d', '-v', 'threadtime', '-t', String(count), `*:${level}`], 30000)
      if (!res.ok && !res.stdout) return err(res.stderr.trim())
      let lines = res.stdout.split('\n').filter((l) => l.trim().length > 0)
      const contains = optionalString(args, 'contains', 200)
      if (contains) lines = lines.filter((l) => l.toLowerCase().includes(contains.toLowerCase()))
      const text = lines.slice(-count).join('\n')
      return ok(text || 'no matching log lines', { lineCount: lines.length })
    }
  },
  {
    name: 'dumpsys',
    description: 'Run dumpsys <service> on the device (window, activity, battery, cpuinfo, meminfo, gfxinfo, package, jobscheduler, alarm…).',
    inputSchema: { type: 'object', properties: { service: { type: 'string' }, serial: { type: 'string' } }, required: ['service'] },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const service = requireString(args, 'service', 80).replace(/[^\w.-]/g, '')
      const res = await adbShell(d.serial, `dumpsys ${service}`, 60000)
      if (!res.ok && !res.stdout) return err(res.stderr.trim())
      return ok(res.stdout.slice(0, 150000), { service, bytes: res.stdout.length })
    }
  },
  {
    name: 'file_push',
    description: 'Push a file from this PC to the device (e.g. /sdcard/Download/).',
    inputSchema: { type: 'object', properties: { localPath: { type: 'string' }, remotePath: { type: 'string' }, serial: { type: 'string' } }, required: ['localPath', 'remotePath'] },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const local = requireString(args, 'localPath', 500)
      const remote = requireString(args, 'remotePath', 500)
      if (!/\/(sdcard|storage|data\/local\/tmp)\//.test(remote)) return err('remotePath must live under /sdcard/, /storage/ or /data/local/tmp/')
      const res = await adb(['-s', d.serial, 'push', local, remote], 180000)
      return res.ok ? ok(res.stdout.trim()) : err(res.stderr.trim() || res.stdout.trim())
    }
  },
  {
    name: 'file_pull',
    description: 'Pull a file from the device to this PC.',
    inputSchema: { type: 'object', properties: { remotePath: { type: 'string' }, localPath: { type: 'string' }, serial: { type: 'string' } }, required: ['remotePath', 'localPath'] },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const res = await adb(['-s', d.serial, 'pull', requireString(args, 'remotePath', 500), requireString(args, 'localPath', 500)], 180000)
      return res.ok ? ok(res.stdout.trim()) : err(res.stderr.trim() || res.stdout.trim())
    }
  },
  {
    name: 'ui_dump',
    description:
      'Dump the accessibility/UI hierarchy of the current screen as a list of nodes (text, resource-id, class, content-desc, bounds, clickable). Use this to find elements to tap precisely, or to verify screen state without vision.',
    inputSchema: {
      type: 'object',
      properties: {
        clickableOnly: { type: 'boolean', description: 'Only return clickable nodes.' },
        contains: { type: 'string', description: 'Only return nodes whose text or content-desc contains this.' },
        serial: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const nodes = await dumpUi(d.serial)
      const contains = optionalString(args, 'contains', 200)
      const filtered = nodes
        .filter((n) => (args.clickableOnly === true ? n.clickable : true))
        .filter((n) => (contains ? matchNode(n, { text: contains }) || n.resourceId.toLowerCase().includes(contains.toLowerCase()) : true))
        .slice(0, 400)
      return ok(
        `${filtered.length} node(s):\n` +
          filtered
            .map((n) => `- ${n.className.split('.').pop()} "${n.text || n.contentDesc}" id=${n.resourceId || '-'} center=${centerOf(n).x},${centerOf(n).y}`)
            .join('\n'),
        { nodes: filtered.map((n) => ({ ...n, center: centerOf(n) })) }
      )
    }
  },
  {
    name: 'ui_find',
    description:
      'Find UI elements by text / resource-id / class / content-desc and return their tap coordinates. Prefer this over guessing coordinates from a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        resourceId: { type: 'string', description: 'Full or partial resource id, e.g. com.app:id/login' },
        className: { type: 'string' },
        contentDesc: { type: 'string' },
        clickableOnly: { type: 'boolean' },
        serial: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const nodes = await findNodes(d.serial, {
        text: optionalString(args, 'text', 200),
        resourceId: optionalString(args, 'resourceId', 200),
        className: optionalString(args, 'className', 200),
        contentDesc: optionalString(args, 'contentDesc', 200),
        clickableOnly: args.clickableOnly === true
      })
      if (nodes.length === 0) return ok('No matching elements. Try ui_dump to see what is on screen.')
      const results = nodes.slice(0, 20).map((n, i) => ({
        ref: i,
        text: n.text,
        resourceId: n.resourceId,
        center: centerOf(n)
      }))
      return ok(
        `${results.length} match(es):\n${results.map((r) => `#${r.ref} "${r.text || r.resourceId}" → tap at ${r.center.x},${r.center.y}`).join('\n')}`,
        { matches: results }
      )
    }
  },
  {
    name: 'ui_wait',
    description:
      'Wait until an element appears (by text/id/desc) or until the given timeout elapses. Call this after actions that trigger navigation or loading, before asserting or screenshotting.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        resourceId: { type: 'string' },
        contentDesc: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 8000.' },
        serial: { type: 'string' }
      }
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const res = await waitFor(
        d.serial,
        { text: optionalString(args, 'text', 200), resourceId: optionalString(args, 'resourceId', 200), contentDesc: optionalString(args, 'contentDesc', 200) },
        optionalNumber(args, 'timeoutMs', 500, 60000, 8000)
      )
      return res.found
        ? ok(`appeared after ${res.elapsedMs}ms${res.node ? ` — "${res.node.text}"` : ''}`, { found: true, elapsedMs: res.elapsedMs })
        : ok(`not found within ${res.elapsedMs}ms`, { found: false, elapsedMs: res.elapsedMs })
    }
  },
  {
    name: 'macro_run',
    description:
      'Run a saved CDeck macro (recorder / Maestro flow) against the device. Requires the CDeck app to be running with its local API enabled.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Macro id from /macros or the CDeck Automate page.' }, serial: { type: 'string' } }
    },
    handler: async (args) => {
      const id = requireString(args, 'id', 60)
      if (!bridge) return err('CDeck app bridge is not available. Enable the local API in CDeck → Settings, and keep the app running.')
      const res = (await bridgePost(bridge, '/macro/run', { id, serial: optionalString(args, 'serial') })) as { ok?: boolean; detail?: string } | null
      if (!res) return err('bridge call failed')
      return res.ok ? ok(res.detail ?? 'macro finished') : err(res.detail ?? 'macro failed')
    }
  },
  {
    name: 'bugreport',
    description: 'Capture a full bugreport zip on the PC via adb bugreport. Long-running (minutes).',
    inputSchema: { type: 'object', properties: { outFile: { type: 'string', description: 'Absolute path on this PC for the zip.' }, serial: { type: 'string' } } },
    handler: async (args) => {
      const d = await pickDevice(optionalString(args, 'serial'))
      const out = optionalString(args, 'outFile', 500) ?? `bugreport-${Date.now()}.zip`
      const res = await adb(['-s', d.serial, 'bugreport', out], 300000)
      return res.ok ? ok(`bugreport written to ${out}`) : err(res.stderr.trim())
    }
  }
]

function toZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const desc = typeof schema.description === 'string' ? schema.description : undefined
  const withDesc = (zs: z.ZodTypeAny) => (desc ? zs.describe(desc) : zs)
  if (Array.isArray(schema.enum)) return withDesc(z.enum(schema.enum as [string, ...string[]]))
  switch (schema.type) {
    case 'string':
      return withDesc(z.string())
    case 'number':
    case 'integer':
      return withDesc(z.number())
    case 'boolean':
      return withDesc(z.boolean())
    case 'array':
      return withDesc(z.array(toZod((schema.items as Record<string, unknown>) ?? { type: 'string' })))
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, value] of Object.entries(props)) {
        const inner = toZod(value)
        shape[key] = required.includes(key) ? inner : inner.optional()
      }
      return withDesc(z.object(shape))
    }
    default:
      return withDesc(z.any())
  }
}

const INSTRUCTIONS =
  'You control a REAL Android phone over adb (no emulator). Golden path: device_list, then device_info, then ui_dump (preferred) or screenshot, then act by ref (ui_find plus input_tap), then verify with a diff or screenshot. Coordinates from the screenshot are device pixels; refs from ui_dump are more robust. Prefer dedicated tools over shell_exec; shell_exec refuses destructive commands unless risk_ack is true. When a device is unauthorized, tell the user to accept the Allow prompt on the phone.'

function buildServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS }
  )

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
        description: t.description,
        inputSchema: toZod(t.inputSchema),
        annotations: t.annotations
      } as never,
      t.handler as never
    )
  }

  const RESOURCES: Array<{ uri: string; name: string; description: string; read: () => Promise<unknown> }> = [
    {
      uri: 'cdeck://devices',
      name: 'Connected devices',
      description: 'Live device list as JSON',
      read: () => (bridge ? bridgeGet(bridge, '/devices') : listDevices().then((devices) => ({ devices })))
    },
    {
      uri: 'cdeck://status',
      name: 'CDeck status',
      description: 'Selected device, mirror session and last wireless target',
      read: () => (bridge ? bridgeGet(bridge, '/status') : Promise.resolve({ version: SERVER_VERSION, bridge: false }))
    },
    {
      uri: 'cdeck://macros',
      name: 'Saved macros',
      description: 'Recorded/Maestro macros available to macro_run',
      read: () => (bridge ? bridgeGet(bridge, '/macros') : Promise.resolve({ macros: [] }))
    }
  ]
  for (const r of RESOURCES) {
    server.registerResource(r.name, r.uri, { description: r.description, mimeType: 'application/json' }, async () => ({
      contents: [
        {
          uri: r.uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            (await r.read().catch(() => ({ error: 'not available (is the CDeck app running with the local API enabled?)' }))) ?? {},
            null,
            2
          )
        }
      ]
    }))
  }

  const PROMPTS: Array<{ name: string; description: string; argsSchema: Record<string, z.ZodTypeAny> }> = [
    {
      name: 'explore_app',
      description: "Walk an app's main screens and report a navigation summary with screenshots.",
      argsSchema: { package: z.string().describe('Android package name') }
    },
    {
      name: 'smoke_test',
      description: 'Launch an app, exercise its top-level UI, and report any crash/ANR found in the logs.',
      argsSchema: { package: z.string().describe('Android package name') }
    },
    {
      name: 'reproduce_bug',
      description: 'Follow reproduction steps, screenshotting after each and reporting what changed.',
      argsSchema: { steps: z.string().describe('Numbered reproduction steps') }
    }
  ]
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { description: p.description, argsSchema: p.argsSchema },
      async (args: { package?: string; steps?: string }) => ({
        messages: await promptMessages(p.name, { package: args.package ?? '', steps: args.steps ?? '' })
      })
    )
  }

  return server
}

async function promptMessages(name: string, args: Record<string, string>): Promise<Array<{ role: 'user'; content: { type: 'text'; text: string } }>> {
  const pkg = args.package || 'com.example.app'
  if (name === 'explore_app') {
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Use the cdeck tools to explore the app ${pkg} on the connected device.\n1. device_list, then app_start ${pkg}.\n2. ui_wait for the first screen, screenshot, then ui_dump to see the tabs/buttons.\n3. Visit each top-level destination with ui_find + input_tap, screenshotting each.\n4. Summarise the navigation map (screens, entry points, notable controls) and note anything broken.`
        }
      }
    ]
  }
  if (name === 'smoke_test') {
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Smoke-test ${pkg}:\n1. app_start, ui_wait for its first screen; screenshot.\n2. Walk the top-level UI (tabs/buttons from ui_dump), returning to the start between each.\n3. After each screen, run logcat_get {contains:"FATAL EXCEPTION", lines:50} and report any crash/ANR.\n4. Finish with a pass/fail table and the exact log lines for any failure.`
        }
      }
    ]
  }
  return [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Reproduce this bug on the device, screenshotting after each step and reporting the observed state:\n\n${args.steps || '(no steps given)'}\n\nUse ui_find/ui_wait for reliability; capture logcat_get if something fails.`
      }
    }
  ]
}

async function main(): Promise<void> {
  await serveStdio(buildServer)
  console.error(`[${SERVER_NAME}] stdio server ready (${TOOLS.length} tools, adb at ${adbPath}, dual-era stdio)`)
}

main().catch((e) => {
  console.error(`[${SERVER_NAME}] fatal: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})