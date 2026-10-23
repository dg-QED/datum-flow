// Canvas 2D drawing of the plan, overlays and (fallback) agents. Used by the live top view, the video
// recorder and the PDF report, so the three always look the same.
import type { Element, P, Project } from "../model/types";
import { seatingLayout, stairFrame, stairFootprint, serverPoints, queueSlot } from "../model/geom";
import { LOS_TABLE, losIndex } from "../model/defaults";
import { C, KIND_COLOR, congestionColor, densityColor, losRgb, usageColor } from "./palette";
import type { Overlay } from "../store";
import type { LevelInfo } from "../sim/protocol";

export interface ViewT { cx: number; cy: number; scale: number; w: number; h: number }
export const toScreen = (v: ViewT, x: number, y: number): [number, number] => [(x - v.cx) * v.scale + v.w / 2, v.h / 2 - (y - v.cy) * v.scale];
export const toWorld = (v: ViewT, sx: number, sy: number): P => [(sx - v.w / 2) / v.scale + v.cx, (v.h / 2 - sy) / v.scale + v.cy];

export interface Theme { bg: string; grid: string; grid2: string; wall: string; text: string; textDim: string; print: boolean }
export const DARK: Theme = { bg: C.bg, grid: C.grid, grid2: C.grid2, wall: C.wall, text: C.ink2, textDim: C.ink3, print: false };
export const PRINT: Theme = { bg: "#ffffff", grid: "#eef0f2", grid2: "#dde1e5", wall: "#1d232a", text: "#2b3138", textDim: "#6f7983", print: true };

export interface PlanOpts {
  level: string;
  ghost: boolean;
  selection?: Set<string>;
  closed?: Set<string>;
  labels?: boolean;
  theme?: Theme;
  showGrid?: boolean;
  gridSize?: number;
  doorsOpen?: Map<string, boolean>;
  running?: boolean;
}

function path(ctx: CanvasRenderingContext2D, v: ViewT, pts: P[], close = false) {
  ctx.beginPath();
  pts.forEach((p, i) => { const [x, y] = toScreen(v, p[0], p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  if (close) ctx.closePath();
}

export function drawGrid(ctx: CanvasRenderingContext2D, v: ViewT, theme: Theme, step = 1) {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, v.w, v.h);
  // choose a grid step that stays ≥ 12 px apart
  let s = step;
  while (s * v.scale < 12) s *= s < 1 ? 2 : 5;
  const [x0, y1] = toWorld(v, 0, 0), [x1, y0] = toWorld(v, v.w, v.h);
  ctx.lineWidth = 1;
  for (const [st, col] of [[s, theme.grid], [s * 5, theme.grid2]] as const) {
    ctx.strokeStyle = col;
    ctx.beginPath();
    for (let x = Math.floor(x0 / st) * st; x <= x1; x += st) { const [sx] = toScreen(v, x, 0); ctx.moveTo(Math.round(sx) + 0.5, 0); ctx.lineTo(Math.round(sx) + 0.5, v.h); }
    for (let y = Math.floor(y0 / st) * st; y <= y1; y += st) { const [, sy] = toScreen(v, 0, y); ctx.moveTo(0, Math.round(sy) + 0.5); ctx.lineTo(v.w, Math.round(sy) + 0.5); }
    ctx.stroke();
  }
}

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, ang: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - s * Math.cos(ang - 0.45), y - s * Math.sin(ang - 0.45));
  ctx.moveTo(x, y);
  ctx.lineTo(x - s * Math.cos(ang + 0.45), y - s * Math.sin(ang + 0.45));
  ctx.stroke();
}

