import { useCallback, useEffect, useState, type DragEvent as ReactDragEvent } from 'react'
import type { DeviceInfo, FileEntryLike } from '@shared/types'
import { Badge, Button, Card, ConfirmDialog, Empty } from './ui'
import { showToast } from '../lib/toast'
import { formatBytes } from '../lib/utils'

const win = window.cdeck

const QUICK_PATHS = ['/sdcard', '/sdcard/Download', '/sdcard/Pictures', '/sdcard/DCIM/Camera', '/data/local/tmp']

export function FilesPanel({ activeDevice }: { activeDevice: DeviceInfo | null }) {
  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const [dir, setDir] = useState('/sdcard')
  const [entries, setEntries] = useState<FileEntryLike[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [dragging, setDragging] = useState(false)
  const [bundleBusy, setBundleBusy] = useState(false)
  const [confirm, setConfirm] = useState<FileEntryLike | null>(null)

  const load = useCallback(
    async (target: string) => {
      if (!serial) return
      setLoading(true)
      setError('')
      const res = await win.files.listDir(serial, target)
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? 'could not list directory')
        setEntries([])
        return
      }
      setEntries(res.entries)
    },
    [serial]
  )

  useEffect(() => {
    void load(dir)
  }, [serial, dir, load])

  const parent = dir.replace(/\/[^/]+$/, '') || '/'

  const remove = (entry: FileEntryLike) => {
    if (!entry.dir) setConfirm(entry)
    else if (window.confirm(`Delete folder ${entry.name} and everything inside it?`)) void doRemove(entry)
  }

  const doRemove = async (entry: FileEntryLike) => {
    if (!serial) return
    setBusy(entry.path)
    const res = await win.files.remove(serial, entry.path)
    setBusy('')
    showToast(res.ok ? 'success' : 'error', res.ok ? 'Deleted' : 'Delete failed', res.detail)
    await load(dir)
  }

  const rename = async (entry: FileEntryLike) => {
    if (!serial) return
    const next = window.prompt(`Rename ${entry.name} to:`, entry.name)
    if (!next || next === entry.name) return
    setBusy(entry.path)
    const res = await win.files.rename(serial, entry.path, `${dir.replace(/\/$/, '')}/${next}`)
    setBusy('')
    showToast(res.ok ? 'success' : 'error', res.ok ? 'Renamed' : 'Rename failed', res.detail)
    await load(dir)
  }

  const mkdir = async () => {
    if (!serial) return
    const name = window.prompt('New folder name:')
    if (!name) return
    const res = await win.files.mkdir(serial, `${dir.replace(/\/$/, '')}/${name}`)
    showToast(res.ok ? 'success' : 'error', res.ok ? 'Folder created' : 'Failed', res.detail)
    await load(dir)
  }

  const pull = async (entry: FileEntryLike) => {
    if (!serial) return
    setBusy(entry.path)
    const res = await win.files.pullViaDialog(serial, entry.path)
    setBusy('')
    if (res.ok) showToast('success', 'Pulled', res.detail)
  }

  const onDrop = async (e: ReactDragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!serial) return
    const files = Array.from(e.dataTransfer.files)
    const paths = files.map((f) => win.paths.forFile(f)).filter((p): p is string => Boolean(p))
    if (paths.length === 0) {
      showToast('error', 'Could not resolve dropped files', 'Use the Push button instead')
      return
    }
    setBusy('drop')
    const res = await win.files.pushPaths(serial, dir, paths)
    setBusy('')
    showToast(res.ok ? 'success' : 'error', res.ok ? 'Pushed' : 'Push had failures', res.detail)
    await load(dir)
  }

  const makeBundle = async () => {
    if (!serial) return
    setBundleBusy(true)
    showToast('info', 'Collecting bug bundle…', 'Logs + info + screenshot (adds bugreport, slower)')
    const res = await win.files.bundle(serial, true)
    setBundleBusy(false)
    if (res.ok) {
      showToast('success', 'Bundle saved', res.file)
      await win.captures.openFolder()
    } else {
      showToast('error', 'Bundle failed', res.error)
    }
  }

  if (!serial) {
    return (
      <Card title="Files">
        <Empty title="No device" hint="Connect a device to browse its storage." />
      </Card>
    )
  }

  return (
    <Card
      title="Files"
      right={
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{entries.length} items</Badge>
          {loading && <Badge pulse>loading</Badge>}
        </div>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setDir(parent)} disabled={dir === '/'} title="Up one level">
          ↑
        </Button>
        <input
          className="min-w-[220px] flex-1 rounded-md border border-line bg-panel2 px-2 py-1.5 font-mono text-[12px]"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void load(dir)
          }}
        />
        <Button size="sm" variant="ghost" onClick={() => void load(dir)}>
          Refresh
        </Button>
        <Button size="sm" onClick={() => void mkdir()}>
          New folder
        </Button>
        <Button size="sm" onClick={() => void win.files.pushViaDialog(serial, dir).then((r) => r.ok && void load(dir))}>
          Push…
        </Button>
        <Button size="sm" variant={bundleBusy ? 'default' : 'primary'} disabled={bundleBusy} onClick={() => void makeBundle()} title="One zip: logcat + device info + battery + perf + packages + screenshot (+ bugreport)">
          {bundleBusy ? 'Bundling…' : 'Bug bundle'}
        </Button>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {QUICK_PATHS.map((p) => (
          <button
            key={p}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${p === dir ? 'border-accent text-accent' : 'border-line text-dim hover:text-fg'}`}
            onClick={() => setDir(p)}
          >
            {p}
          </button>
        ))}
      </div>

      {error && <div className="mb-2 text-[12px] text-warn">{error}</div>}

      <div
        className={`max-h-[52vh] overflow-y-auto rounded-md border ${dragging ? 'border-accent' : 'border-line'} bg-panel2/40`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void onDrop(e)}
      >
        {entries.length === 0 ? (
          <div className="p-6 text-center text-dim text-[12px]">
            {loading ? 'loading…' : 'Empty — or drop files here to push them'}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.path}
                  className="border-b border-line last:border-0 hover:bg-panel2"
                  onDoubleClick={() => (entry.dir ? setDir(entry.path) : void pull(entry))}
                >
                  <td className="max-w-[300px] truncate py-1.5 pl-2.5" title={entry.path}>
                    <button className={entry.dir ? 'text-accent' : ''} onClick={() => entry.dir && setDir(entry.path)}>
                      {entry.dir ? '📁' : '📄'} {entry.name}
                    </button>
                  </td>
                  <td className="py-1.5 text-right font-mono text-[10px] text-dim">{entry.dir ? '—' : formatBytes(entry.size)}</td>
                  <td className="py-1.5 pl-3 font-mono text-[10px] text-dim">{entry.mtime}</td>
                  <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                    {!entry.dir && (
                      <Button size="sm" variant="ghost" disabled={busy === entry.path} onClick={() => void pull(entry)}>
                        Pull
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busy === entry.path} onClick={() => void rename(entry)}>
                      Rename
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === entry.path} onClick={() => void remove(entry)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-1.5 text-[11px] text-dim">
        Double-click a folder to open, or a file to pull it. Drop files onto the list to push them to {dir}. Allowed roots:
        /sdcard, /storage, /data/local/tmp.
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title="Delete file"
        message={
          <>
            <span className="font-mono text-fg">{confirm?.path}</span> will be removed from the device. This cannot be
            undone.
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm) void doRemove(confirm)
          setConfirm(null)
        }}
      />
    </Card>
  )
}