// Datum Flow's AI tools (Datum Bridge protocol v1 / WebMCP). Every mutating tool is one undo step and its
// activity-log entry carries an exact inverse (per-call Undo).
import { textResult, ToolError, type ToolDef, type ToolResult, type JsonSchema } from "./bridgeClient";
import { editProject, getState, redo as storeRedo, setState, undo as storeUndo, activeScenario } from "../store";
import * as simctl from "../simctl";
import { live } from "../live";
import { loadSample, openProject } from "../projectOps";
import { SAMPLES, type SampleId } from "../model/samples";
import { ATTRACTOR_LABEL, LOS_LETTERS, losIndex, newElement, newLevel, newScenario, PROFILE_ORDER, SOURCES } from "../model/defaults";
import type { AttractorType, Dist, Element, ElementKind, P, Project, Scenario } from "../model/types";
import { dist, polyArea, seatingLayout } from "../model/geom";
import { dxfToElements, guessRole, guessScale, parseDXF, ROLES, type Role } from "../io/dxf";
import { serializeProject } from "../io/project";
import { seriesCSV } from "../io/csv";
import { download } from "../io/download";
import { canvasPNG, render2D, render3D } from "../view/snapshot";
import type { Overlay, ColorBy } from "../store";

// ------------------------------------------------------------------ schema helpers
const num = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "number", description, ...extra });
const str = (description: string, extra: Record<string, unknown> = {}): JsonSchema => ({ type: "string", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const point: JsonSchema = { type: "array", items: { type: "number" }, description: "[x, y] in metres" };
const points: JsonSchema = { type: "array", items: point, description: "list of [x, y] points in metres" };
const obj = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema => ({ type: "object", properties, required, ...(description ? { description } : {}) });
const dist_: JsonSchema = obj({ type: str("distribution", { enum: ["lognormal", "uniform", "normal", "fixed"] }), a: num("lognormal median s · uniform min · normal mean · fixed value"), b: num("lognormal σ · uniform max · normal sd") }, ["type", "a"], "time distribution (seconds)");
const profileMix: JsonSchema = obj(Object.fromEntries(PROFILE_ORDER.map((k) => [k, num(`share of ${k} (any scale; normalised)`, { minimum: 0 })])), [], "occupant profile mix, e.g. {adult: 0.9, older: 0.08, mobility: 0.02}");

// ------------------------------------------------------------------ small utilities
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const asP = (v: unknown, what: string): P => {
  if (!Array.isArray(v) || v.length < 2 || !v.slice(0, 2).every((x) => typeof x === "number" && isFinite(x))) throw new ToolError(`${what} must be [x, y] numbers`);
  return [r3(v[0] as number), r3(v[1] as number)];
};
const asPts = (v: unknown, what: string, min: number): P[] => {
  if (!Array.isArray(v) || v.length < min) throw new ToolError(`${what} must be a list of at least ${min} [x, y] points`);
  return v.map((p, i) => asP(p, `${what}[${i}]`));
};
const rectPts = (r: unknown): P[] => {
  const o = r as { x0?: number; y0?: number; x1?: number; y1?: number };
  if (!o || [o.x0, o.y0, o.x1, o.y1].some((v) => typeof v !== "number")) throw new ToolError("rect must be {x0, y0, x1, y1}");
  const x0 = Math.min(o.x0!, o.x1!), x1 = Math.max(o.x0!, o.x1!), y0 = Math.min(o.y0!, o.y1!), y1 = Math.max(o.y0!, o.y1!);
  if (x1 - x0 < 0.2 || y1 - y0 < 0.2) throw new ToolError("rect is smaller than 0.2 m");
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
};
function levelId(ref: unknown, fallback = true): string {
  const s = getState();
  if (ref === undefined || ref === null || ref === "") { if (fallback) return s.level; throw new ToolError("level is required"); }
  const L = s.project.levels.find((l) => l.id === ref || l.name.toLowerCase() === String(ref).toLowerCase());
  if (!L) throw new ToolError(`No level "${ref}". Levels: ${s.project.levels.map((l) => `${l.name} (${l.id})`).join(", ")}`);
  return L.id;
}
function findElement(ref: unknown, kinds?: ElementKind[]): Element {
  const s = getState();
  const list = s.project.elements.filter((e) => !kinds || kinds.includes(e.kind));
  const e = list.find((x) => x.id === ref) ?? list.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
  if (!e) throw new ToolError(`No ${kinds ? kinds.join("/") : "element"} "${ref}"${kinds ? `. Available: ${list.slice(0, 40).map((x) => `${x.name || x.kind} (${x.id})`).join(", ")}` : " — call list_elements"}`);
  const dup = list.filter((x) => x.name.toLowerCase() === String(ref).toLowerCase());
  if (e.id !== ref && dup.length > 1) throw new ToolError(`"${ref}" matches ${dup.length} elements — use an id: ${dup.map((x) => x.id).join(", ")}`);
  return e;
}
function findScenario(ref: unknown): Scenario {
  const s = getState();
  if (ref === undefined) return activeScenario(s);
  const sc = s.project.scenarios.find((x) => x.id === ref || x.name.toLowerCase() === String(ref).toLowerCase());
  if (!sc) throw new ToolError(`No scenario "${ref}". Scenarios: ${s.project.scenarios.map((x) => `${x.name} (${x.id})`).join(", ")}`);
  return sc;
}
const levelName = (id: string) => getState().project.levels.find((l) => l.id === id)?.name ?? id;
function describe(e: Element): Record<string, unknown> {
  const base = { id: e.id, kind: e.kind, name: e.name, level: levelName(e.level) };
  switch (e.kind) {
    case "wall": return { ...base, points: e.pts, closed: e.closed, thickness: e.thickness };
    case "obstacle": return { ...base, points: e.pts, area_m2: r3(polyArea(e.pts)) };
    case "door": return { ...base, a: e.a, b: e.b, width_m: r3(dist(e.a, e.b)), max_flow: e.maxFlow, closed: e.closed };
    case "exit": return { ...base, a: e.a, b: e.b, width_m: r3(dist(e.a, e.b)), closed: e.closed };
    case "barrier": return { ...base, a: e.a, b: e.b };
    case "stair": return { ...base, a: e.a, b: e.b, width: e.width, to_level: levelName(e.toLevel), ramp: e.ramp, speed_down: e.speedDown, speed_up: e.speedUp };
    case "seating": return { ...base, origin: e.origin, width: e.width, depth: e.depth, angle_deg: r3((e.angle * 180) / Math.PI), row_pitch: e.rowPitch, seat_width: e.seatWidth, aisles: e.aisles, aisle_width: e.aisleWidth, occupancy: e.occupancy, seats: seatingLayout(e).capacity, profile: e.profile };
    case "spawn": return { ...base, points: e.pts, mode: e.mode, count: e.count, density: e.density, area_m2: r3(polyArea(e.pts)), profile: e.profile, premove: e.premove, group_share: e.groupFrac, arrivals: e.arrivals };
    case "attractor": return { ...base, p: e.p, type: e.type, servers: e.servers, service: e.service, queue_dir_deg: r3((e.queueDir * 180) / Math.PI) };
  }
}
const asDist = (v: unknown): Dist => {
  const d = v as Dist;
  if (!d || !["lognormal", "uniform", "normal", "fixed"].includes(d.type) || typeof d.a !== "number") throw new ToolError("distribution must be {type: lognormal|uniform|normal|fixed, a, b}");
  return { type: d.type, a: d.a, b: typeof d.b === "number" ? d.b : 0 };
};

/** Map tool parameters (snake_case) onto an element of the given kind. */
function applyParams(e: Element, a: Record<string, unknown>): Element {
  const out = { ...e } as Element & Record<string, unknown>;
  if (typeof a.name === "string") out.name = a.name;
  if (a.level !== undefined) out.level = levelId(a.level);
  switch (out.kind) {
    case "wall":
      if (a.points !== undefined) out.pts = asPts(a.points, "points", 2);
      if (typeof a.thickness === "number") { if (a.thickness <= 0) throw new ToolError("thickness must be > 0"); out.thickness = a.thickness; }
      if (typeof a.closed === "boolean") out.closed = a.closed;
      break;
    case "obstacle":
      if (a.points !== undefined) out.pts = asPts(a.points, "points", 3);
      if (a.rect !== undefined) out.pts = rectPts(a.rect);
      break;
    case "door": case "exit": case "barrier":
      if (a.a !== undefined) out.a = asP(a.a, "a");
      if (a.b !== undefined) out.b = asP(a.b, "b");
      if (typeof a.width === "number" && a.a === undefined && a.b === undefined) {
        // resize about the midpoint, keeping the direction
        const L = dist(out.a, out.b) || 1, mx = (out.a[0] + out.b[0]) / 2, my = (out.a[1] + out.b[1]) / 2, ux = (out.b[0] - out.a[0]) / L, uy = (out.b[1] - out.a[1]) / L;
        out.a = [r3(mx - (ux * a.width) / 2), r3(my - (uy * a.width) / 2)]; out.b = [r3(mx + (ux * a.width) / 2), r3(my + (uy * a.width) / 2)];
      } else if (typeof a.width === "number") {
        const L = dist(out.a, out.b) || 1, ux = (out.b[0] - out.a[0]) / L, uy = (out.b[1] - out.a[1]) / L;
        out.b = [r3(out.a[0] + ux * a.width), r3(out.a[1] + uy * a.width)];
      }
      if (out.kind === "door" && a.max_flow !== undefined) out.maxFlow = a.max_flow === null ? null : Number(a.max_flow);
      if ((out.kind === "door" || out.kind === "exit") && typeof a.closed === "boolean") out.closed = a.closed;
      if (dist(out.a, out.b) < 0.3) throw new ToolError("opening is narrower than 0.3 m");
      break;
    case "stair":
      if (a.a !== undefined) out.a = asP(a.a, "a");
      if (a.b !== undefined) out.b = asP(a.b, "b");
      if (typeof a.width === "number") out.width = a.width;
      if (a.to_level !== undefined) out.toLevel = levelId(a.to_level);
      if (typeof a.ramp === "boolean") { out.ramp = a.ramp; if (a.speed_down === undefined && a.ramp) { out.speedDown = 0.9; out.speedUp = 0.8; } }
      if (typeof a.speed_down === "number") out.speedDown = a.speed_down;
      if (typeof a.speed_up === "number") out.speedUp = a.speed_up;
      if (dist(out.a, out.b) < 1) throw new ToolError("stair run must be at least 1 m long");
      break;
    case "seating":
      if (a.origin !== undefined) out.origin = asP(a.origin, "origin");
      for (const [k, f] of [["width", "width"], ["depth", "depth"], ["row_pitch", "rowPitch"], ["seat_width", "seatWidth"], ["aisle_width", "aisleWidth"], ["occupancy", "occupancy"]] as const) if (typeof a[k] === "number") (out as Record<string, unknown>)[f] = a[k];
      if (typeof a.angle_deg === "number") out.angle = (a.angle_deg * Math.PI) / 180;
      if (typeof a.aisles === "string") out.aisles = a.aisles as typeof out.aisles;
      if (a.profile !== undefined) out.profile = a.profile as never;
      if (out.width < 1 || out.depth < 0.8) throw new ToolError("seating block must be at least 1 m wide and 0.8 m deep");
      break;
    case "spawn":
      if (a.points !== undefined) out.pts = asPts(a.points, "points", 3);
      if (a.rect !== undefined) out.pts = rectPts(a.rect);
      if (typeof a.count === "number") { out.mode = "count"; out.count = Math.round(a.count); }
      if (typeof a.density === "number") { out.mode = "density"; out.density = a.density; }
      if (a.profile !== undefined) out.profile = a.profile as never;
      if (a.premove !== undefined) out.premove = asDist(a.premove);
      if (typeof a.group_share === "number") out.groupFrac = a.group_share;
      if (typeof a.arrivals === "boolean") out.arrivals = a.arrivals;
      break;
    case "attractor":
      if (a.p !== undefined) out.p = asP(a.p, "p");
      if (typeof a.type === "string") out.type = a.type as AttractorType;
      if (typeof a.servers === "number") out.servers = Math.max(1, Math.round(a.servers));
      if (a.service !== undefined) out.service = asDist(a.service);
      if (typeof a.queue_dir_deg === "number") out.queueDir = (a.queue_dir_deg * Math.PI) / 180;
      break;
  }
  return out;
}

// ------------------------------------------------------------------ undo helpers (exact inverses, applied as new undo steps)
function replaceElements(fn: (els: Element[]) => Element[]) { editProject((p) => { p.elements = fn(p.elements); }); }
const restoreScenarios = (before: Pick<Project, "scenarios" | "activeScenario">) => () => editProject((p) => { p.scenarios = structuredClone(before.scenarios); p.activeScenario = before.activeScenario; });

function waitFor(cond: () => boolean, timeoutMs: number, tick?: () => void): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const h = setInterval(() => {
      tick?.();
      if (cond()) { clearInterval(h); res(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(h); rej(new ToolError("timed out")); }
    }, 150);
  });
}