export function drawElement(ctx: CanvasRenderingContext2D, v: ViewT, e: Element, o: { ghost?: boolean; selected?: boolean; closed?: boolean; theme: Theme; labels?: boolean; underside?: boolean; open?: boolean; faint?: boolean }) {
  const th = o.theme;
  const k = v.scale;
  const col = o.ghost ? th.textDim : e.kind === "wall" ? th.wall : KIND_COLOR[e.kind];
  ctx.save();
  ctx.globalAlpha = o.ghost ? 0.22 : o.faint ? 0.35 : 1;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  switch (e.kind) {
    case "wall": {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.5, e.thickness * k);
      path(ctx, v, e.pts, e.closed);
      ctx.stroke();
      break;
    }
    case "obstacle": {
      path(ctx, v, e.pts, true);
      ctx.fillStyle = th.print ? "#c8cdd2" : "#2a323a";
      ctx.fill();
      ctx.strokeStyle = th.print ? "#59636d" : col;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      break;
    }
    case "door": case "exit": case "barrier": {
      const [ax, ay] = toScreen(v, e.a[0], e.a[1]), [bx, by] = toScreen(v, e.b[0], e.b[1]);
      const closed = o.closed || ("closed" in e && e.closed);
      const c = closed ? C.exitClosed : col;
      ctx.strokeStyle = c;
      ctx.lineWidth = e.kind === "exit" ? Math.max(3, 0.25 * k) : Math.max(2, 0.12 * k);
      if (e.kind === "door" && !closed) ctx.setLineDash([Math.max(3, 0.25 * k), Math.max(2, 0.12 * k)]);
      if (e.kind === "door" && o.open === false) { ctx.strokeStyle = "#ff8a5b"; ctx.setLineDash([]); }
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, L = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / L, ny = -(bx - ax) / L;   // screen-space right normal of a→b
      if (e.kind === "barrier") {
        // arrows show the permitted crossing (left → right of a→b)
        ctx.lineWidth = 1.6;
        const s = Math.max(5, Math.min(12, 0.5 * k));
        for (const t of [0.25, 0.5, 0.75]) {
          const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
          ctx.beginPath(); ctx.moveTo(px - nx * s, py - ny * s); ctx.lineTo(px + nx * s, py + ny * s); ctx.stroke();
          arrowHead(ctx, px + nx * s, py + ny * s, Math.atan2(ny, nx), s * 0.6);
        }
      }
      if (e.kind === "exit" && !closed && k > 3) {
        ctx.lineWidth = 1.4;
        const s = Math.max(6, Math.min(14, 0.6 * k));
        ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
        void s;
      }
      if (closed && k > 3) {
        ctx.lineWidth = 1.6;
        const s = Math.max(4, 0.25 * k);
        ctx.beginPath(); ctx.moveTo(mx - s, my - s); ctx.lineTo(mx + s, my + s); ctx.moveTo(mx + s, my - s); ctx.lineTo(mx - s, my + s); ctx.stroke();
      }
      break;
    }
    case "stair": {
      const fp = stairFootprint(e);
      if (o.underside) {
        path(ctx, v, fp, true);
        ctx.fillStyle = th.print ? "#dde6ef" : "#16222e";
        ctx.fill();
        ctx.setLineDash([4, 3]); ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
        break;
      }
      path(ctx, v, fp, true);
      ctx.fillStyle = th.print ? "#e7f1fb" : "rgba(124,196,255,0.10)";
      ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
      // treads every 0.28 m
      const f = stairFrame(e);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      if (!e.ramp) for (let d = 0.28; d < f.L; d += 0.28) {
        const p0: P = [e.a[0] + f.ux * d + f.nx * f.hw, e.a[1] + f.uy * d + f.ny * f.hw], p1: P = [e.a[0] + f.ux * d - f.nx * f.hw, e.a[1] + f.uy * d - f.ny * f.hw];
        const [x0, y0] = toScreen(v, p0[0], p0[1]), [x1, y1] = toScreen(v, p1[0], p1[1]);
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
      ctx.stroke();
      // run arrow a → b
      const [ax, ay] = toScreen(v, e.a[0], e.a[1]), [bx, by] = toScreen(v, e.b[0], e.b[1]);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      arrowHead(ctx, bx, by, Math.atan2(by - ay, bx - ax), Math.max(6, 0.4 * k));
      break;
    }
    case "seating": {
      const lay = seatingLayout(e);
      const corners = [lay.rows[0]?.a ?? e.origin];
      void corners;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, 0.3 * k);
      ctx.globalAlpha *= 0.75;
      ctx.beginPath();
      for (const r of lay.rows) { const [x0, y0] = toScreen(v, r.a[0], r.a[1]), [x1, y1] = toScreen(v, r.b[0], r.b[1]); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
      ctx.stroke();
      ctx.globalAlpha /= 0.75;
      ctx.lineWidth = Math.max(1, 0.1 * k);
      ctx.beginPath();
      for (const r of lay.sideWalls) { const [x0, y0] = toScreen(v, r.a[0], r.a[1]), [x1, y1] = toScreen(v, r.b[0], r.b[1]); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
      ctx.stroke();
      const { toWorld: tw } = { toWorld: (u: number, w: number): P => [e.origin[0] + u * Math.cos(e.angle) - w * Math.sin(e.angle), e.origin[1] + u * Math.sin(e.angle) + w * Math.cos(e.angle)] };
      path(ctx, v, [tw(0, 0), tw(e.width, 0), tw(e.width, e.depth), tw(0, e.depth)], true);
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = th.print ? "#9aa4ad" : "#3a434c"; ctx.stroke(); ctx.setLineDash([]);
      // front edge marker
      const [f0x, f0y] = toScreen(v, ...tw(0, 0)), [f1x, f1y] = toScreen(v, ...tw(e.width, 0));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(f0x, f0y); ctx.lineTo(f1x, f1y); ctx.stroke();
      break;
    }
    case "spawn": {
      path(ctx, v, e.pts, true);
      ctx.fillStyle = e.arrivals ? "rgba(199,166,255,0.08)" : "rgba(124,196,255,0.08)";
      if (th.print) ctx.fillStyle = "rgba(90,169,230,0.10)";
      ctx.fill();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = e.arrivals ? C.attractor : col; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case "attractor": {
      const sv = serverPoints(e);
      ctx.strokeStyle = col; ctx.fillStyle = col;
      // queue direction hint
      const q0 = queueSlot(e, 0), q5 = queueSlot(e, 6);
      const [qx0, qy0] = toScreen(v, q0[0], q0[1]), [qx1, qy1] = toScreen(v, q5[0], q5[1]);
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(qx0, qy0); ctx.lineTo(qx1, qy1); ctx.stroke(); ctx.setLineDash([]);
      for (const p of sv) { const [x, y] = toScreen(v, p[0], p[1]); ctx.beginPath(); ctx.rect(x - 2.5, y - 2.5, 5, 5); ctx.fill(); }
      const [x, y] = toScreen(v, e.p[0], e.p[1]);
      ctx.beginPath(); ctx.arc(x, y, Math.max(5, 0.45 * k), 0, Math.PI * 2);
      ctx.lineWidth = 2; ctx.stroke();
      ctx.font = `600 ${Math.max(9, Math.min(12, 0.5 * k))}px "JetBrains Mono", monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(({ concession: "F", washroom: "W", gate: "G", info: "i", other: "•" } as const)[e.type], x, y + 0.5);
      break;
    }
  }
  if (o.selected) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = C.sel; ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    const pts = e.kind === "wall" || e.kind === "obstacle" || e.kind === "spawn" ? e.pts
      : e.kind === "stair" ? stairFootprint(e)
      : e.kind === "seating" ? [[e.origin[0], e.origin[1]], ...[[e.width, 0], [e.width, e.depth], [0, e.depth]].map(([u, w]) => [e.origin[0] + u * Math.cos(e.angle) - w * Math.sin(e.angle), e.origin[1] + u * Math.sin(e.angle) + w * Math.cos(e.angle)] as P)] as P[]
      : e.kind === "attractor" ? [] : [e.a, e.b];
    if (pts.length) { path(ctx, v, pts, e.kind !== "wall" && e.kind !== "door" && e.kind !== "exit" && e.kind !== "barrier" || (e.kind === "wall" && e.closed)); ctx.stroke(); }
    if (e.kind === "attractor") { const [x, y] = toScreen(v, e.p[0], e.p[1]); ctx.beginPath(); ctx.arc(x, y, Math.max(9, 0.8 * k), 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

export function labelFor(e: Element): string | null {
  if (!e.name) return null;
  if (e.kind === "exit" || e.kind === "attractor" || e.kind === "stair" || e.kind === "seating" || e.kind === "spawn") return e.name;
  if (e.kind === "door" && /vom|gate|stair/i.test(e.name)) return e.name;
  return null;
}
function anchor(e: Element): P | null {
  switch (e.kind) {
    case "exit": case "door": return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    case "attractor": return e.p;
    case "stair": return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
    case "seating": { const u = e.width / 2, w = e.depth / 2; return [e.origin[0] + u * Math.cos(e.angle) - w * Math.sin(e.angle), e.origin[1] + u * Math.sin(e.angle) + w * Math.cos(e.angle)]; }
    case "spawn": { let x = 0, y = 0; for (const p of e.pts) { x += p[0]; y += p[1]; } return [x / e.pts.length, y / e.pts.length]; }
    default: return null;
  }
}

export function drawPlan(ctx: CanvasRenderingContext2D, v: ViewT, p: Project, o: PlanOpts) {
  const th = o.theme ?? DARK;
  const order: Element["kind"][] = ["spawn", "seating", "obstacle", "stair", "wall", "barrier", "door", "exit", "attractor"];
  if (o.ghost) {
    for (const e of p.elements) if (e.level !== o.level && (e.kind === "wall" || e.kind === "obstacle")) drawElement(ctx, v, e, { ghost: true, theme: th });
  }
  const mine = p.elements.filter((e) => e.level === o.level);
  for (const k of order) for (const e of mine) if (e.kind === k) drawElement(ctx, v, e, { selected: o.selection?.has(e.id), closed: o.closed?.has(e.id), theme: th, open: o.doorsOpen?.get(e.id), faint: o.running && e.kind === "spawn" && !o.selection?.has(e.id) });
  // stairs arriving on this level from another one: draw their footprint as the underside
  for (const e of p.elements) if (e.kind === "stair" && e.toLevel === o.level && e.level !== o.level) drawElement(ctx, v, e, { underside: true, theme: th, selected: o.selection?.has(e.id) });
  if (o.labels !== false) drawLabels(ctx, v, p, o.level, th, o.selection);
}

export function drawLabels(ctx: CanvasRenderingContext2D, v: ViewT, p: Project, level: string, th: Theme, selection?: Set<string>) {
  ctx.save();
  ctx.font = `500 11px "Inter Tight", system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const placed: [number, number, number, number][] = [];
  for (const e of p.elements) {
    if (e.level !== level) continue;
    const t = labelFor(e);
    if (!t) continue;
    if (v.scale < 4 && e.kind !== "exit" && !selection?.has(e.id)) continue;
    if (e.kind === "spawn" && v.scale < 10) continue;
    const a = anchor(e);
    if (!a) continue;
    let [x, y] = toScreen(v, a[0], a[1]);
    if (e.kind === "attractor") y -= Math.max(12, 0.9 * v.scale);
    if (e.kind === "exit") y -= 12;
    const w = ctx.measureText(t).width + 8;
    const box: [number, number, number, number] = [x - w / 2, y - 8, x + w / 2, y + 8];
    if (placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
    if (box[2] < 0 || box[0] > v.w || box[3] < 0 || box[1] > v.h) continue;
    placed.push(box);
    ctx.fillStyle = th.print ? "rgba(255,255,255,0.85)" : "rgba(14,17,20,0.78)";
    ctx.fillRect(box[0], box[1], w, 16);
    ctx.fillStyle = e.kind === "exit" ? (th.print ? "#1f7a4a" : C.exit) : th.text;
    ctx.fillText(t, x, y + 0.5);
  }
  ctx.restore();
}

// ------------------------------------------------------------------ overlays
const overlayCache = new Map<string, HTMLCanvasElement>();
export function overlayCanvas(mode: Overlay, li: number, L: LevelInfo, data: { density?: Uint8Array; max?: Float32Array; cong?: Float32Array; occ?: Float32Array }, std: Parameters<typeof losIndex>[1], version: string): HTMLCanvasElement | null {
  const key = `${mode}:${li}:${std}`;
  const { nx, ny } = L.dens;
  let cv = overlayCache.get(key);
  if (cv && cv.dataset.v === version) return cv;
  if (!cv) { cv = document.createElement("canvas"); overlayCache.set(key, cv); }
  cv.width = nx; cv.height = ny;
  const g = cv.getContext("2d")!;
  const img = g.createImageData(nx, ny);
  const px = img.data;
  let mx = 0;
  if (mode === "congestion" && data.cong) for (const v of data.cong) mx = Math.max(mx, v);
  if (mode === "usage" && data.occ) for (const v of data.occ) mx = Math.max(mx, v);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i, o = ((ny - 1 - j) * nx + i) * 4;
    let rgb: [number, number, number] | null = null, a = 0;
    if (mode === "density" && data.density) { const d = data.density[c] / 20; if (d > 0.05) { rgb = densityColor(d); a = Math.min(220, 90 + d * 40); } }
    else if (mode === "los" && data.density) { const d = data.density[c] / 20; if (d > 0.05) { rgb = losRgb(losIndex(d, std)); a = 190; } }
    else if (mode === "maxdensity" && data.max) { const d = data.max[c]; if (d > 0.05) { rgb = losRgb(losIndex(d, std)); a = 200; } }
    else if (mode === "congestion" && data.cong) { const s = data.cong[c]; if (s > 0) { rgb = congestionColor(s, mx); a = 200; } }
    else if (mode === "usage" && data.occ) { const s = data.occ[c]; if (s > 0) { rgb = usageColor(s, mx); a = 190; } }
    if (rgb) { px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = a; }
  }
  g.putImageData(img, 0, 0);
  cv.dataset.v = version;
  cv.dataset.max = String(mx);
  return cv;
}
export function drawOverlay(ctx: CanvasRenderingContext2D, v: ViewT, cv: HTMLCanvasElement, L: LevelInfo, smooth: boolean) {
  const { nx, ny, cs, x0, y0 } = L.dens;
  const [sx, sy] = toScreen(v, x0, y0 + ny * cs);
  ctx.save();
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(cv, sx, sy, nx * cs * v.scale, ny * cs * v.scale);
  ctx.restore();
}

export const LOS_NOTE = (std: keyof typeof LOS_TABLE) => LOS_TABLE[std].source;

export function fitView(p: Project, level: string, w: number, h: number, pad = 30): ViewT {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of p.elements) {
    if (e.level !== level && !(e.kind === "stair" && e.toLevel === level)) continue;
    const pts: P[] = e.kind === "wall" || e.kind === "obstacle" || e.kind === "spawn" ? e.pts : e.kind === "attractor" ? [e.p] : e.kind === "seating" ? [e.origin, [e.origin[0] + e.width * Math.cos(e.angle) - e.depth * Math.sin(e.angle), e.origin[1] + e.width * Math.sin(e.angle) + e.depth * Math.cos(e.angle)]] : e.kind === "stair" ? stairFootprint(e) : [e.a, e.b];
    for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 40; y1 = 30; }
  // side gutters keep the tool rail and zoom buttons off the drawing in the live view
  const side = pad >= 30 && w > 500 ? 60 : pad;
  const scale = Math.max(0.5, Math.min((w - 2 * side) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0)));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale, w, h };
}
