// Datum Bridge client — protocol v1 (docs/mcp-bridge.md).
//
// SHARED FILE: Datum Form, Atlas, Field and Flow each carry an identical copy.
// Keep it framework-agnostic (no app imports, no React) and copy changes to every app.
//
//   const ai = createBridgeClient({ app: "form", appVersion: "3.2.0", title: () => document.title,
//     tools: () => TOOLS, onCall: (tool, args, ctx) => run(tool, args, ctx), onStatus: (s) => render(s) });
//   ai.connect({ code: "123456", port: 47213 });   // remembered in localStorage
//   ai.setPaused(true); ai.toolsChanged(); ai.disconnect();

export type BridgeApp = "form" | "atlas" | "field" | "flow";
export type BridgeState = "off" | "connecting" | "connected" | "error";

export interface BridgeTool { name: string; description: string; inputSchema: Record<string, unknown> }
export type BridgeContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface BridgeResult { content?: BridgeContent[]; structured?: Record<string, unknown> }
export interface CallContext {
  id: string;
  /** Report progress for long calls (passed through to the MCP client). */
  progress: (done: number, total?: number, message?: string) => void;
}
export interface BridgeStatus {
  state: BridgeState;
  /** Human-readable status line ("AI connected", "Can't reach Datum Bridge on 127.0.0.1:47213", …). */
  message: string;
  /** The page cannot reach localhost at all (CSP / sandbox) — show the "open from GitHub Pages" hint. */
  blocked: boolean;
  /** The pairing code was rejected — reconnecting will not help until it changes. */
  pairingRejected: boolean;
  paused: boolean;
  port: number;
  code: string;
  bridgeVersion: string | null;
  instance: string;
  /** Next automatic reconnect (ms epoch) while switched on, or null. */
  retryAt: number | null;
}
export interface BridgeClientOptions {
  app: BridgeApp;
  appVersion: string;
  title: () => string;
  tools: () => BridgeTool[];
  onCall: (tool: string, args: Record<string, unknown>, ctx: CallContext) => Promise<BridgeResult>;
  onStatus?: (s: BridgeStatus) => void;
  /** Called for every call with its outcome (activity logs). */
  onActivity?: (e: { id: string; tool: string; args: Record<string, unknown>; ok: boolean; result?: BridgeResult; error?: string; ms: number }) => void;
  /** localStorage key prefix (shared by all Datum apps on the same origin by default). */
  storageKey?: string;
}
export interface BridgeClient {
  status(): BridgeStatus;
  connect(o?: { code?: string; port?: number }): void;
  disconnect(): void;
  setPaused(p: boolean): void;
  /** Re-send the tool list (after it changes). */
  toolsChanged(): void;
  /** Log a message on the bridge. */
  event(message: string, level?: "info" | "warn" | "error"): void;
}

export const PROTOCOL = 1;
export const DEFAULT_PORT = 47213;
export const BLOCKED_MESSAGE = "AI connection works when the app is opened from GitHub Pages or a downloaded file";

