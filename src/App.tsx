import { useCallback, useEffect, useRef, useState } from "react";
import TopView from "./view/TopView";
import View3D from "./view/View3D";
import PlanPanel from "./panels/PlanPanel";
import PropsPanel from "./panels/PropsPanel";
import ScenarioPanel from "./panels/ScenarioPanel";
import ResultsPanel from "./panels/ResultsPanel";
import Transport from "./panels/Transport";
import DxfDialog from "./panels/DxfDialog";
import { Icon, Logo, Menu, Modal, ToastHost, useMedia, useToast } from "./ui";
import { activeScenario, clearAutosave, editProject, getState, readAutosave, redo, setState, undo, useStore, initialSim, type State } from "./store";
import { buildSample, SAMPLES, type SampleId } from "./model/samples";
import { emptyProject } from "./model/defaults";
import type { Project } from "./model/types";
import { parseDXF, type DxfDoc } from "./io/dxf";
import { parseProject, serializeProject } from "./io/project";
import { download } from "./io/download";
import { seriesCSV } from "./io/csv";
import * as simctl from "./simctl";
import { live, resetLive } from "./live";

export default function App() {
  return <ToastHost><Shell /></ToastHost>;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "model";

export function openProject(p: Project) {
  simctl.cancelMonteCarlo();
  resetLive(null);
  const level = p.view?.level && p.levels.some((l) => l.id === p.view!.level) ? p.view.level : [...p.levels].sort((a, b) => b.elevation - a.elevation)[0].id;
  setState((s) => ({ project: p, level, selection: [], undo: [], redo: [], sim: { ...initialSim, speed: s.sim.speed }, info: null, handCalc: null, series: null, results: null, scrub: null, follow: null, mc: null, rev: s.rev + 1, tool: "select" }));
}
export function loadSample(id: SampleId) {
  const p = buildSample(id);
  openProject(p);
  if (id === "office") setState({ level: p.levels.find((l) => l.name === "Level 2")!.id });
}

// test / automation hook
(window as unknown as { __flow?: unknown }).__flow = { getState, setState, simctl, live, loadSample, openProject, serializeProject, parseProject, seriesCSV, parseDXF };

// boot: autosave → else the arena sample, already running
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  const saved = readAutosave();
  if (saved) {
    try { openProject(parseProject(JSON.stringify(saved))); return; } catch { /* fall through */ }
  }
  loadSample("arena");
  setState({ overlay: "none", colorBy: "speed" });
  // open mid-simulation so the first thing people see is alive
  setTimeout(() => { simctl.warmStart(45, 2).catch(() => {}); }, 50);
}
boot();

