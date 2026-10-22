// Minimal ASCII DXF reader written for Flow: LINE, LWPOLYLINE, POLYLINE/VERTEX (with bulges), ARC, CIRCLE,
// and INSERT (block references, expanded recursively with scale / rotation / translation). Everything else
// (TEXT, DIMENSION, HATCH, splines…) is counted and skipped. Output stays in drawing units.
import type { Element, P } from "../model/types";
import { newElement } from "../model/defaults";

export interface DxfEntity {
  type: "LINE" | "POLYLINE" | "ARC" | "CIRCLE";
  layer: string;
  pts: P[];
  closed: boolean;
  center?: P; radius?: number; a0?: number; a1?: number;   // ARC / CIRCLE (degrees)
}
export interface DxfDoc {
  entities: DxfEntity[];
  layers: Record<string, { count: number; types: Record<string, number> }>;
  units: number;               // $INSUNITS (0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m)
  skipped: Record<string, number>;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

type Pair = [number, string];
type Raw = { type: string; g: Pair[] };

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (isNaN(c)) { i -= 1; continue; }   // resync on stray blank lines
    out.push([c, lines[i + 1].trim()]);
  }
  return out;
}

const num = (g: Pair[], code: number, def = 0) => { const p = g.find((q) => q[0] === code); return p ? parseFloat(p[1]) : def; };
const str = (g: Pair[], code: number, def = "") => g.find((q) => q[0] === code)?.[1] ?? def;

function bulgeArc(a: P, b: P, bulge: number, out: P[]) {
  // bulge = tan(θ/4); θ = included angle, positive = counter-clockwise
  const th = 4 * Math.atan(bulge);
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (chord < 1e-12) return;
  const r = chord / (2 * Math.sin(Math.abs(th) / 2));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) / chord, dy = (b[1] - a[1]) / chord;
  const sag = r * Math.cos(th / 2) * Math.sign(bulge);
  const cx = mx - dy * sag, cy = my + dx * sag;
  const s0 = Math.atan2(a[1] - cy, a[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(th) / (Math.PI / 18)));
  for (let k = 1; k < n; k++) { const t = s0 + (th * k) / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
}

function arcPts(c: P, r: number, a0: number, a1: number): P[] {
  let s = (a0 * Math.PI) / 180, e = (a1 * Math.PI) / 180;
  while (e <= s) e += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((e - s) / (Math.PI / 24)));
  const out: P[] = [];
  for (let k = 0; k <= n; k++) { const t = s + ((e - s) * k) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
}

