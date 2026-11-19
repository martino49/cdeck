import { ChevronLeft, ChevronRight, Cpu, FileText, FolderOpen, Home, Network, Package, ScrollText, Settings, Smartphone, Workflow, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../lib/utils'

export type PageId =
  | 'home'
  | 'mirror'
  | 'device'
  | 'apps'
  | 'files'
  | 'automate'
  | 'logs'
  | 'applogs'
  | 'network'
  | 'tools'
  | 'settings'

export const PAGES: { id: PageId; label: string; icon: LucideIcon; hint: string }[] = [
  { id: 'home', label: 'Home', icon: Home, hint: 'Devices, groups & connect' },
  { id: 'mirror', label: 'Mirror', icon: Smartphone, hint: 'Screen mirroring' },
  { id: 'device', label: 'Device', icon: Cpu, hint: 'Info, display, perf, triage' },
  { id: 'apps', label: 'Apps', icon: Package, hint: 'Packages & intents' },
  { id: 'files', label: 'Files', icon: FolderOpen, hint: 'Browse, push, pull, bundles' },
  { id: 'automate', label: 'Automate', icon: Workflow, hint: 'Macros, suites, Maestro' },
  { id: 'logs', label: 'Logcat', icon: ScrollText, hint: 'Device logs' },
  { id: 'applogs', label: 'App logs', icon: FileText, hint: "CDeck's own log — watch for problems" },
  { id: 'network', label: 'Network', icon: Network, hint: 'Tunnels & watchdog' },
  { id: 'tools', label: 'Tools', icon: Wrench, hint: 'Binaries & downloads' },
  { id: 'settings', label: 'Settings', icon: Settings, hint: 'Preferences, API, audit' }
]

export function Sidebar({ page, onNavigate, collapsed, onToggle }: { page: PageId; onNavigate: (p: PageId) => void; collapsed: boolean; onToggle: () => void }) {
  return (
    <nav className={cn('flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150', collapsed ? 'w-14' : 'w-52')}>
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {PAGES.map((p) => {
          const Icon = p.icon
          const active = p.id === page
          return (
            <button
              key={p.id}
              onClick={() => onNavigate(p.id)}
              title={collapsed ? `${p.label} — ${p.hint}` : p.hint}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors',
                active ? 'bg-panel2 text-fg' : 'text-dim hover:bg-panel2/60 hover:text-fg'
              )}
            >
              <Icon className={cn('h-4.5 w-4.5 shrink-0', active && 'text-accent')} strokeWidth={1.9} />
              {!collapsed && <span className="truncate">{p.label}</span>}
              {!collapsed && active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />}
            </button>
          )
        })}
      </div>
      <button
        onClick={onToggle}
        className="flex items-center justify-center gap-2 border-t border-line px-2.5 py-2 text-[11px] text-dim hover:text-fg"
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </nav>
  )
}