function losSummary(): Record<string, unknown> {
  const s = getState();
  const std = s.project.settings.losStandard;
  const out: Record<string, unknown> = {};
  live.maxDensity.forEach((M, li) => {
    const D = live.info?.levels[li]?.dens;
    if (!D || !M) return;
    const area = [0, 0, 0, 0, 0, 0];
    let worst = -1;
    for (const v of M) if (v > 0) { const k = losIndex(v, std); area[k] += D.cs * D.cs; worst = Math.max(worst, k); }
    out[s.project.levels[li]?.name ?? String(li)] = { worst: worst >= 0 ? LOS_LETTERS[worst] : null, area_m2_by_los: Object.fromEntries(LOS_LETTERS.map((L, i) => [L, r3(area[i])])) };
  });
  return { standard: std, note: "maximum density per 0.5 m cell during the run; seating blocks excluded", levels: out };
}

function resultsPayload(): Record<string, unknown> {
  const s = getState();
  const sc = activeScenario(s);
  const info = s.info;
  const sum = s.results?.summary;
  const series = s.series;
  const exitUsage: Record<string, number> = {};
  info?.openings.forEach((o, k) => { if (o.isExit) exitUsage[o.name] = series?.exitCum[k]?.[series.exitCum[k].length - 1] ?? 0; });
  const peak = series?.maxDensity.length ? Math.max(...series.maxDensity) : 0;
  const mc = s.project.results?.find((r) => r.scenarioId === sc.id)?.monteCarlo;
  return {
    scenario: { id: sc.id, name: sc.name, kind: sc.kind, seed: sum?.seed ?? sc.seed },
    status: s.sim.status, sim_time_s: r3(s.sim.t), people: info?.n ?? 0, completed: s.sim.done,
    tet_s: sum?.tet ?? null,
    rset: sum ? { p50_s: sum.p50, p90_s: sum.p90, premove_mean_s: sum.premoveMean, premove_p90_s: sum.premoveP90, travel_mean_s: sum.travelMean, definition: "RSET = pre-movement + travel; TET = last person out" } : null,
    exit_usage: exitUsage,
    peak_density_ppm2: sum?.maxDensity ?? peak,
    congested_mean_s: sum?.congestedAgentS ?? null,
    door_peak_flow_p_per_m_s: sum ? Object.fromEntries(Object.entries(sum.doorPeak).map(([id, v]) => [info?.openings.find((o) => o.id === id)?.name ?? id, v])) : null,
    queue_peak: sum ? Object.fromEntries(Object.entries(sum.queuePeak).map(([id, v]) => [info?.attractors.find((a) => a.id === id)?.name ?? id, v])) : null,
    los: losSummary(),
    monte_carlo: mc ?? null,
    warnings: info?.warnings ?? [],
  };
}
function handCalcPayload(): Record<string, unknown> | null {
  const hc = getState().handCalc;
  if (!hc) return null;
  return {
    population: hc.population, sfpe_hydraulic_rset_s: Math.round(hc.tHydraulic), premove_p99_s: Math.round(hc.tPre), speed_mps: r3(hc.speed), controlling: hc.controlling,
    exits: hc.exits.map((x) => ({ name: x.name, people: x.people, width_m: r3(x.width), effective_width_m: r3(x.effWidth), flow_time_s: Math.round(x.tFlow), exit_time_s: Math.round(x.t) })),
    stairs: hc.stairs.map((x) => ({ name: x.name, people: x.people, effective_width_m: r3(x.effWidth), flow_time_s: Math.round(x.tFlow) })),
    obc_3_4_3_2: { required_exit_width_mm: Math.round(hc.obcRequiredMm), provided_counted_mm: Math.round(hc.obcProvidedCountedMm), exits_ok: hc.obcOk, stair_required_mm: Math.round(hc.obcStairRequiredMm), stair_provided_mm: Math.round(hc.obcStairProvidedMm), stairs_ok: hc.obcStairOk },
    notes: hc.notes, sources: [SOURCES.sfpe, SOURCES.obc], label: "Cross-check only — not a code-compliance or life-safety engineering analysis",
  };
}
const json = (v: unknown) => JSON.stringify(v, null, 1);

