# CDeck

**One command. The whole tool.** Once this repo's `bin` is on your PATH (or after installing), `cdeck` is the only command you need to remember:

**One command. The whole tool.** Once this repo's `bin` is on your PATH (or after installing), `cdeck` is the only command you need to remember:

```powershell
cdeck                 # build if needed → launch the app → quick self-test
cdeck wireless         # connect over Wi-Fi — re-discovers the port every time (ports rotate!)
cdeck pair 192.168.100.5:46179 123456
cdeck test             # launch + run the embedded-mirror UI test
cdeck selftest         # headless self-test (CI friendly)
cdeck doctor           # environment, devices, build, and log report
cdeck logs --follow    # watch CDeck's own log
cdeck mcp              # run the MCP server for AI agents (Claude, Cursor, opencode…)
```

Not on PATH yet? Run it straight from the repo:

```powershell
cd C:\Users\USER\Documents\droidlink
.\bin\cdeck.cmd doctor
```

Roadmap: the installer will put `cdeck` on PATH, and the companion phone app will talk to the same CLI, so `cdeck wireless` becomes one tap on the phone.

**Android development on your real phone instead of the emulator.** Wireless adb, screen mirroring, reverse tunnels, logcat, and an auto-reconnect watchdog — in one small Windows app that never touches your hardware virtualization.

The Android emulator needs WHPX/Hyper-V and 2–4 GB of RAM per device, and it still isn't your phone. CDeck treats your phone as the device: it manages the adb connection, launches [scrcpy](https://github.com/Genymobile/scrcpy) mirroring, keeps tunnels to your laptop-side dev servers alive, and shows logcat — so Run/Debug in Android Studio just works against real hardware.

Built for the Samsung Galaxy Z Flip6, works with any Android 11+ phone.

## Features

