# cdeckmcp

MCP server that lets AI agents (Claude Desktop, Cursor, opencode, VS Code Copilot, anything that speaks MCP) drive a **real Android phone** through CDeck's adb layer — no emulator, no cloud, no account.

Talk to the phone in natural language:

> "What devices are connected?" → `device_list`
> "Open WhatsApp and screenshot the chat list" → `app_start` + `screenshot`
> "Tap the search icon at 630,180, type 'invoice', screenshot to confirm" → `input_tap`, `input_text`, `screenshot`
> "The app crashed — show me the last 500 log lines" → `logcat_get`

## Tools (18)

| Category | Tools |
|---|---|
| Discover | `device_list`, `device_info`, `app_current` |
| Capture | `screenshot` (returns a PNG image block), `dumpsys`, `bugreport` |
| Input | `input_tap`, `input_swipe`, `input_text`, `input_key` |
| Apps | `app_list`, `app_start`, `app_stop`, `app_info` |
| Files | `file_push`, `file_pull` |
| Raw | `shell_exec` (guarded — destructive commands need `risk_ack: true`) |

Conventions that keep agents effective:
- Coordinates from `screenshot` are **device pixels** — use them directly with `input_*`.
- Every state-changing action should be followed by a `screenshot` to verify.
- Prefer dedicated tools over `shell_exec`.
- When a device shows `unauthorized`, the error tells the human to accept the **Allow USB debugging** prompt.

## Requirements

- Node.js 18+
- `adb` on PATH (Android Platform Tools), or set `CDECK_ADB=C:\path\to\adb.exe`
- Optional: `CDECK_SERIAL` to pin a device when several are attached

## Run

```bash
cd mcp
npm install
npm run build
npm start        # stdio server
```

## Client configuration

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cdeck": {
      "command": "node",
      "args": ["C:\\Users\\you\\Documents\\droidlink\\mcp\\dist\\index.js"]
    }
  }
}
```

**opencode** — `opencode.json` (nests under `mcp.servers`, uses `environment`):

```jsonc
{
  "mcp": {
    "servers": {
      "cdeck": {
        "type": "local",
        "command": ["node", "C:\\Users\\you\\Documents\\droidlink\\mcp\\dist\\index.js"]
      }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cdeck": {
      "command": "node",
      "args": ["C:\\Users\\you\\Documents\\droidlink\\mcp\\dist\\index.js"]
    }
  }
}
```

**VS Code (Copilot)** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "cdeck": {
      "command": "node",
      "args": ["C:\\Users\\you\\Documents\\droidlink\\mcp\\dist\\index.js"]
    }
  }
}
```

Replace the `args` path with your actual checkout location. When CDeck ships as an installed
app, this will point at the bundled binary instead.

## Security

- The server binds nothing and phones nowhere: stdio only, local only.
- `shell_exec` refuses destructive patterns (`rm -rf`, root escalation, transport breakers,
  system-package removal) unless the caller passes `risk_ack: true`.
- File tools are limited to `/sdcard/`, `/storage/`, `/data/local/tmp/` on the device.
- No telemetry, no credentials, no network egress.

## Test

```bash
node test-protocol.mjs
```

Exercises initialize → tools/list → tools/call and prints the results.