function Shell() {
  const mobile = useMedia("(max-width: 760px)");
  const toast = useToast();
  const title = useStore((s) => s.project.title);
  const view = useStore((s) => s.view);
  const leftTab = useStore((s) => s.leftTab);
  const rightTab = useStore((s) => s.rightTab);
  const notice = useStore((s) => s.notice);
  const scenarios = useStore((s) => s.project.scenarios);
  const activeId = useStore((s) => s.project.activeScenario);
  const status = useStore((s) => s.sim.status);
  const dirty = useStore((s) => s.sim.dirty);
  const sample = useStore((s) => s.project.sample);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [dxf, setDxf] = useState<{ doc: DxfDoc; name: string } | null>(null);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (notice) { toast(notice, /error|failed/i.test(notice) ? "err" : "info"); setState({ notice: null }); } }, [notice, toast]);

  const importFiles = useCallback(async (files: FileList | File[]) => {
    for (const f of [...files]) {
      try {
        if (/\.json$/i.test(f.name)) { openProject(parseProject(await f.text())); toast(`Opened ${f.name}`, "ok"); continue; }
        if (!/\.dxf$/i.test(f.name)) { toast(`${f.name}: only .dxf and .dflow.json are supported`, "err"); continue; }
        setBusy(`Reading ${f.name}…`);
        const doc = parseDXF(await f.text());
        if (!doc.entities.length) throw new Error("no supported entities (LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, INSERT)");
        setDxf({ doc, name: f.name });
      } catch (e) { toast(`${f.name}: ${(e as Error).message}`, "err"); } finally { setBusy(null); }
    }
  }, [toast]);

  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth++; setDragOver(true); };
    const over = (e: DragEvent) => { if (has(e)) e.preventDefault(); };
    const leave = (e: DragEvent) => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); };
    const drop = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth = 0; setDragOver(false); if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, [importFiles]);

  const saveProject = () => {
    const name = `${safe(getState().project.title)}.dflow.json`;
    download(name, serializeProject(getState().project), "application/json");
    toast(`Saved ${name}`, "ok");
  };
  const exportCSV = () => {
    const s = getState();
    if (!s.series || !s.info) { toast("Run the scenario first", "err"); return; }
    const name = `${safe(s.project.title)}_${safe(activeScenario(s).name)}_timeseries.csv`;
    download(name, seriesCSV(s.series, s.info), "text/csv");
    toast(`Saved ${name}`, "ok");
  };
  const exportPDF = async () => {
    if (!getState().info) { toast("Run the scenario first — the report needs results", "err"); return; }
    setBusy("Building PDF report…");
    try { const { exportReport } = await import("./io/report"); const name = await exportReport(); toast(`Saved ${name}`, "ok"); }
    catch (e) { toast(`Report failed: ${(e as Error).message}`, "err"); }
    finally { setBusy(null); }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); projRef.current?.click(); return; }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (e.key === " ") { e.preventDefault(); if (getState().sim.status === "playing") simctl.pause(); else simctl.play(); return; }
      if (e.key === ".") { simctl.stepOnce(10); return; }
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) { setHelp((v) => !v); return; }
      if (e.key === "3") setState({ view: getState().view === "3d" ? "2d" : "3d" });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const scenarioSelect = (
    <select className="select sm scen-select" value={activeId} onChange={(e) => { editProject((p) => { p.activeScenario = e.target.value; }, { undoable: false }); simctl.reset(); }} aria-label="Scenario" data-testid="top-scenario">
      {scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );

  const projectMenu = (
    <Menu button={(_o, t) => <button className="btn sm" onClick={t} data-testid="project-menu"><Icon name="folder" size={14} />{!mobile && "Project"}<Icon name="down" size={12} /></button>}>
      {(close) => (
        <>
          <div className="hd">Project</div>
          <button onClick={() => { close(); projRef.current?.click(); }} data-testid="open-project"><Icon name="folder" />Open…<span className="k">.dflow.json</span></button>
          <button onClick={() => { close(); saveProject(); }} data-testid="save-project"><Icon name="save" />Save<span className="k">⌘S</span></button>
          <button onClick={() => { close(); openProject(emptyProject()); }}><Icon name="plus" />New empty model</button>
          <button onClick={() => { close(); fileRef.current?.click(); }} data-testid="menu-import-dxf"><Icon name="upload" />Import DXF…</button>
          <div className="sepl" />
          <div className="hd">Samples (fictional)</div>
          {SAMPLES.map((s) => <button key={s.id} onClick={() => { close(); loadSample(s.id); toast(`Loaded ${s.name}`, "ok"); }} data-testid={`sample-${s.id}`}><Icon name="layers" /><span style={{ whiteSpace: "normal" }}>{s.name}</span></button>)}
          <div className="sepl" />
          <div className="hd">Export</div>
          <button onClick={() => { close(); exportPDF(); }} data-testid="export-pdf"><Icon name="pdf" />PDF report</button>
          <button onClick={() => { close(); exportCSV(); }} data-testid="export-csv"><Icon name="table" />Time series CSV</button>
          <div className="sepl" />
          <button onClick={() => { close(); clearAutosave(); toast("Autosave cleared for this browser"); }}><Icon name="trash" />Clear autosave</button>
          <button onClick={() => { close(); setHelp(true); }}><Icon name="info" />Shortcuts & about</button>
        </>
      )}
    </Menu>
  );

  const topbar = (
    <header className="topbar">
      <div className="brand"><Logo /><b>Flow</b><span className="suite">Datum</span></div>
      <span className="sep" />
      <input className="title-input" value={title} aria-label="Model title" onChange={(e) => editProject((p) => { p.title = e.target.value; }, { undoable: false, geometry: false })} />
      {sample && !mobile && <span className="badge pending" title="Fictional sample model for demonstration">sample</span>}
      <span className="grow" />
      {!mobile && <>
        <button className={`btn sm ghost icon ${leftOpen ? "on" : ""}`} title="Toggle left panel" aria-label="Toggle left panel" onClick={() => setLeftOpen((v) => !v)}><Icon name="panelL" /></button>
        <button className={`btn sm ghost icon ${rightOpen ? "on" : ""}`} title="Toggle right panel" aria-label="Toggle right panel" onClick={() => setRightOpen((v) => !v)}><Icon name="panelR" /></button>
        <span className="sep" />
        {scenarioSelect}
        {dirty && status !== "idle" && <button className="btn sm" title="The model changed since this run was built" onClick={() => simctl.reset()}><Icon name="rewind" size={13} />Rebuild</button>}
        <button className="btn sm" onClick={() => fileRef.current?.click()} data-testid="import-dxf"><Icon name="upload" size={14} />DXF</button>
        <button className="btn sm" onClick={exportPDF} data-testid="report"><Icon name="pdf" size={14} />Report</button>
        <button className="btn sm ghost icon" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}><span style={{ font: "600 13px var(--mono)" }}>?</span></button>
      </>}
      {projectMenu}
      {!mobile && <button className="btn sm primary" onClick={saveProject}><Icon name="save" size={14} />Save</button>}
    </header>
  );

  const hidden = (
    <>
      <input ref={fileRef} type="file" accept=".dxf,.json" multiple hidden data-testid="file-input" onChange={(e) => { if (e.target.files) importFiles(e.target.files); e.target.value = ""; }} />
      <input ref={projRef} type="file" accept=".json" hidden data-testid="project-input" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = "";
        if (!f) return;
        try { openProject(parseProject(await f.text())); toast(`Opened ${f.name}`, "ok"); } catch (err) { toast((err as Error).message, "err"); }
      }} />
    </>
  );
  const dialogs = (
    <>
      {dxf && <DxfDialog doc={dxf.doc} name={dxf.name} onClose={() => setDxf(null)} />}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
      {dragOver && <div className="drop-overlay"><div className="box"><Icon name="upload" size={28} /><div style={{ marginTop: 10, fontWeight: 600 }}>Drop a DXF plan or a .dflow.json model</div></div></div>}
      {busy && <div className="busy"><span><span className="spin" /> {busy}</span></div>}
    </>
  );
  const center = (
    <main className="center">
      {view === "3d" ? <View3D /> : <TopView mobile={mobile} />}
      <Transport mobile={mobile} />
    </main>
  );

  if (mobile) {
    return (
      <div className="app">
        {topbar}
        {center}
        <MobileSheet onImport={() => fileRef.current?.click()} />
        {hidden}{dialogs}
      </div>
    );
  }
  return (
    <div className="app">
      {topbar}
      <div className={`body ${leftOpen ? "" : "no-left"} ${rightOpen ? "" : "no-right"}`}>
        <aside className="side left">
          {leftOpen && <>
            <div className="tabs">
              <button className={leftTab === "plan" ? "on" : ""} onClick={() => setState({ leftTab: "plan" })} data-testid="tab-plan"><Icon name="layers" size={14} />Plan</button>
              <button className={leftTab === "scenario" ? "on" : ""} onClick={() => setState({ leftTab: "scenario" })} data-testid="tab-scenario"><Icon name="users" size={14} />Scenario</button>
            </div>
            {leftTab === "plan" ? <PlanPanel onImport={() => fileRef.current?.click()} /> : <ScenarioPanel />}
          </>}
        </aside>
        {center}
        <aside className="side right">
          {rightOpen && <>
            <div className="tabs">
              <button className={rightTab === "results" ? "on" : ""} onClick={() => setState({ rightTab: "results" })} data-testid="tab-results"><Icon name="chart" size={14} />Results</button>
              <button className={rightTab === "props" ? "on" : ""} onClick={() => setState({ rightTab: "props" })} data-testid="tab-props"><Icon name="style" size={14} />Properties</button>
            </div>
            {rightTab === "results" ? <ResultsPanel /> : <PropsPanel />}
          </>}
        </aside>
      </div>
      {hidden}{dialogs}
    </div>
  );
}

