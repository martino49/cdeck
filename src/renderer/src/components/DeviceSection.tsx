import { useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import type { DeviceInfo, MdnsService, NetworkInfo, PingResult } from '@shared/types'
import { Button, Card, ConfirmDialog, Empty, Badge } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

interface Props {
  devices: DeviceInfo[]
  selected: string | null
  activeDevice: DeviceInfo | null
  onSelect: (serial: string | null) => void
  traySignal: number
}

interface DeviceSnapshot {
  model: string
  release: string
  sdk: string
  screen: string
  density: string
  batteryLevel: number | null
  charging: boolean | null
}

function Diag({ label, value, tone, mono }: { label: string; value: string; tone?: 'ok' | 'warn' | 'dim'; mono?: boolean }) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'dim' ? 'text-dim' : ''
  return (
    <div className="rounded-md border border-line bg-panel2 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-dim">{label}</div>
      <div className={`truncate text-[12px] ${mono ? 'font-mono' : ''} ${color}`} title={value}>
        {value}
      </div>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="truncate">
      <span className="text-dim">{label}: </span>
      <span className={mono ? 'font-mono' : ''} title={value}>
        {value}
      </span>
    </div>
  )
}

export function DeviceSection({ devices, selected, activeDevice, onSelect, traySignal }: Props) {
  const [mdns, setMdns] = useState<MdnsService[]>([])
  const [pairTarget, setPairTarget] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [connectTarget, setConnectTarget] = useState('')
  const [legacyIp, setLegacyIp] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [net, setNet] = useState<NetworkInfo | null>(null)
  const [ping, setPing] = useState<PingResult | null>(null)
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null)
  const [uptime, setUptime] = useState<string | null>(null)
  const [rebootMode, setRebootMode] = useState<'device' | 'recovery' | 'bootloader' | null>(null)
  const pairRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const ipHintRef = useRef<string | null>(null)
  const pingedRef = useRef<string | null>(null)

  const usbDevice = devices.find((d) => d.state === 'device' && d.transport === 'usb') ?? null

  const append = (lines: string[]) => setLog((prev) => [...prev, ...lines].slice(-200))

  const serialRef = useRef<string | null>(null)
  serialRef.current = usbDevice?.serial ?? activeDevice?.serial ?? null
  const devicesKey = devices.map((d) => `${d.serial}:${d.state}`).join(',')

  const targetSerial = usbDevice?.serial ?? (activeDevice?.state === 'device' ? activeDevice.serial : null)

  const refreshSnapshot = async (serial: string) => {
    const [info, up] = await Promise.all([
      win.device.info(serial).catch(() => null),
      win.device.uptime(serial).catch(() => null)
    ])
    setSnapshot(info as DeviceSnapshot | null)
    setUptime(up)
  }

  useEffect(() => {
    if (!targetSerial) {
      setSnapshot(null)
      setUptime(null)
      return
    }
    void refreshSnapshot(targetSerial)
  }, [targetSerial])

  const refreshNet = async () => {
    const serial = serialRef.current
    const info = await win.adb.netInfo(serial).catch(() => null)
    setNet(info)
    if (info?.phoneIp && ipHintRef.current !== info.phoneIp) {
      ipHintRef.current = info.phoneIp
      setLegacyIp(info.phoneIp)
    }
    if (info?.phoneIp && pingedRef.current !== info.phoneIp) {
      pingedRef.current = info.phoneIp
      setPing(await win.adb.ping(info.phoneIp).catch(() => null))
    }
  }

  const discover = async () => {
    setBusy(true)
    const services = await win.adb.mdns()
    setMdns(services)
    const pairSvc = services.find((s) => s.type.includes('tls-pairing'))
    const connSvc = services.find((s) => s.type.includes('tls-connect'))
    if (pairSvc) setPairTarget(`${pairSvc.host}:${pairSvc.port}`)
    if (connSvc) setConnectTarget(`${connSvc.host}:${connSvc.port}`)
    append([`mDNS: ${services.length} service(s)${services.length === 0 ? ' — is Wireless debugging on? Is mDNS blocked by your router?' : ''}`])
    setBusy(false)
  }

  const doWirelessSetup = async () => {
    if (!usbDevice) return
    setBusy(true)
    const res = await win.adb.wirelessSetup(usbDevice.serial, 5555)
    append(res.steps.map((s) => `• ${s}`))
    if (res.ok && res.ip) {
      setConnectTarget(`${res.ip}:${res.port}`)
      setLegacyIp(res.ip)
      pingedRef.current = null
      showToast('success', 'Wireless connected', `${res.ip}:${res.port}`)
    } else {
      showToast('error', 'Wireless setup failed', res.error ?? 'unknown')
    }
    setBusy(false)
    await refreshNet()
  }

  const doPair = async () => {
    if (!pairTarget || !pairCode) return
    setBusy(true)
    const res = await win.adb.pair(pairTarget, pairCode)
    append([`pair ${pairTarget}: ${(res.stdout || res.stderr).trim()}`])
    if (res.ok) showToast('success', 'Paired with phone', 'Now tap Connect')
    else showToast('error', 'Pairing failed', (res.stderr || res.stdout).trim())
    setBusy(false)
  }

  const doConnect = async () => {
    if (!connectTarget) return
    setBusy(true)
    const res = await win.adb.connect(connectTarget)
    append([`connect ${connectTarget}: ${(res.stdout || res.stderr).trim()}`])
    if (res.ok && res.stdout.includes('connected')) pingedRef.current = null
    setBusy(false)
    await refreshNet()
  }

  const doLegacy = async () => {
    if (!legacyIp) return
    setBusy(true)
    const res = await win.adb.tcpip(5555)
    append([`adb tcpip 5555: ${(res.stdout || res.stderr).trim()}`])
    const conn = await win.adb.connect(`${legacyIp}:5555`)
    append([`connect ${legacyIp}:5555: ${(conn.stdout || conn.stderr).trim()}`])
    setBusy(false)
  }

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text)
    showToast('success', `${label} copied`, text)
  }

  const quickScreenPower = async () => {
    if (!targetSerial) return
    const res = await win.device.screenPower(targetSerial)
    append([`screen power (toggle): ${(res.stdout || res.stderr).trim()}`])
  }

  const quickReboot = (mode: 'device' | 'recovery' | 'bootloader') => {
    if (targetSerial) setRebootMode(mode)
  }

  const doReboot = async (mode: 'device' | 'recovery' | 'bootloader') => {
    if (!targetSerial) return
    setBusy(true)
    const res = await win.device.reboot(targetSerial, mode)
    append([`reboot ${mode}: ${(res.stdout || res.stderr).trim()}`])
    setBusy(false)
  }

  const restartAdb = async () => {
    setBusy(true)
    const res = await win.device.restartAdb()
    append([`adb server: ${(res.stdout || res.stderr).trim()}`])
    showToast('success', 'adb server restarted', 'Devices are re-scanning')
    setBusy(false)
  }

  const doWirelessSetupOrHint = () => {
    showToast('info', 'Wireless needs one USB connection', 'Plug in once so CDeck can turn Wi-Fi on and read the IP — after that it stays wireless')
  }

  const rediscover = async () => {
    setBusy(true)
    const res = await win.adb.rediscoverWireless(activeDevice?.serial)
    append([`rediscover: ${res.detail}${res.target ? ` → ${res.target}` : ''}`])
    if (res.target) setConnectTarget(res.target)
    showToast(res.ok ? 'success' : 'error', res.ok ? 'Wireless reconnected' : 'No wireless target found', res.detail)
    setBusy(false)
    await refreshNet()
  }

  const copyConnectionCommand = async () => {
    if (!activeDevice) return
    const cmd = activeDevice.transport === 'tcpip' ? `adb connect ${activeDevice.serial}` : `adb -s ${activeDevice.serial} shell`
    await navigator.clipboard.writeText(cmd)
    showToast('success', 'Command copied', cmd)
  }

  useEffect(() => {
    void discover()
    void win.adb.lastWireless().then((lw) => {
      if (lw) setConnectTarget((prev) => prev || `${lw.ip}:${lw.port}`)
    })
    void refreshNet()
    const t = setInterval(() => void refreshNet(), 8000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    void refreshNet()
  }, [devicesKey])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log])

  useEffect(() => {
    if (traySignal > 0) pairRef.current?.focus()
  }, [traySignal])

  const isolationRisk = net?.sameNetwork === true && ping?.reachable === false
  const diffNet = net?.sameNetwork === false

  return (
    <>
      <Card
        title="Devices"
        right={
          <Button size="sm" variant="ghost" onClick={() => void discover()} disabled={busy}>
            Discover
          </Button>
        }
      >
        {devices.length === 0 ? (
          <Empty
            icon={<Smartphone />}
            title="No devices yet"
            hint="Unlock the phone and allow USB debugging, or pair over Wi-Fi below."
            action={
              <>
                <Button variant="primary" onClick={() => void discover()} disabled={busy}>
                  Discover devices
                </Button>
                <Button variant="ghost" onClick={() => void doWirelessSetupOrHint()} disabled={busy}>
                  Set up wireless
                </Button>
              </>
            }
          />
        ) : (
          devices.map((d) => (
            <div
              key={d.serial}
              className={`mb-1.5 flex items-center gap-2 rounded-md border bg-panel2 px-3 py-2 ${
                d.serial === selected ? 'border-accent' : 'border-line'
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.state === 'device' ? 'var(--ok)' : 'var(--warn)' }} />
              <span className="truncate font-medium">{d.model ?? d.serial}</span>
              <Badge tone={d.state === 'device' ? 'ok' : 'warn'} pulse={d.state !== 'device'}>
                {d.state}
              </Badge>
              <Badge>{d.transport === 'tcpip' ? 'Wi-Fi' : 'USB'}</Badge>
              <div className="flex-1" />
              <span className="max-w-[220px] truncate font-mono text-[11px] text-dim" title={d.serial}>
                {d.serial}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void copy(d.serial, 'Serial')}>
                Copy
              </Button>
              <Button size="sm" variant={d.serial === selected ? 'primary' : 'default'} onClick={() => onSelect(d.serial)}>
                {d.serial === selected ? 'Selected' : 'Use'}
              </Button>
            </div>
          ))
        )}
        {activeDevice && <div className="mt-1.5 text-[11px] text-dim">Selected target: <span className="font-mono">{activeDevice.serial}</span></div>}
      </Card>

      {activeDevice && activeDevice.state !== 'device' && activeDevice.state !== 'offline' && (
        <Card title="Waiting for authorization">
          <div className="text-[12px] text-dim">
            The phone is connected but hasn't trusted this computer yet. Unlock it and tap{' '}
            <span className="font-medium text-fg">Allow USB debugging</span> in the popup (optionally tick "Always allow from
            this computer"). If no popup appears, revoke authorizations in the phone's Developer options and re-plug.
          </div>
        </Card>
      )}
      {activeDevice && activeDevice.state === 'device' && (
        <Card
          title="Connected device"
          right={activeDevice.transport === 'tcpip' ? <Badge tone="ok">wireless</Badge> : <Badge>usb</Badge>}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4">
            <Row label="Model" value={snapshot?.model || activeDevice.model || activeDevice.serial} />
            <Row label="Android" value={snapshot ? `${snapshot.release} (API ${snapshot.sdk})` : '—'} />
            <Row label="Screen" value={snapshot?.screen || '—'} />
            <Row label="Density" value={snapshot?.density || '—'} />
            <Row
              label="Battery"
              value={
                snapshot?.batteryLevel != null
                  ? `${snapshot.batteryLevel}%${snapshot.charging ? ' · charging' : ''}`
                  : '—'
              }
            />
            <Row label="Uptime" value={uptime ?? '—'} />
            <Row label="Serial" value={activeDevice.serial} mono />
            <Row label="Product" value={activeDevice.product ?? '—'} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button
              size="sm"
              disabled={!targetSerial}
              onClick={async () => {
                if (!targetSerial) return
                const res = await win.device.screenshot(targetSerial)
                if (res.ok) showToast('success', 'Screenshot captured', res.file)
                else showToast('error', 'Screenshot failed', res.error)
              }}
            >
              Screenshot
            </Button>
            <Button size="sm" onClick={() => void quickScreenPower()}>
              Screen off / on
            </Button>
            <Button size="sm" onClick={() => quickReboot('device')}>
              Reboot
            </Button>
            <Button size="sm" onClick={() => quickReboot('recovery')}>
              Recovery
            </Button>
            <Button size="sm" onClick={() => quickReboot('bootloader')}>
              Bootloader
            </Button>
            <Button size="sm" onClick={() => void restartAdb()}>
              Restart adb server
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copyConnectionCommand()}>
              Copy adb command
            </Button>
          </div>
        </Card>
      )}

      <Card title="Wireless">
        <div className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <Diag label="Phone IP" value={net?.phoneIp ?? '—'} mono />
          <Diag
            label="Phone Wi-Fi"
            value={
              net?.wifiConnected && net.phoneSsid
                ? net.phoneSsid
                : net?.wifiEnabled === false
                  ? 'off — will be enabled'
                  : 'on, not connected'
            }
            tone={net?.wifiConnected ? (net.sameNetwork === false ? 'warn' : 'ok') : 'warn'}
          />
          <Diag label="This PC Wi-Fi" value={net?.laptopSsid ?? 'not on Wi-Fi'} tone={net?.laptopSsid ? undefined : 'dim'} />
          <Diag
            label="Phone reachable"
            value={
              ping
                ? ping.reachable
                  ? `yes${ping.avgMs != null ? ` · ${ping.avgMs}ms` : ''}`
                  : 'no'
                : net?.phoneIp
                  ? 'checking…'
                  : '—'
            }
            tone={ping ? (ping.reachable ? 'ok' : 'warn') : 'dim'}
          />
        </div>

        {isolationRisk && (
          <div className="mb-3 rounded-md border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--warn)' }}>
            <div className="font-medium text-warn">Same network, but the phone is unreachable</div>
            <div className="text-dim">
              This router has client/AP isolation on (typical on public Wi-Fi) — devices can’t talk to each other.
              Fix it in the router admin (“allow clients to communicate”), or connect this PC to the phone’s own
              hotspot. USB keeps working either way.
            </div>
          </div>
        )}
        {diffNet && (
          <div className="mb-3 rounded-md border border-line bg-panel2 px-3 py-2 text-[12px] text-dim">
            Phone is on <span className="font-medium">{net?.phoneSsid}</span> but this PC is on{' '}
            <span className="font-medium">{net?.laptopSsid}</span>. Put them on the same network — the phone’s
            hotspot is the easiest option.
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void doWirelessSetup()}
            disabled={busy || !usbDevice}
            title={
              usbDevice
                ? 'Forces Wi-Fi on if needed, reads the phone’s IP automatically, then connects. Unplug afterwards — it stays connected.'
                : 'Plug in over USB once to set this up — it reads the IP for you.'
            }
          >
            1-Click Wireless Setup
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void rediscover()}
            disabled={busy}
            title="Wireless-debugging ports rotate every session. This re-finds the phone's current address by its identity, so you never type a port again."
          >
            Re-detect port
          </Button>
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          {mdns.length === 0 && <span className="text-dim">No services — enable Wireless debugging on the phone, then Discover.</span>}
          {mdns.map((s) => (
            <span key={s.raw} className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono">
              {s.type.replace(/^_adb-/, '').replace(/\._tcp\.$/, '')} {s.host}:{s.port}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-[190px] rounded-md border border-line bg-panel2 px-2 py-1.5"
            placeholder="pair host:port"
            value={pairTarget}
            onChange={(e) => setPairTarget(e.target.value)}
            ref={pairRef}
          />
          <input
            className="w-[110px] rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono tracking-widest"
            placeholder="6-digit code"
            value={pairCode}
            maxLength={6}
            onChange={(e) => setPairCode(e.target.value.replace(/\D/g, ''))}
          />
          <Button variant="primary" onClick={() => void doPair()} disabled={busy}>
            Pair
          </Button>
          <div className="flex-1" />
          <input
            className="w-[190px] rounded-md border border-line bg-panel2 px-2 py-1.5"
            placeholder="connect host:port"
            value={connectTarget}
            onChange={(e) => setConnectTarget(e.target.value)}
          />
          <Button onClick={() => void doConnect()} disabled={busy}>
            Connect
          </Button>
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 text-[11px] uppercase tracking-wide text-dim">Legacy mode — IP auto-filled from the phone</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-[150px] rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono"
              placeholder="phone IP"
              value={legacyIp}
              onChange={(e) => setLegacyIp(e.target.value)}
            />
            <Button onClick={() => void doLegacy()} disabled={busy || !legacyIp}>
              adb tcpip 5555 & connect
            </Button>
            {net?.phoneIp && <span className="text-[11px] text-dim">detected: <span className="font-mono">{net.phoneIp}</span></span>}
          </div>
        </div>
        <div className="mt-3 max-h-28 overflow-y-auto font-mono text-[11px] text-dim" ref={logRef}>
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={rebootMode !== null}
        title={rebootMode === 'device' ? 'Reboot device' : rebootMode === 'recovery' ? 'Reboot to recovery' : 'Reboot to bootloader'}
        message={
          <>
            <span className="font-mono text-fg">{activeDevice?.model ?? activeDevice?.serial}</span> will{' '}
            {rebootMode === 'device' ? 'restart' : `reboot into ${rebootMode}`}. Any running mirror or logcat session
            will drop and reconnect automatically.
          </>
        }
        confirmLabel={rebootMode === 'device' ? 'Reboot' : `Reboot to ${rebootMode}`}
        onCancel={() => setRebootMode(null)}
        onConfirm={() => {
          if (rebootMode) void doReboot(rebootMode)
          setRebootMode(null)
        }}
      />
    </>
  )
}