async function ensureLoaded(seed?: number) {
  const s = getState();
  if (s.sim.status === "idle" || s.sim.dirty || !s.info || (seed !== undefined && s.info.seed !== seed)) await simctl.loadScenario(seed);
}

// ------------------------------------------------------------------ the tools
const KIND_ENUM = ["wall", "door", "exit", "stair", "obstacle", "seating", "spawn", "attractor", "barrier"];
const elementParams: Record<string, JsonSchema> = {
  name: str("label"), level: str("level name or id (default: current level)"),
  points: points, rect: obj({ x0: num("min x"), y0: num("min y"), x1: num("max x"), y1: num("max y") }, ["x0", "y0", "x1", "y1"], "axis-aligned rectangle (obstacle, spawn)"),
  thickness: num("wall thickness m (default 0.2)"), closed: bool("wall: closed loop · door/exit: closed in all scenarios"),
  a: point, b: point, width: num("door/exit clear width m (resizes about the midpoint when a/b not given) · stair width · seating block width"),
  max_flow: { type: ["number", "null"], description: "door max flow persons/s (null = unlimited)" },
  to_level: str("stair: level reached at end b"), ramp: bool("stair is a ramp"), speed_down: num("stair speed factor descending (default 0.52)"), speed_up: num("stair speed factor ascending (default 0.45)"),
  origin: point, depth: num("seating block depth m"), angle_deg: num("seating rotation; rows parallel to local x, front row at local y=0"), row_pitch: num("row pitch m (default 0.85)"),
  seat_width: num("seat width m (default 0.5)"), aisles: str("seating aisles", { enum: ["both", "left", "right", "center", "none", "open"] }), aisle_width: num("aisle width m"),
  occupancy: num("seating occupancy 0–1", { minimum: 0, maximum: 1 }), profile: profileMix,
  count: num("spawn: number of people", { minimum: 0 }), density: num("spawn: persons per m²", { minimum: 0 }), premove: dist_, group_share: num("share of people in groups 0–1", { minimum: 0, maximum: 1 }),
  arrivals: bool("spawn zone is an ingress arrival source"), p: point, type: str("attractor type", { enum: Object.keys(ATTRACTOR_LABEL) }), servers: num("attractor servers", { minimum: 1 }),
  service: dist_, queue_dir_deg: num("direction the queue grows from the service point, degrees"),
};

