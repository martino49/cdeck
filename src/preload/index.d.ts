import type { cdeckApi } from './index'
import type {
  DeviceInfo,
  ReverseResult,
  UpdateInfo,
  WatchdogState
} from '@shared/types'

declare global {
  interface Window {
    cdeck: cdeckApi & {
      onDevicesChanged: (cb: (devices: DeviceInfo[]) => void) => () => void
      onToolsProgress: (cb: (p: { tool: string; stage: string; receivedBytes: number; totalBytes: number; message?: string }) => void) => () => void
      onWatchdogState: (cb: (state: WatchdogState) => void) => () => void
      onWatchdogTunnels: (cb: (d: { results: ReverseResult[]; serial: string }) => void) => () => void
      onLogcatBatch: (cb: (d: { serial: string; lines: string[] }) => void) => () => void
      onLogcatExit: (cb: (d: { serial: string; code: number | null }) => void) => () => void
      onUpdateAvailable: (cb: (info: UpdateInfo) => void) => () => void
      onTrayAction: (cb: (d: { action: string }) => void) => () => void
      onMirrorPort: (cb: (port: MessagePort) => void) => () => void
      paths: { forFile: (file: File) => string | null }
      onAutomationStep: (cb: (r: { index: number; type: string; ok: boolean; detail: string; at: number }) => void) => () => void
      onAutomationSuite: (cb: (r: import('@shared/types').SuiteResult) => void) => () => void
    }
  }
}

export {}
