# CDeck — agent notes

## Commands
- `.\bin\cdeck.cmd <cmd>` (or `cdeck` once installed) — the front door: `run` (default: build+launch+selftest), `dev`, `test`, `selftest`, `wireless`, `pair <ip:port> <code>`, `doctor`, `logs [--follow]`, `mcp`. Lives in `cli/cdeck.mjs`.
- `npm install` — deps. **If `node_modules/electron/dist/electron.exe` is missing** (npm's script blocking skips Electron's download), run `node node_modules/electron/install.js`; if that stalls, download `electron-v<version>-win32-x64.zip` from the Electron GitHub release, extract into `node_modules/electron/dist`, and write `dist` into `node_modules/electron/path.txt`.
- `npm run typecheck` — tsc on renderer + main/preload. Must pass before packaging.
- `npm run build` — electron-vite build (main / preload / renderer to `out/`).
- `npm run dev` — electron-vite dev with HMR.
- Selftest (headless, no GUI): `electron . --selftest` or `$env:CDECK_SELFTEST=1; electron .` — writes `%APPDATA%\CDeck\selftest.json`, exit code 0 only if all checks pass.
- `npm run package` — electron-builder → `release/CDeck-<ver>-setup.exe`.

## Verification pattern used for this repo
1. `npm run typecheck && npm run build`
2. `electron . --selftest` → read `%APPDATA%\CDeck\selftest.json`

## Test harness (user runs these; opencode never spawns electron/node)
- `tools\debug-launch.cmd` — starts CDeck with `--remote-debugging-port=9333`, log to `%TEMP%\cdeck-debug.log`.
- `tools\run-mirror-test.cmd` — drives the running app's UI (toggles the embedded mirror, reads state + app log) and writes `tools\mirror-test-result.json`.
- Override the port with `set CDECK_TEST_PORT=xxxx` before running if the app was started on a different port.
- opencode side only READS the result files — it must not launch electron or node processes.
3. Boot smoke: launch `node_modules/electron/dist/electron.exe <repo>` 10–15 s, confirm process stays alive, no ERROR lines in stderr with `ELECTRON_ENABLE_LOGGING=1`.
4. DOM verification: launch with `--remote-debugging-port=9222`, then a Node script using global `fetch` + `WebSocket` to call `Runtime.evaluate` against the page target (see project history for the exact script).

## Architecture
- `src/main/` — Electron main: `adb.ts` (adb wrapper), `tools.ts` (auto-download platform-tools/scrcpy + legacy `droidlink` appdata/bin migration), `scrcpy.ts` (profiles + launch), `mirror.ts` (embedded scrcpy-server client + WebCodecs feed + control socket), `watchdog.ts` (reconnect + tunnel re-assert), `window/ipc-guard/tray/notify/update/log/process` helpers, `index.ts` (IPC + lifecycle), `selftest.ts`.
- `src/preload/index.ts` — the only renderer→main surface. Sandboxed (`sandbox: true`); contextBridge + ipcRenderer only.
- `src/renderer/` — React 19 + Tailwind v4 (`src/renderer/src/index.css` tokens) + Lucide + sonner + react-virtuoso + tinykeys. Components in `src/renderer/src/components/`. Pages come from `PAGES` in `Sidebar.tsx`.
- `mcp/` — standalone **cdeckmcp** package (its own package.json/node_modules): stdio MCP server (SDK v1 `@modelcontextprotocol/sdk`, legacy initialize handshake) giving AI agents 18 device tools. No Electron dependency — plain `child_process` adb. Build/run: `npm run mcp:build` / `npm run mcp:start`; protocol test: `npm run mcp:test`.
- `src/shared/types.ts` — types shared by all three processes.

## Conventions
- No code comments. Tailwind for all styling; tokens live in `index.css` `@theme inline` block; light theme overrides in `:root[data-theme='light']`.
- Devices are addressed by identity when possible: wireless re-discovery matches the mDNS instance (`adb-<serial>-<random>`), never a stored `ip:port`.
- IPC handlers validate every arg (serial/port/text) via `ipc-guard.ts` before touching the device.
- Never store device serials or paths outside `CDeck.json` in userData. No telemetry.

## Phase-2 modules (added in the "all of it" build)
- `src/main/automation.ts` — macro/suite engine (input steps, assertions, per-step artifacts) + Maestro-compatible YAML import/export + HTML/JUnit reports. `src/main/ui-hierarchy.ts` — uiautomator dump/parse/find + current package + crash counting. `src/main/files.ts` — device file manager ops (root-scoped) + bug-bundle zips. `src/main/api.ts` — localhost HTTP API for the companion phone app (token-protected, host-checked, SSE state stream). Renderer: `FleetPanel` (aliases/tags/groups/broadcast), `FilesPanel`, `AutomationPanel` (recorder + Maestro), `DebugPanel` (perf graphs, crash triage, overrides, appops), `AppLogs`, onboarding modal.
- MCP (`mcp/`): 22 tools incl. ui_dump/ui_find/ui_wait + macro_run, 3 resources, 3 prompts; auto-uses the CDeck local API when it's enabled (`bridge.ts`). Built on `@modelcontextprotocol/server@2.4.0` + `serveStdio(buildServer)` whose default `legacy: 'serve'` answers 2025-era `initialize` handshakes (verified against a legacy client). v1 SDK is not a dependency.
- Embedded mirror tunnel ladder (`src/main/mirror.ts`): pre-flight `/proc/net/unix` probe → reverse attempt with fail-fast on server exit → automatic forward-tunnel fallback (`tunnel_forward=true`, dummy byte, `adb forward`) → per-device capability cached in `store.tunnelModes`. Devices whose adbd won't bind `localabstract` (stock scrcpy fails identically) always land on forward.
- Windows only for now (`taskkill`, `.exe` paths).

## Branding (decided 2026-11-15)
- Product renamed **droidlink → CDeck**. Parent brand: **Centrosof** (the "C" in CDeck).
- Registry namespaces verified clean (npm + GitHub org + .com + .dev, 2026-11-15): `cdeck` (GitHub org `cdeck`, repo `centrosof/CDeck`), **npm `cdeckmcp`** for the MCP package (note: `cdeck-mcp` is taken — use no hyphen). `cdeck.com` and the bare GitHub user handle are taken — do not rely on them.
- Identifiers: appId `dev.cdeck.app`, userData `%APPDATA%\CDeck`, preload bridge `window.cdeck`, API type `CDeckApi`, env `CDECK_SELFTEST`, scrcpy window title `CDeck :: <serial>`.
- Settings migration: a legacy `droidlink.json` in userData is copied to `cdeck.json` on first boot (see `store.ts`).
- The project folder on disk was renamed `Documents/droidlink` → `Documents/cdeck` (2026-11-19); no code referenced it, and the probe/test harness paths were made machine-independent in the same change.

## Known environment facts (verified 2026-11-13)
- User Wi-Fi: SSID `GENESIS HOSTELS`, Public profile, **client isolation ON** → wireless adb impossible; USB only. Phone advertises `adb-XSKZSGFA6DUGTWBI` @ `192.168.100.5` but unreachable.
- adb is winget-installed (`Google.PlatformTools`), version 37.0.1.
- No Rust/Go/Python. Node 24.22.1, npm 11.19.1. Not elevated.
