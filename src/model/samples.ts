// Built-in sample models. All three are FICTIONAL buildings drawn for demonstration only — they are not
// QED facilities and their numbers are illustrative.
import type { Element, P, Project } from "./types";
import { emptyProject, lognormal, newElement, newLevel, newScenario } from "./defaults";

export type SampleId = "arena" | "office" | "theatre";
export const SAMPLES: { id: SampleId; name: string; blurb: string }[] = [
  { id: "arena", name: "Arena concourse + bowl section (fictional)", blurb: "6 seating blocks, 6 vomitories, 4 gates, concessions and washrooms — post-event egress, half-time circulation, ingress, evacuation" },
  { id: "office", name: "Two-storey office (fictional)", blurb: "Open-plan Level 2 with two stairs to the ground floor — fire evacuation" },
  { id: "theatre", name: "Small theatre (fictional)", blurb: "Orchestra and balcony with two balcony stairs — evacuation" },
];

const D2R = Math.PI / 180;
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const r2 = (p: P): P => [+p[0].toFixed(3), +p[1].toFixed(3)];
const polar = (R: number, deg: number): P => r2([R * Math.cos(deg * D2R), R * Math.sin(deg * D2R)]);

/** Arc wall from a0 to a1 (deg) at radius R with gaps; returns wall polylines and the gap chords (for openings). */
function arcWithGaps(R: number, a0: number, a1: number, gaps: { at: number; width: number }[], step = 2) {
  const cuts = gaps.map((g) => { const h = (g.width / 2 / R) / D2R; return [g.at - h, g.at + h] as [number, number]; }).sort((a, b) => a[0] - b[0]);
  const walls: P[][] = [];
  const openings: [P, P][] = [];
  let s = a0;
  const run = (from: number, to: number) => {
    if (to - from < 0.05) return;
    const n = Math.max(1, Math.ceil((to - from) / step));
    const pts: P[] = [];
    for (let k = 0; k <= n; k++) pts.push(polar(R, from + ((to - from) * k) / n));
    walls.push(pts);
  };
  for (const [c0, c1] of cuts) { run(s, c0); openings.push([polar(R, c0), polar(R, c1)]); s = c1; }
  run(s, a1);
  return { walls, openings };
}
function arcPoly(R0: number, R1: number, a0: number, a1: number, step = 3): P[] {
  const out: P[] = [];
  const n = Math.max(1, Math.ceil((a1 - a0) / step));
  for (let k = 0; k <= n; k++) out.push(polar(R0, a0 + ((a1 - a0) * k) / n));
  for (let k = n; k >= 0; k--) out.push(polar(R1, a0 + ((a1 - a0) * k) / n));
  return out;
}

