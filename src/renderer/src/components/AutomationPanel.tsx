import { useEffect, useState } from 'react'
import type { DeviceInfo, Macro, MacroStep, SuiteResult } from '@shared/types'
import { Badge, Button, Card, Empty, Field, Modal } from './ui'
import { showToast } from '../lib/toast'
import { cn } from '../lib/utils'

const win = window.cdeck
const RECORD_KEY = 'cdeck:recording'

export function AutomationPanel({ activeDevice }: { activeDevice: DeviceInfo | null }) {
  const serial = activeDevice?.state === 'device' ? activeDevice.serial : null
  const [macros, setMacros] = useState<Macro[]>([])
  const [recording, setRecording] = useState(() => localStorage.getItem(RECORD_KEY) === 'on')
  const [recorded, setRecorded] = useState<MacroStep[]>([])
  const [results, setResults] = useState<SuiteResult[]>([])
  const [running, setRunning] = useState('')
  const [stepLog, setStepLog] = useState<string[]>([])
  const [yamlOpen, setYamlOpen] = useState(false)
  const [yamlText, setYamlText] = useState('')
  const [yamlName, setYamlName] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const [macroName, setMacroName] = useState('')
  const [editing, setEditing] = useState<Macro | null>(null)

  const load = async () => setMacros(await win.macros.list())
  useEffect(() => {
    void load()
    const offStep = win.onAutomationStep((r) => {
      setStepLog((prev) => [...prev.slice(-200), `#${r.index + 1} ${r.type}: ${r.ok ? 'ok' : 'FAIL'} — ${r.detail}`])
    })
    const offSuite = win.onAutomationSuite((r) => setResults((prev) => [r, ...prev].slice(0, 30)))
    const refreshRec = () => setRecorded(readRecording())
    window.addEventListener('cdeck:record', refreshRec)
    return () => {
      offStep()
      offSuite()
      window.removeEventListener('cdeck:record', refreshRec)
    }
  }, [])

  const toggleRecording = () => {
    const next = !recording
    setRecording(next)
    localStorage.setItem(RECORD_KEY, next ? 'on' : 'off')
    if (next) {
      writeRecording([])
      setRecorded([])
      showToast('info', 'Recording started', 'Use the embedded mirror — your taps/swipes are captured')
    } else {
      setRecorded(readRecording())
      showToast('success', 'Recording stopped', `${readRecording().length} steps captured`)
    }
  }

  const saveRecorded = async () => {
    const steps = readRecording()
    if (steps.length === 0) {
      showToast('error', 'Nothing recorded yet', 'Enable recording, then use the mirror')
      return
    }
    const list = await win.macros.save({
      id: `m${Date.now()}`,
      name: macroName || `Macro ${new Date().toLocaleTimeString()}`,
      deviceSerial: serial,
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    setMacros(list)
    setSaveOpen(false)
    setMacroName('')
    showToast('success', 'Macro saved', `${steps.length} steps`)
  }

  const run = async (macro: Macro, all = false) => {
    if (!serial) {
      showToast('error', 'No device', 'Connect a device first')
      return
    }
    setRunning(all ? 'suite' : macro.id)
    setStepLog([])
    try {
      const res = all ? await win.automation.runSuite(null, serial) : [await win.automation.run(macro.id, serial)]
      setResults((prev) => [...res, ...prev].slice(0, 30))
      showToast(res.every((r) => r.ok) ? 'success' : 'error', all ? 'Suite finished' : 'Macro finished', res.map((r) => `${r.name}: ${r.ok ? 'PASS' : 'FAIL'}`).join(', '))
    } catch (e) {
      showToast('error', 'Run failed', e instanceof Error ? e.message : String(e))
    }
    setRunning('')
  }

  const exportMaestro = async (macro: Macro) => {
    const yaml = await win.automation.toMaestro(macro.id)
    const res = await win.files.save(`${macro.name.replace(/\W+/g, '-')}.yaml`, yaml)
    if (res.ok) showToast('success', 'Exported for Maestro', res.path)
  }

  const importYaml = async () => {
    if (!yamlText.trim()) return
    const list = await win.automation.fromMaestro(yamlText, yamlName || 'Imported suite')
    setMacros(list)
    setYamlOpen(false)
    setYamlText('')
    setYamlName('')
    showToast('success', 'Imported', 'Maestro flow added to your macros')
  }

  const del = async (macro: Macro) => {
    if (!window.confirm(`Delete macro "${macro.name}"?`)) return
    setMacros(await win.macros.remove(macro.id))
  }

  return (
    <>
      <Card
        title="Automation"
        right={
          <div className="flex items-center gap-2">
            <Badge tone={recording ? 'err' : 'neutral'} pulse={recording}>
              {recording ? 'recording' : 'idle'}
            </Badge>
            <Badge tone="neutral">{macros.length} macros</Badge>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant={recording ? 'danger' : 'primary'} onClick={toggleRecording}>
            {recording ? 'Stop recording' : 'Record from mirror'}
          </Button>
          {recording && <span className="text-[11px] text-warn">{recorded.length} steps captured — use the Mirror page</span>}
          {!recording && recorded.length > 0 && (
            <Button onClick={() => setSaveOpen(true)}>Save {recorded.length}-step macro…</Button>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setYamlOpen(true)} title="Paste a Maestro flow (YAML) to import">
            Import Maestro YAML
          </Button>
          <Button size="sm" disabled={!serial || running !== '' || macros.length === 0} onClick={() => void run(macros[0], true)}>
            {running === 'suite' ? 'Running suite…' : 'Run all'}
          </Button>
        </div>

        {macros.length === 0 ? (
          <Empty
            title="No macros yet"
            hint="Record taps on the mirror, or import a Maestro YAML flow. Macros replay on any device and export back to Maestro."
          />
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-md border border-line">
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {macros.map((m) => (
                  <tr key={m.id} className="border-b border-line last:border-0 hover:bg-panel2">
                    <td className="max-w-[220px] truncate py-1.5 pl-2.5" title={m.name}>
                      {m.name}
                    </td>
                    <td className="py-1.5 text-[11px] text-dim">{m.steps.length} steps</td>
                    <td className="py-1.5 text-[11px] text-dim">{new Date(m.updatedAt).toLocaleDateString()}</td>
                    <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" disabled={!serial || running !== ''} onClick={() => void run(m)}>
                        {running === m.id ? 'Running…' : 'Run'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                        View
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void exportMaestro(m)}>
                        Export
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void del(m)}>
                        ✕
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-3 border-t border-line pt-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-dim">Results</span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => void win.automation.report(results, 'html')}>
                Export HTML
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void win.automation.report(results, 'junit')}>
                Export JUnit
              </Button>
            </div>
            <div className="max-h-32 overflow-y-auto font-mono text-[11px]">
              {results.map((r) => (
                <div key={`${r.macroId}-${r.startedAt}`} className={r.ok ? 'text-ok' : 'text-err'}>
                  {r.ok ? 'PASS' : 'FAIL'} {r.name} — {r.steps.filter((s) => s.ok).length}/{r.steps.length} steps,{' '}
                  {(r.durationMs / 1000).toFixed(1)}s{r.artifacts.length ? `, ${r.artifacts.length} artifact(s)` : ''}
                </div>
              ))}
            </div>
            {stepLog.length > 0 && (
              <pre className="mt-2 max-h-28 overflow-y-auto rounded border border-line bg-panel2 p-2 font-mono text-[10.5px] text-dim">
                {stepLog.join('\n')}
              </pre>
            )}
          </div>
        )}
      </Card>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save recorded macro">
        <Field label="Name" hint={`${readRecording().length} steps captured from the mirror`}>
          <input
            className="w-full rounded-md border border-line bg-panel2 px-2 py-1.5"
            value={macroName}
            onChange={(e) => setMacroName(e.target.value)}
            placeholder="e.g. open settings and toggle wifi"
          />
        </Field>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => void saveRecorded()}>
            Save macro
          </Button>
          <Button variant="ghost" onClick={() => setSaveOpen(false)}>
            Cancel
          </Button>
        </div>
      </Modal>

      <Modal open={yamlOpen} onClose={() => setYamlOpen(false)} title="Import Maestro flow">
        <Field label="Name">
          <input className="w-full rounded-md border border-line bg-panel2 px-2 py-1.5" value={yamlName} onChange={(e) => setYamlName(e.target.value)} placeholder="flow name" />
        </Field>
        <Field label="YAML" hint="Paste a Maestro flow (tapOn, inputText, pressKey, assertVisible, swipe, takeScreenshot)">
          <textarea
            className="h-56 w-full rounded-md border border-line bg-panel2 p-2 font-mono text-[11px]"
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            placeholder={'appId: com.example\n---\n- tapOn:\n    point: "100,200"\n- inputText: "hello"\n- assertVisible: "Welcome"'}
          />
        </Field>
        <Button variant="primary" onClick={() => void importYaml()} disabled={!yamlText.trim()}>
          Import
        </Button>
      </Modal>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? editing.name : 'Macro'}>
        {editing && (
          <div className="max-h-[60vh] space-y-1 overflow-y-auto font-mono text-[11.5px]">
            {editing.steps.map((s, i) => (
              <div key={i} className={cn('rounded border border-line bg-panel2 px-2 py-1')}>
                {i + 1}. {JSON.stringify(s)}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  )
}

export function readRecording(): MacroStep[] {
  try {
    const raw = localStorage.getItem('cdeck:recording-steps')
    return raw ? (JSON.parse(raw) as MacroStep[]) : []
  } catch {
    return []
  }
}

export function writeRecording(steps: MacroStep[]): void {
  localStorage.setItem('cdeck:recording-steps', JSON.stringify(steps.slice(-2000)))
}

export function recordStep(step: MacroStep): void {
  if (localStorage.getItem(RECORD_KEY) !== 'on') return
  const steps = readRecording()
  steps.push(step)
  writeRecording(steps)
  window.dispatchEvent(new Event('cdeck:record'))
}