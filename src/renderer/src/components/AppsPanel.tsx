import { useEffect, useState } from 'react'
import type { DeviceInfo } from '@shared/types'
import { Badge, Button, Card, Empty, Field, Modal } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

interface Props {
  activeDevice: DeviceInfo | null
}

export function AppsPanel({ activeDevice }: Props) {
  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const [packages, setPackages] = useState<string[]>([])
  const [launchable, setLaunchable] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [uri, setUri] = useState('')
  const [pkg, setPkg] = useState('')
  const [busyPkg, setBusyPkg] = useState('')
  const [onlyLaunchable, setOnlyLaunchable] = useState(false)
  const [detail, setDetail] = useState<{ pkg: string; version: string; targetSdk: string; minSdk: string; permissions: string[] } | null>(null)
  const [busyPerm, setBusyPerm] = useState('')

  const load = async () => {
    if (!serial) {
      setPackages([])
      setLaunchable(new Set())
      return
    }
    setLoading(true)
    const [res, launcher] = await Promise.all([win.apps.list(serial), win.apps.launchable(serial).catch(() => [] as string[])])
    setPackages(res.packages)
    setLaunchable(new Set(launcher))
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [serial])

  const run = async (label: string, fn: () => Promise<{ ok: boolean; stdout: string; stderr: string }>, target: string) => {
    if (!serial) return
    setBusyPkg(target)
    const res = await fn()
    setBusyPkg('')
    if (res.ok) showToast('success', `${label} — ${target}`, res.stdout.trim() || 'done')
    else showToast('error', `${label} failed`, res.stderr || res.stdout)
  }

  const visible = packages
    .filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
    .filter((p) => (onlyLaunchable ? launchable.has(p) : true))

  const openDeeplink = async () => {
    if (!serial || !uri) return
    const res = await win.apps.deeplink(serial, uri.trim(), pkg.trim() || null)
    if (res.ok) showToast('success', 'Intent sent', uri)
    else showToast('error', 'Intent failed', res.stderr || res.stdout)
  }

  const showDetails = async (p: string) => {
    if (!serial) return
    setBusyPkg(p)
    const info = await win.apps.info(serial, p).catch(() => null)
    setBusyPkg('')
    if (!info) {
      showToast('error', 'Could not read app info', p)
      return
    }
    setDetail({ pkg: p, ...info })
  }

  const togglePermission = async (permission: string, granted: boolean) => {
    if (!serial || !detail) return
    setBusyPerm(permission)
    const res = granted ? await win.apps.revoke(serial, detail.pkg, permission) : await win.apps.grant(serial, detail.pkg, permission)
    setBusyPerm('')
    if (res.ok) showToast('success', granted ? 'Permission revoked' : 'Permission granted', permission)
    else showToast('error', 'Permission change failed', (res.stderr || res.stdout).trim())
    await showDetails(detail.pkg)
  }

  return (
    <>
      <Card
        title="Apps"
        right={
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading || !serial}>
            {loading ? 'Loading…' : 'Reload'}
          </Button>
        }
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5"
            placeholder="filter packages (e.g. com.your.app)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="flex items-center gap-1 text-[11px] text-dim">
            <input type="checkbox" checked={onlyLaunchable} onChange={(e) => setOnlyLaunchable(e.target.checked)} />
            only apps with a launcher
          </label>
          <Badge>{visible.length} shown</Badge>
          {launchable.size > 0 && <Badge tone="neutral">{launchable.size} launchable</Badge>}
        </div>
        {packages.length === 0 ? (
          <Empty title="No third-party apps listed" hint="Connect a device to enumerate installed packages." />
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-md border border-line">
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {visible.map((p) => (
                  <tr key={p} className="border-b border-line last:border-0 hover:bg-panel2">
                    <td className="max-w-[280px] truncate py-1.5 pl-2.5 font-mono" title={p}>
                      {p}
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!serial || busyPkg === p}
                        onClick={() => void navigator.clipboard.writeText(p).then(() => showToast('success', 'Package name copied', p))}
                      >
                        Copy
                      </Button>
<Button
                        size="sm"
                        variant="ghost"
                        disabled={!serial || busyPkg === p || (launchable.size > 0 && !launchable.has(p))}
                        title={
                          launchable.size > 0 && !launchable.has(p)
                            ? 'No launcher activity — this package has no main screen (background, plugin, or input-method app)'
                            : 'Start'
                        }
                        onClick={() => void run('Start', () => win.apps.start(serial!, p), p)}
                      >
                        Start
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!serial || busyPkg === p} onClick={() => void run('Force stop', () => win.apps.stop(serial!, p), p)}>
                        Stop
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!serial || busyPkg === p} onClick={() => void run('Clear data', () => win.apps.clear(serial!, p), p)}>
                        Clear data
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!serial || busyPkg === p}
                        onClick={() => void run('APK path', () => win.apps.path(serial!, p), p)}
                      >
                        Path
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!serial || busyPkg === p} onClick={() => void showDetails(p)} title="Version, SDK level, and runtime permissions">
                        Info
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Deep link runner" right={<span className="text-[11px] text-dim">am start -a VIEW -d</span>}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="min-w-[260px] flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono"
            placeholder="https://example.com/item/42"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
          />
          <input
            className="w-[220px] rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono"
            placeholder="optional: com.example.app"
            value={pkg}
            onChange={(e) => setPkg(e.target.value)}
          />
          <Button variant="primary" onClick={() => void openDeeplink()} disabled={!serial || !uri}>
            Send intent
          </Button>
        </div>
        <div className="mt-1.5 text-[11px] text-dim">
          Tests app links and navigation routes without tapping. Leave the package empty to let Android resolve the link.
        </div>
      </Card>

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail ? detail.pkg : 'App details'}>
        {detail && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <Field label="Version" hint="">
                <span className="font-mono">{detail.version || '—'}</span>
              </Field>
              <Field label="Target SDK" hint="">
                <span className="font-mono">{detail.targetSdk || '—'}</span>
              </Field>
              <Field label="Min SDK" hint="">
                <span className="font-mono">{detail.minSdk || '—'}</span>
              </Field>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-dim">Runtime permissions</div>
              {detail.permissions.length === 0 ? (
                <div className="text-[12px] text-dim">No runtime permissions declared. (dumpsys only reports what was granted or requested.)</div>
              ) : (
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {detail.permissions.map((perm) => {
                    const name = perm.split(':')[0]
                    const granted = perm.includes(':granted=true') || perm.includes(':grant=true')
                    return (
                      <div key={perm} className="flex items-center gap-2 rounded border border-line bg-panel2 px-2 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={perm}>
                          {name}
                        </span>
                        <Badge tone={granted ? 'ok' : 'neutral'}>{granted ? 'granted' : 'not granted'}</Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyPerm === perm}
                          onClick={() => void togglePermission(name, granted)}
                        >
                          {granted ? 'Revoke' : 'Grant'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
