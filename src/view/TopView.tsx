// 2D top view: Canvas 2D plan + overlays, instanced WebGL agents, Canvas 2D interaction layer.
// Handles pan / zoom (mouse, wheel, touch pinch), drawing tools, selection, vertex editing and follow-agent.
import { useCallback, useEffect, useRef, useState } from "react";
import { editProject, getState, setState, useStore, type Tool, updateElement } from "../store";
import { live, onLive } from "../live";
import type { Element, P } from "../model/types";
import { newElement } from "../model/defaults";
import { dist, elementPoints, pointInPoly, segDist, stairFootprint } from "../model/geom";
import { AgentLayer, drawAgents2D } from "./agentsGL";
import { agentBuffers } from "./agentData";
import { drawGrid, drawOverlay, drawPlan, drawTrails, fitView, overlayCanvas, toScreen, toWorld, DARK, type ViewT } from "./render2d";
import { C } from "./palette";
import { Field, Icon, Modal } from "../ui";
import { Legend } from "../panels/Legend";

// shared so the video recorder and report can read the current view
export const viewRef: { v: ViewT; base: HTMLCanvasElement | null; gl: HTMLCanvasElement | null; top: HTMLCanvasElement | null } = { v: { cx: 0, cy: 0, scale: 10, w: 800, h: 600 }, base: null, gl: null, top: null };

interface Draft { pts: P[]; cursor: P | null }
type Drag =
  | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
  | { kind: "move"; id: string; start: P; orig: Element; moved: boolean }
  | { kind: "vertex"; id: string; vi: number; orig: Element; moved: boolean }
  | { kind: "rect"; start: P; cur: P }
  | null;

const TOOLS: { t: Tool; icon: string; label: string; key: string }[] = [
  { t: "select", icon: "select", label: "Select / edit", key: "V" },
  { t: "pan", icon: "move", label: "Pan", key: "H" },
  { t: "wall", icon: "wall", label: "Wall (click points, double-click to end)", key: "W" },
  { t: "obstacle", icon: "obstacle", label: "Obstacle (drag a rectangle)", key: "O" },
  { t: "door", icon: "door", label: "Door / opening (two clicks)", key: "D" },
  { t: "exit", icon: "exit", label: "Exit (two clicks)", key: "E" },
  { t: "stair", icon: "stair", label: "Stair / ramp (two clicks, top → bottom)", key: "S" },
  { t: "seating", icon: "seating", label: "Seating block (drag)", key: "B" },
  { t: "spawn", icon: "spawn", label: "Spawn zone (drag)", key: "Z" },
  { t: "attractor", icon: "attractor", label: "Attractor / service point (click)", key: "A" },
  { t: "barrier", icon: "barrier", label: "One-way barrier (two clicks)", key: "N" },
  { t: "calibrate", icon: "calibrate", label: "Calibrate scale (two clicks + distance)", key: "K" },
  { t: "measure", icon: "ruler", label: "Measure", key: "M" },
];

function hitDistance(e: Element, p: P): number {
  switch (e.kind) {
    case "wall": { let d = Infinity; const pts = e.closed ? [...e.pts, e.pts[0]] : e.pts; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p[0], p[1], pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) - e.thickness / 2); return Math.max(0, d); }
    case "obstacle": case "spawn": { if (pointInPoly(p[0], p[1], e.pts)) return e.kind === "spawn" ? 0.4 : 0; let d = Infinity; for (let i = 0; i < e.pts.length; i++) { const a = e.pts[i], b = e.pts[(i + 1) % e.pts.length]; d = Math.min(d, segDist(p[0], p[1], a[0], a[1], b[0], b[1])); } return d; }
    case "door": case "exit": case "barrier": return segDist(p[0], p[1], e.a[0], e.a[1], e.b[0], e.b[1]);
    case "stair": return pointInPoly(p[0], p[1], stairFootprint(e)) ? 0.1 : Infinity;
    case "seating": { const pts = elementPoints(e); return pointInPoly(p[0], p[1], pts) ? 0.3 : Infinity; }
    case "attractor": return Math.max(0, dist(p, e.p) - 0.5);
  }
}
/** Editable vertices of an element. */
function handles(e: Element): P[] {
  switch (e.kind) {
    case "wall": case "obstacle": case "spawn": return e.pts;
    case "door": case "exit": case "barrier": case "stair": return [e.a, e.b];
    case "seating": return [e.origin];
    case "attractor": return [e.p];
  }
}
function setHandle(e: Element, i: number, p: P): Element {
  switch (e.kind) {
    case "wall": case "obstacle": case "spawn": return { ...e, pts: e.pts.map((q, k) => (k === i ? p : q)) } as Element;
    case "door": case "exit": case "barrier": case "stair": return { ...e, [i === 0 ? "a" : "b"]: p } as Element;
    case "seating": return { ...e, origin: p };
    case "attractor": return { ...e, p };
  }
}
function translate(e: Element, dx: number, dy: number): Element {
  const t = (q: P): P => [+(q[0] + dx).toFixed(3), +(q[1] + dy).toFixed(3)];
  switch (e.kind) {
    case "wall": case "obstacle": case "spawn": return { ...e, pts: e.pts.map(t) } as Element;
    case "door": case "exit": case "barrier": case "stair": return { ...e, a: t(e.a), b: t(e.b) } as Element;
    case "seating": return { ...e, origin: t(e.origin) };
    case "attractor": return { ...e, p: t(e.p) };
  }
}

