// Datum Bridge client (protocol v1, docs/mcp-bridge.md). Framework-free and shared verbatim by every Datum app:
// connection, hello, call dispatch, progress, ping, reconnect with backoff, pairing settings, pause,
// AI activity log with per-call undo, and optional WebMCP registration.

export const BRIDGE_PROTOCOL = 1;
export const DEFAULT_PORT = 47213;
export const LOCALHOST_BLOCKED_MSG = "AI connection works when the app is opened from GitHub Pages or a downloaded file";

export type JsonSchema = Record<string, unknown>;
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: ToolContent[];
  structured?: unknown;
  /** Present on mutating calls: reverts exactly this call (shown as "Undo" in the activity panel). */
  undo?: () => void | Promise<void>;
}
export interface ToolContext {
  /** Report progress for long calls (forwarded to the bridge as {type:"progress"}). */
  progress: (done: number, total: number, message?: string) => void;
  /** "bridge" or "webmcp". */
  via: "bridge" | "webmcp";
}
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  mutating?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export type BridgeStatus = "off" | "connecting" | "connected" | "error";
export interface ActivityEntry {
  id: number;
  time: number;
  tool: string;
  args: Record<string, unknown>;
  via: "bridge" | "webmcp";
  state: "running" | "ok" | "error" | "undone";
  summary: string;
  progress?: { done: number; total: number; message?: string };
  undo?: () => void | Promise<void>;
}
export interface BridgeState {
  enabled: boolean;
  status: BridgeStatus;
  message: string;
  paused: boolean;
  port: number;
  pairing: string;
  bridgeVersion: string | null;
  activity: ActivityEntry[];
  webmcp: boolean;
}

export interface BridgeClientOptions {
  app: "form" | "atlas" | "field" | "flow";
  appVersion: string;
  title: () => string;
  tools: () => ToolDef[];
  /** Called after every call finishes (toast etc.). */
  onActivity?: (e: ActivityEntry) => void;
  storageKey?: string;
}

/** Text error helper for tools: thrown errors become {ok:false,error}. */
export class ToolError extends Error {}

const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

/** Pages hosted inside the claude.ai artifact viewer cannot open ws://127.0.0.1 (CSP). */
export function localhostLikelyBlocked(): boolean {
  try {
    const h = location.hostname;
    return /(^|\.)claude\.ai$|claudeusercontent\.com$|(^|\.)claude\.site$/.test(h);
  } catch { return false; }
}

export function textResult(text: string, structured?: unknown): ToolResult {
  return { content: [{ type: "text", text }], structured };
}

/** Minimal JSON-Schema check (type / required / enum / number ranges) for incoming arguments. */
export function validateArgs(schema: JsonSchema, args: unknown, path = "args"): string | null {
  const s = schema as { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: unknown[]; minimum?: number; maximum?: number; items?: JsonSchema; additionalProperties?: boolean };
  const types = s.type === undefined ? null : Array.isArray(s.type) ? s.type : [s.type];
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types) {
    const t = typeOf(args);
    const ok = types.some((x) => x === t || (x === "number" && t === "integer"));
    if (!ok) return `${path} must be ${types.join(" or ")} (got ${t})`;
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(args))) return `${path} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  if (typeof args === "number") {
    if (s.minimum !== undefined && args < s.minimum) return `${path} must be ≥ ${s.minimum}`;
    if (s.maximum !== undefined && args > s.maximum) return `${path} must be ≤ ${s.maximum}`;
  }
  if (Array.isArray(args) && s.items) {
    for (let i = 0; i < args.length; i++) { const e = validateArgs(s.items, args[i], `${path}[${i}]`); if (e) return e; }
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    for (const r of s.required ?? []) if (o[r] === undefined) return `${path}.${r} is required`;
    for (const [k, v] of Object.entries(o)) {
      const ps = s.properties?.[k];
      if (!ps) { if (s.additionalProperties === false) return `${path}.${k} is not a known argument`; continue; }
      if (v === undefined) continue;
      const e = validateArgs(ps, v, `${path}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

let seq = 0;

export class BridgeClient {
  private opts: BridgeClientOptions;
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private subs = new Set<() => void>();
  private key: string;
  private blocked = false;
  state: BridgeState;

