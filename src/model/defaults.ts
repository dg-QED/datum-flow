// Default parameters with their sources. Every number a user might question carries a citation here,
// and the same strings are printed in the PDF report's assumptions table.
import type { AttractorType, Dist, Element, ElementKind, Level, P, Profile, Project, Scenario, Settings } from "./types";

let seq = 0;
export const uid = (p = "e") => `${p}${Date.now().toString(36).slice(-5)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export const PROFILES: Profile[] = [
  {
    id: "adult", name: "Adult", speedMean: 1.34, speedSd: 0.26, speedMin: 0.7, speedMax: 2.0,
    radius: 0.23, radiusSd: 0.02, tau: 0.5, mass: 80, stairFactor: 1, color: "#7cc4ff",
    source: "Free speed 1.34 ± 0.26 m/s: Weidmann (1993), Transporttechnik der Fussgänger, ETH IVT 90; consistent with Fruin (1971) 1.35 m/s. Body width ≈ 0.46 m: Fruin (1971) body ellipse 0.46 × 0.61 m.",
  },
  {
    id: "older", name: "Older adult", speedMean: 1.05, speedSd: 0.2, speedMin: 0.5, speedMax: 1.5,
    radius: 0.23, radiusSd: 0.02, tau: 0.6, mass: 75, stairFactor: 0.85, color: "#c7a6ff",
    source: "Normal gait 0.94–1.26 m/s for ages 70–99: Bohannon & Andrews (2011), Physiotherapy 97(3):182–189. Older people on stairs ~10–20 % slower than younger adults: Fujiyama & Tyler (2004), UTSG.",
  },
  {
    id: "child", name: "Child", speedMean: 1.1, speedSd: 0.25, speedMin: 0.5, speedMax: 1.8,
    radius: 0.18, radiusSd: 0.02, tau: 0.5, mass: 35, stairFactor: 0.9, color: "#5cc28a",
    source: "Assumed (school-age, accompanied). Compare with Larusdottir & Dederichs (2012), Fire Technology 48:43–53 before using for day-care or primary-school populations.",
  },
  {
    id: "mobility", name: "Mobility impaired / wheelchair", speedMean: 0.69, speedSd: 0.35, speedMin: 0.3, speedMax: 1.3,
    radius: 0.36, radiusSd: 0.02, tau: 0.9, mass: 110, stairFactor: 0.3, color: "#ff8a5b",
    source: "Manual wheelchair 0.69 ± 0.35 m/s, electric 0.89, walking frame 0.57: Boyce, Shields & Silcock (1999), Fire Technology 35(1):51–67. Footprint ≈ 0.70 × 1.20 m (ISO 7193); modelled as a 0.72 m wide circle (radius 0.36 m) so a chair fits an 0.85 m clear door as it does in reality — the extra length is not represented. Stair use (assisted) is a planning assumption.",
  },
  {
    id: "staff", name: "Staff", speedMean: 1.4, speedSd: 0.15, speedMin: 1.0, speedMax: 2.0,
    radius: 0.23, radiusSd: 0.02, tau: 0.45, mass: 80, stairFactor: 1.05, color: "#f2a93b",
    source: "Assumed: trained, familiar with the building, purposeful walking (upper half of Weidmann 1993 distribution).",
  },
];

export const SOURCES = {
  sf: "Social force: Helbing & Molnár (1995), Phys. Rev. E 51:4282; parameters A = 2000 N, B = 0.08 m, k = 1.2·10⁵ kg/s², κ = 2.4·10⁵ kg/(m·s), τ = 0.5 s, m = 80 kg from Helbing, Farkas & Vicsek (2000), Nature 407:487–490.",
  anis: "Anisotropy (field of view) weight λ + (1 − λ)(1 + cos φ)/2: Helbing & Johansson (2009), Encyclopedia of Complexity and Systems Science. Flow uses λ = 0.5, calibrated so a 1.0 m door passes 1.2–1.5 p/(m·s); λ = 1 recovers the isotropic HFV 2000 model (which clogs at 1 m doors with these friction constants).",
  fmm: "Navigation: eikonal floor field |∇T| = 1/F solved by fast marching (Sethian 1996, PNAS 93:1591) with the multi-stencil variant of Hassouna & Farag (2007), IEEE PAMI 29(9).",
  groups: "Groups: cohesion toward the group centre after Moussaïd et al. (2010), PLoS ONE 5(4):e10047.",
  stairs: "Stair horizontal speeds (normal pace, 30–35° flights): ascending 0.56–0.63 m/s, descending 0.65–0.74 m/s for adults 25–60: Fujiyama & Tyler (2004), 'Pedestrian speeds on stairs', UTSG, Table 3 → factors ≈ 0.45 (up) and 0.52 (down) of 1.34 m/s.",
  los: "Level of Service: Fruin (1971), Pedestrian Planning and Design. Walkway A ≥ 3.25 m²/p, B 2.32–3.25, C 1.39–2.32, D 0.93–1.39, E 0.46–0.93, F < 0.46.",
  sfpe: "Hydraulic cross-check: SFPE Handbook of Fire Protection Engineering (5th ed., 2016), ch. 59 (Gwynne & Rosenbaum): S = k(1 − 0.266 D), Fs = S·D, Fsm = 1.32 p/(s·m effective width) for doors, corridors and ramps (k = 1.40 m/s); stairs 7/11: k = 1.08, Fsm = 1.01; effective width = clear width − boundary layers (door jamb 0.15 m, corridor wall 0.20 m, stair wall 0.15 m each side).",
  obc: "Code capacity cross-check: Ontario Building Code (O. Reg. 332/12) Div. B 3.4.3.2.(1) (same as NBC 2015/2020 3.4.3.2.(1)): 6.1 mm per person for doorways, corridors, passageways and ramps ≤ 1 in 8; 8 mm per person for stairs with rise ≤ 180 mm and run ≥ 280 mm; 9.2 mm for other stairs and steeper ramps. 3.4.3.2.(7): with more than one exit, no exit counts for more than half the required width.",
  fd: "Fundamental diagram for comparison: Weidmann (1993) — peak specific flow ≈ 1.22 p/(m·s) at ≈ 1.75 p/m²; bottleneck experiments 1.6–1.9 p/(m·s) for 0.8–1.2 m openings: Seyfried et al. (2009), Transportation Science 43(3):395–406; Kretz, Grünebohm & Schreckenberg (2006), J. Stat. Mech. P10014.",
};

export const DEFAULT_SETTINGS: Settings = {
  gridCell: 0.25, dt: 0.05, substeps: 2, wallClearance: 0.4, densityCell: 0.5,
  losStandard: "walkway", congestionDensity: 2.0, anisotropy: 0.5,
  sf: { A: 2000, B: 0.08, k: 1.2e5, kappa: 2.4e5, Aw: 2000, Bw: 0.08 },
};

export const LOS_TABLE: Record<Settings["losStandard"], { name: string; m2pp: number[]; source: string }> = {
  // area per person thresholds (m²/p) separating A|B, B|C, C|D, D|E, E|F (Fruin 1971, converted from ft²)
  walkway: { name: "Fruin walkway", m2pp: [3.25, 2.32, 1.39, 0.93, 0.46], source: "Fruin (1971) walkway LOS: 35/25/15/10/5 ft² per person" },
  queuing: { name: "Fruin queuing", m2pp: [1.21, 0.93, 0.65, 0.28, 0.19], source: "Fruin (1971) queuing LOS: 13/10/7/3/2 ft² per person" },
  stairs: { name: "Fruin stairway", m2pp: [1.86, 1.39, 0.93, 0.65, 0.37], source: "Fruin (1971) stairway LOS: 20/15/10/7/4 ft² per person" },
};
export const LOS_COLORS = ["#2f8f5b", "#6fbf4a", "#d8d04a", "#f2a93b", "#ef6a3a", "#d2304a"];
export const LOS_LETTERS = ["A", "B", "C", "D", "E", "F"];
/** LOS index 0..5 for a density (p/m²). */
export function losIndex(density: number, std: Settings["losStandard"]): number {
  if (density <= 0) return 0;
  const a = 1 / density;
  const t = LOS_TABLE[std].m2pp;
  for (let i = 0; i < t.length; i++) if (a >= t[i]) return i;
  return 5;
}

export const lognormal = (median: number, sigma: number): Dist => ({ type: "lognormal", a: median, b: sigma });
export function distLabel(d: Dist): string {
  switch (d.type) {
    case "fixed": return `${d.a} s`;
    case "uniform": return `U(${d.a}, ${d.b}) s`;
    case "normal": return `N(${d.a}, ${d.b}) s`;
    case "lognormal": return `logN median ${d.a} s, σ ${d.b} (P90 ${Math.round(d.a * Math.exp(1.2816 * d.b))} s)`;
  }
}

export const ATTRACTOR_LABEL: Record<AttractorType, string> = { concession: "Concession", washroom: "Washroom", gate: "Gate / screening", info: "Info / guest services", other: "Other" };

export function newScenario(kind: Scenario["kind"], name?: string): Scenario {
  return {
    id: uid("sc"), name: name ?? ({ evacuation: "Evacuation", ingress: "Ingress", egress: "Post-event egress", circulation: "Half-time circulation" }[kind]),
    kind, seed: 1, duration: kind === "circulation" ? 900 : kind === "ingress" ? 1800 : 1200,
    exitChoice: kind === "evacuation" ? "least-time" : "nearest", closedExits: [], spawns: "all", seating: "all",
    seatPremove: kind === "egress" ? { type: "uniform", a: 0, b: 90 } : kind === "circulation" ? { type: "uniform", a: 0, b: 240 } : lognormal(45, 0.5),
    arrivalWindow: 900, useGates: true, visit: { concession: 0.35, washroom: 0.25 }, agentScale: 1,
  };
}

export function newLevel(name: string, elevation: number): Level { return { id: uid("L"), name, elevation, height: 4 }; }

export function newElement(kind: ElementKind, level: string, data: Partial<Element> = {}): Element {
  const id = uid(kind.slice(0, 2));
  const base = { id, level, name: "" };
  const d = data as Record<string, unknown>;
  const p = (k: string, def: P): P => (d[k] as P) ?? def;
  switch (kind) {
    case "wall": return { ...base, kind, pts: (d.pts as P[]) ?? [], closed: !!d.closed, thickness: (d.thickness as number) ?? 0.2, ...data } as Element;
    case "obstacle": return { ...base, kind, pts: (d.pts as P[]) ?? [], ...data } as Element;
    case "door": return { ...base, kind, a: p("a", [0, 0]), b: p("b", [0.9, 0]), maxFlow: null, closed: false, ...data } as Element;
    case "exit": return { ...base, kind, a: p("a", [0, 0]), b: p("b", [1.8, 0]), closed: false, ...data } as Element;
    case "stair": return { ...base, kind, a: p("a", [0, 0]), b: p("b", [6, 0]), width: 1.5, toLevel: level, ramp: false, speedDown: 0.52, speedUp: 0.45, ...data } as Element;
    case "seating": return { ...base, kind, origin: p("origin", [0, 0]), width: 12, depth: 8, angle: 0, rowPitch: 0.85, seatWidth: 0.5, aisles: "both", aisleWidth: 1.1, occupancy: 0.9, profile: { adult: 0.85, older: 0.1, child: 0.05 }, ...data } as Element;
    case "spawn": return { ...base, kind, pts: (d.pts as P[]) ?? [], mode: "density", count: 50, density: 0.5, profile: { adult: 0.9, older: 0.08, mobility: 0.02 }, premove: lognormal(30, 0.5), groupFrac: 0.3, groupSize: [2, 4], arrivals: false, ...data } as Element;
    case "attractor": return { ...base, kind, p: p("p", [0, 0]), type: "concession", service: { type: "lognormal", a: 25, b: 0.4 }, servers: 3, queueDir: -Math.PI / 2, ...data } as Element;
    case "barrier": return { ...base, kind, a: p("a", [0, 0]), b: p("b", [2, 0]), ...data } as Element;
  }
}

export function emptyProject(title = "Untitled model"): Project {
  const L = newLevel("Ground", 0);
  const sc = newScenario("evacuation");
  return {
    format: "datum-flow", version: 1, title, levels: [L], elements: [], profiles: PROFILES.map((p) => ({ ...p })),
    scenarios: [sc], activeScenario: sc.id, settings: structuredClone(DEFAULT_SETTINGS),
  };
}
