// Colours shared by the 2D view, 3D view, charts and the PDF report (dark drafting palette of the Datum suite).
import { LOS_COLORS } from "../model/defaults";
import type { ElementKind } from "../model/types";

export const C = {
  bg: "#0b0d10", grid: "#161b20", grid2: "#1d242b", ink: "#e6e9ec", ink2: "#a9b1b9", ink3: "#6f7983",
  wall: "#c9d0d7", obstacle: "#59636d", door: "#f2a93b", exit: "#5cc28a", exitClosed: "#ff6b6b", stair: "#7cc4ff",
  seating: "#8a95a1", spawn: "#7cc4ff", attractor: "#c7a6ff", barrier: "#ff8a5b", accent: "#f2a93b", sel: "#f2a93b",
};
export const KIND_COLOR: Record<ElementKind, string> = {
  wall: C.wall, obstacle: C.obstacle, door: C.door, exit: C.exit, stair: C.stair, seating: C.seating, spawn: C.spawn, attractor: C.attractor, barrier: C.barrier,
};
export const KIND_LABEL: Record<ElementKind, string> = {
  wall: "Wall", obstacle: "Obstacle", door: "Door", exit: "Exit", stair: "Stair / ramp", seating: "Seating block", spawn: "Spawn zone", attractor: "Attractor", barrier: "One-way barrier",
};
export const STATE_COLORS = ["#555", "#5d7894", "#7cc4ff", "#c7a6ff", "#f2a93b", "#333", "#3d6b52", "#9aa4ad"];
export const STATE_LABELS = ["Not arrived", "Waiting (pre-movement)", "Moving", "Queuing", "Being served", "Left", "Seated", "Idle / settled"];

export function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function ramp(stops: string[], t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  const f = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), u = f - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}
/** Speed ramp: stopped (red) → slow (amber) → free walking (blue). */
export const SPEED_STOPS = ["#e0454f", "#f2a93b", "#d8d04a", "#5cc28a", "#5aa9e6"];
export const speedColor = (v: number) => ramp(SPEED_STOPS, v / 1.5);
/** Continuous density ramp (p/m²) used for the live density and congestion maps. */
export const DENSITY_STOPS = ["#1b3a5c", "#2f8f5b", "#d8d04a", "#f2a93b", "#ef6a3a", "#d2304a", "#ff9ad5"];
export const densityColor = (d: number) => ramp(DENSITY_STOPS, d / 6);
export const congestionColor = (s: number, max: number) => ramp(["#1b3a5c", "#6a3d9a", "#d2304a", "#ffd166"], max > 0 ? s / max : 0);
export const usageColor = (s: number, max: number) => ramp(["#0f2a3f", "#2a6f97", "#61a5c2", "#e9c46a", "#f4a261", "#e76f51"], max > 0 ? Math.sqrt(s / max) : 0);
export const losRgb = (i: number) => hexToRgb(LOS_COLORS[i]);