  constructor(opts: BridgeClientOptions) {
    this.opts = opts;
    this.key = opts.storageKey ?? `datum-${opts.app}:ai`;
    let saved: Partial<BridgeState> = {};
    try { saved = JSON.parse(ls.get(this.key) ?? "{}"); } catch { saved = {}; }
    this.state = {
      enabled: false, status: "off", message: "", paused: false,
      port: Number(saved.port) || DEFAULT_PORT, pairing: typeof saved.pairing === "string" ? saved.pairing : "",
      bridgeVersion: null, activity: [], webmcp: false,
    };
    if (typeof window !== "undefined") {
      window.addEventListener("securitypolicyviolation", (e) => {
        if (/^wss?:\/\/(127\.0\.0\.1|localhost)/.test(e.blockedURI) || (e.violatedDirective.startsWith("connect-src") && /127\.0\.0\.1|localhost|^wss?:/.test(e.blockedURI))) {
          this.blocked = true;
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.set({ status: "error", message: LOCALHOST_BLOCKED_MSG });
        }
      });
    }
  }

  subscribe(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private set(p: Partial<BridgeState>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f()); }
  private save() { ls.set(this.key, JSON.stringify({ port: this.state.port, pairing: this.state.pairing })); }

  /** Turn the connection on (remembering pairing code and port) or off. */
  enable(on: boolean, settings?: { pairing?: string; port?: number }) {
    if (settings) { this.set({ pairing: (settings.pairing ?? this.state.pairing).trim(), port: settings.port ?? this.state.port }); this.save(); }
    if (!on) {
      this.set({ enabled: false, status: "off", message: "" });
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      try { this.ws?.close(); } catch { /* ignore */ }
      this.ws = null;
      return;
    }
    this.set({ enabled: true });
    this.retry = 0;
    this.connect();
  }
  setPaused(p: boolean) { this.set({ paused: p }); }
  /** Re-announce the tool list (e.g. after the set of tools changed). */
  refreshTools() { this.send({ type: "tools", tools: this.toolList() }); }
  event(message: string, level: "info" | "warn" | "error" = "info") { this.send({ type: "event", level, message }); }

