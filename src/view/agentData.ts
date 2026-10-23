// Turn a frame (live or scrubbed) into per-agent draw buffers for one level.
import { live, frameAt } from "../live";
import { LOS_COLORS, losIndex, PROFILE_ORDER } from "../model/defaults";
import type { Project } from "../model/types";
import type { ColorBy } from "../store";
import { hexToRgb, speedColor, STATE_COLORS } from "./palette";

let inst = new Float32Array(0), col = new Uint8Array(0);
export interface AgentDraw { inst: Float32Array; col: Uint8Array; count: number; idx: Int32Array }
let idx = new Int32Array(0);

export function currentPositions(scrub: number | null) {
  if (scrub !== null) { const f = frameAt(scrub); if (f) return { ...f, spd: null as Uint8Array | null, dens: null as Uint8Array | null }; }
  const f = live.frame;
  if (!f) return null;
  return { x: f.x, y: f.y, z: f.z, lvl: f.lvl, st: f.st, spd: f.spd as Uint8Array | null, dens: f.dens as Uint8Array | null };
}

export function agentBuffers(project: Project, levelIndex: number | null, colorBy: ColorBy, scrub: number | null, follow: number | null): AgentDraw | null {
  const f = currentPositions(scrub);
  const info = live.info;
  if (!f || !info) return null;
  const n = f.x.length;
  if (inst.length < n * 3) { inst = new Float32Array(n * 3); col = new Uint8Array(n * 4); idx = new Int32Array(n); }
  const radius = PROFILE_ORDER.map((id) => project.profiles.find((p) => p.id === id)?.radius ?? 0.23);
  const profRgb = PROFILE_ORDER.map((id) => hexToRgb(project.profiles.find((p) => p.id === id)?.color ?? "#7cc4ff"));
  const stRgb = STATE_COLORS.map(hexToRgb);
  const losRgb = LOS_COLORS.map(hexToRgb);
  const std = project.settings.losStandard;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = f.st[i];
    if (s === 0 || s === 5) continue;
    if (levelIndex !== null && f.lvl[i] !== levelIndex) continue;
    const pr = info.prof[i] ?? 0;
    inst[k * 3] = f.x[i]; inst[k * 3 + 1] = f.y[i]; inst[k * 3 + 2] = (s === 6 ? 0.7 : 1) * radius[pr];
    let rgb: [number, number, number];
    if (s === 6) rgb = stRgb[6];
    else if (colorBy === "state") rgb = stRgb[s];
    else if (colorBy === "profile") rgb = profRgb[pr];
    else if (colorBy === "density") rgb = f.dens ? losRgb[losIndex(f.dens[i] / 20, std)] : stRgb[s];
    else rgb = s === 1 || s === 7 ? stRgb[1] : s === 3 || s === 4 ? stRgb[s] : f.spd ? speedColor(f.spd[i] / 100) : stRgb[2];
    const o = k * 4;
    col[o] = rgb[0]; col[o + 1] = rgb[1]; col[o + 2] = rgb[2]; col[o + 3] = s === 6 ? 150 : 255;
    if (follow === i) { col[o] = 255; col[o + 1] = 255; col[o + 2] = 255; }
    idx[k] = i;
    k++;
  }
  return { inst, col, count: k, idx };
}
