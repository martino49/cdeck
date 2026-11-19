import type { DeviceInfo, ReverseResult, WatchdogState } from '@shared/types'
import { adbConnect, adbDisconnect, adbGetState, discoverWirelessTarget, ensureReverse, listDevices, mdnsServices } from './adb'
import { loadStore, saveStore } from './store'

export interface WatchdogEvents {
  onState: (state: WatchdogState) => void
  onTunnels: (results: ReverseResult[], serial: string) => void
}

export class Watchdog {
  private timer: NodeJS.Timeout | null = null
  private state: WatchdogState = {
    running: false,
    lastAction: 'idle',
    lastError: null,
    reconnects: 0,
    checks: 0,
    lastTarget: null
  }

  constructor(private events: WatchdogEvents) {}

  getState(): WatchdogState {
    return { ...this.state }
  }

  start(): void {
    if (this.timer) return
    const { settings } = loadStore()
    this.state.running = true
    this.state.lastAction = 'started'
    this.emit()
    this.timer = setInterval(() => {
      void this.reconcile()
    }, Math.max(2, settings.watchdogIntervalSec) * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.state.running = false
    this.state.lastAction = 'stopped'
    this.emit()
  }

  private emit(): void {
    this.events.onState({ ...this.state })
  }

  private async findServer(): Promise<DeviceInfo | null> {
    const devices = await listDevices()
    const { settings } = loadStore()
    const wanted = settings.deviceSerial
    if (wanted) {
      const found = devices.find((d) => d.serial === wanted)
      if (found) return found
    }
    const usable = devices.filter((d) => d.state === 'device')
    return usable[0] ?? devices[0] ?? null
  }

  async reconcile(): Promise<void> {
    this.state.checks += 1
    try {
      let server = await this.findServer()
      if (!server) {
        const { lastWireless, lastTarget } = loadStore()
        const candidates = [lastWireless ? `${lastWireless.ip}:${lastWireless.port}` : null, lastTarget].filter(
          (t): t is string => Boolean(t)
        )
        if (candidates.length > 0) {
          this.state.lastAction = `no devices visible — retrying ${candidates[0]}`
          this.emit()
          await adbConnect(candidates[0])
          const after = await this.findServer()
          if (after && after.state === 'device') {
            this.state.reconnects += 1
            this.state.lastTarget = candidates[0]
            server = after
          } else {
            this.state.lastAction = 'no devices visible'
            this.state.lastError = null
            this.emit()
            return
          }
        } else {
          this.state.lastAction = 'no devices visible'
          this.state.lastError = null
          this.emit()
          return
        }
      }

      let alive = server.state === 'device' && (await adbGetState(server.serial)) === 'device'

      if (!alive && server.transport === 'tcpip') {
        this.state.lastAction = `reconnecting ${server.serial}`
        this.emit()
        await adbDisconnect(server.serial)
        await adbConnect(server.serial)
        this.state.reconnects += 1
        alive = (await adbGetState(server.serial)) === 'device'
      }

      if (!alive && this.state.lastTarget) {
        this.state.lastAction = `retrying last target ${this.state.lastTarget}`
        this.emit()
        await adbConnect(this.state.lastTarget)
        alive = (await adbGetState(server.serial)) === 'device' || (await adbGetState(this.state.lastTarget)) === 'device'
      }

      if (!alive) {
        const { lastWireless } = loadStore()
        const fresh = await discoverWirelessTarget(lastWireless?.deviceSerial)
        const targets: string[] = []
        if (fresh) targets.push(`${fresh.host}:${fresh.port}`)
        const services = (await mdnsServices()).filter((s) => s.type.includes('tls-connect'))
        for (const svc of services) {
          const t = `${svc.host}:${svc.port}`
          if (!targets.includes(t)) targets.push(t)
        }
        for (const t of targets) {
          this.state.lastAction = `discovering via mDNS ${t}`
          this.emit()
          await adbConnect(t)
          const after = await this.findServer()
          if (after && after.state === 'device' && (await adbGetState(after.serial)) === 'device') {
            this.state.lastTarget = t
            server.serial = after.serial
            alive = true
            this.state.reconnects += 1
            break
          }
        }
      }

      if (!alive) {
        this.state.lastAction = `device not ready (${server.state})`
        this.state.lastError = null
        this.emit()
        return
      }

      const serial = server.serial
      if (serial.includes(':')) {
        this.state.lastTarget = serial
        const store = loadStore()
        store.lastTarget = serial
        saveStore(store)
      }

      const { settings } = loadStore()
      if (settings.tunnels.length > 0) {
        const results = await ensureReverse(serial, settings.tunnels)
        const failed = results.filter((r) => !r.ok)
        this.state.lastAction = `tunnels active for ${serial}`
        this.state.lastError = failed.length ? failed.map((f) => `tcp:${f.port} ${f.error ?? 'failed'}`).join('; ') : null
        this.events.onTunnels(results, serial)
      } else {
        this.state.lastAction = `connected ${serial} (no tunnels)`
        this.state.lastError = null
      }
      this.emit()
    } catch (err) {
      this.state.lastError = String(err)
      this.emit()
    }
  }
}
