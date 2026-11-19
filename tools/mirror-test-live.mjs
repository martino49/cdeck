import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = process.env.CDECK_TEST_OUT || join(tmpdir(), 'embedtest-result.json')
const HARD = setTimeout(() => {
  writeFileSync(OUT, JSON.stringify({ fatal: 'HARD TIMEOUT' }, null, 1))
  process.exit(2)
}, 240000)

const PORT = 9234
const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: x })
    if (r.result?.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0]
    return r.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}

  await sleep(4000)
  out.devices = await ev(`(async () => JSON.stringify(await window.cdeck.adb.devices()))()`)

  await ev(`[...document.querySelectorAll('nav button')].find((b) => /^Mirror/.test(b.textContent))?.click()`)
  await sleep(2000)

  out.toggle = await ev(`(() => {
    const sw = [...document.querySelectorAll('main [role=switch]')].find((x) => /Embed/.test(x.getAttribute('aria-label') || ''))
    if (!sw) return 'no switch'
    const was = sw.getAttribute('aria-checked')
    sw.click()
    return 'clicked (was ' + was + ')'
  })()`)

  await sleep(20000)

  out.embedded = await ev(`(() => {
    const main = document.querySelector('main')
    const t = main?.innerText || ''
    const size = t.match(/(\\d+)\\u00d7(\\d+)/)
    const fps = (t.match(/(\\d+) fps/) || [])[1]
    return { hasCard: t.includes('EMBEDDED MIRROR'), running: t.includes('running'), errorText: t.includes('error'), deviceSize: size ? size[0] : null, fps: fps ?? null }
  })()`)

  out.appLog = await ev(`(async () => { const r = await window.cdeck.logs.read(30000); return (r.text.match(/(embedded mirror[^\\n]*)/gi) || []).slice(-8) })()`)

  writeFileSync(OUT, JSON.stringify(out, null, 1))
  clearTimeout(HARD)
  process.exit(0)
}

main().catch((e) => {
  writeFileSync(OUT, JSON.stringify({ fatal: e.message }, null, 1))
  clearTimeout(HARD)
  process.exit(1)
})
