// Compile a project + scenario into simulation geometry: per-level navigation grids, wall segments
// (with door/exit openings cut out), spatial hashes, stairs, attractors, seating and spawn sources.
import type { Attractor, Barrier, Door, Exit, Obstacle, P, Project, Scenario, Seating, Spawn, Stair, Wall } from "../model/types";
import { pointInPoly, seatingLayout, segDist, segT, stairFootprint, stairFrame, emptyBox, addPt, elementPoints, serverPoints } from "../model/geom";
import { obstacleDistance, type Grid, type OneWay } from "./fmm";

export const SEG_STATIC = 0, SEG_DOOR = 1, SEG_BARRIER = 2;

export interface SegHash { cs: number; x0: number; y0: number; nx: number; ny: number; start: Int32Array; items: Int32Array }

export interface LevelWorld {
  id: string; name: string; index: number; elev: number; height: number;
  grid: Grid;
  blocked: Uint8Array;
  slow: Float32Array;         // base slowness (clearance + stairs), Infinity where blocked
  oneWay: OneWay | null;
  stairCell: Int16Array;      // stair index whose walkable footprint covers the cell, −1 otherwise
  segs: Float64Array;         // ax, ay, bx, by, halfThickness
  segKind: Int8Array;
  segRef: Int16Array;         // door index (SEG_DOOR) or barrier index (SEG_BARRIER)
  nSegs: number;
  segHash: SegHash;
  lines: number[];            // indices into world.openings on this level
  lineHash: SegHash;
}

export interface OpeningW { id: string; name: string; level: number; ax: number; ay: number; bx: number; by: number; width: number; isExit: boolean; closed: boolean; maxFlow: number | null }
export interface StairW { id: string; name: string; la: number; lb: number; ax: number; ay: number; bx: number; by: number; L: number; ux: number; uy: number; nx: number; ny: number; hw: number; down: number; up: number; ramp: boolean; descendsToB: boolean; width: number }
export interface AttractorW { id: string; name: string; level: number; el: Attractor; servers: P[] }
export interface SeatingW { id: string; name: string; level: number; el: Seating; seats: P[]; aisleSeat: boolean[]; capacity: number }
export interface SpawnW { id: string; name: string; level: number; el: Spawn; area: number }
export interface BarrierW { id: string; level: number; ax: number; ay: number; bx: number; by: number }

export interface World {
  levels: LevelWorld[];
  levelIndex: Map<string, number>;
  openings: OpeningW[];        // doors and exits (index = door index used by SEG_DOOR)
  exits: number[];             // indices into openings of open exits
  stairs: StairW[];
  attractors: AttractorW[];
  seating: SeatingW[];
  spawns: SpawnW[];
  barriers: BarrierW[];
  warnings: string[];
}

interface RawSeg { ax: number; ay: number; bx: number; by: number; ht: number; kind: number; ref: number }

/** Remove door/exit openings from wall segments that run along them. */
function cutOpenings(seg: RawSeg, openings: OpeningW[]): RawSeg[] {
  const dx = seg.bx - seg.ax, dy = seg.by - seg.ay;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return [];
  const cuts: [number, number][] = [];
  const tol = seg.ht + 0.08;
  for (const o of openings) {
    const da = segDist(o.ax, o.ay, seg.ax, seg.ay, seg.bx, seg.by), db = segDist(o.bx, o.by, seg.ax, seg.ay, seg.bx, seg.by);
    // the opening must lie along the wall (both ends near the wall line, roughly parallel)
    const ox = o.bx - o.ax, oy = o.by - o.ay, oL = Math.hypot(ox, oy);
    if (oL < 1e-6) continue;
    const par = Math.abs((ox * dx + oy * dy) / (oL * L));
    const ta = segT(o.ax, o.ay, seg.ax, seg.ay, seg.bx, seg.by), tb = segT(o.bx, o.by, seg.ax, seg.ay, seg.bx, seg.by);
    const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
    if (hi <= 0 || lo >= 1) continue;
    const perpA = Math.abs(((o.ax - seg.ax) * dy - (o.ay - seg.ay) * dx) / L), perpB = Math.abs(((o.bx - seg.ax) * dy - (o.by - seg.ay) * dx) / L);
    if (par > 0.97 && perpA <= tol && perpB <= tol && (da < oL || db < oL)) cuts.push([Math.max(0, lo), Math.min(1, hi)]);
  }
  if (!cuts.length) return [seg];
  cuts.sort((a, b) => a[0] - b[0]);
  const out: RawSeg[] = [];
  let t0 = 0;
  for (const [a, b] of cuts) {
    if (a > t0 + 1e-4) out.push({ ...seg, ax: seg.ax + dx * t0, ay: seg.ay + dy * t0, bx: seg.ax + dx * a, by: seg.ay + dy * a });
    t0 = Math.max(t0, b);
  }
  if (t0 < 1 - 1e-4) out.push({ ...seg, ax: seg.ax + dx * t0, ay: seg.ay + dy * t0, bx: seg.bx, by: seg.by });
  return out.filter((s) => Math.hypot(s.bx - s.ax, s.by - s.ay) > 0.02);
}

