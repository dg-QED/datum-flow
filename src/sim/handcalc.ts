// Hand-calculation cross-checks, shown beside the simulation so users can see both:
//  1. SFPE hydraulic (specific-flow) method — SFPE Handbook 5th ed. ch. 59.
//  2. Ontario Building Code / NBC egress capacity — Div. B 3.4.3.2.(1).
// These are deliberately simple and labelled as cross-checks, not compliance calculations.
import { sampleT } from "./fields";
import type { Sim } from "./engine";

export const SFPE = {
  a: 0.266,                 // m²/p
  kLevel: 1.40,             // m/s — corridors, aisles, ramps, doorways
  kStair711: 1.08,          // m/s — 7 in riser / 11 in tread stair
  fsmLevel: 1.32,           // p/(s·m effective width)
  fsmStair711: 1.01,
  blDoor: 0.15,             // boundary layer per side (door jamb), m
  blStair: 0.15,            // stair wall / handrail side, m
  unimpededDensity: 0.54,   // p/m² below which speed is the free speed
};
export const OBC = { door: 6.1, stair: 8.0, steep: 9.2 };   // mm per person, 3.4.3.2.(1)(a)–(c)

export interface HandCalcExit { id: string; name: string; width: number; effWidth: number; people: number; dMin: number; dMax: number; flow: number; tFlow: number; t: number }
export interface HandCalcStair { id: string; name: string; width: number; effWidth: number; people: number; flow: number; tFlow: number }
export interface HandCalc {
  population: number;
  tPre: number;             // P99 pre-movement used
  speed: number;            // SFPE unimpeded walking speed, m/s
  exits: HandCalcExit[];
  stairs: HandCalcStair[];
  tHydraulic: number;       // pre-movement + controlling component
  controlling: string;
  obcRequiredMm: number; obcProvidedMm: number; obcProvidedCountedMm: number; obcOk: boolean;
  obcStairRequiredMm: number; obcStairProvidedMm: number; obcStairOk: boolean; upperPopulation: number;
  notes: string[];
}

export function handCalc(sim: Sim): HandCalc {
  const w = sim.w;
  const S = SFPE.kLevel * (1 - SFPE.a * SFPE.unimpededDensity);
  const exits: HandCalcExit[] = w.exits.map((oi) => {
    const o = w.openings[oi];
    const eff = Math.max(0.1, o.width - 2 * SFPE.blDoor);
    return { id: o.id, name: o.name, width: o.width, effWidth: eff, people: 0, dMin: Infinity, dMax: 0, flow: SFPE.fsmLevel * eff, tFlow: 0, t: 0 };
  });
  const pre: number[] = [];
  let pop = 0;
  const levelHasExit = new Set(w.exits.map((oi) => w.openings[oi].level));
  const upper: number[] = [];
  for (let i = 0; i < sim.n; i++) {
    if (!sim.legs[i].some((l) => l.k === "exit")) continue;
    pop++;
    pre.push(sim.premove[i]);
    if (!levelHasExit.has(sim.lvl[i])) upper.push(i);
    // route length from the floor field (includes stairs; wall-clearance weighting makes it slightly conservative)
    let best = -1, bd = Infinity;
    sim.exitFields.forEach((f, e) => { const d = sampleT(w.levels[sim.lvl[i]], f.T[sim.lvl[i]], sim.x[i], sim.y[i]); if (d < bd) { bd = d; best = e; } });
    if (best < 0 || !isFinite(bd)) continue;
    const X = exits[best];
    X.people++; X.dMin = Math.min(X.dMin, bd); X.dMax = Math.max(X.dMax, bd);
  }
  pre.sort((a, b) => a - b);
  const tPre = pre.length ? pre[Math.min(pre.length - 1, Math.floor(0.99 * (pre.length - 1) + 0.5))] : 0;
  for (const X of exits) {
    if (!X.people) { X.dMin = 0; continue; }
    X.tFlow = X.people / X.flow;
    X.t = Math.max(X.dMax / S, X.dMin / S + X.tFlow);
  }
  // stairs leaving levels without exits: people split by straight-line distance to each stair's entry
  const stairs: HandCalcStair[] = w.stairs.filter((s) => s.la !== s.lb).map((s) => {
    const eff = Math.max(0.1, s.width - 2 * SFPE.blStair);
    return { id: s.id, name: s.name, width: s.width, effWidth: eff, people: 0, flow: (s.ramp ? SFPE.fsmLevel : SFPE.fsmStair711) * eff, tFlow: 0 };
  });
  const usable = w.stairs.map((s, k) => [s, k] as const).filter(([s]) => s.la !== s.lb);
  for (const i of upper) {
    let best = -1, bd = Infinity;
    usable.forEach(([s], k) => {
      const onLevel = s.la === sim.lvl[i] ? [s.ax, s.ay] : s.lb === sim.lvl[i] ? [s.bx + s.ux * 0.5, s.by + s.uy * 0.5] : null;
      if (!onLevel) return;
      const d = Math.hypot(sim.x[i] - onLevel[0], sim.y[i] - onLevel[1]);
      if (d < bd) { bd = d; best = k; }
    });
    if (best >= 0) stairs[best].people++;
  }
  for (const s of stairs) s.tFlow = s.people / s.flow;
  let tComp = 0, controlling = "—";
  for (const X of exits) if (X.t > tComp) { tComp = X.t; controlling = `${X.name} (${X.people} p over ${X.effWidth.toFixed(2)} m effective)`; }
  for (const s of stairs) if (s.tFlow > tComp) { tComp = s.tFlow; controlling = `${s.name} flow (${s.people} p over ${s.effWidth.toFixed(2)} m effective)`; }

  const required = pop * OBC.door;
  const provided = exits.reduce((a, X) => a + X.width * 1000, 0);
  const counted = exits.length > 1 ? exits.reduce((a, X) => a + Math.min(X.width * 1000, required / 2), 0) : provided;
  const stairReq = upper.length * OBC.stair;
  const stairProv = stairs.reduce((a, s) => a + s.width * 1000, 0);
  const notes = [
    `Speed S = k(1 − aD) = ${S.toFixed(2)} m/s at D ≤ ${SFPE.unimpededDensity} p/m² (SFPE).`,
    "Each person is assigned to the exit with the shortest floor-field route; exit time = max(farthest walk, nearest walk + N / (Fsm·We)).",
    `Pre-movement: 99th percentile of the sampled population (${tPre.toFixed(0)} s).`,
    "OBC 3.4.3.2.(7): with more than one exit, no exit is counted for more than half the required width.",
  ];
  return {
    population: pop, tPre, speed: S, exits, stairs, tHydraulic: tPre + tComp, controlling,
    obcRequiredMm: required, obcProvidedMm: provided, obcProvidedCountedMm: counted, obcOk: counted >= required,
    obcStairRequiredMm: stairReq, obcStairProvidedMm: stairProv, obcStairOk: stairProv >= stairReq, upperPopulation: upper.length,
    notes,
  };
}