// ------------------------------------------------------------------ (b) arena
function arena(): Project {
  const p = emptyProject("Arena concourse + bowl section (fictional sample)");
  p.sample = "arena";
  const L = p.levels[0];
  L.name = "Concourse / bowl";
  const l = L.id;
  const E: Element[] = [];
  const R0 = 55, D = 12, RB = 69, RO = 82;
  const blocks = [50, 66, 82, 98, 114, 130];
  // front rail of the bowl (event floor beyond)
  E.push(newElement("wall", l, { name: "Bowl front rail", pts: arcWithGaps(54, 40, 140, []).walls[0], thickness: 0.15 }));
  // seating blocks: rows face the event floor, rows step outward
  blocks.forEach((phi, k) => {
    const a = (phi - 90) * D2R;
    const W = 14;
    const F = polar(R0, phi);
    const ux = Math.cos(a), uy = Math.sin(a);
    E.push(newElement("seating", l, {
      name: `Block ${101 + k}`, origin: r2([F[0] - (ux * W) / 2, F[1] - (uy * W) / 2]), width: W, depth: D, angle: +a.toFixed(5),
      rowPitch: 0.85, seatWidth: 0.5, aisles: "both", aisleWidth: 1.2, occupancy: 0.9, profile: { adult: 0.84, older: 0.1, child: 0.04, mobility: 0.02 },
    }));
  });
  // back wall of the bowl with one vomitory behind each block
  const back = arcWithGaps(RB, 40, 140, blocks.map((at) => ({ at, width: 2.4 })));
  back.walls.forEach((pts) => E.push(newElement("wall", l, { name: "Bowl back wall", pts, thickness: 0.3 })));
  back.openings.forEach(([a, b], k) => E.push(newElement("door", l, { name: `Vom ${k + 1}`, a, b })));
  // bowl and concourse end walls (the model is a cut section)
  for (const ang of [40, 140]) {
    E.push(newElement("wall", l, { name: "Section end", pts: [polar(54, ang), polar(RO, ang)], thickness: 0.3 }));
  }
  // outer wall with four gates (final exits)
  const gates = [52, 78, 102, 128];
  const outer = arcWithGaps(RO, 40, 140, gates.map((at) => ({ at, width: 6 })));
  outer.walls.forEach((pts) => E.push(newElement("wall", l, { name: "Outer wall", pts, thickness: 0.4 })));
  outer.openings.forEach(([a, b], k) => E.push(newElement("exit", l, { name: `Gate ${"ABCD"[k]}`, a, b })));
  // concession stands against the outer wall, queues toward the bowl
  [65, 90, 115].forEach((phi, k) => {
    E.push(newElement("obstacle", l, { name: `Counter ${k + 1}`, pts: arcPoly(80.3, 81.6, phi - 4.5, phi + 4.5, 1.5) }));
    E.push(newElement("attractor", l, { name: `Concession ${k + 1}`, type: "concession", p: polar(79.5, phi), servers: 8, queueDir: +((phi + 180) * D2R).toFixed(4), service: lognormal(30, 0.4) }));
  });
  // washrooms at the concourse ends; queues run along the concourse
  E.push(newElement("obstacle", l, { name: "Washroom W", pts: arcPoly(71, 80, 40, 43.2, 1) }));
  E.push(newElement("obstacle", l, { name: "Washroom E", pts: arcPoly(71, 80, 136.8, 140, 1) }));
  E.push(newElement("attractor", l, { name: "Washroom W", type: "washroom", p: polar(75.5, 44.2), servers: 12, queueDir: +((44.2 + 90) * D2R).toFixed(4), service: lognormal(50, 0.35) }));
  E.push(newElement("attractor", l, { name: "Washroom E", type: "washroom", p: polar(75.5, 135.8), servers: 12, queueDir: +((135.8 - 90) * D2R).toFixed(4), service: lognormal(50, 0.35) }));
  // standing crowd on the concourse
  E.push(newElement("spawn", l, { name: "Concourse crowd", pts: arcPoly(71, 77.5, 47, 133, 4), mode: "count", count: 160, premove: lognormal(20, 0.5), groupFrac: 0.4 }));
  // ingress: arrivals in the plaza outside each gate, screened at the gate
  gates.forEach((phi, k) => {
    E.push(newElement("spawn", l, { name: `Plaza ${"ABCD"[k]}`, pts: arcPoly(85, 92, phi - 4.5, phi + 4.5, 1.5), mode: "count", count: 220, arrivals: true, premove: { type: "fixed", a: 0, b: 0 }, groupFrac: 0.45, groupSize: [2, 4] }));
    E.push(newElement("attractor", l, { name: `Screening ${"ABCD"[k]}`, type: "gate", p: polar(83.6, phi), servers: 5, queueDir: +(phi * D2R).toFixed(4), service: lognormal(6, 0.35) }));
  });
  p.elements = E;
  const egress = newScenario("egress", "Post-event egress");
  egress.seatPremove = { type: "uniform", a: 0, b: 120 };
  egress.duration = 1200;
  const half = newScenario("circulation", "Half-time concourse");
  half.duration = 900;
  half.visit = { concession: 0.3, washroom: 0.22 };
  half.seatPremove = { type: "uniform", a: 0, b: 180 };
  const ingress = newScenario("ingress", "Doors-open ingress");
  ingress.arrivalWindow = 600; ingress.duration = 1500;
  const evac = newScenario("evacuation", "Evacuation — Gate B closed");
  evac.seatPremove = lognormal(40, 0.45);
  evac.exitChoice = "least-time";
  evac.closedExits = [E.find((e) => e.name === "Gate B")!.id];
  p.scenarios = [egress, half, ingress, evac];
  p.activeScenario = egress.id;
  p.view = { cx: 0, cy: 68, scale: 6.5, level: l };
  return p;
}

