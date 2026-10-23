// Mutable simulation buffers shared by the renderers (2D, 3D, video, report). Kept out of React state.
import type { Frame, KeyFrame, WorldInfo } from "./sim/protocol";
import { Q } from "./sim/protocol";

export const live = {
  info: null as WorldInfo | null,
  frame: null as Frame | null,
  keys: [] as KeyFrame[],
  density: [] as Uint8Array[],        // latest density per level (p/m² × 20)
  maxDensity: [] as Float32Array[],   // running max (p/m²) per level
  congestion: [] as Float32Array[],   // seconds at or above the congestion threshold
  occupancy: [] as Float32Array[],    // person-seconds per density cell (usage heatmap)
  doorsOpen: null as Uint8Array | null,
  lastT: 0,
  version: 0,                         // bumps on every new frame
  densVersion: 0,
};

const listeners = new Set<() => void>();
export const onLive = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const bumpLive = () => { live.version++; listeners.forEach((f) => f()); };

export function resetLive(info: WorldInfo | null) {
  live.info = info;
  live.frame = null;
  live.keys = [];
  live.lastT = 0;
  const L = info?.levels ?? [];
  live.density = L.map((l) => new Uint8Array(l.dens.nx * l.dens.ny));
  live.maxDensity = L.map((l) => new Float32Array(l.dens.nx * l.dens.ny));
  live.congestion = L.map((l) => new Float32Array(l.dens.nx * l.dens.ny));
  live.occupancy = L.map((l) => new Float32Array(l.dens.nx * l.dens.ny));
  live.doorsOpen = null;
  live.version++; live.densVersion++;
}

export function ingestFrame(f: Frame, congestionDensity: number) {
  const info = live.info;
  const dt = Math.max(0, f.t - live.lastT);
  live.lastT = f.t;
  live.frame = f;
  if (f.doorsOpen) live.doorsOpen = f.doorsOpen;
  if (f.density && info) {
    f.density.forEach((d, li) => {
      live.density[li] = d;
      const M = live.maxDensity[li], C = live.congestion[li];
      for (let c = 0; c < d.length; c++) {
        const v = d[c] / 20;
        if (v > M[c]) M[c] = v;
        if (v >= congestionDensity) C[c] += f.densDt ?? 0;
      }
    });
    live.densVersion++;
  }
  if (info && dt > 0 && dt < 5) {
    for (let i = 0; i < f.x.length; i++) {
      const s = f.st[i];
      if (s === 0 || s === 5 || s === 6) continue;
      const D = info.levels[f.lvl[i]]?.dens;
      if (!D) continue;
      const ci = Math.floor((f.x[i] - D.x0) / D.cs), cj = Math.floor((f.y[i] - D.y0) / D.cs);
      if (ci >= 0 && cj >= 0 && ci < D.nx && cj < D.ny) live.occupancy[f.lvl[i]][cj * D.nx + ci] += dt;
    }
  }
  bumpLive();
}

/** Positions at time t from the recorded keyframes (linear interpolation between seconds). */
export function frameAt(t: number): { x: Float32Array; y: Float32Array; z: Float32Array; lvl: Uint8Array; st: Uint8Array } | null {
  const K = live.keys;
  if (!K.length || !live.info) return null;
  let lo = 0, hi = K.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (K[m].t <= t) lo = m; else hi = m - 1; }
  const a = K[lo], b = K[Math.min(K.length - 1, lo + 1)];
  const u = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 0;
  const n = a.x.length, [ox, oy] = live.info.origin;
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const same = a.lvl[i] === b.lvl[i];
    const w = same ? u : 0;
    x[i] = ox + ((1 - w) * a.x[i] + w * b.x[i]) / Q;
    y[i] = oy + ((1 - w) * a.y[i] + w * b.y[i]) / Q;
    z[i] = ((1 - w) * a.z[i] + w * b.z[i]) / Q - 100;
  }
  return { x, y, z, lvl: a.lvl, st: u > 0.5 ? b.st : a.st };
}