function buildHash(items: { x0: number; y0: number; x1: number; y1: number }[], box: { x0: number; y0: number; x1: number; y1: number }, cs: number): SegHash {
  const nx = Math.max(1, Math.ceil((box.x1 - box.x0) / cs) + 1), ny = Math.max(1, Math.ceil((box.y1 - box.y0) / cs) + 1);
  const count = new Int32Array(nx * ny + 1);
  const cellsOf = (b: { x0: number; y0: number; x1: number; y1: number }, f: (c: number) => void) => {
    const i0 = Math.max(0, Math.floor((b.x0 - box.x0) / cs)), i1 = Math.min(nx - 1, Math.floor((b.x1 - box.x0) / cs));
    const j0 = Math.max(0, Math.floor((b.y0 - box.y0) / cs)), j1 = Math.min(ny - 1, Math.floor((b.y1 - box.y0) / cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * nx + i);
  };
  items.forEach((b) => cellsOf(b, (c) => count[c + 1]++));
  for (let i = 1; i <= nx * ny; i++) count[i] += count[i - 1];
  const start = count.slice();
  const fill = count.slice();
  const out = new Int32Array(start[nx * ny]);
  items.forEach((b, k) => cellsOf(b, (c) => { out[fill[c]++] = k; }));
  return { cs, x0: box.x0, y0: box.y0, nx, ny, start, items: out };
}

export function hashCell(h: SegHash, x: number, y: number): number {
  const i = Math.floor((x - h.x0) / h.cs), j = Math.floor((y - h.y0) / h.cs);
  if (i < 0 || j < 0 || i >= h.nx || j >= h.ny) return -1;
  return j * h.nx + i;
}

export function compileWorld(project: Project, scenario: Scenario): World {
  const warnings: string[] = [];
  const levelIndex = new Map(project.levels.map((l, i) => [l.id, i]));
  const closed = new Set(scenario.closedExits);
  const els = project.elements.filter((e) => levelIndex.has(e.level));
  const by = <K extends string>(k: K) => els.filter((e) => e.kind === k);

  const openings: OpeningW[] = [];
  for (const e of [...by("door"), ...by("exit")] as (Door | Exit)[]) {
    const w = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    openings.push({
      id: e.id, name: e.name || (e.kind === "exit" ? "Exit" : "Door"), level: levelIndex.get(e.level)!, ax: e.a[0], ay: e.a[1], bx: e.b[0], by: e.b[1], width: w,
      isExit: e.kind === "exit", closed: e.closed || closed.has(e.id), maxFlow: e.kind === "door" && e.maxFlow && e.maxFlow > 0 ? e.maxFlow : null,
    });
  }
  const exits = openings.map((o, i) => (o.isExit && !o.closed ? i : -1)).filter((i) => i >= 0);
  if (!exits.length && (scenario.kind === "evacuation" || scenario.kind === "egress")) warnings.push("No open exits — nobody can leave.");

  const stairs: StairW[] = [];
  for (const s of by("stair") as Stair[]) {
    const lb = levelIndex.get(s.toLevel);
    if (lb === undefined) { warnings.push(`Stair ${s.name || s.id} connects to a missing level`); continue; }
    const f = stairFrame(s);
    const la = levelIndex.get(s.level)!;
    stairs.push({
      id: s.id, name: s.name || "Stair", la, lb, ax: s.a[0], ay: s.a[1], bx: s.b[0], by: s.b[1], L: f.L, ux: f.ux, uy: f.uy, nx: f.nx, ny: f.ny, hw: f.hw,
      down: s.speedDown, up: s.speedUp, ramp: s.ramp, width: s.width,
      descendsToB: project.levels[lb].elevation < project.levels[la].elevation,
    });
  }

  const attractors: AttractorW[] = (by("attractor") as Attractor[]).map((a) => ({ id: a.id, name: a.name || a.type, level: levelIndex.get(a.level)!, el: a, servers: serverPoints(a) }));
  const seatingAll = (by("seating") as Seating[]).map((s) => { const lay = seatingLayout(s); return { id: s.id, name: s.name || "Seating", level: levelIndex.get(s.level)!, el: s, seats: lay.seats, aisleSeat: lay.aisleSeat, capacity: lay.capacity, lay }; });
  const spawns: SpawnW[] = (by("spawn") as Spawn[]).filter((s) => s.pts.length >= 3).map((s) => {
    let a = 0; for (let i = 0, j = s.pts.length - 1; i < s.pts.length; j = i++) a += (s.pts[j][0] + s.pts[i][0]) * (s.pts[j][1] - s.pts[i][1]);
    return { id: s.id, name: s.name || "Spawn", level: levelIndex.get(s.level)!, el: s, area: Math.abs(a) / 2 };
  });
  const barriers: BarrierW[] = (by("barrier") as Barrier[]).map((b) => ({ id: b.id, level: levelIndex.get(b.level)!, ax: b.a[0], ay: b.a[1], bx: b.b[0], by: b.b[1] }));

  const levels: LevelWorld[] = project.levels.map((L, li) => {
    // ---- raw segments
    const raw: RawSeg[] = [];
    const levelOpenings = openings.filter((o) => o.level === li);
    for (const w of by("wall") as Wall[]) {
      if (levelIndex.get(w.level) !== li) continue;
      const pts = w.closed ? [...w.pts, w.pts[0]] : w.pts;
      for (let i = 1; i < pts.length; i++)
        raw.push(...cutOpenings({ ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1], ht: Math.max(0.02, w.thickness / 2), kind: SEG_STATIC, ref: -1 }, levelOpenings));
    }
    for (const o of by("obstacle") as Obstacle[]) {
      if (levelIndex.get(o.level) !== li) continue;
      for (let i = 0; i < o.pts.length; i++) { const a = o.pts[i], b = o.pts[(i + 1) % o.pts.length]; raw.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], ht: 0.02, kind: SEG_STATIC, ref: -1 }); }
    }
    for (const s of seatingAll) {
      if (s.level !== li) continue;
      for (const r of s.lay.rows) raw.push({ ax: r.a[0], ay: r.a[1], bx: r.b[0], by: r.b[1], ht: 0.15, kind: SEG_STATIC, ref: -1 });
      for (const r of s.lay.sideWalls) raw.push({ ax: r.a[0], ay: r.a[1], bx: r.b[0], by: r.b[1], ht: 0.05, kind: SEG_STATIC, ref: -1 });
    }
    stairs.forEach((s) => {
      const fp: P[] = [[s.ax + s.nx * s.hw, s.ay + s.ny * s.hw], [s.bx + s.nx * s.hw, s.by + s.ny * s.hw], [s.bx - s.nx * s.hw, s.by - s.ny * s.hw], [s.ax - s.nx * s.hw, s.ay - s.ny * s.hw]];
      if (s.la === li) {
        // side walls and the closed b end of the flight on its own level
        raw.push({ ax: fp[0][0], ay: fp[0][1], bx: fp[1][0], by: fp[1][1], ht: 0.05, kind: SEG_STATIC, ref: -1 });
        raw.push({ ax: fp[3][0], ay: fp[3][1], bx: fp[2][0], by: fp[2][1], ht: 0.05, kind: SEG_STATIC, ref: -1 });
        raw.push({ ax: fp[1][0], ay: fp[1][1], bx: fp[2][0], by: fp[2][1], ht: 0.05, kind: SEG_STATIC, ref: -1 });
      }
      if (s.lb === li && s.lb !== s.la) for (let i = 0; i < 4; i++) raw.push({ ax: fp[i][0], ay: fp[i][1], bx: fp[(i + 1) % 4][0], by: fp[(i + 1) % 4][1], ht: 0.05, kind: SEG_STATIC, ref: -1 });
    });
    levelOpenings.forEach((o) => {
      const idx = openings.indexOf(o);
      if (o.closed) raw.push({ ax: o.ax, ay: o.ay, bx: o.bx, by: o.by, ht: 0.1, kind: SEG_STATIC, ref: -1 });
      else if (o.maxFlow) raw.push({ ax: o.ax, ay: o.ay, bx: o.bx, by: o.by, ht: 0.05, kind: SEG_DOOR, ref: idx });
    });
    barriers.forEach((b, bi) => { if (b.level === li) raw.push({ ax: b.ax, ay: b.ay, bx: b.bx, by: b.by, ht: 0.03, kind: SEG_BARRIER, ref: bi }); });

    // ---- grid extent
    const box = emptyBox();
    for (const e of els) {
      const on = levelIndex.get(e.level) === li || (e.kind === "stair" && levelIndex.get(e.toLevel) === li);
      if (on) for (const p of elementPoints(e)) addPt(box, p);
    }
    if (!isFinite(box.x0)) { box.x0 = 0; box.y0 = 0; box.x1 = 10; box.y1 = 10; }
    const margin = 3;
    let h = project.settings.gridCell;
    const W = box.x1 - box.x0 + 2 * margin, H = box.y1 - box.y0 + 2 * margin;
    while ((W / h) * (H / h) > 2_000_000) h *= 1.25;
    if (h !== project.settings.gridCell) warnings.push(`${L.name}: grid coarsened to ${h.toFixed(2)} m to stay under 2 M cells`);
    const grid: Grid = { nx: Math.ceil(W / h), ny: Math.ceil(H / h), h, x0: box.x0 - margin, y0: box.y0 - margin };
    const N = grid.nx * grid.ny;
    const blocked = new Uint8Array(N);
    const cellOf = (x: number, y: number) => [Math.floor((x - grid.x0) / h), Math.floor((y - grid.y0) / h)];
    const forCellsNear = (ax: number, ay: number, bx: number, by: number, r: number, f: (c: number, cx: number, cy: number) => void) => {
      const [i0, j0] = cellOf(Math.min(ax, bx) - r, Math.min(ay, by) - r), [i1, j1] = cellOf(Math.max(ax, bx) + r, Math.max(ay, by) + r);
      for (let j = Math.max(0, j0); j <= Math.min(grid.ny - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(grid.nx - 1, i1); i++) {
        const cx = grid.x0 + (i + 0.5) * h, cy = grid.y0 + (j + 0.5) * h;
        f(j * grid.nx + i, cx, cy);
      }
    };
    const rasterPad = h * 0.71;
    for (const s of raw) {
      if (s.kind !== SEG_STATIC) continue;
      const r = Math.max(s.ht, rasterPad);
      forCellsNear(s.ax, s.ay, s.bx, s.by, r, (c, cx, cy) => { if (segDist(cx, cy, s.ax, s.ay, s.bx, s.by) <= r) blocked[c] = 1; });
    }
    const fillPoly = (pts: P[]) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      forCellsNear(x0, y0, x1, y1, 0, (c, cx, cy) => { if (pointInPoly(cx, cy, pts)) blocked[c] = 1; });
    };
    for (const o of by("obstacle") as Obstacle[]) if (levelIndex.get(o.level) === li && o.pts.length >= 3) fillPoly(o.pts);
    stairs.forEach((s) => { if (s.lb === li && s.lb !== s.la) fillPoly(stairFootprint(project.elements.find((e) => e.id === s.id) as Stair)); });

    // ---- stair footprint lookup + slowness
    const stairCell = new Int16Array(N).fill(-1);
    stairs.forEach((s, si) => {
      if (s.la !== li) return;
      forCellsNear(s.ax, s.ay, s.bx, s.by, s.hw + h, (c, cx, cy) => {
        const along = (cx - s.ax) * s.ux + (cy - s.ay) * s.uy, lat = (cx - s.ax) * s.nx + (cy - s.ay) * s.ny;
        if (along >= 0 && along <= s.L && Math.abs(lat) <= s.hw) stairCell[c] = si;
      });
    });
    const slow = new Float32Array(N);
    const clr = project.settings.wallClearance;
    const dObs = clr > 0 ? obstacleDistance(grid, blocked) : null;
    for (let c = 0; c < N; c++) {
      if (blocked[c]) { slow[c] = Infinity; continue; }
      let s = 1;
      if (dObs) { const d = dObs[c] - rasterPad * 0.5; if (d < clr) s += 1.2 * (1 - Math.max(0, d) / clr); }
      const si = stairCell[c];
      if (si >= 0) s /= Math.max(0.1, (stairs[si].down + stairs[si].up) / 2);
      slow[c] = s;
    }

    // ---- one-way barriers for the field
    let oneWay: OneWay | null = null;
    const myBarriers = barriers.map((b, i) => [b, i] as const).filter(([b]) => b.level === li);
    if (myBarriers.length) {
      oneWay = { id: new Int16Array(N).fill(-1), side: new Int8Array(N) };
      for (const [b, bi] of myBarriers) {
        const r = h * 1.6;
        forCellsNear(b.ax, b.ay, b.bx, b.by, r, (c, cx, cy) => {
          if (segDist(cx, cy, b.ax, b.ay, b.bx, b.by) > r) return;
          const t = segT(cx, cy, b.ax, b.ay, b.bx, b.by);
          if (t < -0.02 || t > 1.02) return;
          oneWay!.id[c] = bi;
          oneWay!.side[c] = (b.bx - b.ax) * (cy - b.ay) - (b.by - b.ay) * (cx - b.ax) > 0 ? 1 : -1;   // +1 = left (allowed origin)
        });
      }
    }

    // ---- segment arrays + hashes
    const n = raw.length;
    const segs = new Float64Array(n * 5), segKind = new Int8Array(n), segRef = new Int16Array(n);
    raw.forEach((s, i) => { segs.set([s.ax, s.ay, s.bx, s.by, s.ht], i * 5); segKind[i] = s.kind; segRef[i] = s.ref; });
    const hbox = { x0: grid.x0, y0: grid.y0, x1: grid.x0 + grid.nx * h, y1: grid.y0 + grid.ny * h };
    const reach = 1.1;
    const segHash = buildHash(raw.map((s) => ({ x0: Math.min(s.ax, s.bx) - s.ht - reach, y0: Math.min(s.ay, s.by) - s.ht - reach, x1: Math.max(s.ax, s.bx) + s.ht + reach, y1: Math.max(s.ay, s.by) + s.ht + reach })), hbox, 1.5);
    const lines = levelOpenings.map((o) => openings.indexOf(o)).filter((i) => !openings[i].closed);
    const lineHash = buildHash(lines.map((i) => { const o = openings[i]; return { x0: Math.min(o.ax, o.bx) - 0.6, y0: Math.min(o.ay, o.by) - 0.6, x1: Math.max(o.ax, o.bx) + 0.6, y1: Math.max(o.ay, o.by) + 0.6 }; }), hbox, 2);
    return { id: L.id, name: L.name, index: li, elev: L.elevation, height: L.height, grid, blocked, slow, oneWay, stairCell, segs, segKind, segRef, nSegs: n, segHash, lines, lineHash };
  });

  const seating: SeatingW[] = seatingAll.map(({ lay: _l, ...s }) => s);
  return { levels, levelIndex, openings, exits, stairs, attractors, seating, spawns, barriers, warnings };
}

/** Bilinear-free nearest-cell index for a point, or −1 outside. */
export function cellIndex(L: LevelWorld, x: number, y: number): number {
  const g = L.grid;
  const i = Math.floor((x - g.x0) / g.h), j = Math.floor((y - g.y0) / g.h);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
  return j * g.nx + i;
}
