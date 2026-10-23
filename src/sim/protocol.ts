// Messages between the app and the simulation worker. Typed arrays are transferred, never shared
// (SharedArrayBuffer is not available in the host).
import type { Project, ResultSummary } from "../model/types";
import type { Series } from "./engine";
import type { HandCalc } from "./handcalc";

export type ToWorker =
  | { type: "load"; project: Project; scenarioId: string; seed: number }
  | { type: "play"; speed: number }          // sim seconds per wall second; Infinity = as fast as possible
  | { type: "pause" }
  | { type: "step"; steps: number }
  | { type: "runToEnd" }
  | { type: "batch"; project: Project; scenarioId: string; seeds: number[] }
  | { type: "bench"; agents: number; steps: number };

export interface LevelInfo { id: string; name: string; elev: number; height: number; dens: { nx: number; ny: number; cs: number; x0: number; y0: number } }
export interface WorldInfo {
  n: number;
  levels: LevelInfo[];
  openings: { id: string; name: string; level: number; width: number; isExit: boolean; ax: number; ay: number; bx: number; by: number }[];
  attractors: { id: string; name: string; level: number; type: string }[];
  stairs: { id: string; la: number; lb: number; ax: number; ay: number; bx: number; by: number; hw: number; nx: number; ny: number }[];
  prof: Uint8Array;
  origin: [number, number];                 // keyframe quantisation origin
  warnings: string[];
  handCalc: HandCalc | null;
  seed: number;
}

export interface Frame {
  t: number;
  x: Float32Array; y: Float32Array; z: Float32Array;   // z: elevation (stairs interpolate)
  lvl: Uint8Array; st: Uint8Array; spd: Uint8Array; dens: Uint8Array;
  counts: { done: number; active: number; moving: number; waiting: number; queued: number };
  density?: Uint8Array[];       // per level, p/m² × 20, sent every ≥ 0.5 s
  densDt?: number;              // sim seconds the density snapshot stands for
  doorsOpen?: Uint8Array;
}
export interface KeyFrame { t: number; x: Uint16Array; y: Uint16Array; z: Uint16Array; lvl: Uint8Array; st: Uint8Array }

export interface FinalResult {
  summary: ResultSummary;
  series: Series;
  maxDensity: Float32Array[];
  congestion: Float32Array[];
  crossings: number[][];
}

export type FromWorker =
  | { type: "ready"; info: WorldInfo; buildMs: number }
  | { type: "frame"; frame: Frame; series?: Series }
  | { type: "key"; key: KeyFrame }
  | { type: "progress"; t: number; done: number; n: number }
  | { type: "finished"; result: FinalResult }
  | { type: "batchResult"; seed: number; summary: ResultSummary; stepsPerSec: number; agents: number }
  | { type: "bench"; agents: number; steps: number; stepsPerSec: number; msPerStep: number; buildMs: number }
  | { type: "error"; message: string };

export const Q = 50;   // keyframe quantisation: 2 cm
