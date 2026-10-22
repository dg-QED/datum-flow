// Floor fields: travel-time-to-goal maps T(x) per level, coupled across levels through stair portals.
import { pointInPoly, segDist } from "../model/geom";
import type { P } from "../model/types";
import { fastMarch } from "./fmm";
import { cellIndex, type LevelWorld, type World } from "./world";

export interface Field { id: string; T: Float32Array[] }

export type GoalSpec =
  | { kind: "segment"; level: number; ax: number; ay: number; bx: number; by: number }
  | { kind: "points"; level: number; pts: P[]; r: number }
  | { kind: "polygon"; level: number; pts: P[] };

function goalCells(L: LevelWorld, g: GoalSpec): number[] {
  const { grid } = L, h = grid.h;
  const out: number[] = [];
  let x0: number, y0: number, x1: number, y1: number, test: (x: number, y: number) => boolean;
  if (g.kind === "segment") {
    const r = Math.max(h * 1.05, 0.3);
    x0 = Math.min(g.ax, g.bx) - r; x1 = Math.max(g.ax, g.bx) + r; y0 = Math.min(g.ay, g.by) - r; y1 = Math.max(g.ay, g.by) + r;
    test = (x, y) => segDist(x, y, g.ax, g.ay, g.bx, g.by) <= r;
  } else if (g.kind === "points") {
    x0 = Math.min(...g.pts.map((p) => p[0])) - g.r; x1 = Math.max(...g.pts.map((p) => p[0])) + g.r;
    y0 = Math.min(...g.pts.map((p) => p[1])) - g.r; y1 = Math.max(...g.pts.map((p) => p[1])) + g.r;
    test = (x, y) => g.pts.some((p) => Math.hypot(x - p[0], y - p[1]) <= g.r);
  } else {
    x0 = Math.min(...g.pts.map((p) => p[0])); x1 = Math.max(...g.pts.map((p) => p[0]));
    y0 = Math.min(...g.pts.map((p) => p[1])); y1 = Math.max(...g.pts.map((p) => p[1]));
    test = (x, y) => pointInPoly(x, y, g.pts);
  }
  const i0 = Math.max(0, Math.floor((x0 - grid.x0) / h)), i1 = Math.min(grid.nx - 1, Math.floor((x1 - grid.x0) / h));
  const j0 = Math.max(0, Math.floor((y0 - grid.y0) / h)), j1 = Math.min(grid.ny - 1, Math.floor((y1 - grid.y0) / h));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * grid.nx + i;
    if (L.blocked[c]) continue;
    if (test(grid.x0 + (i + 0.5) * h, grid.y0 + (j + 0.5) * h)) out.push(c);
  }
  if (!out.length) {
    // goal falls entirely in blocked cells (e.g. a point inside a counter): use the nearest free cells
    const cx = g.kind === "segment" ? (g.ax + g.bx) / 2 : g.pts.reduce((a, p) => a + p[0], 0) / g.pts.length;
    const cy = g.kind === "segment" ? (g.ay + g.by) / 2 : g.pts.reduce((a, p) => a + p[1], 0) / g.pts.length;
    let best = -1, bd = Infinity;
    const ci = Math.floor((cx - grid.x0) / h), cj = Math.floor((cy - grid.y0) / h);
    for (let j = Math.max(0, cj - 12); j <= Math.min(grid.ny - 1, cj + 12); j++) for (let i = Math.max(0, ci - 12); i <= Math.min(grid.nx - 1, ci + 12); i++) {
      const c = j * grid.nx + i;
      if (L.blocked[c]) continue;
      const d = (i - ci) ** 2 + (j - cj) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    if (best >= 0) out.push(best);
  }
  return out;
}

/** Sample T at a point (nearest free cell in the 3×3 neighbourhood). */
export function sampleT(L: LevelWorld, T: Float32Array, x: number, y: number): number {
  const g = L.grid;
  const i = Math.floor((x - g.x0) / g.h), j = Math.floor((y - g.y0) / g.h);
  let best = Infinity;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue;
    const v = T[jj * g.nx + ii];
    if (di === 0 && dj === 0 && isFinite(v)) return v;
    if (v + g.h < best) best = v + g.h;
  }
  return best;
}

/** Cells on level `li` forming a stair portal: inside the flight next to its b end (la), or in front of its b face (lb). */
export function portalCells(w: World, si: number, onA: boolean): number[] {
  const s = w.stairs[si];
  const L = w.levels[onA ? s.la : s.lb];
  const g = L.grid;
  const out: number[] = [];
  const lo = onA ? s.L - 0.6 : s.L + 0.05, hi = onA ? s.L : s.L + 0.7;
  const r = s.hw + g.h + 0.8;
  const i0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - r - g.x0) / g.h)), i1 = Math.min(g.nx - 1, Math.floor((Math.max(s.ax, s.bx) + r - g.x0) / g.h));
  const j0 = Math.max(0, Math.floor((Math.min(s.ay, s.by) - r - g.y0) / g.h)), j1 = Math.min(g.ny - 1, Math.floor((Math.max(s.ay, s.by) + r - g.y0) / g.h));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * g.nx + i;
    if (L.blocked[c]) continue;
    const x = g.x0 + (i + 0.5) * g.h, y = g.y0 + (j + 0.5) * g.h;
    const along = (x - s.ax) * s.ux + (y - s.ay) * s.uy, lat = (x - s.ax) * s.nx + (y - s.ay) * s.ny;
    if (along >= lo && along <= hi && Math.abs(lat) <= s.hw - 0.05) out.push(c);
  }
  return out;
}

