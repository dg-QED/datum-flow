# Datum Bridge — AI control of the Datum apps over MCP (protocol v1)

Datum Bridge lets an MCP client (Claude Desktop, Claude Code, Perplexity's Mac app, any MCP host) drive the Datum apps
that are open in the user's browser. No server deployment: the bridge is a small Node program on the user's own computer.

```
MCP client (Claude / Perplexity)  ──stdio MCP──▶  datum-bridge (localhost)  ◀──WebSocket──  Datum app tab(s) in the browser
                                   (or Streamable HTTP on 127.0.0.1)            ws://127.0.0.1:47213/app
```

## Bridge (lives in `datum-form/bridge/`, package name `datum-bridge`)

- Node ≥ 20, TypeScript compiled to plain JS checked in under `bridge/dist/` so `node bridge/dist/cli.js` works with no build;
  dependencies: `@modelcontextprotocol/sdk`, `ws`, `zod` only.
- Start: `npx -y github:Nerdifitronix/datum-form#main --prefix bridge` is NOT required to work; the documented ways are
  `cd bridge && npm install && node dist/cli.js` and an MCP client config entry
  `{"command":"node","args":["/path/to/datum-form/bridge/dist/cli.js"]}`.
- Transports to the MCP client: stdio (default) and `--http` → Streamable HTTP on `127.0.0.1:47214/mcp`.
- WebSocket listener for apps: `127.0.0.1:47213` path `/app` (port override `--ws-port`). Binds 127.0.0.1 ONLY.
- Origin check on the WebSocket upgrade: allow `https://*.github.io`, `http://localhost:*`, `http://127.0.0.1:*`,
  `null` (file:// pages), plus any `--allow-origin` values. Reject others with 403.
- Pairing: on start the bridge prints (to stderr, never stdout in stdio mode) a 6-digit pairing code, and writes it to
  `~/.datum-bridge/pairing-code`. An app must send it in `hello`; wrong code → `{type:"error",code:"pairing"}` and close.
  `--no-pairing` disables it (for local dev only). Codes persist across restarts unless `--new-code`.

## Messages (JSON text frames)

App → bridge, first frame:
```json
{ "type": "hello", "protocol": 1, "app": "form", "appVersion": "3.2.0", "instance": "a1b2c3",
  "title": "Datum Form — Twisting tower", "pairing": "123456",
  "tools": [ { "name": "run_command", "description": "…", "inputSchema": { "type": "object", "properties": {…}, "required": [] } } ] }
```
- `app` ∈ `form` | `atlas` | `field` | `flow`. `instance` = random id per tab. `tools` = JSON Schema (draft 2020-12 subset).
- The app may send `{ "type": "tools", "tools": [...] }` later to replace its tool list (bridge emits `notifications/tools/list_changed`).
- `{ "type": "event", "level": "info", "message": "…" }` optional, logged by the bridge.

Bridge → app:
```json
{ "type": "welcome", "protocol": 1, "bridgeVersion": "1.0.0" }
{ "type": "call", "id": "c17", "tool": "run_command", "args": { "command": "Box" } }
{ "type": "ping" }            // app answers { "type": "pong" }
```
App → bridge, for each call:
```json
{ "type": "result", "id": "c17", "ok": true,
  "content": [ { "type": "text", "text": "Created 1 box on layer Default (id 4f2…)" },
               { "type": "image", "data": "<base64 png>", "mimeType": "image/png" } ],
  "structured": { "...": "optional JSON result" } }
{ "type": "result", "id": "c17", "ok": false, "error": "No site imported — call import_site first" }
```
- Calls time out in the bridge after 120 s (long analyses report progress with `{type:"progress", id, done, total, message}`).

## MCP surface the bridge exposes

- `datum_list_apps` — connected apps: app, instance, title, tool count.
- For every connected app, each app tool is exposed as `<app>_<tool>` (e.g. `form_run_command`, `field_run_lens`).
  If two tabs of the same app are connected, tools take an optional `instance` argument; default = most recently connected.
- Results pass through: text and image content, `structured` → `structuredContent`.
- No apps connected → tools list holds only `datum_list_apps` and `datum_how_to_connect` (returns setup steps).

## Required tools in every app (same names, app-specific behaviour)

| tool | does |
| --- | --- |
| `get_state` | summary of the open project as JSON (counts, layers, selection, current view/settings) |
| `screenshot` | PNG of the main view (optionally `width`, `height`; default 1280×800) |
| `open_sample` | load one of the app's built-in samples by name |
| `export_file` | produce one of the app's exports (`format`); returns it as text (or base64 for binary) AND offers a download |
| `undo` / `redo` | one step |

Plus app-specific tools (each app's brief lists them). Every tool: validates input, returns a clear error string on bad input,
is undoable where the app has undo, and shows the user what happened (toast + an "AI activity" log panel listing each call,
its arguments and its result, with an "Undo" button per mutating call).

## In-app UX (all four apps, identical)

- A status-bar/menu control **"Connect AI"** (plug icon): off by default. Turning it on asks for the bridge pairing code
  (remembered per browser in localStorage, wrapped in try/catch) and the port (default 47213), then connects.
- States: Off · Connecting · Connected (green dot, "AI connected") · Error (message + "How to connect" link that opens a help
  sheet with the bridge setup steps and the client config snippets for Claude Desktop, Claude Code and Perplexity).
- Auto-reconnect with backoff while switched on. A "Pause AI" toggle rejects calls with `"paused by user"`.
- When the page cannot reach localhost (e.g. inside the claude.ai artifact viewer, where the CSP blocks it), show
  "AI connection works when the app is opened from GitHub Pages or a downloaded file" instead of failing silently.

## WebMCP (bonus, no bridge needed)

If `navigator.modelContext?.provideContext` (or `registerTool`) exists, also register the same tools there so
browser-native agents can call them. Feature-detect only; never assume it exists.

## Shared client code

Each app carries its own copy of `src/ai/bridgeClient.ts` (connection, hello, call dispatch, progress, reconnect,
pairing UI state) and `src/ai/tools.ts` (that app's tool definitions + handlers). Keep `bridgeClient.ts` identical across
apps (copy, don't diverge) so fixes apply everywhere.