// ------------------------------------------------------------------ mobile bottom sheet
const SHEET_H = { peek: 54, half: 0.5, full: 0.86 };
function MobileSheet({ onImport }: { onImport: () => void }) {
  const tab = useStore((s) => s.sheetTab);
  const size = useStore((s) => s.sheetSize);
  const [vh, setVh] = useState(window.innerHeight);
  useEffect(() => { const r = () => setVh(window.innerHeight); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  const h = size === "peek" ? SHEET_H.peek : Math.round(vh * SHEET_H[size]);
  useEffect(() => { document.documentElement.style.setProperty("--sheet-h", `${size === "peek" ? h : Math.min(h, Math.round(vh * 0.5))}px`); }, [h, size, vh]);
  const drag = useRef<{ y: number; h: number } | null>(null);
  const [liveH, setLiveH] = useState<number | null>(null);
  const tabs: [State["sheetTab"], string, string][] = [["results", "Results", "chart"], ["scenario", "Scenario", "users"], ["plan", "Plan", "layers"], ["props", "Edit", "style"]];
  return (
    <div className="sheet" style={{ height: liveH ?? h }} data-testid="sheet">
      <div className="handle"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { y: e.clientY, h }; }}
        onPointerMove={(e) => { if (drag.current) setLiveH(Math.max(50, Math.min(vh * 0.92, drag.current.h + drag.current.y - e.clientY))); }}
        onPointerUp={(e) => {
          const d = drag.current; drag.current = null;
          const nh = liveH; setLiveH(null);
          if (!d) return;
          if (nh === null || Math.abs(d.y - e.clientY) < 5) { setState({ sheetSize: size === "peek" ? "half" : size === "half" ? "full" : "peek" }); return; }
          const f = nh / vh;
          setState({ sheetSize: f < 0.2 ? "peek" : f < 0.66 ? "half" : "full" });
        }} />
      <div className="tabs">
        {tabs.map(([k, label, ic]) => (
          <button key={k} className={tab === k && size !== "peek" ? "on" : ""} onClick={() => setState(tab === k && size !== "peek" ? { sheetSize: "peek" } : { sheetTab: k, sheetSize: size === "peek" ? "half" : size })} data-testid={`sheet-${k}`}>
            <Icon name={ic} size={17} /><span>{label}</span>
          </button>
        ))}
      </div>
      {size !== "peek" && (
        <div className="body-m">
          {tab === "results" && <ResultsPanel />}
          {tab === "scenario" && <ScenarioPanel />}
          {tab === "plan" && <PlanPanel onImport={onImport} />}
          {tab === "props" && <PropsPanel />}
        </div>
      )}
    </div>
  );
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ["Space", "Play / pause"], [".", "Step 0.5 s"], ["3", "Toggle 2D / 3D"], ["V", "Select / edit"], ["H", "Pan"], ["W", "Wall"], ["O", "Obstacle"], ["D", "Door"], ["E", "Exit"], ["S", "Stair / ramp"],
    ["B", "Seating block"], ["Z", "Spawn zone"], ["A", "Attractor"], ["N", "One-way barrier"], ["K", "Calibrate scale"], ["M", "Measure"], ["G", "Grid snap"], ["F", "Fit level"],
    ["Shift", "Orthogonal while drawing"], ["Enter / dbl-click", "Finish wall"], ["Del", "Delete selection"], ["Esc", "Cancel / deselect / stop following"], ["⌘Z / ⌘⇧Z", "Undo / redo"], ["⌘S / ⌘O", "Save / open"],
  ];
  return (
    <Modal title="Datum Flow — shortcuts" onClose={onClose} width={620} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="help-grid">{keys.map(([k, d]) => <div key={k}><span>{d}</span><span className="kbd">{k}</span></div>)}</div>
      <div className="note">Datum Flow is a planning tool for comparing layouts and operating plans. It is not a substitute for a code-compliance review or a life-safety engineer's analysis. Sample models are fictional.</div>
      <div className="hint">GPL-3.0-or-later · social force model (Helbing et al.) with fast-marching floor fields · built for QED Architecture & Engineering.</div>
    </Modal>
  );
}
