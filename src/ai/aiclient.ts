// Flow's AI connection: wraps the shared Datum Bridge client (bridgeClient.ts, identical in every Datum app)
// with Flow's tools, argument validation, the AI activity log (per-call Undo), toasts and WebMCP.
import { useSyncExternalStore } from "react";
import { createBridgeClient, registerWebMCP, DEFAULT_PORT, type BridgeResult, type BridgeStatus } from "./bridgeClient";
import { validateArgs, ToolError, type ActivityEntry, type ToolDef, LOCALHOST_BLOCKED_MSG, localhostLikelyBlocked } from "./toolkit";
import { flowTools } from "./tools";
import { getState } from "../store";
import pkg from "../../package.json";

export const APP_VERSION: string = pkg.version;

export interface AIState {
  enabled: boolean;
  status: BridgeStatus["state"];
  message: string;
  blocked: boolean;
  paused: boolean;
  port: number;
  pairing: string;
  bridgeVersion: string | null;
  activity: ActivityEntry[];
  webmcp: boolean;
}

let toolCache: ToolDef[] | null = null;
const tools = () => (toolCache ??= flowTools());
const subs = new Set<() => void>();
let seq = 0;

function fromStatus(s: BridgeStatus, prev?: AIState): AIState {
  return {
    enabled: s.state !== "off", status: s.state, message: s.message, blocked: s.blocked || (s.state === "error" && localhostLikelyBlocked()),
    paused: s.paused, port: s.port, pairing: s.code, bridgeVersion: s.bridgeVersion,
    activity: prev?.activity ?? [], webmcp: prev?.webmcp ?? false,
  };
}

const client = createBridgeClient({
  app: "flow",
  appVersion: APP_VERSION,
  title: () => `Datum Flow — ${getState().project?.title ?? ""}`,
  tools: () => tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  onCall: (tool, args, ctx) => dispatch(tool, args, "bridge", ctx.progress),
  onStatus: (s) => set(fromStatus(s, bridge.state)),
  onActivity: (e) => {
    // paused calls never reach dispatch: log them here
    if (!e.ok && e.error === "paused by user") record({ id: ++seq, time: Date.now(), tool: e.tool, args: redact(e.args), via: "bridge", state: "error", summary: e.error });
  },
});

function set(next: AIState) { bridge.state = next; subs.forEach((f) => f()); }
function record(e: ActivityEntry) {
  set({ ...bridge.state, activity: [e, ...bridge.state.activity.filter((x) => x.id !== e.id)].slice(0, 200) });
  if (e.state !== "running") window.dispatchEvent(new CustomEvent("flow:ai-activity", { detail: e }));
}

/** Validate, run and log one tool call. Throws (→ {ok:false,error}) on any failure. */
async function dispatch(tool: string, args: Record<string, unknown>, via: "bridge" | "webmcp", progress?: (done: number, total?: number, message?: string) => void): Promise<BridgeResult> {
  const entry: ActivityEntry = { id: ++seq, time: Date.now(), tool, args: redact(args), via, state: "running", summary: "…" };
  const fail = (msg: string): never => { record({ ...entry, state: "error", summary: msg }); throw new ToolError(msg); };
  const def = tools().find((t) => t.name === tool);
  if (!def) fail(`Unknown tool "${tool}". Tools: ${tools().map((t) => t.name).join(", ")}`);
  const bad = validateArgs(def!.inputSchema, args ?? {});
  if (bad) fail(`Invalid arguments: ${bad}`);
  record(entry);
  try {
    const r = await def!.handler(args ?? {}, {
      via,
      progress: (done, total, message) => { progress?.(done, total, message); record({ ...entry, progress: { done, total, message } }); },
    });
    const text = r.content.find((c) => c.type === "text") as { text: string } | undefined;
    record({ ...entry, state: "ok", summary: (text?.text ?? "done").slice(0, 400), undo: r.undo });
    return { content: r.content, structured: r.structured as Record<string, unknown> | undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record({ ...entry, state: "error", summary: msg });
    throw err instanceof ToolError ? err : new ToolError(msg);
  }
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  return out;
}

/** The app-facing AI controller (also exposed to tests as window.__flow.bridge). */
export const bridge = {
  state: fromStatus(client.status()) as AIState,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  enable(on: boolean, s?: { pairing?: string; port?: number }) {
    if (!on) { client.disconnect(); return; }
    if (localhostLikelyBlocked()) { client.connect({ code: s?.pairing, port: s?.port ?? DEFAULT_PORT }); set({ ...bridge.state, status: "error", blocked: true, message: LOCALHOST_BLOCKED_MSG }); return; }
    client.connect({ code: s?.pairing, port: s?.port });
  },
  setPaused(p: boolean) { client.setPaused(p); },
  async undoEntry(id: number) {
    const e = bridge.state.activity.find((x) => x.id === id);
    if (!e?.undo || e.state !== "ok") return;
    await e.undo();
    set({ ...bridge.state, activity: bridge.state.activity.map((x) => (x.id === id ? { ...x, state: "undone" as const, undo: undefined } : x)) });
  },
  clearActivity() { set({ ...bridge.state, activity: [] }); },
  /** Call a tool locally (used by WebMCP). */
  call: (tool: string, args: Record<string, unknown>) => dispatch(tool, args, "webmcp"),
};

let inited = false;
export function initAI() {
  if (inited) return;
  inited = true;
  try { if (registerWebMCP(tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), (t, a) => dispatch(t, a, "webmcp"))) set({ ...bridge.state, webmcp: true }); }
  catch { /* feature-detected only */ }
}

export function useBridge<T>(sel: (s: AIState) => T): T {
  return useSyncExternalStore(bridge.subscribe, () => sel(bridge.state), () => sel(bridge.state));
}