export function parseDXF(text: string): DxfDoc {
  const P_ = pairs(text);
  let units = 0;
  const blocks = new Map<string, { base: P; ents: Raw[] }>();
  const top: Raw[] = [];
  let i = 0;
  let section = "";
  let curBlock: { name: string; base: P; ents: Raw[] } | null = null;
  const readEntity = (): Raw => {
    const type = P_[i][1];
    const g: Pair[] = [];
    i++;
    while (i < P_.length && P_[i][0] !== 0) { g.push(P_[i]); i++; }
    return { type, g };
  };
  while (i < P_.length) {
    const [c, v] = P_[i];
    if (c === 0 && v === "SECTION") { section = P_[i + 1]?.[1] ?? ""; i += 2; continue; }
    if (c === 0 && v === "ENDSEC") { section = ""; i++; continue; }
    if (c === 0 && v === "EOF") break;
    if (section === "HEADER") {
      if (c === 9 && v === "$INSUNITS") { units = parseInt(P_[i + 1]?.[1] ?? "0", 10) || 0; i += 2; continue; }
      i++; continue;
    }
    if (section === "BLOCKS" && c === 0) {
      if (v === "BLOCK") { const e = readEntity(); curBlock = { name: str(e.g, 2), base: [num(e.g, 10), num(e.g, 20)], ents: [] }; continue; }
      if (v === "ENDBLK") { if (curBlock) blocks.set(curBlock.name, { base: curBlock.base, ents: curBlock.ents }); curBlock = null; readEntity(); continue; }
      const e = readEntity();
      curBlock?.ents.push(e);
      continue;
    }
    if (section === "ENTITIES" && c === 0) { top.push(readEntity()); continue; }
    i++;
  }

  const entities: DxfEntity[] = [];
  const skipped: Record<string, number> = {};
  type Xf = (p: P) => P;
  const ident: Xf = (p) => p;
  const emit = (raws: Raw[], xf: Xf, scaleAbs: number, mirror: boolean, inheritLayer: string | null, depth: number) => {
    for (let k = 0; k < raws.length; k++) {
      const r = raws[k];
      let layer = str(r.g, 8, "0");
      if (inheritLayer && layer === "0") layer = inheritLayer;
      const ocsFlip = num(r.g, 230, 1) < 0;
      const ocs = (p: P): P => (ocsFlip ? [-p[0], p[1]] : p);
      switch (r.type) {
        case "LINE":
          entities.push({ type: "LINE", layer, closed: false, pts: [xf([num(r.g, 10), num(r.g, 20)]), xf([num(r.g, 11), num(r.g, 21)])] });
          break;
        case "LWPOLYLINE": {
          const pts: P[] = [];
          const closed = (num(r.g, 70) & 1) === 1;
          const verts: { p: P; bulge: number }[] = [];
          for (const [cc, vv] of r.g) {
            if (cc === 10) verts.push({ p: [parseFloat(vv), 0], bulge: 0 });
            else if (cc === 20 && verts.length) verts[verts.length - 1].p[1] = parseFloat(vv);
            else if (cc === 42 && verts.length) verts[verts.length - 1].bulge = parseFloat(vv);
          }
          verts.forEach((vt, j) => {
            pts.push(vt.p);
            const nxt = verts[j + 1] ?? (closed ? verts[0] : null);
            if (nxt && Math.abs(vt.bulge) > 1e-9) bulgeArc(vt.p, nxt.p, ocsFlip ? -vt.bulge : vt.bulge, pts);
          });
          entities.push({ type: "POLYLINE", layer, closed, pts: pts.map((p) => xf(ocs(p))) });
          break;
        }
        case "POLYLINE": {
          const closed = (num(r.g, 70) & 1) === 1;
          const verts: { p: P; bulge: number }[] = [];
          while (k + 1 < raws.length && raws[k + 1].type === "VERTEX") { k++; const vg = raws[k].g; verts.push({ p: [num(vg, 10), num(vg, 20)], bulge: num(vg, 42) }); }
          if (k + 1 < raws.length && raws[k + 1].type === "SEQEND") k++;
          const pts: P[] = [];
          verts.forEach((vt, j) => {
            pts.push(vt.p);
            const nxt = verts[j + 1] ?? (closed ? verts[0] : null);
            if (nxt && Math.abs(vt.bulge) > 1e-9) bulgeArc(vt.p, nxt.p, vt.bulge, pts);
          });
          if (pts.length >= 2) entities.push({ type: "POLYLINE", layer, closed, pts: pts.map((p) => xf(ocs(p))) });
          break;
        }
        case "ARC": {
          const c0 = ocs([num(r.g, 10), num(r.g, 20)]), rad = num(r.g, 40);
          let a0 = num(r.g, 50), a1 = num(r.g, 51);
          if (ocsFlip) { const t = 180 - a1; a1 = 180 - a0; a0 = t; }
          const pts = arcPts(c0, rad, a0, a1).map(xf);
          entities.push({ type: "ARC", layer, closed: false, pts, center: xf(c0), radius: rad * scaleAbs, a0, a1 });
          if (mirror) entities[entities.length - 1].pts.reverse();
          break;
        }
        case "CIRCLE": {
          const c0 = ocs([num(r.g, 10), num(r.g, 20)]), rad = num(r.g, 40);
          const pts = arcPts(c0, rad, 0, 360).slice(0, -1).map(xf);
          entities.push({ type: "CIRCLE", layer, closed: true, pts, center: xf(c0), radius: rad * scaleAbs });
          break;
        }
        case "INSERT": {
          const b = blocks.get(str(r.g, 2));
          if (!b || depth > 8) { skipped.INSERT = (skipped.INSERT ?? 0) + 1; break; }
          const ins: P = [num(r.g, 10), num(r.g, 20)];
          const sx = num(r.g, 41, 1), sy = num(r.g, 42, 1), rot = (num(r.g, 50) * Math.PI) / 180;
          const cr = Math.cos(rot), sr = Math.sin(rot);
          const local: Xf = (p) => {
            const x = (p[0] - b.base[0]) * sx, y = (p[1] - b.base[1]) * sy;
            return [ins[0] + x * cr - y * sr, ins[1] + x * sr + y * cr];
          };
          emit(b.ents, (p) => xf(local(p)), scaleAbs * Math.sqrt(Math.abs(sx * sy)), mirror !== (sx * sy < 0), layer, depth + 1);
          break;
        }
        case "VERTEX": case "SEQEND": case "ATTRIB": case "ATTDEF": break;
        default: skipped[r.type] = (skipped[r.type] ?? 0) + 1;
      }
    }
  };
  emit(top, ident, 1, false, null, 0);

  const layers: DxfDoc["layers"] = {};
  const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const e of entities) {
    const L = (layers[e.layer] ??= { count: 0, types: {} });
    L.count++; L.types[e.type] = (L.types[e.type] ?? 0) + 1;
    for (const p of e.pts) { bbox.x0 = Math.min(bbox.x0, p[0]); bbox.y0 = Math.min(bbox.y0, p[1]); bbox.x1 = Math.max(bbox.x1, p[0]); bbox.y1 = Math.max(bbox.y1, p[1]); }
  }
  return { entities, layers, units, skipped, bbox };
}