export function flowTools(): ToolDef[] {
  return [
    {
      name: "get_state",
      description: "Summary of the open Datum Flow model as JSON: title, levels, element counts per kind, scenarios (active one marked), selection, run status, current view and overlay.",
      inputSchema: obj({}),
      handler: () => {
        const s = getState();
        const counts: Record<string, Record<string, number>> = {};
        for (const e of s.project.elements) { const L = levelName(e.level); (counts[L] ??= {})[e.kind] = (counts[L][e.kind] ?? 0) + 1; }
        const seats = s.project.elements.reduce((a, e) => a + (e.kind === "seating" ? seatingLayout(e).capacity : 0), 0);
        const st = {
          title: s.project.title, sample: s.project.sample ?? null,
          levels: s.project.levels.map((l) => ({ id: l.id, name: l.name, elevation_m: l.elevation })), current_level: levelName(s.level),
          elements_by_level: counts, seats,
          scenarios: s.project.scenarios.map((x) => ({ id: x.id, name: x.name, kind: x.kind, seed: x.seed, active: x.id === s.project.activeScenario, closed: x.closedExits.map((id) => s.project.elements.find((e) => e.id === id)?.name ?? id) })),
          selection: s.selection, run: { status: s.sim.status, t_s: r3(s.sim.t), people: s.sim.n, done: s.sim.done, stale: s.sim.dirty },
          view: s.view, overlay: s.overlay, color_by: s.colorBy, undo_steps: s.undo.length, redo_steps: s.redo.length,
          samples: SAMPLES.map((x) => x.id),
        };
        return textResult(json(st), st);
      },
    },
    {
      name: "screenshot",
      description: "PNG of the model. view 2d (default) renders the plan of a level at the requested size with an optional overlay (los = live Fruin LOS, maxdensity = max density as LOS, density, congestion, usage) and trails; view 3d captures the 3D view. Agents are drawn as of the current run time.",
      inputSchema: obj({ view: str("2d or 3d", { enum: ["2d", "3d"] }), overlay: str("2D overlay", { enum: ["none", "los", "maxdensity", "density", "congestion", "usage"] }), trails: bool("draw recent paths"), color_by: str("agent colouring", { enum: ["speed", "profile", "density", "state"] }), level: str("level name or id"), width: num("px (default 1280)", { minimum: 200, maximum: 4096 }), height: num("px (default 800)", { minimum: 150, maximum: 4096 }) }),
      handler: async (a) => {
        const w = Math.round(Number(a.width ?? 1280)), h = Math.round(Number(a.height ?? 800));
        const s = getState();
        let c: HTMLCanvasElement;
        if (a.view === "3d") c = await render3D(w, h);
        else c = render2D({ width: w, height: h, level: levelId(a.level), overlay: (a.overlay as Overlay) ?? s.overlay, trails: !!a.trails, colorBy: (a.color_by as ColorBy) ?? s.colorBy });
        return { content: [{ type: "image", data: canvasPNG(c), mimeType: "image/png" }, { type: "text", text: `${a.view === "3d" ? "3D view" : `2D plan of ${levelName(levelId(a.level))}${a.overlay && a.overlay !== "none" ? ` with ${a.overlay} overlay` : ""}`}, ${w}×${h}, t = ${s.sim.t.toFixed(1)} s` }] };
      },
    },
    {
      name: "open_sample",
      description: `Load a built-in fictional sample: ${SAMPLES.map((x) => `${x.id} (${x.blurb})`).join("; ")}. One undo step.`,
      inputSchema: obj({ name: str("sample id", { enum: SAMPLES.map((x) => x.id) }) }, ["name"]),
      mutating: true,
      handler: (a) => {
        const before = structuredClone({ ...getState().project, results: undefined });
        const prevLevel = getState().level;
        loadSample(a.name as SampleId, { keepUndo: true });
        const p = getState().project;
        return {
          ...textResult(`Opened ${p.title}: ${p.levels.length} level(s), ${p.elements.length} elements, scenarios: ${p.scenarios.map((x) => x.name).join(", ")}`, { title: p.title, scenarios: p.scenarios.map((x) => ({ id: x.id, name: x.name, kind: x.kind })) }),
          undo: () => { openProject(before, { keepUndo: true }); setState({ level: before.levels.some((l) => l.id === prevLevel) ? prevLevel : before.levels[0].id }); },
        };
      },
    },
    {
      name: "export_file",
      description: "Produce an export and offer it as a download: pdf (report with plans, LOS maps, charts, hand-calc cross-check; needs a run), csv (time series of the last run), dflow (.dflow.json model). Text formats are returned as text, pdf as base64 in structured.base64. WebM video is out of scope for this tool — use the Record button in the app.",
      inputSchema: obj({ format: str("export format", { enum: ["pdf", "csv", "dflow", "webm"] }) }, ["format"]),
      handler: async (a) => {
        const s = getState();
        const safe = (t: string) => t.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "model";
        if (a.format === "webm") throw new ToolError("WebM video is out of scope for export_file: start and stop a recording with the Record button in the app's run bar.");
        if (a.format === "dflow") {
          const name = `${safe(s.project.title)}.dflow.json`, text = serializeProject(s.project);
          download(name, text, "application/json");
          return { content: [{ type: "text", text: `Saved ${name} (${(text.length / 1024).toFixed(0)} kB)` }, { type: "text", text }], structured: { filename: name, mimeType: "application/json", bytes: text.length } };
        }
        if (!s.info || !s.series) throw new ToolError("No run yet — call run_simulation first");
        if (a.format === "csv") {
          const name = `${safe(s.project.title)}_${safe(activeScenario(s).name)}_timeseries.csv`, text = seriesCSV(s.series, s.info);
          download(name, text, "text/csv");
          return { content: [{ type: "text", text: `Saved ${name} (${text.split("\n").length - 2} rows)` }, { type: "text", text }], structured: { filename: name, mimeType: "text/csv", bytes: text.length } };
        }
        const { buildReport } = await import("../io/report");
        const { pdf, name } = await buildReport();
        const blob = pdf.output("blob") as Blob;
        download(name, blob, "application/pdf");
        const b64 = pdf.output("datauristring").split(",")[1];
        return { content: [{ type: "text", text: `Saved ${name} (${(blob.size / 1024).toFixed(0)} kB PDF report). Base64 in structured.base64.` }], structured: { filename: name, mimeType: "application/pdf", bytes: blob.size, base64: b64 } };
      },
    },
    { name: "undo", description: "Undo one step of the model (geometry, scenarios, settings).", inputSchema: obj({}), handler: () => { const n = getState().undo.length; if (!n) throw new ToolError("Nothing to undo"); storeUndo(); return textResult(`Undone (${n - 1} more undo step(s))`); } },
    { name: "redo", description: "Redo one undone step.", inputSchema: obj({}), handler: () => { const n = getState().redo.length; if (!n) throw new ToolError("Nothing to redo"); storeRedo(); return textResult(`Redone (${n - 1} more redo step(s))`); } },
    {
      name: "list_elements",
      description: "List plan elements (walls, doors, exits, stairs, obstacles, seating blocks, spawn zones, attractors, barriers) with ids, names and key geometry/parameters. Filter by kind and/or level.",
      inputSchema: obj({ kind: str("element kind", { enum: KIND_ENUM }), level: str("level name or id") }),
      handler: (a) => {
        const s = getState();
        const L = a.level !== undefined ? levelId(a.level) : null;
        const list = s.project.elements.filter((e) => (!a.kind || e.kind === a.kind) && (!L || e.level === L)).map(describe);
        return textResult(json(list.length > 120 ? { count: list.length, first_120: list.slice(0, 120) } : list), { count: list.length, elements: list });
      },
    },
    {
      name: "add_element",
      description: "Add one plan element. kind wall: points[, thickness, closed] · door: a, b (or a + width, running along +x)[, max_flow] · exit: a, b · stair: a (top, opens on this level), b (arrival end), width, to_level[, ramp, speed_down, speed_up] · obstacle: points or rect · seating: origin, width, depth[, angle_deg, row_pitch, seat_width, aisles, aisle_width, occupancy, profile] · spawn: points or rect, count or density[, profile, premove, group_share, arrivals] · attractor: p, type[, servers, service, queue_dir_deg] · barrier: a, b (crossing allowed left→right of a→b). Doors/exits drawn along a wall cut it. Coordinates in metres. One undo step.",
      inputSchema: obj({ kind: str("element kind", { enum: KIND_ENUM }), ...elementParams }, ["kind"]),
      mutating: true,
      handler: (a) => {
        const kind = a.kind as ElementKind;
        const L = levelId(a.level);
        let e = newElement(kind, L, { name: typeof a.name === "string" ? a.name : "" } as Partial<Element>);
        if (kind === "door" || kind === "exit") { if (a.a === undefined) throw new ToolError(`${kind} needs a (and b or width)`); if (a.b === undefined && typeof a.width !== "number") throw new ToolError(`${kind} needs b or width`); }
        if (kind === "door" && a.a !== undefined && a.b === undefined) { e = { ...e, a: asP(a.a, "a"), b: [asP(a.a, "a")[0] + 1, asP(a.a, "a")[1]] } as Element; }
        if (kind === "exit" && a.a !== undefined && a.b === undefined) { e = { ...e, a: asP(a.a, "a"), b: [asP(a.a, "a")[0] + 1, asP(a.a, "a")[1]] } as Element; }
        if ((kind === "wall") && a.points === undefined) throw new ToolError("wall needs points");
        if ((kind === "obstacle" || kind === "spawn") && a.points === undefined && a.rect === undefined) throw new ToolError(`${kind} needs points or rect`);
        if ((kind === "stair" || kind === "barrier") && (a.a === undefined || a.b === undefined)) throw new ToolError(`${kind} needs a and b`);
        if (kind === "seating" && (a.origin === undefined || typeof a.width !== "number" || typeof a.depth !== "number")) throw new ToolError("seating needs origin, width and depth");
        if (kind === "attractor" && a.p === undefined) throw new ToolError("attractor needs p");
        if (kind === "stair" && a.to_level === undefined) {
          const lv = [...getState().project.levels].sort((x, y) => x.elevation - y.elevation), me = lv.findIndex((l) => l.id === L);
          (e as Element & { toLevel: string }).toLevel = (lv[me - 1] ?? lv[me + 1] ?? lv[me]).id;
        }
        const { kind: _k, ...rest } = a;
        void _k;
        e = applyParams(e, { ...rest, level: undefined });
        if (!e.name) e = { ...e, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${getState().project.elements.filter((x) => x.kind === kind).length + 1}` } as Element;
        replaceElements((els) => [...els, e]);
        setState({ selection: [e.id] });
        const d = describe(e);
        return { ...textResult(`Added ${kind} "${e.name}" (${e.id}) on ${levelName(L)}`, d), undo: () => replaceElements((els) => els.filter((x) => x.id !== e.id)) };
      },
    },
    {
      name: "update_element",
      description: "Change an element (by id or unique name) using the same parameters as add_element (only those given change). One undo step.",
      inputSchema: obj({ id: str("element id or unique name"), ...elementParams }, ["id"]),
      mutating: true,
      handler: (a) => {
        const old = findElement(a.id);
        const { id: _id, ...rest } = a;
        void _id;
        const next = applyParams(old, rest);
        replaceElements((els) => els.map((x) => (x.id === old.id ? next : x)));
        return { ...textResult(`Updated ${old.kind} "${next.name}" (${old.id})`, describe(next)), undo: () => replaceElements((els) => els.map((x) => (x.id === old.id ? old : x))) };
      },
    },
    {
      name: "delete_element",
      description: "Delete an element by id or unique name. One undo step.",
      inputSchema: obj({ id: str("element id or unique name") }, ["id"]),
      mutating: true,
      handler: (a) => {
        const e = findElement(a.id);
        const idx = getState().project.elements.findIndex((x) => x.id === e.id);
        replaceElements((els) => els.filter((x) => x.id !== e.id));
        setState({ selection: [] });
        return { ...textResult(`Deleted ${e.kind} "${e.name}" (${e.id})`), undo: () => replaceElements((els) => { const c = els.filter((x) => x.id !== e.id); c.splice(Math.min(idx, c.length), 0, e); return c; }) };
      },
    },
    {
      name: "import_dxf",
      description: `Import an ASCII DXF given as text. mapping assigns roles to layers (${ROLES.join(", ")}); layers not listed are guessed from their names (A-WALL → walls, …). scale = metres per drawing unit (default from $INSUNITS). level: existing level name/id or "new". recentre (default true) moves the drawing's lower-left corner to 0,0. One undo step.`,
      inputSchema: obj({ content: str("DXF file text"), mapping: { type: "object", description: "layer → role", additionalProperties: { type: "string", enum: ROLES } }, scale: num("metres per drawing unit", { minimum: 0 }), level: str("target level name/id or 'new'"), level_name: str("name for a new level"), recentre: bool("move the drawing origin to its lower-left corner") }, ["content"]),
      mutating: true,
      handler: (a) => {
        const doc = parseDXF(String(a.content));
        if (!doc.entities.length) throw new ToolError("No supported entities found (LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, INSERT)");
        const mapping: Record<string, Role> = {};
        const given = (a.mapping ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(given)) if (!ROLES.includes(v as Role)) throw new ToolError(`Role "${v}" for layer ${k} must be one of ${ROLES.join(", ")}`);
        for (const k of Object.keys(given)) if (!doc.layers[k]) throw new ToolError(`Layer "${k}" is not in the DXF. Layers: ${Object.keys(doc.layers).join(", ")}`);
        for (const l of Object.keys(doc.layers)) mapping[l] = (given[l] as Role) ?? guessRole(l);
        const scale = typeof a.scale === "number" && a.scale > 0 ? a.scale : guessScale(doc);
        let level: string, newLevelId: string | null = null;
        const before = structuredClone(getState().project.levels);
        if (a.level === "new") {
          const top = Math.max(...getState().project.levels.map((l) => l.elevation));
          const L = newLevel(typeof a.level_name === "string" ? a.level_name : "Imported", top + 4);
          editProject((p) => { p.levels = [...p.levels, L]; });
          level = newLevelId = L.id;
        } else level = levelId(a.level);
        const { elements, warnings } = dxfToElements(doc, mapping, { scale, level, origin: a.recentre === false ? undefined : [doc.bbox.x0, doc.bbox.y0] });
        if (!elements.length) throw new ToolError(`Nothing mapped. Layers: ${Object.entries(mapping).map(([l, r]) => `${l}→${r}`).join(", ")}`);
        if (newLevelId) editProject((p) => { p.elements = [...p.elements, ...elements]; }, { undoable: false });
        else replaceElements((els) => [...els, ...elements]);
        setState({ level });
        window.dispatchEvent(new Event("flow:fit"));
        const counts: Record<string, number> = {};
        for (const e of elements) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
        const ids = new Set(elements.map((e) => e.id));
        return {
          ...textResult(`Imported ${elements.length} elements onto ${levelName(level)} at ${scale} m/unit: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}${warnings.length ? `. ${warnings.join(" ")}` : ""}`, { counts, scale, level: levelName(level), mapping, skipped: doc.skipped, warnings }),
          undo: () => editProject((p) => { p.elements = p.elements.filter((x) => !ids.has(x.id)); if (newLevelId) p.levels = structuredClone(before); }),
        };
      },
    },
    {
      name: "set_scenario",
      description: "Select, create or edit a scenario in one step. scenario: id/name of an existing one (default active); create: a kind to add a new scenario (evacuation | egress | ingress | circulation). Parameters: name, kind, seed, duration (s), exit_choice (nearest | least-time), seat_premove (distribution), arrival_window (s, ingress), use_gates, visit ({concession: p, washroom: p, …}, circulation), agent_scale, closed_exits (names/ids of exits or doors closed in this scenario). The edited scenario becomes active. One undo step.",
      inputSchema: obj({
        scenario: str("existing scenario id or name"), create: str("create a new scenario of this kind", { enum: ["evacuation", "egress", "ingress", "circulation"] }), name: str("scenario name"),
        kind: str("scenario type", { enum: ["evacuation", "egress", "ingress", "circulation"] }), seed: num("random seed", { minimum: 0 }), duration: num("max duration s", { minimum: 10 }),
        exit_choice: str("exit choice", { enum: ["nearest", "least-time"] }), seat_premove: dist_, arrival_window: num("ingress arrival window s", { minimum: 0 }), use_gates: bool("ingress through gate attractors"),
        visit: { type: "object", description: "circulation visit probabilities per attractor type", additionalProperties: { type: "number" } }, agent_scale: num("population multiplier", { minimum: 0 }),
        closed_exits: { type: "array", items: { type: "string" }, description: "exit/door names or ids closed in this scenario (replaces the list)" },
      }),
      mutating: true,
      handler: (a) => {
        const s0 = getState().project;
        const before = { scenarios: structuredClone(s0.scenarios), activeScenario: s0.activeScenario };
        let target: Scenario = a.create ? newScenario(a.create as Scenario["kind"], typeof a.name === "string" ? a.name : undefined) : findScenario(a.scenario);
        target = { ...target };
        if (typeof a.name === "string") target.name = a.name;
        if (typeof a.kind === "string") target.kind = a.kind as Scenario["kind"];
        if (typeof a.seed === "number") target.seed = Math.round(a.seed);
        if (typeof a.duration === "number") target.duration = a.duration;
        if (typeof a.exit_choice === "string") target.exitChoice = a.exit_choice as Scenario["exitChoice"];
        if (a.seat_premove !== undefined) target.seatPremove = asDist(a.seat_premove);
        if (typeof a.arrival_window === "number") target.arrivalWindow = a.arrival_window;
        if (typeof a.use_gates === "boolean") target.useGates = a.use_gates;
        if (a.visit !== undefined) target.visit = a.visit as Scenario["visit"];
        if (typeof a.agent_scale === "number") target.agentScale = a.agent_scale;
        if (Array.isArray(a.closed_exits)) target.closedExits = (a.closed_exits as string[]).map((r) => findElement(r, ["exit", "door"]).id);
        editProject((p) => { p.scenarios = p.scenarios.some((x) => x.id === target.id) ? p.scenarios.map((x) => (x.id === target.id ? target : x)) : [...p.scenarios, target]; p.activeScenario = target.id; });
        const closed = target.closedExits.map((id) => getState().project.elements.find((e) => e.id === id)?.name ?? id);
        return { ...textResult(`Scenario "${target.name}" (${target.kind}) is active: seed ${target.seed}, duration ${target.duration} s, ${target.exitChoice} exit choice${closed.length ? `, closed: ${closed.join(", ")}` : ""}`, { ...target, closed_names: closed }), undo: restoreScenarios(before) };
      },
    },
    ...(["close_exit", "open_exit"] as const).map((nm): ToolDef => ({
      name: nm,
      description: `${nm === "close_exit" ? "Close (block)" : "Re-open"} an exit or door in a scenario (default: the active one). One undo step.`,
      inputSchema: obj({ exit: str("exit or door name or id"), scenario: str("scenario id or name") }, ["exit"]),
      mutating: true,
      handler: (a) => {
        const e = findElement(a.exit, ["exit", "door"]);
        const sc = findScenario(a.scenario);
        const s0 = getState().project;
        const before = { scenarios: structuredClone(s0.scenarios), activeScenario: s0.activeScenario };
        const closed = nm === "close_exit" ? [...new Set([...sc.closedExits, e.id])] : sc.closedExits.filter((x) => x !== e.id);
        editProject((p) => { p.scenarios = p.scenarios.map((x) => (x.id === sc.id ? { ...x, closedExits: closed } : x)); });
        const open = s0.elements.filter((x) => x.kind === "exit" && !closed.includes(x.id) && !(x.kind === "exit" && x.closed)).map((x) => x.name);
        return { ...textResult(`${e.name} is ${nm === "close_exit" ? "closed" : "open"} in "${sc.name}". Open exits: ${open.join(", ") || "none"}`, { scenario: sc.name, closed: closed.map((id) => s0.elements.find((x) => x.id === id)?.name ?? id), open_exits: open }), undo: restoreScenarios(before) };
      },
    })),
    {
      name: "run_simulation",
      description: "Run the active (or given) scenario from t = 0 with an optional seed, either until everyone is done (until: 'done', default; capped by the scenario duration) or for a number of simulated seconds. Streams progress. Returns TET, RSET (P50/P90, pre-movement, travel), per-exit usage, peak density and an LOS summary.",
      inputSchema: obj({ scenario: str("scenario id or name"), seed: num("random seed", { minimum: 0 }), until: { type: ["string", "number"], description: "'done' or simulated seconds" } }),
      handler: async (a, ctx) => {
        if (a.scenario !== undefined) { const sc = findScenario(a.scenario); if (sc.id !== getState().project.activeScenario) editProject((p) => { p.activeScenario = sc.id; }, { undoable: false }); }
        if (a.until !== undefined && a.until !== "done" && !(typeof a.until === "number" && a.until > 0)) throw new ToolError("until must be 'done' or a positive number of seconds");
        const sc = activeScenario(getState());
        if (getState().sim.status === "playing") simctl.pause();
        ctx.progress(0, 1, "building fields and placing people");
        await simctl.loadScenario(typeof a.seed === "number" ? Math.round(a.seed) : undefined);
        const total = typeof a.until === "number" ? Math.min(a.until, sc.duration) : sc.duration;
        const tick = () => { const s = getState().sim; ctx.progress(Math.round(s.t), Math.round(total), `t = ${s.t.toFixed(0)} s · ${s.done}/${s.n} done`); };
        if (typeof a.until === "number") {
          const steps = Math.round(total / getState().project.settings.dt);
          await simctl.stepOnce(steps);
          await waitFor(() => { const s = getState().sim; return s.status === "finished" || s.t >= total - getState().project.settings.dt * 1.5; }, 600000, tick);
        } else {
          const h = setInterval(tick, 400);
          try { await simctl.runToEnd(); } finally { clearInterval(h); }
        }
        ctx.progress(Math.round(total), Math.round(total), "done");
        const r = resultsPayload();
        const s = getState();
        const lines = [
          `${sc.name} (${sc.kind}), seed ${s.info?.seed ?? sc.seed}: ${s.sim.done}/${s.sim.n} done at t = ${s.sim.t.toFixed(1)} s${s.sim.status === "finished" ? "" : " (paused, not finished)"}`,
          r.tet_s != null ? `TET ${r.tet_s} s · P50 ${s.results?.summary.p50 ?? "—"} s · P90 ${s.results?.summary.p90 ?? "—"} s · mean pre-move ${s.results?.summary.premoveMean} s · mean travel ${s.results?.summary.travelMean} s` : "TET: not reached",
          `Exit usage: ${Object.entries(r.exit_usage as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`,
          `Peak density ${r.peak_density_ppm2} p/m²`,
        ];
        return textResult(lines.join("\n"), r);
      },
    },
    {
      name: "run_monte_carlo",
      description: "Run the active scenario with n seeds (first_seed, first_seed+1, …) in parallel workers; returns total evacuation time per seed with P50 / P90 / min / max.",
      inputSchema: obj({ n: num("number of seeds (2–100)", { minimum: 2, maximum: 100 }), first_seed: num("first seed (default 1)", { minimum: 0 }) }, ["n"]),
      handler: async (a, ctx) => {
        const n = Math.round(Number(a.n));
        const h = setInterval(() => { const m = getState().mc; if (m) ctx.progress(m.runs.length, n, `${m.runs.length}/${n} seeds`); }, 400);
        try { await simctl.runMonteCarlo(n, Math.round(Number(a.first_seed ?? 1))); } finally { clearInterval(h); }
        const s = getState();
        const sc = activeScenario(s);
        const mc = s.project.results?.find((r) => r.scenarioId === sc.id)?.monteCarlo;
        const runs = s.mc?.runs ?? [];
        return textResult(`${sc.name}: ${runs.length} seeds · TET P50 ${mc?.p50 ?? "—"} s, P90 ${mc?.p90 ?? "—"} s (min ${mc?.min ?? "—"}, max ${mc?.max ?? "—"})`, { scenario: sc.name, runs: runs.map((r) => ({ seed: r.seed, tet_s: r.tet, p90_s: r.p90, agents: r.agents })), p50_s: mc?.p50 ?? null, p90_s: mc?.p90 ?? null, mean_s: mc?.mean ?? null, min_s: mc?.min ?? null, max_s: mc?.max ?? null });
      },
    },
    {
      name: "get_results",
      description: "Results of the current/last run: status, TET, RSET breakdown, per-exit usage, peak density, congestion time, peak door flows, queue peaks, LOS summary and Monte-Carlo summary.",
      inputSchema: obj({}),
      handler: () => { if (!getState().info) throw new ToolError("No run loaded — call run_simulation first"); const r = resultsPayload(); return textResult(json(r), r); },
    },
    {
      name: "hand_calc",
      description: "SFPE hydraulic RSET and Ontario Building Code 3.4.3.2 exit-width cross-check for the active evacuation/egress scenario (built from the scenario's initial population). Cross-check only.",
      inputSchema: obj({}),
      handler: async () => {
        const sc = activeScenario(getState());
        if (sc.kind !== "evacuation" && sc.kind !== "egress") throw new ToolError(`Hand calculation applies to evacuation/egress scenarios; "${sc.name}" is ${sc.kind}`);
        await ensureLoaded();
        const hc = handCalcPayload();
        if (!hc) throw new ToolError("Hand calculation unavailable (no exits or no population)");
        const sim = getState().results?.summary;
        return textResult(`SFPE hydraulic RSET ${hc.sfpe_hydraulic_rset_s} s (controlling: ${hc.controlling}); OBC 3.4.3.2 exits: ${(hc.obc_3_4_3_2 as { required_exit_width_mm: number }).required_exit_width_mm} mm required, ${(hc.obc_3_4_3_2 as { provided_counted_mm: number }).provided_counted_mm} mm counted → ${(hc.obc_3_4_3_2 as { exits_ok: boolean }).exits_ok ? "OK" : "NOT MET"}${sim?.tet != null ? `; simulation TET ${sim.tet} s` : ""}. Cross-check only.`, { ...hc, simulation_tet_s: sim?.tet ?? null });
      },
    },
  ];
}

export type { ToolResult };