  private toolList() { return this.opts.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); }
  private send(m: unknown) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  private connect() {
    if (!this.state.enabled) return;
    if (this.blocked || localhostLikelyBlocked()) { this.set({ status: "error", message: LOCALHOST_BLOCKED_MSG }); return; }
    this.set({ status: "connecting", message: `Connecting to 127.0.0.1:${this.state.port}…` });
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${this.state.port}/app`); }
    catch { this.set({ status: "error", message: LOCALHOST_BLOCKED_MSG }); return; }
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "hello", protocol: BRIDGE_PROTOCOL, app: this.opts.app, appVersion: this.opts.appVersion,
        instance: instanceId(), title: this.opts.title(), pairing: this.state.pairing, tools: this.toolList(),
      }));
    };
    ws.onmessage = (ev) => {
      let m: { type?: string; [k: string]: unknown };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "welcome") { welcomed = true; this.retry = 0; this.set({ status: "connected", message: "AI connected", bridgeVersion: String(m.bridgeVersion ?? "") }); }
      else if (m.type === "ping") this.send({ type: "pong" });
      else if (m.type === "error") {
        const pairing = m.code === "pairing";
        this.set({ status: "error", message: pairing ? "Wrong pairing code — copy it from the bridge (~/.datum-bridge/pairing-code)" : String(m.message ?? "Bridge error") });
        if (pairing) this.set({ enabled: false });
        try { ws.close(); } catch { /* ignore */ }
      } else if (m.type === "call") this.dispatch(String(m.id), String(m.tool), (m.args ?? {}) as Record<string, unknown>, "bridge");
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.state.enabled) return;
      if (this.blocked) { this.set({ status: "error", message: LOCALHOST_BLOCKED_MSG }); return; }
      if (this.state.status !== "error" || welcomed) {
        this.set({ status: "error", message: welcomed ? "Bridge disconnected — reconnecting…" : localhostLikelyBlocked() ? LOCALHOST_BLOCKED_MSG : `Can't reach the Datum Bridge on 127.0.0.1:${this.state.port} — is it running?` });
      }
      if (!this.state.enabled) return;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(4, this.retry++));
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Run one tool call from either transport; records it in the activity log. */
  async dispatch(id: string, tool: string, args: Record<string, unknown>, via: "bridge" | "webmcp"): Promise<{ ok: boolean; content?: ToolContent[]; structured?: unknown; error?: string }> {
    const entry: ActivityEntry = { id: ++seq, time: Date.now(), tool, args: redact(args), via, state: "running", summary: "…" };
    const push = (e: ActivityEntry) => this.set({ activity: [e, ...this.state.activity.filter((x) => x.id !== e.id)].slice(0, 200) });
    const fail = (error: string) => {
      const e = { ...entry, state: "error" as const, summary: error };
      push(e); this.opts.onActivity?.(e);
      if (via === "bridge") this.send({ type: "result", id, ok: false, error });
      return { ok: false, error };
    };
    if (this.state.paused) return fail("paused by user");
    const def = this.opts.tools().find((t) => t.name === tool);
    if (!def) return fail(`Unknown tool "${tool}"`);
    const bad = validateArgs(def.inputSchema, args ?? {});
    if (bad) return fail(`Invalid arguments: ${bad}`);
    push(entry);
    try {
      const ctx: ToolContext = {
        via,
        progress: (done, total, message) => {
          if (via === "bridge") this.send({ type: "progress", id, done, total, message });
          push({ ...entry, progress: { done, total, message } });
        },
      };
      const r = await def.handler(args ?? {}, ctx);
      const text = r.content.find((c) => c.type === "text") as { text: string } | undefined;
      const e: ActivityEntry = { ...entry, state: "ok", summary: (text?.text ?? "done").slice(0, 400), undo: r.undo };
      push(e); this.opts.onActivity?.(e);
      if (via === "bridge") this.send({ type: "result", id, ok: true, content: r.content, structured: r.structured });
      return { ok: true, content: r.content, structured: r.structured };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Undo one logged call (its own undo function); marks it undone. */
  async undoEntry(id: number) {
    const e = this.state.activity.find((x) => x.id === id);
    if (!e?.undo || e.state !== "ok") return;
    await e.undo();
    this.set({ activity: this.state.activity.map((x) => (x.id === id ? { ...x, state: "undone" as const, undo: undefined } : x)) });
  }
  clearActivity() { this.set({ activity: [] }); }

  /** Register the same tools with a browser-native agent (WebMCP) when the API exists. Feature-detected only. */
  registerWebMCP(): boolean {
    type MC = { provideContext?: (c: unknown) => unknown; registerTool?: (t: unknown) => unknown };
    const mc = (typeof navigator !== "undefined" ? (navigator as unknown as { modelContext?: MC }).modelContext : undefined);
    if (!mc || (typeof mc.provideContext !== "function" && typeof mc.registerTool !== "function")) return false;
    const tools = this.opts.tools().map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      execute: async (args: Record<string, unknown>) => {
        const r = await this.dispatch(`w${Date.now()}`, t.name, args ?? {}, "webmcp");
        if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
        return { content: r.content, structuredContent: r.structured };
      },
    }));
    try {
      if (typeof mc.provideContext === "function") mc.provideContext({ tools });
      else for (const t of tools) mc.registerTool!(t);
      this.set({ webmcp: true });
      return true;
    } catch { return false; }
  }
}

let inst: string | null = null;
function instanceId() { return (inst ??= Math.random().toString(36).slice(2, 8)); }

/** Keep the activity log readable: long strings (file contents, images) are shortened. */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  return out;
}

export const HOW_TO_CONNECT = {
  steps: [
    "Get the bridge: git clone https://github.com/Nerdifitronix/datum-form, then cd datum-form/bridge && npm install",
    "Add it to your MCP client (snippets below). The client starts the bridge; it prints a 6-digit pairing code and saves it to ~/.datum-bridge/pairing-code",
    "Open this app from GitHub Pages or a downloaded file, click Connect AI, enter the pairing code (port 47213) and switch it on",
    "Ask your assistant to use the Datum tools (e.g. “flow_get_state”)",
  ],
  claudeDesktop: `{\n  "mcpServers": {\n    "datum": { "command": "node", "args": ["/path/to/datum-form/bridge/dist/cli.js"] }\n  }\n}`,
  claudeCode: "claude mcp add datum -- node /path/to/datum-form/bridge/dist/cli.js",
  perplexity: `Settings → Connectors → Add MCP server → Command: node  Arguments: /path/to/datum-form/bridge/dist/cli.js`,
};
