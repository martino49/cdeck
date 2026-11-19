import { useEffect, useState } from 'react'
import type { DeviceGroup, DeviceInfo, DeviceProfile } from '@shared/types'
import { Badge, Button, Card, Empty, Field } from './ui'
import { showToast } from '../lib/toast'

const win = window.cdeck

export function FleetPanel({ devices, activeDevice }: { devices: DeviceInfo[]; activeDevice: DeviceInfo | null }) {
  const connected = devices.filter((d) => d.state === 'device')
  const [profiles, setProfiles] = useState<Record<string, DeviceProfile>>({})
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [aliasDraft, setAliasDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const [shell, setShell] = useState('')
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState<Array<{ serial: string; ok: boolean; detail: string }>>([])

  const load = async () => {
    setProfiles(await win.profiles.get())
    setGroups(await win.groups.list())
  }

  useEffect(() => {
    void load()
  }, [devices.length])

  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const current = serial ? profiles[serial] ?? {} : {}

  useEffect(() => {
    setAliasDraft(current.alias ?? '')
  }, [serial, current.alias])

  const saveAlias = async () => {
    if (!serial) return
    const p = await win.profiles.set(serial, { ...current, alias: aliasDraft })
    setProfiles((prev) => ({ ...prev, [serial]: p }))
    showToast('success', 'Alias saved', aliasDraft || '(cleared)')
  }

  const addTag = async () => {
    if (!serial || !tagDraft.trim()) return
    const tags = Array.from(new Set([...(current.tags ?? []), tagDraft.trim().toLowerCase()])).slice(0, 12)
    const p = await win.profiles.set(serial, { ...current, tags })
    setProfiles((prev) => ({ ...prev, [serial]: p }))
    setTagDraft('')
  }

  const removeTag = async (tag: string) => {
    if (!serial) return
    const p = await win.profiles.set(serial, { ...current, tags: (current.tags ?? []).filter((t) => t !== tag) })
    setProfiles((prev) => ({ ...prev, [serial]: p }))
  }

  const addGroupFromConnected = async () => {
    const name = window.prompt('Group name (contains all currently connected devices):', `Group ${groups.length + 1}`)
    if (!name) return
    const next = [...groups, { id: `g${Date.now()}`, name, members: connected.map((d) => d.serial) }]
    setGroups(await win.groups.save(next))
    showToast('success', 'Group saved', `${connected.length} device(s)`)
  }

  const removeGroup = async (id: string) => {
    setGroups(await win.groups.save(groups.filter((g) => g.id !== id)))
  }

  const broadcast = async (action: 'screenshot' | 'reboot' | 'screenPower' | 'shell', payload: Record<string, unknown> = {}) => {
    if (connected.length === 0) {
      showToast('error', 'No devices', 'Connect at least one device')
      return
    }
    if (action === 'reboot' && !window.confirm(`Reboot ${connected.length} device(s)?`)) return
    setBusy(action)
    const res = await win.broadcast.run(action, { ...payload, serials: connected.map((d) => d.serial) })
    setBusy('')
    setResults(res)
    showToast(res.every((r) => r.ok) ? 'success' : 'error', `Broadcast ${action}`, `${res.filter((r) => r.ok).length}/${res.length} ok`)
  }

  const broadcastInstall = async () => {
    if (connected.length === 0) return
    setBusy('install')
    const res = await win.broadcast.install(connected.map((d) => d.serial))
    setBusy('')
    if (res.results.length > 0) setResults(res.results)
    showToast(res.ok ? 'success' : 'error', 'Broadcast install', res.detail)
  }

  const groupChips = Object.entries(profiles).filter(([, p]) => (p.tags ?? []).length > 0)

  return (
    <Card
      title="Fleet"
      right={
        <div className="flex items-center gap-2">
          <Badge tone={connected.length > 0 ? 'ok' : 'neutral'}>{connected.length} connected</Badge>
          <Badge tone="neutral">{groups.length} groups</Badge>
        </div>
      }
    >
      {serial ? (
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <Field label="Alias" hint={`Name for ${serial}`}>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5"
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                placeholder="e.g. work Flip6"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveAlias()
                }}
              />
              <Button size="sm" onClick={() => void saveAlias()}>
                Save
              </Button>
            </div>
          </Field>
          <Field label="Tags" hint="Group devices by purpose (ci, qa, demo…)">
            <div className="flex flex-wrap items-center gap-1.5">
              {(current.tags ?? []).map((t) => (
                <button key={t} className="rounded border border-accent/40 px-1.5 py-0.5 text-[11px] text-accent" onClick={() => void removeTag(t)} title="Remove tag">
                  {t} ✕
                </button>
              ))}
              <input
                className="w-28 rounded-md border border-line bg-panel2 px-2 py-1 text-[12px]"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="add tag"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addTag()
                }}
              />
              <Button size="sm" variant="ghost" onClick={() => void addTag()} disabled={!tagDraft.trim()}>
                Add
              </Button>
            </div>
          </Field>
        </div>
      ) : (
        <div className="mb-3 text-[12px] text-dim">Select a device to give it an alias and tags.</div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-[11px] uppercase tracking-wide text-dim">Broadcast to connected</span>
        <Button size="sm" disabled={busy !== '' || connected.length === 0} onClick={() => void broadcast('screenshot')}>
          Screenshot all
        </Button>
        <Button size="sm" disabled={busy !== '' || connected.length === 0} onClick={() => void broadcastInstall()}>
          Install APK all
        </Button>
        <Button size="sm" disabled={busy !== '' || connected.length === 0} onClick={() => void broadcast('screenPower')}>
          Screen on/off all
        </Button>
        <Button size="sm" variant="danger" disabled={busy !== '' || connected.length === 0} onClick={() => void broadcast('reboot')}>
          Reboot all
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="min-w-[200px] flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]"
          placeholder="shell command to run on every connected device"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shell.trim()) void broadcast('shell', { command: shell })
          }}
        />
        <Button size="sm" disabled={!shell.trim() || connected.length === 0} onClick={() => void broadcast('shell', { command: shell })}>
          Run on all
        </Button>
      </div>

      {groups.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {groups.map((g) => (
            <span key={g.id} className="flex items-center gap-1 rounded border border-line bg-panel2 px-1.5 py-0.5 text-[11px]">
              {g.name} <span className="text-dim">({g.members.length})</span>
              <button className="text-dim hover:text-err" onClick={() => void removeGroup(g.id)} title="Delete group">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void addGroupFromConnected()} disabled={connected.length === 0}>
          Save connected as a group
        </Button>
        {groupChips.length > 0 && <span className="text-[11px] text-dim">{groupChips.length} device(s) have tags</span>}
      </div>

      {results.length > 0 && (
        <div className="mt-2 max-h-28 overflow-y-auto rounded border border-line bg-panel2 p-2 font-mono text-[11px]">
          {results.map((r, i) => (
            <div key={`${r.serial}-${i}`} className={r.ok ? 'text-ok' : 'text-err'}>
              {r.ok ? 'ok  ' : 'FAIL'} {r.serial} — {r.detail}
            </div>
          ))}
        </div>
      )}

      {devices.length === 0 && <Empty title="No devices connected" hint="Plug in or pair a device to use fleet features." />}
    </Card>
  )
}