const store = {
  get(k: string): string | null { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

export function createBridgeClient(o: BridgeClientOptions): BridgeClient {
  const key = o.storageKey ?? "datum-bridge";
  const instance = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  let ws: WebSocket | null = null;
  let on = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sawCspBlock = false;
  const st: BridgeStatus = {
    state: "off", message: "AI off", blocked: false, pairingRejected: false, paused: false,
    port: Number(store.get(`${key}.port`)) || DEFAULT_PORT, code: store.get(`${key}.code`) ?? "",
    bridgeVersion: null, instance, retryAt: null,
  };
  const emit = () => { try { o.onStatus?.({ ...st }); } catch { /* UI error must not break the client */ } };
  const set = (p: Partial<BridgeStatus>) => { Object.assign(st, p); emit(); };
  const send = (m: unknown) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  // a Content-Security-Policy that forbids localhost shows up as a violation event, not a readable error
  if (typeof document !== "undefined") {
    document.addEventListener("securitypolicyviolation", (e) => {
      const u = (e as SecurityPolicyViolationEvent).blockedURI || "";
      if (/^wss?:\/\/(127\.0\.0\.1|localhost)/.test(u) || ((e as SecurityPolicyViolationEvent).violatedDirective || "").startsWith("connect-src")) {
        sawCspBlock = true;
        if (on) { stopSocket(); set({ state: "error", blocked: true, message: BLOCKED_MESSAGE, retryAt: null }); }
      }
    });
  }

  function stopSocket() {
    if (timer) { clearTimeout(timer); timer = null; }
    const s = ws; ws = null;
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(); } catch { /* */ } }
  }

  function schedule() {
    if (!on || st.blocked || st.pairingRejected) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    attempt++;
    st.retryAt = Date.now() + delay;
    timer = setTimeout(open, delay);
    emit();
  }

  function open() {
    timer = null;
    if (!on) return;
    stopSocket();
    set({ state: "connecting", message: `Connecting to Datum Bridge on 127.0.0.1:${st.port}…`, retryAt: null, bridgeVersion: null });
    let sock: WebSocket;
    try { sock = new WebSocket(`ws://127.0.0.1:${st.port}/app`); }
    catch (e) {
      // CSP / sandbox: the constructor itself refuses
      set({ state: "error", blocked: true, message: BLOCKED_MESSAGE });
      void e;
      return;
    }
    ws = sock;
    let welcomed = false;
    sock.onopen = () => {
      send({ type: "hello", protocol: PROTOCOL, app: o.app, appVersion: o.appVersion, instance, title: safe(o.title, ""), pairing: st.code || undefined, tools: safe(o.tools, []) });
    };
    sock.onmessage = (ev) => {
      let m: { type?: string; [k: string]: unknown };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "welcome") {
        welcomed = true; attempt = 0;
        set({ state: "connected", message: "AI connected", bridgeVersion: String(m.bridgeVersion ?? ""), pairingRejected: false, blocked: false });
      } else if (m.type === "error") {
        if (m.code === "pairing") { set({ state: "error", pairingRejected: true, message: "Pairing code rejected — use the code the bridge printed (also in ~/.datum-bridge/pairing-code)" }); on = true; }
        else set({ state: "error", message: `Bridge: ${String(m.message ?? m.code ?? "error")}` });
      } else if (m.type === "ping") send({ type: "pong" });
      else if (m.type === "call") void handleCall(String(m.id), String(m.tool), (m.args && typeof m.args === "object" ? m.args : {}) as Record<string, unknown>);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (!on) return;
      if (sawCspBlock) { set({ state: "error", blocked: true, message: BLOCKED_MESSAGE }); return; }
      if (st.pairingRejected) return;
      set({ state: "error", message: welcomed ? "Bridge connection lost — reconnecting…" : `Can't reach Datum Bridge on 127.0.0.1:${st.port} — is it running? (node bridge/dist/cli.js)` });
      schedule();
    };
    sock.onerror = () => { /* onclose follows */ };
  }

  async function handleCall(id: string, tool: string, args: Record<string, unknown>) {
    const t0 = Date.now();
    if (st.paused) {
      send({ type: "result", id, ok: false, error: "paused by user" });
      o.onActivity?.({ id, tool, args, ok: false, error: "paused by user", ms: 0 });
      return;
    }
    const ctx: CallContext = { id, progress: (done, total, message) => send({ type: "progress", id, done, total, message }) };
    try {
      const r = await o.onCall(tool, args, ctx);
      send({ type: "result", id, ok: true, content: r.content ?? [{ type: "text", text: "OK" }], structured: r.structured });
      o.onActivity?.({ id, tool, args, ok: true, result: r, ms: Date.now() - t0 });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      send({ type: "result", id, ok: false, error });
      o.onActivity?.({ id, tool, args, ok: false, error, ms: Date.now() - t0 });
    }
  }

  return {
    status: () => ({ ...st }),
    connect(c = {}) {
      if (c.code !== undefined) { st.code = c.code.trim(); store.set(`${key}.code`, st.code); }
      if (c.port !== undefined && Number.isInteger(c.port) && c.port > 0 && c.port < 65536) { st.port = c.port; store.set(`${key}.port`, String(c.port)); }
      on = true; attempt = 0; sawCspBlock = false;
      st.blocked = false; st.pairingRejected = false;
      open();
    },
    disconnect() {
      on = false;
      stopSocket();
      set({ state: "off", message: "AI off", retryAt: null, bridgeVersion: null, blocked: false, pairingRejected: false });
    },
    setPaused(p) { set({ paused: p }); },
    toolsChanged() { send({ type: "tools", tools: safe(o.tools, []) }); },
    event(message, level = "info") { send({ type: "event", level, message }); },
  };
}

function safe<T>(f: () => T, d: T): T { try { return f(); } catch { return d; } }

// ---------------------------------------------------------------- WebMCP (browser-native agents; feature-detected)
/**
 * Register the same tools with `navigator.modelContext` when the browser provides it
 * (provideContext or registerTool). Returns true if registered. Never assumes it exists.
 */
export function registerWebMCP(tools: BridgeTool[], call: (tool: string, args: Record<string, unknown>) => Promise<BridgeResult>): boolean {
  const mc = (typeof navigator !== "undefined" ? (navigator as unknown as { modelContext?: Record<string, unknown> }).modelContext : undefined);
  if (!mc) return false;
  const defs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    execute: async (args: Record<string, unknown>) => {
      try { const r = await call(t.name, args ?? {}); return { content: r.content ?? [{ type: "text", text: "OK" }], structuredContent: r.structured }; }
      catch (e) { return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] }; }
    },
  }));
  try {
    if (typeof mc.provideContext === "function") { (mc.provideContext as (c: unknown) => void)({ tools: defs }); return true; }
    if (typeof mc.registerTool === "function") { for (const d of defs) (mc.registerTool as (d: unknown) => void)(d); return true; }
  } catch { /* the API shape changed: ignore */ }
  return false;
}