export const UNIT_SCALE: Record<number, number> = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 13: 1e-6, 14: 0.1 };
export const UNIT_NAME: Record<number, string> = { 0: "unitless", 1: "inches", 2: "feet", 4: "millimetres", 5: "centimetres", 6: "metres", 14: "decimetres" };

/** Suggested metres-per-drawing-unit for a document (from $INSUNITS, else from the extents). */
export function guessScale(d: DxfDoc): number {
  if (UNIT_SCALE[d.units]) return UNIT_SCALE[d.units];
  const span = Math.max(d.bbox.x1 - d.bbox.x0, d.bbox.y1 - d.bbox.y0);
  return span > 2000 ? 0.001 : span > 300 ? 0.01 : 1;
}

export type Role = "ignore" | "walls" | "obstacles" | "doors" | "exits" | "stairs" | "seating" | "spawn" | "barriers";
export const ROLES: Role[] = ["ignore", "walls", "obstacles", "doors", "exits", "stairs", "seating", "spawn", "barriers"];

/** Guess a role from common layer naming conventions (AIA / NCS, plain English). */
export function guessRole(layer: string): Role {
  const s = layer.toUpperCase();
  if (/WALL|MURS?|PARTITION|^A-W|CORE|STRUCT|COLS?$|COLUMN/.test(s)) return /COL/.test(s) ? "obstacles" : "walls";
  if (/EXIT|EGRESS|SORTIE/.test(s)) return "exits";
  if (/DOOR|PORTE|^A-D/.test(s)) return "doors";
  if (/STAIR|ESCAL|RAMP/.test(s)) return "stairs";
  if (/SEAT|CHAIR|BLEACH|SIEGE/.test(s)) return "seating";
  if (/FURN|EQUIP|OBST|COUNTER|FIXT|CASEWORK|MILLWORK/.test(s)) return "obstacles";
  if (/SPAWN|OCCUP|CROWD|POP/.test(s)) return "spawn";
  if (/BARRIER|TURNSTILE|ONEWAY/.test(s)) return "barriers";
  return "ignore";
}

export interface DxfImportOpts { scale: number; level: string; origin?: P; toLevel?: string }

