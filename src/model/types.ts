// Datum Flow project model. Everything is in metres and seconds, plan coordinates x → east, y → north.
// The project is plain JSON (saved as .dflow.json) and is the single input to the simulation engine.

export type P = [number, number];

export interface Level {
  id: string;
  name: string;
  elevation: number;     // m, used for stacking in 3D and for stair direction
  height: number;        // storey height, 3D only
}

/** Pre-movement / service-time distribution. lognormal: a = median (s), b = σ of ln; uniform: [a, b]; normal: mean a, sd b; fixed: a. */
export interface Dist { type: "lognormal" | "uniform" | "normal" | "fixed"; a: number; b: number }

export type ProfileId = "adult" | "older" | "child" | "mobility" | "staff";
export interface Profile {
  id: ProfileId;
  name: string;
  speedMean: number;     // free (desired) walking speed on the level, m/s
  speedSd: number;
  speedMin: number;
  speedMax: number;
  radius: number;        // body radius, m (circle of equal width)
  radiusSd: number;
  tau: number;           // relaxation time, s
  mass: number;          // kg
  stairFactor: number;   // extra multiplier on the stair's own speed factor (e.g. 0.6 for mobility impaired)
  color: string;
  source: string;        // citation shown in the UI and the report
}
export type ProfileMix = Partial<Record<ProfileId, number>>;

export type ElementKind = "wall" | "obstacle" | "door" | "exit" | "stair" | "seating" | "spawn" | "attractor" | "barrier";

interface Base { id: string; kind: ElementKind; level: string; name: string }

export interface Wall extends Base { kind: "wall"; pts: P[]; closed: boolean; thickness: number }
export interface Obstacle extends Base { kind: "obstacle"; pts: P[] }
/** An opening. Walls under it are cut at compile time. maxFlow (persons/s) throttles it; closed turns it into a wall. */
export interface Door extends Base { kind: "door"; a: P; b: P; maxFlow: number | null; closed: boolean }
/** A final exit (agents leave the model when they reach it). */
export interface Exit extends Base { kind: "exit"; a: P; b: P; closed: boolean }
/**
 * A straight stair or ramp run drawn in plan on `level` from a to b. The a end opens onto `level`;
 * the b end connects to `toLevel` at the same plan position. On `toLevel` the run's footprint is solid
 * (it is the underside / the flight itself) and people arrive in front of its b face.
 */
export interface Stair extends Base {
  kind: "stair"; a: P; b: P; width: number; toLevel: string;
  ramp: boolean;
  speedDown: number;     // horizontal-speed factor while descending (× free speed)
  speedUp: number;       // … while ascending
}
/** Seating block: rows parallel to the local x axis, front row at local y = 0, rows step back toward +y. */
export interface Seating extends Base {
  kind: "seating"; origin: P; width: number; depth: number; angle: number;
  rowPitch: number; seatWidth: number; aisles: "both" | "left" | "right" | "center" | "none" | "open"; aisleWidth: number;
  occupancy: number;     // 0..1 of seats occupied at the start of egress / circulation
  profile: ProfileMix;
}
export interface Spawn extends Base {
  kind: "spawn"; pts: P[];
  mode: "count" | "density"; count: number; density: number;
  profile: ProfileMix;
  premove: Dist;
  groupFrac: number;     // share of people who move in groups
  groupSize: [number, number];
  arrivals: boolean;     // ingress source: people arrive over the scenario's arrival window instead of all at t = 0
}
export type AttractorType = "concession" | "washroom" | "gate" | "info" | "other";
export interface Attractor extends Base {
  kind: "attractor"; p: P; type: AttractorType;
  service: Dist;         // service time per person
  servers: number;
  queueDir: number;      // radians: direction the queue grows from the service point
}
/** One-way barrier: people may cross from the left of a→b to the right, never back. */
export interface Barrier extends Base { kind: "barrier"; a: P; b: P }

export type Element = Wall | Obstacle | Door | Exit | Stair | Seating | Spawn | Attractor | Barrier;
export type ElementOf<K extends ElementKind> = Extract<Element, { kind: K }>;

export type ScenarioKind = "evacuation" | "ingress" | "egress" | "circulation";
export interface Scenario {
  id: string;
  name: string;
  kind: ScenarioKind;
  seed: number;
  duration: number;               // s, hard stop
  exitChoice: "nearest" | "least-time";
  closedExits: string[];          // exit / door ids closed for this scenario
  spawns: string[] | "all";       // spawn zones included
  seating: string[] | "all";      // seating blocks included (seated occupants)
  seatPremove: Dist;              // pre-movement of seated occupants
  arrivalWindow: number;          // ingress: arrivals spread over this many seconds
  useGates: boolean;              // ingress: route through gate attractors (screening)
  visit: Partial<Record<AttractorType, number>>;   // circulation: probability of visiting a type
  agentScale: number;             // multiplier on all populations (sensitivity checks)
}

export interface Settings {
  gridCell: number;               // navigation grid resolution, m
  dt: number;                     // simulation step, s
  substeps: number;               // force sub-steps per step
  wallClearance: number;          // m: navigation prefers to stay this far from walls (0 = shortest path)
  densityCell: number;            // m
  losStandard: "walkway" | "queuing" | "stairs";
  congestionDensity: number;      // p/m² counted as "congested"
  anisotropy: number;             // λ in the social-force anisotropy (1 = isotropic, HFV 2000)
  sf: { A: number; B: number; k: number; kappa: number; Aw: number; Bw: number };
}

export interface ResultSummary {
  scenarioId: string;
  scenarioName: string;
  kind: ScenarioKind;
  seed: number;
  agents: number;
  completed: number;
  tet: number | null;             // total evacuation time (s) — time the last person left
  p50: number | null;             // exit / arrival time percentiles
  p90: number | null;
  premoveMean: number;
  premoveP90: number;
  travelMean: number;
  maxDensity: number;
  congestedAgentS: number;        // mean seconds per person at or above congestionDensity
  exitUsage: Record<string, number>;
  doorPeak: Record<string, number>;   // peak specific flow, p/(m·s), 10 s window
  queuePeak: Record<string, number>;
  simTime: number;
  wallMs: number;
  steps: number;
  monteCarlo?: { seeds: number[]; tets: (number | null)[]; p50: number | null; p90: number | null; mean: number | null; min: number | null; max: number | null };
}

export interface Project {
  format: "datum-flow";
  version: 1;
  title: string;
  sample?: string;                // id of the built-in sample this came from (fictional data)
  levels: Level[];
  elements: Element[];
  profiles: Profile[];
  scenarios: Scenario[];
  activeScenario: string;
  settings: Settings;
  results?: ResultSummary[];
  view?: { cx: number; cy: number; scale: number; level: string };
}
