// Application state: a tiny external store (useSyncExternalStore) with immutable updates, project
// undo/redo and per-browser autosave. Bulk simulation data (frames, keyframes, density grids) lives in
// live.ts and never goes through React.
import { useRef, useSyncExternalStore } from "react";
import type { Element, Project, ResultSummary } from "./model/types";
import type { Series } from "./sim/engine";
import type { HandCalc } from "./sim/handcalc";
import type { WorldInfo } from "./sim/protocol";

export type Tool = "select" | "pan" | "wall" | "obstacle" | "door" | "exit" | "stair" | "seating" | "spawn" | "attractor" | "barrier" | "calibrate" | "measure";
export type ColorBy = "speed" | "profile" | "density" | "state";
export type Overlay = "none" | "density" | "los" | "maxdensity" | "congestion" | "usage";
export type SimStatus = "idle" | "loading" | "ready" | "playing" | "paused" | "finished";

export interface Results {
  summary: ResultSummary;
  series: Series;
  crossings: number[][];
}
export interface MonteCarlo {
  running: boolean; total: number; seeds: number[];
  runs: { seed: number; tet: number | null; p90: number | null; agents: number; stepsPerSec: number }[];
}

export interface State {
  project: Project;
  level: string;
  tool: Tool;
  selection: string[];
  snap: boolean;
  gridSize: number;
  view: "2d" | "3d";
  colorBy: ColorBy;
  overlay: Overlay;
  trails: boolean;
  ghostLevels: boolean;
  leftTab: "plan" | "scenario";
  rightTab: "props" | "results" | "ai";
  sheetTab: "run" | "results" | "plan" | "scenario" | "props" | "ai";
  sheetSize: "peek" | "half" | "full";
  undo: Project[];
  redo: Project[];
  sim: { status: SimStatus; t: number; n: number; done: number; active: number; moving: number; waiting: number; queued: number; speed: number; dirty: boolean; buildMs: number; progress: number | null; error: string | null };
  info: WorldInfo | null;
  handCalc: HandCalc | null;
  series: Series | null;
  results: Results | null;
  scrub: number | null;
  follow: number | null;
  mc: MonteCarlo | null;
  recording: boolean;
  notice: string | null;
  rev: number;          // bump → base layer redraw
}

export const initialSim: State["sim"] = { status: "idle", t: 0, n: 0, done: 0, active: 0, moving: 0, waiting: 0, queued: 0, speed: 2, dirty: false, buildMs: 0, progress: null, error: null };

let state: State = {
  project: null as unknown as Project,
  level: "",
  tool: "select",
  selection: [],
  snap: true,
  gridSize: 0.5,
  view: "2d",
  colorBy: "speed",
  overlay: "none",
  trails: false,
  ghostLevels: true,
  leftTab: "plan",
  rightTab: "results",
  sheetTab: "run",
  sheetSize: "peek",
  undo: [],
  redo: [],
  sim: initialSim,
  info: null,
  handCalc: null,
  series: null,
  results: null,
  scrub: null,
  follow: null,
  mc: null,
  recording: false,
  notice: null,
  rev: 0,
};

const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
  if ("project" in p) scheduleSave();
}
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

function shallowEq(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return false;
}
export function useStore<T>(sel: (s: State) => T): T {
  const ref = useRef<{ s: State | null; v: T }>({ s: null, v: undefined as T });
  const get = () => {
    if (ref.current.s !== state) {
      const v = sel(state);
      if (!shallowEq(v, ref.current.v)) ref.current.v = v;
      ref.current.s = state;
    }
    return ref.current.v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

// ------------------------------------------------------------------ project edits (undoable)
/** Undo snapshots hold the whole model (geometry, scenarios, settings), never run results. */
const snap = (p: Project): Project => structuredClone({ ...p, results: undefined });

/** Apply a geometry/scenario edit; geometry edits are undoable and mark the loaded simulation stale. */
export function editProject(fn: (p: Project) => Project | void, opts: { undoable?: boolean; geometry?: boolean } = {}) {
  const { undoable = true, geometry = true } = opts;
  const cur = state.project;
  const draft: Project = { ...cur, levels: cur.levels.map((l) => ({ ...l })), elements: cur.elements.map((e) => ({ ...e }) as Element), scenarios: cur.scenarios.map((s) => ({ ...s })), settings: { ...cur.settings, sf: { ...cur.settings.sf } } };
  const next = fn(draft) ?? draft;
  setState((s) => ({
    project: next,
    undo: undoable ? [...s.undo.slice(-79), snap(cur)] : s.undo,
    redo: undoable ? [] : s.redo,
    sim: geometry ? { ...s.sim, dirty: true } : s.sim,
    rev: s.rev + 1,
  }));
}
export function updateElement(id: string, patch: Partial<Element>, undoable = true) {
  editProject((p) => { p.elements = p.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as Element) : e)); }, { undoable });
}
const levelFor = (p: Project, cur: string) => (p.levels.some((l) => l.id === cur) ? cur : [...p.levels].sort((a, b) => b.elevation - a.elevation)[0].id);
/** Push the current model as one undo step (for whole-project replacements such as opening a sample). */
export function pushUndo() { setState((s) => ({ undo: [...s.undo.slice(-79), snap(s.project)], redo: [] })); }
export function undo() {
  const s = state;
  const prev = s.undo[s.undo.length - 1];
  if (!prev) return;
  setState({ project: { ...structuredClone(prev), results: s.project.results }, level: levelFor(prev, s.level), undo: s.undo.slice(0, -1), redo: [...s.redo, snap(s.project)], selection: [], sim: { ...s.sim, dirty: true }, rev: s.rev + 1 });
}
export function redo() {
  const s = state;
  const nxt = s.redo[s.redo.length - 1];
  if (!nxt) return;
  setState({ project: { ...structuredClone(nxt), results: s.project.results }, level: levelFor(nxt, s.level), redo: s.redo.slice(0, -1), undo: [...s.undo, snap(s.project)], selection: [], sim: { ...s.sim, dirty: true }, rev: s.rev + 1 });
}

export const activeScenario = (s: State = state) => s.project.scenarios.find((x) => x.id === s.project.activeScenario) ?? s.project.scenarios[0];

// ------------------------------------------------------------------ autosave
const KEY = "datum-flow:autosave";
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ ...state.project, results: undefined })); } catch { /* storage may be unavailable */ }
  }, 800);
}
export function readAutosave(): Project | null {
  try { const s = localStorage.getItem(KEY); if (!s) return null; const p = JSON.parse(s); return p?.format === "datum-flow" ? p : null; } catch { return null; }
}
export function clearAutosave() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
