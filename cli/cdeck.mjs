#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logDir = path.join(process.env.APPDATA || '', 'cdeck', 'logs')

const args = process.argv.slice(2)
const cmd = args[0] ?? 'run'

const run = (bin, params, opts = {}) =>
  new Promise((resolveP) => {
    const child = spawn(bin, params, { stdio: 'inherit', windowsHide: true, ...opts })
    child.on('exit', (code) => resolveP(code ?? 0))
  })

const runCapture = (bin, params) => {
  const res = spawnSync(bin, params, { encoding: 'utf8', windowsHide: true })
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}

function resolveAdb() {
  if (process.env.CDECK_ADB && existsSync(process.env.CDECK_ADB)) return process.env.CDECK_ADB
  const bundled = path.join(process.env.APPDATA ?? '', 'cdeck', 'bin', 'scrcpy', 'adb.exe')
  if (existsSync(bundled)) return bundled
  const pt = path.join(process.env.APPDATA ?? '', 'cdeck', 'bin', 'platform-tools', 'adb.exe')
  if (existsSync(pt)) return pt
  return 'adb'
}

const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const hasBuild = existsSync(path.join(root, 'out', 'main', 'index.js'))

async function ensureBuild() {
  if (hasBuild) return true
  console.log('cdeck: first run — building the app…')
  const code = await run('npm', ['run', 'build'], { cwd: root })
  if (code !== 0) {
    console.error('cdeck: build failed')
    return false
  }
  return true
}

async function launch(port = 9333, extraArgs = []) {
  if (!existsSync(electronExe)) {
    console.error('cdeck: electron is not installed — run `npm install` in the repo first')
    process.exit(1)
  }
  console.log(`cdeck: launching (debug port ${port})`)
  spawn(electronExe, [`--remote-debugging-port=${port}`, root, ...extraArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  }).unref()
}

