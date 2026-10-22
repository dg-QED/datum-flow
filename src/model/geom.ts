// Plan geometry helpers shared by the editor, the renderer and the simulation compiler.
import type { Attractor, Element, P, Seating, Stair } from "./types";

export const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const lerp = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Distance from point to segment and the parameter of the closest point. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}
export function segT(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  return L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
}

/** Do segments p1p2 and p3p4 properly intersect? */
export function segCross(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
  const d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
  if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0)) return false;
  const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
  if ((d3 > 0 && d4 > 0) || (d3 < 0 && d4 < 0)) return false;
  return !(d1 === 0 && d2 === 0);
}

export function pointInPoly(x: number, y: number, pts: P[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function polyArea(pts: P[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a) / 2;
}
export function polyCentroid(pts: P[]): P {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / Math.max(1, pts.length), y / Math.max(1, pts.length)];
}

export interface BBox { x0: number; y0: number; x1: number; y1: number }
export const emptyBox = (): BBox => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export function addPt(b: BBox, p: P) { if (p[0] < b.x0) b.x0 = p[0]; if (p[1] < b.y0) b.y0 = p[1]; if (p[0] > b.x1) b.x1 = p[0]; if (p[1] > b.y1) b.y1 = p[1]; }

/** Outline points used for bounds, hit testing and drawing. */
export function elementPoints(e: Element): P[] {
  switch (e.kind) {
    case "wall": case "obstacle": case "spawn": return e.pts;
    case "door": case "exit": case "barrier": return [e.a, e.b];
    case "stair": return stairFootprint(e);
    case "seating": return seatingCorners(e);
    case "attractor": return [e.p];
  }
}
export function elementsBox(els: Element[], level?: string): BBox {
  const b = emptyBox();
  for (const e of els) {
    if (level && e.level !== level && !(e.kind === "stair" && e.toLevel === level)) continue;
    for (const p of elementPoints(e)) addPt(b, p);
  }
  return b;
}

// ------------------------------------------------------------------ stairs
export function stairFrame(s: Stair) {
  const L = Math.max(1e-6, dist(s.a, s.b));
  const ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L;
  return { L, ux, uy, nx: -uy, ny: ux, hw: s.width / 2 };
}
export function stairFootprint(s: Stair): P[] {
  const { nx, ny, hw } = stairFrame(s);
  return [
    [s.a[0] + nx * hw, s.a[1] + ny * hw], [s.b[0] + nx * hw, s.b[1] + ny * hw],
    [s.b[0] - nx * hw, s.b[1] - ny * hw], [s.a[0] - nx * hw, s.a[1] - ny * hw],
  ];
}

// ------------------------------------------------------------------ seating
export const SEAT_DEPTH = 0.3;   // folded seat + back, the solid part of each row (m)

export function seatingFrame(s: Seating) {
  const c = Math.cos(s.angle), si = Math.sin(s.angle);
  const toWorld = (u: number, v: number): P => [s.origin[0] + u * c - v * si, s.origin[1] + u * si + v * c];
  const toLocal = (x: number, y: number): P => { const dx = x - s.origin[0], dy = y - s.origin[1]; return [dx * c + dy * si, -dx * si + dy * c]; };
  return { toWorld, toLocal };
}
export function seatingCorners(s: Seating): P[] {
  const { toWorld } = seatingFrame(s);
  return [toWorld(0, 0), toWorld(s.width, 0), toWorld(s.width, s.depth), toWorld(0, s.depth)];
}
/** Row spans (local u ranges) after cutting aisles. */
export function seatingSpans(s: Seating): [number, number][] {
  const W = s.width, aw = Math.min(s.aisleWidth, W / 3);
  switch (s.aisles) {
    case "both": return [[aw, W - aw]];
    case "left": return [[aw, W]];
    case "right": return [[0, W - aw]];
    case "center": return [[0, W / 2 - aw / 2], [W / 2 + aw / 2, W]];
    case "none": return [[0, W]];
  }
}
export interface SeatLayout { rows: { a: P; b: P }[]; seats: P[]; aisleSeat: boolean[]; sideWalls: { a: P; b: P }[]; capacity: number }
export function seatingLayout(s: Seating): SeatLayout {
  const { toWorld } = seatingFrame(s);
  const nRows = Math.max(1, Math.floor(s.depth / s.rowPitch + 1e-6));
  const rows: SeatLayout["rows"] = [], seats: P[] = [], aisleSeat: boolean[] = [];
  const spans = seatingSpans(s);
  for (let r = 0; r < nRows; r++) {
    const v0 = r * s.rowPitch;
    const vRow = v0 + s.rowPitch - SEAT_DEPTH / 2;      // centre line of the solid seat row
    const vSeat = v0 + (s.rowPitch - SEAT_DEPTH) / 2;    // where a person stands in the clearway
    for (const [u0, u1] of spans) {
      if (u1 - u0 < s.seatWidth) continue;
      rows.push({ a: toWorld(u0, vRow), b: toWorld(u1, vRow) });
      const n = Math.floor((u1 - u0) / s.seatWidth + 1e-6);
      const pad = (u1 - u0 - n * s.seatWidth) / 2;
      for (let k = 0; k < n; k++) {
        seats.push(toWorld(u0 + pad + (k + 0.5) * s.seatWidth, vSeat));
        aisleSeat.push((k === 0 && u0 > 1e-6) || (k === n - 1 && u1 < s.width - 1e-6));
      }
    }
  }
  const sideWalls: SeatLayout["sideWalls"] = [];
  const D = nRows * s.rowPitch;
  if (s.aisles === "left" || s.aisles === "none" || s.aisles === "center") sideWalls.push({ a: toWorld(s.width, 0.15), b: toWorld(s.width, D) });
  if (s.aisles === "right" || s.aisles === "none" || s.aisles === "center") sideWalls.push({ a: toWorld(0, 0.15), b: toWorld(0, D) });
  return { rows, seats, aisleSeat, sideWalls, capacity: seats.length };
}

// ------------------------------------------------------------------ attractors
export function serverPoints(a: Attractor): P[] {
  const px = -Math.sin(a.queueDir), py = Math.cos(a.queueDir);
  const out: P[] = [];
  for (let j = 0; j < a.servers; j++) { const o = (j - (a.servers - 1) / 2) * 0.9; out.push([a.p[0] + px * o, a.p[1] + py * o]); }
  return out;
}
export function queueSlot(a: Attractor, k: number): P {
  const dx = Math.cos(a.queueDir), dy = Math.sin(a.queueDir);
  // the queue snakes back and forth every 10 places so long queues stay compact
  const lane = Math.floor(k / 10), pos = k % 10;
  const along = lane % 2 === 0 ? pos : 9 - pos;
  const px = -dy, py = dx;
  const dd = 0.9 + 0.62 * along;
  return [a.p[0] + dx * dd + px * lane * 0.75, a.p[1] + dy * dd + py * lane * 0.75];
}

export function lengthOf(e: Element): number {
  if (e.kind === "door" || e.kind === "exit" || e.kind === "barrier") return dist(e.a, e.b);
  if (e.kind === "stair") return dist(e.a, e.b);
  if (e.kind === "wall") { let L = 0; for (let i = 1; i < e.pts.length; i++) L += dist(e.pts[i - 1], e.pts[i]); return L; }
  return 0;
}
