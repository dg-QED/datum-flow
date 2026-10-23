// "Connect AI" control, connection dialog, How-to-connect sheet and the AI activity log (per-call Undo).
import { useState } from "react";
import { bridge, useBridge } from "../ai/aiclient";
import { DEFAULT_PORT } from "../ai/bridgeClient";
import { HOW_TO_CONNECT, LOCALHOST_BLOCKED_MSG, localhostLikelyBlocked } from "../ai/toolkit";
import { Field, Icon, Modal } from "../ui";
import { setState } from "../store";

const STATUS_LABEL = { off: "AI off", connecting: "Connecting…", connected: "AI connected", error: "AI error" } as const;

export function ConnectAIButton({ compact }: { compact?: boolean }) {
  const status = useBridge((s) => s.status);
  const paused = useBridge((s) => s.paused);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn sm ai-btn ${status}`} onClick={() => setOpen(true)} title={STATUS_LABEL[status]} data-testid="connect-ai">
        <span className={`ai-dot ${status}${paused ? " paused" : ""}`} /><Icon name="plug" size={14} />{!compact && (status === "off" ? "Connect AI" : paused ? "AI paused" : STATUS_LABEL[status])}
      </button>
      {open && <ConnectAIDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function ConnectAIDialog({ onClose }: { onClose: () => void }) {
  const st = useBridge((s) => s);
  const [pairing, setPairing] = useState(st.pairing);
  const [port, setPort] = useState(String(st.port || DEFAULT_PORT));
  const [help, setHelp] = useState(false);
  const blocked = localhostLikelyBlocked();
  const apply = (on: boolean) => bridge.enable(on, { pairing, port: Number(port) || DEFAULT_PORT });
  return (
    <Modal title="Connect AI (Datum Bridge · MCP)" onClose={onClose} width={520} footer={<>
      <button className="btn ghost" onClick={() => setHelp(true)} data-testid="ai-howto">How to connect</button>
      <span className="grow" />
      <button className="btn" onClick={onClose}>Close</button>
      {st.enabled && <button className="btn" onClick={() => apply(false)} data-testid="ai-off">Turn off</button>}
      {(st.status === "off" || (st.status === "error" && !st.blocked)) && <button className="btn primary" onClick={() => apply(true)} disabled={!/^\d{6}$/.test(pairing.trim())} data-testid="ai-on"><Icon name="plug" size={14} />{st.status === "error" ? "Reconnect" : "Connect"}</button>}
    </>}>
      <div className="hint">Lets an AI assistant (Claude Desktop, Claude Code, Perplexity or any MCP client) drive this tab through the Datum Bridge running on your computer. Nothing leaves your machine except what the assistant asks for.</div>
      <div className={`note ai-status ${st.status}`} data-testid="ai-status">
        <span className={`ai-dot ${st.status}`} /> <b>{STATUS_LABEL[st.status]}</b>{st.message && st.message !== "AI connected" && st.message !== "AI off" && !st.blocked ? ` — ${st.message}` : ""}{st.bridgeVersion && st.status === "connected" ? ` · bridge ${st.bridgeVersion}` : ""}
      </div>
      {(blocked || st.blocked) && <div className="note err" data-testid="ai-blocked">{LOCALHOST_BLOCKED_MSG}. This page cannot reach 127.0.0.1 from here.</div>}
      <Field label="Pairing code"><input className="input mono" inputMode="numeric" maxLength={6} placeholder="6 digits from the bridge" value={pairing} onChange={(e) => setPairing(e.target.value.replace(/\D/g, ""))} data-testid="ai-pairing" /></Field>
      <Field label="Port"><input className="input mono" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} data-testid="ai-port" /></Field>
      <label className="row"><input type="checkbox" checked={st.paused} onChange={(e) => bridge.setPaused(e.target.checked)} data-testid="ai-pause" />Pause AI — calls are rejected with “paused by user”</label>
      {st.webmcp && <div className="hint">Also registered with this browser's built-in agent (WebMCP).</div>}
      <div className="hint">Every call the assistant makes appears in <b>AI activity</b> (right panel) with its arguments and result; changes can be undone there or with ⌘Z.</div>
      {help && <HowToConnect onClose={() => setHelp(false)} />}
    </Modal>
  );
}

export function HowToConnect({ onClose }: { onClose: () => void }) {
  const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* clipboard may be blocked */ } };
  const block = (label: string, text: string) => (
    <div className="col" style={{ gap: 4 }}>
      <div className="row"><span className="eyebrow">{label}</span><span className="grow" /><button className="btn sm ghost" onClick={() => copy(text)}><Icon name="copy" size={12} />Copy</button></div>
      <pre className="code">{text}</pre>
    </div>
  );
  return (
    <Modal title="How to connect an AI assistant" onClose={onClose} width={620} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <ol className="steps">{HOW_TO_CONNECT.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      {block("Claude Desktop — claude_desktop_config.json", HOW_TO_CONNECT.claudeDesktop)}
      {block("Claude Code", HOW_TO_CONNECT.claudeCode)}
      {block("Perplexity (Mac app)", HOW_TO_CONNECT.perplexity)}
      <div className="hint">The bridge listens on 127.0.0.1:47213 only and accepts pages from GitHub Pages, localhost and downloaded files. Flow's tools appear as <span className="mono">flow_get_state</span>, <span className="mono">flow_run_simulation</span>, … Inside the claude.ai artifact viewer the connection is blocked: {LOCALHOST_BLOCKED_MSG.toLowerCase()}.</div>
    </Modal>
  );
}

export function AiActivity() {
  const activity = useBridge((s) => s.activity);
  const status = useBridge((s) => s.status);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="panel-body" data-testid="ai-activity">
      <div className="panel-pad row">
        <span className={`ai-dot ${status}`} /><b>{STATUS_LABEL[status]}</b><span className="grow" />
        {activity.length > 0 && <button className="btn sm ghost" onClick={() => bridge.clearActivity()}>Clear</button>}
      </div>
      {!activity.length && <div className="panel-empty">No AI calls yet.<br />Use <b>Connect AI</b> in the top bar to let an assistant drive this model.</div>}
      {activity.map((e) => (
        <div key={e.id} className={`ai-entry ${e.state}`} data-testid="ai-entry">
          <div className="row" onClick={() => setOpen(open === e.id ? null : e.id)} style={{ cursor: "pointer" }}>
            <span className={`badge ${e.state === "ok" ? "ok" : e.state === "error" ? "err" : e.state === "running" ? "pending" : ""}`}>{e.state}</span>
            <span className="mono ai-tool">{e.tool}</span>
            <span className="grow" />
            <span className="faint mono" style={{ fontSize: 10.5 }}>{new Date(e.time).toLocaleTimeString("en-CA", { hour12: false })}</span>
            {e.undo && e.state === "ok" && <button className="btn sm" onClick={(ev) => { ev.stopPropagation(); void bridge.undoEntry(e.id); }} data-testid="ai-undo"><Icon name="undo" size={12} />Undo</button>}
          </div>
          {e.progress && e.state === "running" && <div className="ai-prog"><span style={{ width: `${Math.min(100, (e.progress.done / Math.max(1, e.progress.total)) * 100)}%` }} /></div>}
          <div className={`ai-sum ${open === e.id ? "open" : ""}`}>{e.state === "running" ? e.progress?.message ?? "running…" : e.summary}</div>
          {open === e.id && <pre className="code">{JSON.stringify(e.args, null, 1)}</pre>}
        </div>
      ))}
    </div>
  );
}

export function openAiPanel() { setState({ rightTab: "ai", sheetTab: "ai", sheetSize: "half" }); }
