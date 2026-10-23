// Flow-side helpers for the AI tools: tool definitions, argument validation, results, the activity entry type.
// (The connection itself is the shared, verbatim src/ai/bridgeClient.ts.)
import { BLOCKED_MESSAGE } from "./bridgeClient";

export const LOCALHOST_BLOCKED_MSG = BLOCKED_MESSAGE;

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
/** Text error helper for tools: thrown errors become {ok:false,error}. */
export class ToolError extends Error {}

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