export function dxfToElements(d: DxfDoc, mapping: Record<string, Role>, o: DxfImportOpts): { elements: Element[]; warnings: string[] } {
  const ox = o.origin?.[0] ?? 0, oy = o.origin?.[1] ?? 0;
  const T = (p: P): P => [+((p[0] - ox) * o.scale).toFixed(4), +((p[1] - oy) * o.scale).toFixed(4)];
  const out: Element[] = [];
  const warnings: string[] = [];
  const L = o.level;
  const walls: [P, P][] = [];
  // walls first so door arcs can be matched against them
  const ents = [...d.entities].sort((a, b) => (mapping[a.layer] === "walls" ? 0 : 1) - (mapping[b.layer] === "walls" ? 0 : 1));
  for (const e of ents) {
    const role = mapping[e.layer] ?? "ignore";
    if (role === "ignore") continue;
    const pts = e.pts.map(T);
    switch (role) {
      case "walls":
        out.push(newElement("wall", L, { pts, closed: e.closed, thickness: 0.15 }));
        for (let k = 1; k < pts.length; k++) walls.push([pts[k - 1], pts[k]]);
        if (e.closed && pts.length > 2) walls.push([pts[pts.length - 1], pts[0]]);
        break;
      case "obstacles":
        if (e.closed && pts.length >= 3) out.push(newElement("obstacle", L, { pts }));
        else out.push(newElement("wall", L, { pts, closed: false, thickness: 0.1 }));
        break;
      case "exits": case "barriers": case "doors": {
        const kind = role === "exits" ? "exit" : role === "barriers" ? "barrier" : "door";
        if (e.type === "ARC" && e.center && e.radius) {
          if (kind !== "door") break;
          const c = T(e.center);
          const cand = [pts[0], pts[pts.length - 1]];
          const near = (p: P) => Math.min(Infinity, ...walls.map(([a, b]) => segDistP(p, a, b)));
          const closedEnd = near(cand[0]) <= near(cand[1]) ? cand[0] : cand[1];
          out.push(newElement("door", L, { a: c, b: closedEnd }));
        } else if (e.type === "LINE" || (!e.closed && kind === "door")) {
          out.push(newElement(kind, L, { a: pts[0], b: pts[pts.length - 1] }));
        } else {
          for (let k = 1; k < pts.length; k++) out.push(newElement(kind, L, { a: pts[k - 1], b: pts[k] }));
        }
        break;
      }
      case "stairs": {
        if (pts.length < 4 || !e.closed) { warnings.push(`Stair on layer ${e.layer} is not a closed outline — skipped`); break; }
        const r = minRect(pts);
        out.push(newElement("stair", L, { a: r.a, b: r.b, width: +r.w.toFixed(3), toLevel: o.toLevel ?? L, name: "Stair (DXF)" }));
        break;
      }
      case "seating": {
        if (pts.length < 4 || !e.closed) break;
        const e1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const e2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
        if (e1 < 1 || e2 < 0.8) break;
        out.push(newElement("seating", L, { origin: pts[0], width: +e1.toFixed(3), depth: +e2.toFixed(3), angle: Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]), name: "Seating (DXF)" }));
        break;
      }
      case "spawn":
        if (pts.length >= 3 && e.closed) out.push(newElement("spawn", L, { pts, name: `Spawn (${e.layer})` }));
        break;
    }
  }
  if (out.some((e) => e.kind === "stair")) warnings.push("Stairs imported on the current level: set each stair's target level and direction in Properties.");
  return { elements: out, warnings };
}

function segDistP(p: P, a: P, b: P) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** Minimum-area bounding rectangle (rotating edges) → centreline a→b along the long side and the width. */
function minRect(pts: P[]): { a: P; b: P; w: number } {
  let best = { area: Infinity, a: pts[0], b: pts[1], w: 1 };
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k], q = pts[(k + 1) % pts.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 1e-9) continue;
    const ux = (q[0] - p[0]) / L, uy = (q[1] - p[1]) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const r of pts) { const u = r[0] * ux + r[1] * uy, v = -r[0] * uy + r[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const long = u1 - u0 >= v1 - v0;
      const W = (u: number, v: number): P => [u * ux - v * uy, u * uy + v * ux];
      const vm = (v0 + v1) / 2, um = (u0 + u1) / 2;
      best = long ? { area, a: W(u0, vm), b: W(u1, vm), w: v1 - v0 } : { area, a: W(um, v0), b: W(um, v1), w: u1 - u0 };
    }
  }
  return { a: best.a, b: best.b, w: best.w };
}
