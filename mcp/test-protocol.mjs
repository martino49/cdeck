import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const child = spawn(process.execPath, [join(here, 'dist', 'index.js')], {
  cwd: here,
  stdio: ['pipe', 'pipe', 'pipe']
})

let buffer = ''
child.stdout.on('data', (d) => { buffer += d.toString() })
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d.toString()))

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')

const pending = new Map()
const reader = setInterval(() => {
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch { /* partial */ }
  }
}, 50)

const request = (id, method, params) =>
  new Promise((resolveP, rejectP) => {
    pending.set(id, resolveP)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => rejectP(new Error(`timeout: ${method}`)), 12000)
  })

const notify = (method) => send({ jsonrpc: '2.0', method })

async function main() {
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cdeck-test', version: '1.0.0' }
  })
  console.log('INIT: ' + JSON.stringify(init.result?.serverInfo) + ' proto=' + init.result?.protocolVersion)
  notify('notifications/initialized')

  const tools = await request(2, 'tools/list', {})
  const names = tools.result?.tools?.map((t) => t.name) ?? []
  console.log(`TOOLS (${names.length}): ${names.join(', ')}`)

  const list = await request(3, 'tools/call', { name: 'device_list', arguments: {} })
  console.log('DEVICE_LIST: ' + JSON.stringify(list.result?.content?.[0]?.text).slice(0, 120))

  const bad = await request(4, 'tools/call', { name: 'screenshot', arguments: {} })
  console.log('SCREENSHOT (no device): isError=' + bad.result?.isError + ' text=' + JSON.stringify(bad.result?.content?.[0]?.text).slice(0, 130))

  const unknown = await request(5, 'tools/call', { name: 'nope', arguments: {} })
  console.log('UNKNOWN TOOL: isError=' + unknown.result?.isError)

  const deny = await request(6, 'tools/call', { name: 'shell_exec', arguments: { command: 'echo hi', serial: 'fake' } })
  console.log('SHELL fake-serial: isError=' + deny.result?.isError + ' ' + JSON.stringify(deny.result?.content?.[0]?.text).slice(0, 130))

  const instructions = (await request(7, 'prompts/list', {})).error ? null : null
  void instructions
  clearInterval(reader)
  child.kill()
  process.exit(0)
}

main().catch((e) => {
  console.error('TEST FAILED: ' + e.message)
  clearInterval(reader)
  child.kill()
  process.exit(1)
})