- **Device management** — USB and wireless (Android 11+ mDNS pairing wizard, plus legacy `adb tcpip 5555` fallback), multi-device, per-serial targeting.
- **Screen mirroring** — launches scrcpy with purpose-built profiles: Daily (screen off, stays awake, UHID keyboard), Wireless (low bandwidth), **Cover screen (Flip6 — mirrors only the 3.4" cover window)**, Quality, Plain. Custom extra flags for anything scrcpy supports.
- **Reverse tunnels** — map `localhost:PORT` on the phone to ports on your laptop (Next.js :3000, Postgres :5432, your MCP server). Rules are re-asserted automatically because adb drops them whenever the transport drops.
- **Watchdog** — reconnects after sleep/Wi-Fi drops, re-discovers the randomized wireless-debugging port via mDNS, re-asserts tunnels. Visible counters for checks/reconnects/last action.
- **Logcat** — separate window, 20k-line ring buffer, batched IPC (~10 fps), virtualized list (smooth at thousands of lines), pause/resume, substring filter, severity coloring, copy-visible.
- **Device tools** — device info (model, Android version, build fingerprint, battery), viewport/density presets for testing layouts without folding the phone, battery simulation (15%, 5%, charging, unplugged, **reset**), developer toggles (show touches, stay-awake, don't-keep-activities, animation scales).
- **App management** — list/start/force-stop/clear-data/copy package/APK path, deep-link runner (`am start -a VIEW -d …`).
- **Captures** — one-click screenshots, 15s/30s screen recordings saved to a captures folder.
- **Tools auto-install** — scrcpy and platform-tools download and extract automatically on first run into the app's data dir. CDeck pins its own adb so it never conflicts with Android Studio's.
- **App polish** — dark dev-tool UI, keyboard shortcuts (`?` for cheat sheet, `Ctrl+M` mirror, `Ctrl+L` logcat, `F5` refresh), system tray with device status, native notifications for connect/disconnect, window-state persistence, file logging with rotation, `--selftest` harness for headless verification.

## Install

Download `CDeck-<version>-setup.exe` from [Releases](../../releases) and run it (per-user, no admin). Windows will show an "unknown publisher" SmartScreen warning — the installer is unsigned; see [Why is Windows warning me?](#why-is-windows-warning-me).

Or run from source:

```powershell
git clone <repo> && cd CDeck
npm install
node node_modules/electron/install.js   # only if electron.exe is missing after install
npm run dev                             # or: npm run build && electron .
```

## Using it with your phone

### One-time setup on the phone

1. Settings → About phone → Software information → tap **Build number** 7× (enables Developer options).
2. Settings → Developer options → enable **USB debugging**.
3. For wireless: enable **Wireless debugging** (Android 11+).

### Daily workflow

- **USB is the reliable path**: plug in, allow the RSA prompt, the device appears in CDeck. Best latency, charges the phone, no Wi-Fi drama.
- **Wireless**: press **Discover** in CDeck, enter the 6-digit pairing code from the phone once, then **Connect**. The connect port is randomized per session — CDeck re-discovers it every time, so don't hardcode it.
- Press **Mirror device** (or `Ctrl+M`). The scrcpy window opens; `MOD+o` turns the phone's screen off while mirroring to save the panel.
- Set `adb reverse` ports in the **Reverse tunnels** panel (e.g. 3000 for Next.js). Your phone app calls `http://localhost:3000` and hits your laptop. Android blocks cleartext `http://localhost` by default — add a debug-only `network_security_config.xml` allowing `localhost` in your Android project.

### If wireless won't connect

Check in this order:

1. **Laptop and phone on the same Wi-Fi, and the network has no client isolation.** This is the #1 blocker: guest networks, hostel/campus/hotel Wi-Fi and some APs block device-to-device traffic entirely. Symptom: `adb mdns services` finds your phone but `adb connect` times out. Fix: use your **phone's own hotspot**, a router LAN without AP isolation, or USB.
2. Windows firewall prompt on first run — allow adb on **Private** networks. Set your trusted network to Private in Windows Settings.
3. Wireless debugging toggled off, or the phone rebooted (re-pair/rescan).
4. Legacy mode (`adb tcpip 5555`) works when mDNS is blocked but needs one USB connection first.

### Local API access from the phone

```
# Next.js on :3000, Postgres on :5432 — CDeck's tunnel panel does this for you:
adb -s <serial> reverse tcp:3000 tcp:3000
adb -s <serial> reverse tcp:5432 tcp:5432
```

The watchdog re-asserts these after every reconnect. Requests appear in your dev server logs as `127.0.0.1` (the adb server dials loopback itself).

### Foldable testing

The Z Flip6 has two viewports: the 3.4" cover screen (~720×748) and the 6.7" main screen. Use the **Viewport presets** (Cover screen / Main screen / Tablet) and the **Cover screen** scrcpy profile; physically fold/unfold for true app-continuity tests. `POSTURE_HALF_OPENED` (Flex mode) via Jetpack WindowManager is the software hook; CDeck can't fake the fold — that's what the phone is for.

## What this does not replace

Honest limits of a phone-only workflow — covered elsewhere, documented here so you don't get surprised:

- **Multiple API levels** — one phone runs one Android version. Use [Firebase Test Lab](https://firebase.google.com/docs/test-lab) (free tier: 5 physical + 10 virtual runs/day) or [Samsung Remote Test Lab](https://developer.samsung.com/remote-testlab) for other versions.
- **GPS/mock location, SMS/call simulation, network throttling, virtual sensors** — emulator-only commands (`adb emu …` do nothing on hardware). Mock location needs a mock-location app; broadcast intents for SMS/call receivers.
- **`adb backup`** — removed from modern platform-tools.

## Why is Windows warning me?

The installer and app are unsigned. Code-signing certs cost money, and EV certs no longer bypass SmartScreen instantly anyway (reputation is per-download). Until there's reputation, expect the warning once per download: **More info → Run anyway**. Differential updates work unsigned; auto-update checks a configured GitHub repo in Settings → Updates.

## Tech

Electron 45 + React 19 + TypeScript + Vite + Tailwind v4 + Lucide + react-virtuoso + sonner + tinykeys. Rust-free by design (see AGENTS.md for the toolchain rationale). Binaries are not committed; scrcpy and platform-tools are downloaded on demand and extracted into the app's data dir.

## License

MIT