export default function TopView({ mobile }: { mobile: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);
  const agents = useRef<AgentLayer | null>(null);
  const v = useRef<ViewT>(viewRef.v);
  const dpr = useRef(1);
  const dirty = useRef({ base: true, agents: true, top: true });
  const draft = useRef<Draft>({ pts: [], cursor: null });
  const drag = useRef<Drag>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; scale: number; mid: P } | null>(null);
  const [cursor, setCursor] = useState<P | null>(null);
  const [calib, setCalib] = useState<{ a: P; b: P } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const project = useStore((s) => s.project);
  const level = useStore((s) => s.level);
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const overlay = useStore((s) => s.overlay);
  const colorBy = useStore((s) => s.colorBy);
  const scrub = useStore((s) => s.scrub);
  const follow = useStore((s) => s.follow);
  const rev = useStore((s) => s.rev);
  const snapOn = useStore((s) => s.snap);
  const gridSize = useStore((s) => s.gridSize);
  const ghost = useStore((s) => s.ghostLevels);
  const status = useStore((s) => s.sim.status);
  const info = useStore((s) => s.info);
  const sc = useStore((s) => s.project.scenarios.find((x) => x.id === s.project.activeScenario));

  useEffect(() => { dirty.current.base = true; dirty.current.agents = true; dirty.current.top = true; }, [project, level, selection, overlay, colorBy, scrub, follow, rev, ghost, info, sc]);
  useEffect(() => { draft.current = { pts: [], cursor: null }; dirty.current.top = true; setHint(null); }, [tool, level]);
  useEffect(() => onLive(() => { dirty.current.agents = true; if (getState().overlay !== "none") dirty.current.base = true; }), []);

  // fit or restore the view when the project / level changes
  const fit = useCallback(() => {
    const el = wrap.current; if (!el) return;
    const s = getState();
    v.current = fitView(s.project, s.level, el.clientWidth, el.clientHeight, mobile ? 18 : 40);
    viewRef.v = v.current;
    dirty.current = { base: true, agents: true, top: true };
  }, [mobile]);
  const projectId = useStore((s) => s.project.title + (s.project.sample ?? ""));
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const pv = getState().project.view;
    if (pv && pv.level === getState().level && !mobile) { v.current = { cx: pv.cx, cy: pv.cy, scale: pv.scale, w: el.clientWidth, h: el.clientHeight }; viewRef.v = v.current; dirty.current = { base: true, agents: true, top: true }; }
    else fit();
  }, [projectId, fit, mobile]);
  useEffect(() => { const h = () => fit(); window.addEventListener("flow:fit", h); return () => window.removeEventListener("flow:fit", h); }, [fit]);

  // canvas sizing
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      dpr.current = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [baseRef.current, glRef.current, topRef.current]) { if (!c) continue; c.width = Math.round(w * dpr.current); c.height = Math.round(h * dpr.current); c.style.width = `${w}px`; c.style.height = `${h}px`; }
      v.current = { ...v.current, w, h };
      viewRef.v = v.current;
      dirty.current = { base: true, agents: true, top: true };
    });
    ro.observe(el);
    agents.current = new AgentLayer(glRef.current!);
    viewRef.base = baseRef.current; viewRef.gl = glRef.current; viewRef.top = topRef.current;
    return () => ro.disconnect();
  }, []);

  // render loop
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = getState();
      const li = s.project.levels.findIndex((l) => l.id === s.level);
      // follow camera
      if (s.follow !== null && live.frame) {
        const f = live.frame, i = s.follow;
        if (i < f.x.length && f.st[i] !== 5) {
          if (f.lvl[i] !== li) { const lid = s.project.levels[f.lvl[i]]?.id; if (lid) setState({ level: lid }); }
          v.current = { ...v.current, cx: f.x[i], cy: f.y[i] }; viewRef.v = v.current;
          dirty.current.base = true;
        }
      }
      const k = dpr.current;
      if (dirty.current.base && baseRef.current) {
        dirty.current.base = false;
        const g = baseRef.current.getContext("2d")!;
        g.setTransform(k, 0, 0, k, 0, 0);
        drawGrid(g, v.current, DARK, 1);
        const L = live.info?.levels[li];
        if (s.overlay !== "none" && L && live.info?.levels.length === s.project.levels.length) {
          const data = { density: live.density[li], max: live.maxDensity[li], cong: live.congestion[li], occ: live.occupancy[li] };
          const cv = overlayCanvas(s.overlay, li, L, data, s.project.settings.losStandard, `${live.densVersion}:${live.version}`);
          if (cv) drawOverlay(g, v.current, cv, L, s.overlay === "density" || s.overlay === "usage" || s.overlay === "congestion");
        }
        const scen = s.project.scenarios.find((x) => x.id === s.project.activeScenario);
        const doorsOpen = new Map<string, boolean>();
        if (live.doorsOpen && live.info) live.info.openings.forEach((o, i) => { if (!live.doorsOpen![i]) doorsOpen.set(o.id, false); });
        drawPlan(g, v.current, s.project, { level: s.level, ghost: s.ghostLevels, selection: new Set(s.selection), closed: new Set(scen?.closedExits ?? []), doorsOpen, running: !!live.frame });
        if (s.trails && live.keys.length > 1 && live.info) drawTrails(g, v.current, li, s.scrub);
      }
      if (dirty.current.agents && glRef.current) {
        dirty.current.agents = false;
        const ab = agentBuffers(s.project, li, s.colorBy, s.scrub, s.follow);
        const ok = agents.current?.draw(v.current, k, ab?.inst ?? new Float32Array(0), ab?.col ?? new Uint8Array(0), ab?.count ?? 0);
        if (!ok && topRef.current) dirty.current.top = true;
      }
      if (dirty.current.top && topRef.current) {
        dirty.current.top = false;
        const g = topRef.current.getContext("2d")!;
        g.setTransform(k, 0, 0, k, 0, 0);
        g.clearRect(0, 0, v.current.w, v.current.h);
        if (!agents.current?.gl) { const ab = agentBuffers(s.project, li, s.colorBy, s.scrub, s.follow); if (ab) drawAgents2D(g, v.current, ab.inst, ab.col, ab.count); dirty.current.top = live.frame !== null; }
        drawTop(g);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const drawTop = (g: CanvasRenderingContext2D) => {
    const s = getState();
    const V = v.current;
    // vertex handles of the selected element
    if (s.selection.length === 1 && s.tool === "select") {
      const e = s.project.elements.find((x) => x.id === s.selection[0]);
      if (e && e.level === s.level) for (const p of handles(e)) { const [x, y] = toScreen(V, p[0], p[1]); g.fillStyle = C.bg; g.strokeStyle = C.accent; g.lineWidth = 1.5; g.fillRect(x - 4, y - 4, 8, 8); g.strokeRect(x - 4, y - 4, 8, 8); }
    }
    const d = draft.current;
    const pts = d.cursor ? [...d.pts, d.cursor] : d.pts;
    g.strokeStyle = C.accent; g.fillStyle = C.accent; g.lineWidth = 2;
    if (drag.current?.kind === "rect") {
      const { start, cur } = drag.current;
      const [x0, y0] = toScreen(V, start[0], start[1]), [x1, y1] = toScreen(V, cur[0], cur[1]);
      g.setLineDash([5, 3]); g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); g.setLineDash([]);
      label(g, `${Math.abs(cur[0] - start[0]).toFixed(2)} × ${Math.abs(cur[1] - start[1]).toFixed(2)} m`, (x0 + x1) / 2, Math.min(y0, y1) - 12);
    }
    if (pts.length) {
      g.beginPath();
      pts.forEach((p, i) => { const [x, y] = toScreen(V, p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
      for (const p of pts) { const [x, y] = toScreen(V, p[0], p[1]); g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
      if (pts.length >= 2) {
        const a = pts[pts.length - 2], b = pts[pts.length - 1];
        const [x, y] = toScreen(V, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        label(g, `${dist(a, b).toFixed(2)} m`, x, y - 12);
      }
    }
    if (d.cursor && s.tool !== "select" && s.tool !== "pan") {
      const [x, y] = toScreen(V, d.cursor[0], d.cursor[1]);
      g.strokeStyle = "rgba(242,169,59,0.7)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x - 8, y); g.lineTo(x + 8, y); g.moveTo(x, y - 8); g.lineTo(x, y + 8); g.stroke();
    }
  };
  const label = (g: CanvasRenderingContext2D, t: string, x: number, y: number) => {
    g.font = `500 11px "JetBrains Mono", monospace`;
    const w = g.measureText(t).width + 10;
    g.fillStyle = "rgba(14,17,20,0.9)"; g.fillRect(x - w / 2, y - 9, w, 18);
    g.strokeStyle = "#323a43"; g.lineWidth = 1; g.strokeRect(x - w / 2 + 0.5, y - 8.5, w - 1, 17);
    g.fillStyle = C.ink; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, x, y + 0.5);
  };

  // ------------------------------------------------------------------ snapping
  const snapPoint = (p: P, opts: { toWall?: boolean } = {}): P => {
    const s = getState();
    const V = v.current;
    const tol = 9 / V.scale;
    // vertices of elements on this level
    let best: P | null = null, bd = tol;
    for (const e of s.project.elements) {
      if (e.level !== s.level) continue;
      for (const q of handles(e)) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
    }
    if (best) return [best[0], best[1]];
    if (opts.toWall) {
      // project onto the nearest wall segment
      let bw: P | null = null, bwd = 12 / V.scale;
      for (const e of s.project.elements) {
        if (e.level !== s.level || e.kind !== "wall") continue;
        const pts = e.closed ? [...e.pts, e.pts[0]] : e.pts;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const d = segDist(p[0], p[1], a[0], a[1], b[0], b[1]);
          if (d < bwd) {
            const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
            let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
            t = Math.max(0, Math.min(1, t));
            let q: P = [a[0] + dx * t, a[1] + dy * t];
            if (s.snap) { const L = Math.sqrt(L2); const tt = Math.round((t * L) / 0.05) * 0.05 / L; q = [a[0] + dx * tt, a[1] + dy * tt]; }
            bwd = d; bw = q;
          }
        }
      }
      if (bw) return [+bw[0].toFixed(3), +bw[1].toFixed(3)];
    }
    if (!s.snap) return [+p[0].toFixed(3), +p[1].toFixed(3)];
    const gs = s.gridSize;
    return [+(Math.round(p[0] / gs) * gs).toFixed(3), +(Math.round(p[1] / gs) * gs).toFixed(3)];
  };
  // orthogonal constraint with shift
  const ortho = (from: P, p: P, shift: boolean): P => {
    if (!shift) return p;
    return Math.abs(p[0] - from[0]) > Math.abs(p[1] - from[1]) ? [p[0], from[1]] : [from[0], p[1]];
  };

  const pick = (p: P): Element | null => {
    const s = getState();
    const tol = 7 / v.current.scale;
    let best: Element | null = null, bd = Infinity;
    // smaller / point-like things win over containers
    const prio: Record<Element["kind"], number> = { attractor: 0, door: 0.05, exit: 0.05, barrier: 0.05, wall: 0.1, stair: 0.2, obstacle: 0.2, seating: 0.3, spawn: 0.4 };
    for (const e of s.project.elements) {
      if (e.level !== s.level) continue;
      const d = hitDistance(e, p);
      if (d > tol && !(d < 1 && (e.kind === "stair" || e.kind === "seating" || e.kind === "spawn" || e.kind === "obstacle"))) continue;
      const score = d + prio[e.kind];
      if (score < bd) { bd = score; best = e; }
    }
    return best;
  };
  const pickAgent = (sx: number, sy: number): number | null => {
    const f = live.frame;
    if (!f) return null;
    const s = getState();
    const li = s.project.levels.findIndex((l) => l.id === s.level);
    let best: number | null = null, bd = 10;
    for (let i = 0; i < f.x.length; i++) {
      if (f.lvl[i] !== li || f.st[i] === 5 || f.st[i] === 0) continue;
      const [x, y] = toScreen(v.current, f.x[i], f.y[i]);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  // ------------------------------------------------------------------ element creation
  const addElement = (e: Element) => {
    editProject((p) => { p.elements = [...p.elements, e]; });
    setState({ selection: [e.id], rightTab: "props", sheetTab: getState().sheetTab });
  };
  const finishTwoClick = (a: P, b: P) => {
    const s = getState();
    const t = s.tool;
    if (dist(a, b) < 0.05) return;
    if (t === "door") addElement(newElement("door", s.level, { a, b, name: "Door" }));
    else if (t === "exit") addElement(newElement("exit", s.level, { a, b, name: `Exit ${s.project.elements.filter((e) => e.kind === "exit").length + 1}` }));
    else if (t === "barrier") addElement(newElement("barrier", s.level, { a, b, name: "One-way" }));
    else if (t === "stair") {
      const levels = [...s.project.levels].sort((x, y) => x.elevation - y.elevation);
      const me = levels.findIndex((l) => l.id === s.level);
      const to = levels[me - 1] ?? levels[me + 1] ?? levels[me];
      addElement(newElement("stair", s.level, { a, b, toLevel: to.id, name: "Stair" }));
    } else if (t === "measure") setHint(`Distance ${dist(a, b).toFixed(3)} m · Δx ${(b[0] - a[0]).toFixed(2)} · Δy ${(b[1] - a[1]).toFixed(2)}`);
    else if (t === "calibrate") setCalib({ a, b });
  };
  const finishRect = (a: P, b: P) => {
    const s = getState();
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    if (x1 - x0 < 0.2 || y1 - y0 < 0.2) return;
    const pts: P[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    if (s.tool === "obstacle") addElement(newElement("obstacle", s.level, { pts, name: "Obstacle" }));
    else if (s.tool === "spawn") addElement(newElement("spawn", s.level, { pts, name: `Spawn ${s.project.elements.filter((e) => e.kind === "spawn").length + 1}` }));
    else if (s.tool === "seating") addElement(newElement("seating", s.level, { origin: [x0, y0], width: +(x1 - x0).toFixed(2), depth: +(y1 - y0).toFixed(2), angle: 0, name: `Block ${s.project.elements.filter((e) => e.kind === "seating").length + 1}` }));
  };
  const finishWall = () => {
    const s = getState();
    const pts = draft.current.pts;
    if (pts.length >= 2) {
      const closed = pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-6;
      addElement(newElement("wall", s.level, { pts: closed ? pts.slice(0, -1) : pts, closed, thickness: 0.2, name: "Wall" }));
    }
    draft.current = { pts: [], cursor: null };
    dirty.current.top = true;
  };

  // ------------------------------------------------------------------ pointer handlers
  const local = (e: { clientX: number; clientY: number }) => { const r = wrap.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as [number, number]; };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    pointers.current.set(e.pointerId, { x: sx, y: sy });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: v.current.scale, mid: toWorld(v.current, (a.x + b.x) / 2, (a.y + b.y) / 2) };
      drag.current = null;
      return;
    }
    const s = getState();
    const w = toWorld(v.current, sx, sy);
    const pan = s.tool === "pan" || e.button === 1 || e.button === 2 || (e as React.PointerEvent & { altKey: boolean }).altKey;
    if (pan) { drag.current = { kind: "pan", sx, sy, cx: v.current.cx, cy: v.current.cy }; return; }
    if (s.tool === "select") {
      // vertex handles of the selected element first
      if (s.selection.length === 1) {
        const el = s.project.elements.find((x) => x.id === s.selection[0]);
        if (el && el.level === s.level) {
          const hs = handles(el);
          for (let i = 0; i < hs.length; i++) {
            const [hx, hy] = toScreen(v.current, hs[i][0], hs[i][1]);
            if (Math.hypot(hx - sx, hy - sy) < 8) { drag.current = { kind: "vertex", id: el.id, vi: i, orig: el, moved: false }; return; }
          }
        }
      }
      const hit = pick(w);
      if (hit) {
        setState({ selection: [hit.id], follow: null });
        drag.current = { kind: "move", id: hit.id, start: w, orig: hit, moved: false };
        return;
      }
      const ag = pickAgent(sx, sy);
      if (ag !== null) { setState({ follow: s.follow === ag ? null : ag, selection: [] }); return; }
      setState({ selection: [] });
      drag.current = { kind: "pan", sx, sy, cx: v.current.cx, cy: v.current.cy };
      return;
    }
    const p = snapPoint(w, { toWall: s.tool === "door" || s.tool === "exit" || s.tool === "barrier" });
    if (s.tool === "obstacle" || s.tool === "spawn" || s.tool === "seating") { drag.current = { kind: "rect", start: p, cur: p }; return; }
    if (s.tool === "attractor") { addElement(newElement("attractor", s.level, { p, name: `Service point ${s.project.elements.filter((x) => x.kind === "attractor").length + 1}` })); return; }
    if (s.tool === "wall") {
      const d = draft.current;
      const q = d.pts.length ? ortho(d.pts[d.pts.length - 1], p, e.shiftKey) : p;
      if (d.pts.length && dist(q, d.pts[d.pts.length - 1]) < 1e-6) { finishWall(); return; }
      if (d.pts.length > 2 && dist(q, d.pts[0]) < 1e-6) { d.pts.push(q); finishWall(); return; }
      d.pts.push(q);
      setHint("Click to add points · double-click / Enter to finish · click the first point to close · Shift = orthogonal · Esc cancels");
      dirty.current.top = true;
      return;
    }
    // two-click tools
    const d = draft.current;
    if (!d.pts.length) { d.pts = [p]; setHint(s.tool === "stair" ? "Click the bottom end of the run (b) — people reach the other level there" : "Click the second point"); }
    else { const a = d.pts[0]; draft.current = { pts: [], cursor: null }; finishTwoClick(a, ortho(a, p, e.shiftKey)); if (s.tool !== "measure") setHint(null); }
    dirty.current.top = true;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const [sx, sy] = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: sx, y: sy });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = Math.max(0.3, Math.min(400, pinch.current.scale * (d / pinch.current.d)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const m = pinch.current.mid;
      v.current = { ...v.current, scale, cx: m[0] - (mx - v.current.w / 2) / scale, cy: m[1] + (my - v.current.h / 2) / scale };
      viewRef.v = v.current;
      dirty.current = { base: true, agents: true, top: true };
      return;
    }
    const w = toWorld(v.current, sx, sy);
    setCursor(w);
    const s = getState();
    const dg = drag.current;
    if (dg?.kind === "pan") {
      v.current = { ...v.current, cx: dg.cx - (sx - dg.sx) / v.current.scale, cy: dg.cy + (sy - dg.sy) / v.current.scale };
      viewRef.v = v.current;
      if (s.follow !== null) setState({ follow: null });
      dirty.current = { base: true, agents: true, top: true };
      return;
    }
    if (dg?.kind === "move") {
      const p = s.snap ? snapPoint(w) : w;
      const st = s.snap ? snapPoint(dg.start) : dg.start;
      const dx = p[0] - st[0], dy = p[1] - st[1];
      if (!dg.moved && Math.hypot(dx, dy) * v.current.scale < 4) return;
      const next = translate(dg.orig, dx, dy);
      if (!dg.moved) { editProject((pp) => { pp.elements = pp.elements.map((x) => (x.id === dg.id ? next : x)); }); dg.moved = true; }
      else updateElement(dg.id, next, false);
      return;
    }
    if (dg?.kind === "vertex") {
      const p = snapPoint(w, { toWall: dg.orig.kind === "door" || dg.orig.kind === "exit" });
      const next = setHandle(dg.orig, dg.vi, p);
      if (!dg.moved) { editProject((pp) => { pp.elements = pp.elements.map((x) => (x.id === dg.id ? next : x)); }); dg.moved = true; }
      else updateElement(dg.id, next, false);
      return;
    }
    if (dg?.kind === "rect") { dg.cur = snapPoint(w); dirty.current.top = true; return; }
    if (s.tool !== "select" && s.tool !== "pan") {
      const d = draft.current;
      let p = snapPoint(w, { toWall: s.tool === "door" || s.tool === "exit" || s.tool === "barrier" });
      if (d.pts.length) p = ortho(d.pts[d.pts.length - 1], p, e.shiftKey);
      d.cursor = p;
      dirty.current.top = true;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const dg = drag.current;
    drag.current = null;
    if (dg?.kind === "rect") finishRect(dg.start, dg.cur);
    if (dg?.kind === "pan") persistView();
    dirty.current.top = true;
  };
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistView = () => {
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      const V = v.current;
      setState((s) => ({ project: { ...s.project, view: { cx: +V.cx.toFixed(2), cy: +V.cy.toFixed(2), scale: +V.scale.toFixed(3), level: s.level } } }));
    }, 400);
  };
  const zoomAt = (sx: number, sy: number, f: number) => {
    const before = toWorld(v.current, sx, sy);
    const scale = Math.max(0.3, Math.min(400, v.current.scale * f));
    v.current = { ...v.current, scale };
    const after = toWorld(v.current, sx, sy);
    v.current = { ...v.current, cx: v.current.cx + before[0] - after[0], cy: v.current.cy + before[1] - after[1] };
    viewRef.v = v.current;
    dirty.current = { base: true, agents: true, top: true };
    persistView();
  };
  useEffect(() => {
    const el = wrap.current!;
    const wheel = (e: WheelEvent) => { e.preventDefault(); const [sx, sy] = local(e); zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });

  // keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const s = getState();
      if (e.key === "Escape") { draft.current = { pts: [], cursor: null }; drag.current = null; setHint(null); setState({ selection: [], follow: null, tool: s.tool === "select" ? "select" : s.tool }); dirty.current.top = true; return; }
      if (e.key === "Enter" && s.tool === "wall") { finishWall(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && s.selection.length) {
        e.preventDefault();
        const ids = new Set(s.selection);
        editProject((p) => { p.elements = p.elements.filter((x) => !ids.has(x.id)); });
        setState({ selection: [] });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tl = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (tl) { setState({ tool: tl.t }); return; }
      if (e.key === "f" || e.key === "F") { fit(); return; }
      if (e.key === "g" || e.key === "G") setState({ snap: !s.snap });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  const levels = project.levels;
  const li = levels.findIndex((l) => l.id === level);
  const scaleBar = (() => {
    const target = 110 / v.current.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const m = [1, 2, 5, 10].map((x) => x * pow).filter((x) => x <= target).pop() ?? pow;
    return { m, px: m * v.current.scale };
  })();
  const fol = follow !== null && live.frame ? follow : null;

  return (
    <div className="map-wrap" ref={wrap} data-testid="topview"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => { if (getState().tool === "wall") finishWall(); }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => setCursor(null)}
      style={{ cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair", touchAction: "none" }}>
      <canvas ref={baseRef} className="layer" />
      <canvas ref={glRef} className="layer" />
      <canvas ref={topRef} className="layer" />
      <div className="ov rail" onPointerDown={(e) => e.stopPropagation()} data-testid="rail">
        {TOOLS.filter((t) => !mobile || ["select", "pan", "wall", "door", "exit", "measure"].includes(t.t)).map((t, i) => (
          <span key={t.t} style={{ display: "contents" }}>
            {(i === 2 || i === 11) && <div className="sep" />}
            <button className={`rb ${tool === t.t ? "on" : ""}`} data-tip={`${t.label} · ${t.key}`} aria-label={t.label} onClick={() => setState({ tool: t.t })} data-testid={`tool-${t.t}`}><Icon name={t.icon} size={17} /></button>
          </span>
        ))}
      </div>
      <div className="ov view-ctl" onPointerDown={(e) => e.stopPropagation()}>
        <button className="rb tip-left" data-tip="Zoom in" aria-label="Zoom in" onClick={() => zoomAt(v.current.w / 2, v.current.h / 2, 1.4)}><Icon name="plus" size={17} /></button>
        <button className="rb tip-left" data-tip="Zoom out" aria-label="Zoom out" onClick={() => zoomAt(v.current.w / 2, v.current.h / 2, 1 / 1.4)}><Icon name="minus" size={17} /></button>
        <button className="rb tip-left" data-tip="Fit level · F" aria-label="Fit" onClick={fit}><Icon name="fit" size={17} /></button>
        <div className="sep" />
        <button className={`rb tip-left ${snapOn ? "on" : ""}`} data-tip={`Snap to ${gridSize} m grid · G`} aria-label="Snap" onClick={() => setState({ snap: !snapOn })}><Icon name="magnet" size={17} /></button>
      </div>
      {hint && <div className="ov hintbar" onPointerDown={(e) => e.stopPropagation()}><span>{hint}</span><button className="btn sm ghost icon" aria-label="Dismiss" onClick={() => setHint(null)}><Icon name="x" size={13} /></button></div>}
      <div className="ov statusbar" onPointerDown={(e) => e.stopPropagation()}>
        {levels.length > 1 && (
          <select value={level} onChange={(e) => setState({ level: e.target.value, selection: [] })} aria-label="Level" data-testid="level-select">
            {levels.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.elevation >= 0 ? "+" : ""}{l.elevation} m)</option>)}
          </select>
        )}
        {levels.length <= 1 && <span>{levels[li]?.name}</span>}
        <span className="coords">{cursor ? `${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)} m` : "—"}</span>
        <span className="scalebar"><span style={{ fontSize: 10 }}>{scaleBar.m >= 1 ? scaleBar.m : scaleBar.m.toFixed(1)} m</span><span className="bar" style={{ width: scaleBar.px }} /></span>
        {fol !== null && <span style={{ color: C.accent }}>following #{fol}</span>}
      </div>
      {(overlay !== "none" || (status !== "idle" && !mobile)) && <Legend />}
      {calib && <CalibrateDialog a={calib.a} b={calib.b} onClose={() => setCalib(null)} />}
    </div>
  );
}

function CalibrateDialog({ a, b, onClose }: { a: P; b: P; onClose: () => void }) {
  const cur = dist(a, b);
  const [val, setVal] = useState(cur.toFixed(3));
  const level = useStore((s) => s.level);
  const apply = () => {
    const d = Number(val);
    if (!(d > 0)) return;
    const k = d / cur;
    const sc = (q: P): P => [+(a[0] + (q[0] - a[0]) * k).toFixed(4), +(a[1] + (q[1] - a[1]) * k).toFixed(4)];
    editProject((p) => {
      p.elements = p.elements.map((e) => {
        if (e.level !== level) return e;
        switch (e.kind) {
          case "wall": case "obstacle": case "spawn": return { ...e, pts: e.pts.map(sc) } as Element;
          case "door": case "exit": case "barrier": return { ...e, a: sc(e.a), b: sc(e.b) } as Element;
          case "stair": return { ...e, a: sc(e.a), b: sc(e.b), width: +(e.width * k).toFixed(3) };
          case "seating": return { ...e, origin: sc(e.origin), width: +(e.width * k).toFixed(3), depth: +(e.depth * k).toFixed(3) };
          case "attractor": return { ...e, p: sc(e.p) };
        }
      });
    });
    window.dispatchEvent(new Event("flow:fit"));
    onClose();
  };
  return (
    <Modal title="Calibrate scale" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={apply} data-testid="calib-apply">Scale level</button></>}>
      <div className="hint">The two points are {cur.toFixed(3)} model units apart. Enter their real distance; every element on this level is scaled about the first point by the same factor.</div>
      <Field label="Real distance m"><input className="input mono" autoFocus value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") apply(); }} data-testid="calib-input" /></Field>
      {Number(val) > 0 && <div className="note mono">factor × {(Number(val) / cur).toFixed(5)}</div>}
    </Modal>
  );
}