const commands = {
  async run() {
    await ensureBuild()
    await launch(9333)
    await run('npm', ['run', 'selftest'], { cwd: root }).catch(() => undefined)
    console.log('cdeck: app is running')
  },

  async dev() {
    await run('npm', ['run', 'dev'], { cwd: root })
  },

  async selftest() {
    await ensureBuild()
    const code = await run(electronExe, [root, '--selftest'])
    process.exit(code)
  },

  async run() {
    await ensureBuild()
    const passthrough = args.slice(1)
    const target = passthrough.find((a) => !a.startsWith('--'))
    if (!target) {
      console.log('usage: cdeck run <suite.yaml|macro name|macro id> [--serial X] [--output dir] [--format junit|html|json|all]')
      console.log('exit codes: 0 pass · 1 test failure · 2 infrastructure failure · 3 bad arguments')
      process.exit(3)
    }
    const code = await run(electronExe, [root, '--run-suite', target, ...passthrough.filter((a) => a !== target)])
    process.exit(code)
  },

  async test() {
    await ensureBuild()
    await launch(9333)
    await new Promise((r) => setTimeout(r, 14000))
    await run('node', [path.join(root, 'tools', 'mirror-test.mjs'), path.join(root, 'tools', 'mirror-test-result.json')], { cwd: root, env: { ...process.env, CDECK_TEST_PORT: '9333' } })
  },

  async wireless() {
    const adb = resolveAdb()
    const list = runCapture(adb, ['devices', '-l'])
    const usbLine = list.out.split('\n').find((l) => /\tdevice$/.test(l.trim()) && !l.trim().startsWith('adb-'))
    const usbSerial = usbLine ? usbLine.trim().split(/\s+/)[0] : null

    const finish = (target) => {
      console.log(`cdeck: discovered fresh target ${target} (ports rotate — this is the current one)`)
      const conn = runCapture(adb, ['connect', target])
      console.log(conn.out || conn.err)
      const after = runCapture(adb, ['devices', '-l'])
      const ok = after.out.split('\n').some((l) => l.trim().startsWith(target) && /\tdevice/.test(l))
      console.log(ok ? `cdeck: connected via ${target}` : 'cdeck: connect failed — the port may have rotated again; re-run')
      process.exit(ok ? 0 : 1)
    }

    if (usbSerial) {
      console.log(`cdeck: USB device ${usbSerial} — switching to wireless`)
      runCapture(adb, ['-s', usbSerial, 'tcpip', '5555'])
      await new Promise((r) => setTimeout(r, 3000))
      const svc = runCapture(adb, ['mdns', 'services']).out.split('\n').find((l) => l.includes('_adb-tls-connect._tcp'))
      const m = svc?.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/)
      if (m) return finish(m[0])
      const route = runCapture(adb, ['-s', usbSerial, 'shell', 'ip route']).out
      const src = route.match(/wlan0[^\n]*src (\d+\.\d+\.\d+\.\d+)/) ?? route.match(/src (\d+\.\d+\.\d+\.\d+)/)
      if (src) return finish(`${src[1]}:5555`)
    }

    const mdnsSvc = runCapture(adb, ['mdns', 'services']).out.split('\n').find((l) => l.includes('_adb-tls-connect._tcp'))
    const mdnsTarget = mdnsSvc?.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/)?.[0]
    if (mdnsTarget) return finish(mdnsTarget)
    console.log('cdeck: no wireless target found. On the phone: Settings → Developer options → Wireless debugging ON, on the same Wi-Fi as this PC.')
    process.exit(1)
  },

  async pair() {
    const [target, code] = args.slice(1)
    if (!target || !code) {
      console.log('usage: cdeck pair <ip:port> <6-digit-code>')
      process.exit(1)
    }
    const res = runCapture(resolveAdb(), ['pair', target, code])
    console.log(res.out || res.err)
    if (res.ok) await commands.wireless()
  },

  async doctor() {
    const node = runCapture('node', ['--version'])
    const npm = runCapture('npm', ['--version'])
    const adb = runCapture(resolveAdb(), ['version'])
    const adbDev = runCapture(resolveAdb(), ['devices', '-l'])
    const scrcpyDir = path.join(process.env.APPDATA ?? '', 'cdeck', 'bin', 'scrcpy')
    const scrcpy = existsSync(scrcpyDir) ? readdirSync(scrcpyDir).join(', ') : 'not installed'
    const ips = []
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) if (!a.internal && a.family === 'IPv4') ips.push(a.address)
    }
    const logFile = path.join(logDir, 'main.log')
    const logInfo = existsSync(logFile) ? `${Math.round(readFileSync(logFile).length / 1024)} KB` : 'none'
    console.log(`cdeck doctor
  node          ${node.out || node.err || 'missing'}
  npm           ${npm.out || npm.err || 'missing'}
  adb           ${adb.out.split('\n')[0] || adb.err}
  adb path      ${resolveAdb()}
  devices
${adbDev.out.split('\n').map((l) => '    ' + l).join('\n')}
  laptop IPs    ${ips.join(', ') || 'none'}
  scrcpy        ${scrcpy}
  appdata logs  ${logInfo} (${logDir})
  build         ${hasBuild ? 'present (out/)' : 'MISSING — run `cdeck` to build'}
  mcp           ${existsSync(path.join(root, 'mcp', 'dist', 'index.js')) ? 'built (mcp/dist)' : 'MISSING — run `npm run mcp:build`'}`)
  },

  async logs() {
    const file = path.join(logDir, 'main.log')
    if (!existsSync(file)) {
      console.log('cdeck: no logs yet at ' + file)
      return
    }
    const text = readFileSync(file, 'utf8').split('\n').slice(-80).join('\n')
    console.log(text)
    if (args.includes('--follow')) {
      let size = readFileSync(file).length
      watch(file, () => {
        const buf = readFileSync(file)
        console.log(buf.subarray(size).toString('utf8').replace(/\r/g, ''))
        size = buf.length
      })
      await new Promise(() => {})
    }
  },

  async mcp() {
    const entry = path.join(root, 'mcp', 'dist', 'index.js')
    if (!existsSync(entry)) {
      console.log('cdeck: building the MCP server…')
      await run('npm', ['run', 'mcp:build'], { cwd: root })
    }
    await run('node', [entry])
  },

  async help() {
    console.log(`cdeck — the Android device workspace

  cdeck                 build if needed, launch the app, run a quick self-test
  cdeck dev             run in dev mode (hot reload)
  cdeck test            launch the app and run the embedded-mirror UI test
  cdeck selftest        run the headless self-test and exit
  cdeck run <suite|macro> [--serial X] [--output dir] [--format junit|html|json|all]
                        run a suite headless for CI; exit codes 0 pass / 1 test-fail /
                        2 infra-fail / 3 bad-args
  cdeck wireless        connect over Wi-Fi (re-discovers the current port — ports rotate)
  cdeck pair <ip:port> <code>
                        pair with a phone's pairing code, then connect wirelessly
  cdeck doctor          environment + device + build report
  cdeck logs [--follow] show the app's own log (and follow it)
  cdeck mcp             run the MCP server for AI agents

The app, the wireless automation, and the MCP server are the same tool — this is the front door.`)
  }
}

const fn = commands[cmd] ?? commands.help
await fn()