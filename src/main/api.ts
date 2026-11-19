import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server } from 'node:http'

export interface ApiHandlers {
  status: () => Promise<Record<string, unknown>>
  devices: () => Promise<unknown>
  wireless: (deviceSerial?: string | null) => Promise<{ ok: boolean; target: string | null; detail: string }>
  pair: (target: string, code: string) => Promise<{ ok: boolean; detail: string }>
  connect: (target: string) => Promise<{ ok: boolean; detail: string }>
  screenshot: (serial: string) => Promise<{ ok: boolean; data?: Buffer; error?: string }>
  action: (name: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>
  intent: (serial: string, uri: string, pkg?: string | null) => Promise<{ ok: boolean; detail: string }>
  installApk?: (serial: string, file: string) => Promise<{ ok: boolean; detail: string }>
  macros?: () => Promise<unknown>
  runMacro?: (id: string, serial?: string | null) => Promise<{ ok: boolean; detail: string }>
}

export interface LocalApi {
  url: string
  port: number
  token: string
  close: () => Promise<void>
  emit: (payload: Record<string, unknown>) => void
  clientCount: () => number
}

const MAX_BODY = 2 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        rejectP(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectP)
  })
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

export function startLocalApi(port: number, token: string, handlers: ApiHandlers): Promise<LocalApi> {
  const clients = new Set<ServerResponse>()

  const server: Server = createServer(async (req, res) => {
    const host = String(req.headers.host ?? '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      json(res, 403, { ok: false, error: 'invalid host header' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${host}`)
    const provided = req.headers['x-cdeck-token'] ?? url.searchParams.get('token')
    if (provided !== token) {
      json(res, 401, { ok: false, error: 'missing or invalid token' })
      return
    }

    try {
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === '/status') return json(res, 200, { ok: true, ...(await handlers.status()) })
      if (method === 'GET' && path === '/devices') return json(res, 200, { ok: true, devices: await handlers.devices() })
      if (method === 'GET' && path === '/macros' && handlers.macros) return json(res, 200, { ok: true, macros: await handlers.macros() })

      if (method === 'GET' && path === '/screenshot') {
        const serial = url.searchParams.get('serial') ?? ''
        const shot = await handlers.screenshot(serial)
        if (!shot.ok || !shot.data) return json(res, 400, { ok: false, error: shot.error ?? 'failed' })
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': shot.data.length })
        res.end(shot.data)
        return
      }

      if (method === 'GET' && path === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        })
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        clients.add(res)
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(ping)
          }
        }, 20000)
        req.on('close', () => {
          clearInterval(ping)
          clients.delete(res)
        })
        return
      }

      if (method === 'POST') {
        let payload: Record<string, unknown> = {}
        const body = await readBody(req)
        if (body.trim().length > 0) {
          try {
            payload = JSON.parse(body) as Record<string, unknown>
          } catch {
            return json(res, 400, { ok: false, error: 'invalid JSON body' })
          }
        }
        const serial = typeof payload.serial === 'string' ? payload.serial : undefined

        if (path === '/wireless') {
          const r = await handlers.wireless(typeof payload.deviceSerial === 'string' ? payload.deviceSerial : undefined)
          return json(res, r.ok ? 200 : 502, r)
        }
        if (path === '/pair') {
          const target = String(payload.target ?? '')
          const code = String(payload.code ?? '')
          if (!target || !code) return json(res, 400, { ok: false, error: 'target and code are required' })
          return json(res, 200, await handlers.pair(target, code))
        }
        if (path === '/connect') {
          const target = String(payload.target ?? '')
          if (!target) return json(res, 400, { ok: false, error: 'target is required' })
          return json(res, 200, await handlers.connect(target))
        }
        if (path === '/intent') {
          if (!serial) return json(res, 400, { ok: false, error: 'serial is required' })
          const uri = String(payload.uri ?? '')
          if (!uri) return json(res, 400, { ok: false, error: 'uri is required' })
          return json(res, 200, await handlers.intent(serial, uri, typeof payload.pkg === 'string' ? payload.pkg : null))
        }
        if (path === '/install' && handlers.installApk) {
          if (!serial) return json(res, 400, { ok: false, error: 'serial is required' })
          const file = String(payload.file ?? '')
          if (!file) return json(res, 400, { ok: false, error: 'file is required' })
          return json(res, 200, await handlers.installApk(serial, file))
        }
        if (path === '/macro/run' && handlers.runMacro) {
          const id = String(payload.id ?? '')
          if (!id) return json(res, 400, { ok: false, error: 'id is required' })
          return json(res, 200, await handlers.runMacro(id, typeof payload.serial === 'string' ? payload.serial : undefined))
        }
        if (path === '/action') {
          const name = String(payload.action ?? '')
          if (!name) return json(res, 400, { ok: false, error: 'action is required' })
          return json(res, 200, await handlers.action(name, payload))
        }
      }

      json(res, 404, { ok: false, error: `no route for ${method} ${path}` })
    } catch (e) {
      json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  return new Promise((resolveP, rejectP) => {
    server.once('error', rejectP)
    server.listen(port, '127.0.0.1', () => {
      const api: LocalApi = {
        url: `http://127.0.0.1:${port}`,
        port,
        token,
        close: () =>
          new Promise((done) => {
            for (const c of clients) {
              try {
                c.end()
              } catch {
                /* already closed */
              }
            }
            clients.clear()
            server.close(() => done())
          }),
        emit: (payload) => {
          const line = `data: ${JSON.stringify(payload)}\n\n`
          for (const c of clients) {
            try {
              c.write(line)
            } catch {
              clients.delete(c)
            }
          }
        },
        clientCount: () => clients.size
      }
      resolveP(api)
    })
  })
}