// ------------------------------------------------------------------ (a) office
function office(): Project {
  const p = emptyProject("Two-storey office (fictional sample)");
  p.sample = "office";
  const G = p.levels[0];
  G.name = "Ground";
  const U = newLevel("Level 2", 4.2);
  p.levels = [G, U];
  const g = G.id, u = U.id;
  const E: Element[] = [];
  const W = 40, H = 24;
  for (const lv of [g, u]) {
    // shell
    E.push(newElement("wall", lv, { name: "Exterior", pts: rect(0, 0, W, H), closed: true, thickness: 0.3 }));
    // stair cores (west and east)
    E.push(newElement("wall", lv, { name: "West core", pts: [[0, 6], [4.4, 6], [4.4, 18], [0, 18]], thickness: 0.2 }));
    E.push(newElement("wall", lv, { name: "East core", pts: [[W, 6], [W - 4.4, 6], [W - 4.4, 18], [W, 18]], thickness: 0.2 }));
    // central services core (lifts, washrooms)
    E.push(newElement("obstacle", lv, { name: "Services core", pts: rect(16, 9, 24, 15) }));
  }
  // Level 2: core doors, stairs, meeting rooms, desks
  E.push(newElement("door", u, { name: "West stair door", a: [4.4, 15.6], b: [4.4, 16.6] }));
  E.push(newElement("door", u, { name: "East stair door", a: [W - 4.4, 7.4], b: [W - 4.4, 8.4] }));
  E.push(newElement("stair", u, { name: "Stair W", a: [2.2, 16.2], b: [2.2, 8.2], width: 1.4, toLevel: g }));
  E.push(newElement("stair", u, { name: "Stair E", a: [W - 2.2, 7.8], b: [W - 2.2, 15.8], width: 1.4, toLevel: g }));
  // meeting rooms on the north side
  for (const [x0, x1] of [[6, 11], [11, 16], [24, 29], [29, 34]]) {
    E.push(newElement("wall", u, { name: "Meeting room", pts: [[x0, H], [x0, 19.5], [x1, 19.5], [x1, H]], thickness: 0.12 }));
    E.push(newElement("door", u, { name: "Meeting room door", a: [x0 + 1.5, 19.5], b: [x0 + 2.4, 19.5] }));
  }
  // desk clusters (pairs of 1.6 × 0.8 m desks back to back)
  const desks = (x0: number, y0: number, cols: number, rows: number) => {
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const x = x0 + c * 3.4, y = y0 + r * 3.0;
      E.push(newElement("obstacle", u, { name: "Desks", pts: rect(x, y, x + 1.6, y + 1.6) }));
    }
  };
  desks(6.2, 1.6, 3, 2); desks(25.2, 1.6, 3, 2); desks(6.2, 11.8, 2, 2); desks(26.6, 11.8, 2, 2);
  // occupants: 0.2 p/m² — about twice the OBC Table 3.1.17.1 office design load (9.3 m²/person ≈ 0.11 p/m²), to load the stairs
  const office = { adult: 0.9, older: 0.06, mobility: 0.02, staff: 0.02 };
  E.push(newElement("spawn", u, { name: "Open office south", pts: rect(5, 0.6, 35, 8.4), mode: "density", density: 0.2, profile: office, premove: lognormal(60, 0.4), groupFrac: 0.1 }));
  E.push(newElement("spawn", u, { name: "Open office north", pts: rect(5, 9, 15.5, 19), mode: "density", density: 0.2, profile: office, premove: lognormal(60, 0.4), groupFrac: 0.1 }));
  E.push(newElement("spawn", u, { name: "Open office north-east", pts: rect(24.5, 9, 35, 19), mode: "density", density: 0.2, profile: office, premove: lognormal(60, 0.4), groupFrac: 0.1 }));
  E.push(newElement("spawn", u, { name: "Meeting rooms", pts: rect(6.3, 20, 33.7, 23.6), mode: "count", count: 24, profile: office, premove: lognormal(75, 0.4), groupFrac: 0.2 }));
  // Ground: discharge exits from each stair core, main entrance, lobby occupants
  E.push(newElement("exit", g, { name: "West stair discharge", a: [0, 6.5], b: [0, 7.6] }));
  E.push(newElement("exit", g, { name: "East stair discharge", a: [W, 16.4], b: [W, 17.5] }));
  E.push(newElement("door", g, { name: "West core lobby door", a: [4.4, 16.4], b: [4.4, 17.4] }));
  E.push(newElement("door", g, { name: "East core lobby door", a: [W - 4.4, 6.6], b: [W - 4.4, 7.6] }));
  E.push(newElement("exit", g, { name: "Main entrance", a: [18.2, 0], b: [21.8, 0] }));
  E.push(newElement("obstacle", g, { name: "Reception", pts: rect(18, 4, 22, 5.2) }));
  E.push(newElement("spawn", g, { name: "Ground floor", pts: rect(5, 1, 35, 22), mode: "count", count: 40, profile: office, premove: lognormal(45, 0.4), groupFrac: 0.1 }));
  p.elements = E;
  const sc = newScenario("evacuation", "Fire evacuation — all exits");
  sc.duration = 900;
  const sc2 = newScenario("evacuation", "Evacuation — east stair blocked");
  sc2.duration = 900;
  sc2.closedExits = [E.find((e) => e.name === "East stair door")!.id];
  p.scenarios = [sc, sc2];
  p.activeScenario = sc.id;
  p.view = { cx: 20, cy: 12, scale: 20, level: u };
  return p;
}

