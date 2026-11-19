import { Modal } from './ui'
import { Kbd } from './ui'

const SCRCPY_SHORTCUTS: Array<[string, string]> = [
  ['MOD+q', 'Quit scrcpy'],
  ['MOD+f / F11', 'Fullscreen'],
  ['MOD+o / MOD+Shift+o', 'Turn device screen off / on'],
  ['MOD+r', 'Rotate device'],
  ['MOD+h / MOD+b / MOD+s', 'Home / Back / App switch'],
  ['MOD+p', 'Power button'],
  ['MOD+↑ / MOD+↓', 'Volume'],
  ['MOD+n / MOD+n+n', 'Notification panel / settings panel'],
  ['MOD+c / MOD+x / MOD+v', 'Copy / cut / paste (Android clipboard)'],
  ['MOD+Shift+v', 'Paste PC clipboard as keystrokes'],
  ['MOD+k', 'Physical keyboard settings (UHID mode)'],
  ['MOD+i', 'Toggle FPS counter'],
  ['MOD+Shift+r', 'Reset capture (fixes a frozen window)'],
  ['MOD+g / MOD+w', 'Resize 1:1 / remove black bars'],
  ['Right click', 'Back'],
  ['Middle click', 'Home'],
  ['Ctrl+drag', 'Pinch to zoom'],
  ['Shift+drag', 'Tilt / rotate gesture']
]

const APP_SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+M', 'Mirror the selected device'],
  ['Ctrl+L', 'Open logcat window'],
  ['Ctrl+P', 'Pause / resume logcat'],
  ['Ctrl+D', 'Clear logcat'],
  ['Ctrl+F', 'Focus logcat filter'],
  ['F5', 'Refresh everything'],
  ['?', 'Toggle this sheet'],
  ['Esc', 'Close dialogs'],
  ['Ctrl+1 … Ctrl+5', 'Switch pages (Home, Mirror, Device, Apps, Logs)']
]

export function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" footer={<div className="text-dim text-[11px]">MOD = left Alt or left Super by default.</div>}>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h3 className="mb-2 text-[11px] uppercase tracking-wide text-dim">CDeck</h3>
          <table className="w-full text-[12px]">
            <tbody>
              {APP_SHORTCUTS.map(([keys, label]) => (
                <tr key={keys} className="border-b border-line last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    <Kbd>{keys}</Kbd>
                  </td>
                  <td className="py-1">{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="mb-2 text-[11px] uppercase tracking-wide text-dim">inside the scrcpy window</h3>
          <table className="w-full text-[12px]">
            <tbody>
              {SCRCPY_SHORTCUTS.map(([keys, label]) => (
                <tr key={keys} className="border-b border-line last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">
                    <Kbd>{keys}</Kbd>
                  </td>
                  <td className="py-1">{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  )
}