export function computeField(w: World, id: string, goals: GoalSpec[]): Field {
  const nL = w.levels.length;
  const seeds: Float32Array[] = w.levels.map((L) => new Float32Array(L.grid.nx * L.grid.ny).fill(Infinity));
  for (const g of goals) {
    const L = w.levels[g.level];
    for (const c of goalCells(L, g)) seeds[g.level][c] = 0;
  }
  const T: Float32Array[] = w.levels.map((L) => new Float32Array(L.grid.nx * L.grid.ny).fill(Infinity));
  const dirty = new Set<number>();
  goals.forEach((g) => dirty.add(g.level));
  const portals = w.stairs.map((_, si) => ({ a: portalCells(w, si, true), b: portalCells(w, si, false) }));
  for (let pass = 0; pass < 2 * nL + 2 && dirty.size; pass++) {
    for (const li of dirty) {
      const L = w.levels[li];
      T[li] = fastMarch(L.grid, L.slow, seeds[li].slice(), L.oneWay);
    }
    dirty.clear();
    w.stairs.forEach((s, si) => {
      if (s.la === s.lb) return;
      const LA = w.levels[s.la], LB = w.levels[s.lb];
      const vB = sampleT(LB, T[s.lb], s.bx + s.ux * 0.45, s.by + s.uy * 0.45);
      if (isFinite(vB)) for (const c of portals[si].a) if (vB + 0.05 < seeds[s.la][c]) { seeds[s.la][c] = vB + 0.05; dirty.add(s.la); }
      const vA = sampleT(LA, T[s.la], s.bx - s.ux * 0.35, s.by - s.uy * 0.35);
      if (isFinite(vA)) for (const c of portals[si].b) if (vA + 0.05 < seeds[s.lb][c]) { seeds[s.lb][c] = vA + 0.05; dirty.add(s.lb); }
    });
  }
  return { id, T };
}

/**
 * Desired walking direction at (x, y): −∇T, bilinearly blended from the four surrounding cell centres.
 * Writes into out[0..1]; returns false when no direction is available.
 */
export function fieldDir(L: LevelWorld, T: Float32Array, x: number, y: number, out: Float64Array): boolean {
  const g = L.grid, nx = g.nx, ny = g.ny, h = g.h;
  const fx = (x - g.x0) / h - 0.5, fy = (y - g.y0) / h - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const tx = fx - i0, ty = fy - j0;
  let gx = 0, gy = 0, wsum = 0;
  for (let dj = 0; dj <= 1; dj++) for (let di = 0; di <= 1; di++) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    const c = j * nx + i;
    const tc = T[c];
    if (!isFinite(tc)) continue;
    const wgt = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) + 1e-6;
    const L_ = i > 0 ? T[c - 1] : Infinity, R = i < nx - 1 ? T[c + 1] : Infinity;
    const D = j > 0 ? T[c - nx] : Infinity, U = j < ny - 1 ? T[c + nx] : Infinity;
    let cx: number, cy: number;
    if (isFinite(L_) && isFinite(R)) cx = (R - L_) / 2; else if (isFinite(R)) cx = R - tc; else if (isFinite(L_)) cx = tc - L_; else cx = 0;
    if (isFinite(D) && isFinite(U)) cy = (U - D) / 2; else if (isFinite(U)) cy = U - tc; else if (isFinite(D)) cy = tc - D; else cy = 0;
    const m = Math.hypot(cx, cy);
    if (m < 1e-9) continue;
    gx += (cx / m) * wgt; gy += (cy / m) * wgt; wsum += wgt;
  }
  if (wsum > 0) {
    const m = Math.hypot(gx, gy);
    if (m > 1e-9) { out[0] = -gx / m; out[1] = -gy / m; return true; }
  }
  // inside a blocked cell or on a plateau: head for the lowest neighbouring free cell
  const c0 = cellIndex(L, x, y);
  if (c0 < 0) return false;
  const ci = c0 % nx, cj = (c0 - ci) / nx;
  let best = Infinity, bx = 0, by = 0;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= nx || j >= ny || (!di && !dj)) continue;
    const v = T[j * nx + i];
    if (v < best) { best = v; bx = g.x0 + (i + 0.5) * h - x; by = g.y0 + (j + 0.5) * h - y; }
  }
  if (!isFinite(best)) return false;
  const m = Math.hypot(bx, by) || 1;
  out[0] = bx / m; out[1] = by / m;
  return true;
}

/** Bilinear travel-time value used for exit choice and progress. */
export function fieldValue(L: LevelWorld, T: Float32Array, x: number, y: number): number {
  return sampleT(L, T, x, y);
}