// ------------------------------------------------------------------ (c) theatre
function theatre(): Project {
  const p = emptyProject("Small theatre (fictional sample)");
  p.sample = "theatre";
  const O = p.levels[0];
  O.name = "Orchestra";
  const B = newLevel("Balcony", 5);
  p.levels = [O, B];
  const o = O.id, b = B.id;
  const E: Element[] = [];
  const W = 24, H = 26;
  // orchestra: hall with exits at the rear and beside the stage
  E.push(newElement("wall", o, { name: "Hall", pts: rect(0, 0, W, H), closed: true, thickness: 0.3 }));
  E.push(newElement("exit", o, { name: "Rear exit L", a: [3.2, 0], b: [5, 0] }));
  E.push(newElement("exit", o, { name: "Rear exit R", a: [19, 0], b: [20.8, 0] }));
  E.push(newElement("exit", o, { name: "Stage-side exit W", a: [0, 17.2], b: [0, 18.8] }));
  E.push(newElement("exit", o, { name: "Stage-side exit E", a: [W, 17.2], b: [W, 18.8] }));
  E.push(newElement("obstacle", o, { name: "Stage", pts: rect(0.15, 20.5, W - 0.15, H - 0.15) }));
  // two orchestra blocks with open row ends: 2.2 m side aisles and a 1.4 m centre aisle
  for (const [x0, nm] of [[21.8, "Orchestra right"], [11.1, "Orchestra left"]] as const)
    E.push(newElement("seating", o, { name: nm, origin: [x0, 19], width: 8.9, depth: 13.6, angle: Math.PI, rowPitch: 0.85, seatWidth: 0.5, aisles: "open", aisleWidth: 1.2, occupancy: 0.95, profile: { adult: 0.85, older: 0.12, child: 0.02, mobility: 0.01 } }));
  // side passages to the balcony stairs (outside the hall walls)
  for (const [x0, x1] of [[-4, 0], [W, W + 4]]) {
    E.push(newElement("wall", o, { name: "Stair passage", pts: [[x0 === -4 ? 0 : W, 10], [x0 === -4 ? -4 : W + 4, 10], [x0 === -4 ? -4 : W + 4, 0]], thickness: 0.2 }));
    E.push(newElement("exit", o, { name: x0 < 0 ? "Stair exit W" : "Stair exit E", a: [x0 + 0.3, 0], b: [x1 - 0.3, 0] }));
  }
  E.push(newElement("wall", o, { name: "Passage", pts: [[-4, 0], [-3.7, 0]], thickness: 0.2 }));
  // balcony
  E.push(newElement("wall", b, { name: "Balcony", pts: [[0, 9.4], [0, 0], [W, 0], [W, 9.4]], thickness: 0.3 }));
  E.push(newElement("wall", b, { name: "Balcony front rail", pts: [[0, 9.4], [W, 9.4]], thickness: 0.15 }));
  for (const [x0, nm] of [[21.8, "Balcony right"], [11.1, "Balcony left"]] as const)
    E.push(newElement("seating", b, { name: nm, origin: [x0, 8.9], width: 8.9, depth: 7.6, angle: Math.PI, rowPitch: 0.9, seatWidth: 0.5, aisles: "open", aisleWidth: 1.2, occupancy: 0.95, profile: { adult: 0.88, older: 0.1, child: 0.02 } }));
  E.push(newElement("door", b, { name: "Balcony door W", a: [0, 0.4], b: [0, 1.4] }));
  E.push(newElement("door", b, { name: "Balcony door E", a: [W, 0.4], b: [W, 1.4] }));
  E.push(newElement("wall", b, { name: "Stair hall W", pts: [[0, 9], [-4, 9], [-4, -0.6], [0, -0.6], [0, 0]], thickness: 0.2 }));
  E.push(newElement("wall", b, { name: "Stair hall E", pts: [[W, 9], [W + 4, 9], [W + 4, -0.6], [W, -0.6], [W, 0]], thickness: 0.2 }));
  E.push(newElement("stair", b, { name: "Balcony stair W", a: [-2.3, 1.2], b: [-2.3, 7.6], width: 1.5, toLevel: o }));
  E.push(newElement("stair", b, { name: "Balcony stair E", a: [W + 2.3, 1.2], b: [W + 2.3, 7.6], width: 1.5, toLevel: o }));
  p.elements = E;
  const sc = newScenario("evacuation", "Show-stop evacuation");
  sc.seatPremove = lognormal(30, 0.5);
  sc.duration = 900;
  p.scenarios = [sc];
  p.activeScenario = sc.id;
  p.view = { cx: 12, cy: 12, scale: 22, level: o };
  return p;
}

export function buildSample(id: SampleId): Project {
  return id === "arena" ? arena() : id === "office" ? office() : theatre();
}
