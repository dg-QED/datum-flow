// Known-answer tests for the Datum Flow model. Bundled with esbuild and run under Node:  npm test
import { fastMarch, type Grid } from "../src/sim/fmm";
import { Sim, ST_DONE } from "../src/sim/engine";
import { emptyProject, newElement, newScenario, PROFILES } from "../src/model/defaults";
import type { Element, P, Project } from "../src/model/types";
import { parseDXF, dxfToElements } from "../src/io/dxf";
import { handCalc } from "../src/sim/handcalc";
import { buildSample } from "../src/model/samples";

let failed = 0;
const results: string[] = [];
function test(name: string, fn: () => string | void) {
  const t0 = performance.now();
  try {
    const msg = fn();
    results.push(`  ok   ${name}${msg ? `  — ${msg}` : ""}  (${Math.round(performance.now() - t0)} ms)`);
  } catch (e) {
    failed++;
    results.push(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
  console.log(results[results.length - 1]);
}
function assert(c: boolean, msg: string) { if (!c) throw new Error(msg); }

// ------------------------------------------------------------------ helpers
function rectWalls(x0: number, y0: number, x1: number, y1: number, level: string): Element {
  return newElement("wall", level, { pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as P[], closed: true, thickness: 0.2 });
}
function project(els: (lvl: string) => Element[], tweak?: (p: Project) => void): Project {
  const p = emptyProject("test");
  const L = p.levels[0].id;
  p.elements = els(L);
  p.scenarios = [newScenario("evacuation")];
  p.activeScenario = p.scenarios[0].id;
  p.scenarios[0].exitChoice = "nearest";
  p.settings.wallClearance = 0;
  tweak?.(p);
  return p;
}
function fixedProfile(p: Project, speed: number) {
  p.profiles = PROFILES.map((q) => ({ ...q, speedSd: 0, radiusSd: 0, speedMean: speed, speedMin: speed, speedMax: speed }));
}

// ------------------------------------------------------------------ fast marching
test("FMM: empty grid matches Euclidean distance within grid error", () => {
  const g: Grid = { nx: 201, ny: 201, h: 0.25, x0: 0, y0: 0 };
  const slow = new Float32Array(g.nx * g.ny).fill(1);
  const T = new Float32Array(g.nx * g.ny).fill(Infinity);
  const sx = 100, sy = 100;
  // exact initialisation in a 2-cell disk around the source (standard practice for point sources)
  for (let j = sy - 2; j <= sy + 2; j++) for (let i = sx - 2; i <= sx + 2; i++) T[j * g.nx + i] = Math.hypot(i - sx, j - sy) * g.h;
  fastMarch(g, slow, T);
  let maxAbs = 0, maxRel = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const d = Math.hypot(i - sx, j - sy) * g.h;
    const e = Math.abs(T[j * g.nx + i] - d);
    maxAbs = Math.max(maxAbs, e);
    if (d > 2) maxRel = Math.max(maxRel, e / d);
  }
  assert(maxAbs < 2 * g.h, `max abs error ${maxAbs.toFixed(3)} m ≥ 2 cells`);
  assert(maxRel < 0.03, `max relative error ${(maxRel * 100).toFixed(2)} % ≥ 3 %`);
  return `max |T − d| = ${maxAbs.toFixed(3)} m (${(maxAbs / g.h).toFixed(2)} cells), max relative ${(maxRel * 100).toFixed(2)} % at d > 2 m`;
});

test("FMM: distance around a wall matches the geodesic", () => {
  const g: Grid = { nx: 161, ny: 161, h: 0.25, x0: 0, y0: 0 };
  const N = g.nx * g.ny;
  const slow = new Float32Array(N).fill(1);
  // wall: vertical line x = 20 m from y = 0 to y = 30 m (cells blocked within one cell column)
  const wx = 80;
  for (let j = 0; j <= 120; j++) slow[j * g.nx + wx] = Infinity;
  const T = new Float32Array(N).fill(Infinity);
  const sx = 40, sy = 40;   // source (10, 10)
  for (let j = sy - 2; j <= sy + 2; j++) for (let i = sx - 2; i <= sx + 2; i++) T[j * g.nx + i] = Math.hypot(i - sx, j - sy) * g.h;
  fastMarch(g, slow, T);
  // target (30, 10) is behind the wall; geodesic goes around the wall end (≈ (20, 30.25))
  const tx = 120, ty = 40;
  const corner: P = [wx, 121];
  const geo = (Math.hypot(corner[0] - sx, corner[1] - sy) + Math.hypot(tx - corner[0], ty - corner[1])) * g.h;
  const got = T[ty * g.nx + tx];
  const err = Math.abs(got - geo);
  assert(err < 0.03 * geo + 2 * g.h, `T = ${got.toFixed(2)} m vs geodesic ${geo.toFixed(2)} m`);
  assert(got > Math.hypot(tx - sx, ty - sy) * g.h * 1.5, "front leaked through the wall");
  return `T = ${got.toFixed(2)} m, geodesic ${geo.toFixed(2)} m (straight line ${(Math.hypot(tx - sx, ty - sy) * g.h).toFixed(1)} m)`;
});

// ------------------------------------------------------------------ single agent
test("Single agent in an empty corridor: reaches desired speed and the exit on time (±5 %)", () => {
  const p = project((L) => [
    newElement("wall", L, { pts: [[0, 0], [50, 0]], thickness: 0.2 }),
    newElement("wall", L, { pts: [[0, 3], [50, 3]], thickness: 0.2 }),
    newElement("wall", L, { pts: [[0, 0], [0, 3]], thickness: 0.2 }),
    newElement("exit", L, { a: [50, 0], b: [50, 3] }),
    newElement("spawn", L, { pts: [[4.9, 1.4], [5.1, 1.4], [5.1, 1.6], [4.9, 1.6]], mode: "count", count: 1, profile: { adult: 1 }, premove: { type: "fixed", a: 0, b: 0 }, groupFrac: 0 }),
  ]);
  fixedProfile(p, 1.34);
  const sim = new Sim(p);
  assert(sim.n === 1, `expected 1 agent, got ${sim.n}`);
  let vmax = 0;
  const x0 = sim.x[0];
  while (!sim.finished()) { sim.step(); vmax = Math.max(vmax, Math.hypot(sim.vx[0], sim.vy[0])); }
  assert(sim.st[0] === ST_DONE, "agent did not exit");
  const dist = 50 - x0;
  // τ-lag of a first-order velocity response: x(t) = v0 (t − τ (1 − e^(−t/τ)))
  const expected = dist / 1.34 + 0.5;
  const tExit = sim.doneT[0];
  assert(Math.abs(vmax - 1.34) / 1.34 < 0.02, `peak speed ${vmax.toFixed(3)} m/s`);
  assert(Math.abs(tExit - expected) / expected < 0.05, `exit at ${tExit.toFixed(2)} s, expected ${expected.toFixed(2)} s`);
  return `peak speed ${vmax.toFixed(3)} m/s, exit after ${tExit.toFixed(2)} s (expected ${expected.toFixed(2)} s, ${(((tExit - expected) / expected) * 100).toFixed(1)} %)`;
});

// ------------------------------------------------------------------ bottleneck
function doorFlow(seed: number) {
  const p = project((L) => [
    // 10 × 10 m room, exit wall at x = 10 with a 1.0 m opening, then a short corridor to the final exit
    newElement("wall", L, { pts: [[10, 0], [0, 0], [0, 10], [10, 10]], thickness: 0.2 }),
    newElement("wall", L, { pts: [[10, 0], [10, 4.5]], thickness: 0.2 }),
    newElement("wall", L, { pts: [[10, 5.5], [10, 10]], thickness: 0.2 }),
    newElement("door", L, { a: [10, 4.5], b: [10, 5.5] }),
    newElement("wall", L, { pts: [[10, 0], [20, 0]], thickness: 0.2 }),
    newElement("wall", L, { pts: [[10, 10], [20, 10]], thickness: 0.2 }),
    newElement("exit", L, { a: [20, 0], b: [20, 10] }),
    newElement("spawn", L, { pts: [[0.5, 0.5], [9.3, 0.5], [9.3, 9.5], [0.5, 9.5]], mode: "count", count: 180, profile: { adult: 1 }, premove: { type: "fixed", a: 0, b: 0 }, groupFrac: 0 }),
  ], (pp) => { pp.scenarios[0].seed = seed; });
  const sim = new Sim(p);
  const doorIdx = sim.w.openings.findIndex((o) => !o.isExit);
  const times: number[] = [];
  let last = 0;
  while (!sim.finished()) {
    sim.step();
    const c = sim.crossings[doorIdx].reduce((a, b) => a + b, 0);
    while (last < c) { times.push(sim.t); last++; }
  }
  // steady phase: between the 20th and 160th person through the door
  const a = times[19], b = times[159];
  return { flow: 140 / (b - a), n: times.length, agents: sim.n, tet: sim.summary().tet };
}
test("Bottleneck: 1.0 m door specific flow with a dense crowd lies in the literature range", () => {
  const runs = [1, 2, 3].map(doorFlow);
  const mean = runs.reduce((a, r) => a + r.flow, 0) / runs.length;
  assert(runs.every((r) => r.n === r.agents && r.agents >= 170), `not everybody passed the door: ${runs.map((r) => `${r.n}/${r.agents}`).join(", ")}`);
  // Literature: SFPE Fsm 1.32 p/(m·s) of effective width; Weidmann 1.22 (corridor); Fruin ~1.3–1.4;
  // bottleneck experiments reach 1.6–1.9 (Seyfried et al. 2009). Accept the design range 1.2–1.5.
  assert(mean >= 1.2 && mean <= 1.5, `specific flow ${mean.toFixed(2)} p/(m·s) outside 1.2–1.5`);
  return `specific flow ${runs.map((r) => r.flow.toFixed(2)).join(", ")} → mean ${mean.toFixed(2)} p/(m·s) (3 seeds)`;
});

// ------------------------------------------------------------------ lanes
test("Counterflow: lane order parameter rises (lane formation)", () => {
  const p = project((L) => [
    newElement("wall", L, { pts: [[0, 0], [60, 0]], thickness: 0.2 }),
    newElement("wall", L, { pts: [[0, 5], [60, 5]], thickness: 0.2 }),
    newElement("exit", L, { id: "E", a: [0, 0], b: [0, 5] }),
    newElement("exit", L, { id: "W", a: [60, 0], b: [60, 5] }),
    newElement("spawn", L, { pts: [[12, 0.4], [48, 0.4], [48, 4.6], [12, 4.6]], mode: "count", count: 120, profile: { adult: 1 }, premove: { type: "fixed", a: 0, b: 0 }, groupFrac: 0 }),
    newElement("spawn", L, { pts: [[12, 0.4], [48, 0.4], [48, 4.6], [12, 4.6]], mode: "count", count: 120, profile: { adult: 1 }, premove: { type: "fixed", a: 0, b: 0 }, groupFrac: 0 }),
  ]);
  const sim = new Sim(p);
  // first spawn's people → the east exit (x = 60), second spawn's → the west exit (x = 0)
  const eIdx = sim.w.exits.findIndex((k) => sim.w.openings[k].ax === 60), wIdx = 1 - eIdx;
  const half = sim.n / 2;
  for (let i = 0; i < sim.n; i++) sim.exitSel[i] = i < half ? eIdx : wIdx;
  // freeze exit choice
  const dirOf = (i: number) => (i < half ? 1 : -1);
  const order = () => {
    let sum = 0, cnt = 0;
    for (let i = 0; i < sim.n; i++) {
      if (sim.st[i] === ST_DONE || sim.x[i] < 14 || sim.x[i] > 46) continue;
      let same = 0, opp = 0;
      for (let j = 0; j < sim.n; j++) {
        if (j === i || sim.st[j] === ST_DONE) continue;
        if (Math.abs(sim.y[j] - sim.y[i]) < 0.35 && Math.abs(sim.x[j] - sim.x[i]) < 2.5) { if (dirOf(j) === dirOf(i)) same++; else opp++; }
      }
      if (same + opp) { sum += ((same - opp) / (same + opp)) ** 2; cnt++; }
    }
    return cnt ? sum / cnt : 0;
  };
  const phi0 = order();
  for (let k = 0; k < 400; k++) { sim.step(); for (let i = 0; i < sim.n; i++) sim.exitSel[i] = i < half ? eIdx : wIdx; }
  const phi1 = order();
  assert(phi1 > phi0 + 0.2, `Φ ${phi0.toFixed(2)} → ${phi1.toFixed(2)}`);
  return `lane order Φ ${phi0.toFixed(2)} at t = 0 → ${phi1.toFixed(2)} at t = 20 s`;
});

// ------------------------------------------------------------------ determinism
test("Seeded runs are deterministic", () => {
  const p = buildSample("office");
  const run = (seed: number) => { const s = new Sim(p, p.activeScenario, { seed }); for (let k = 0; k < 300; k++) s.step(); return s; };
  const a = run(7), b = run(7), c = run(8);
  let same = true, diff = false;
  for (let i = 0; i < a.n; i++) { if (a.x[i] !== b.x[i] || a.y[i] !== b.y[i]) same = false; }
  for (let i = 0; i < Math.min(a.n, c.n); i++) if (a.x[i] !== c.x[i]) { diff = true; break; }
  assert(same, "same seed gave different positions");
  assert(diff || a.n !== c.n, "different seeds gave identical runs");
  return `${a.n} agents, 300 steps: identical for seed 7 twice, different for seed 8`;
});

// ------------------------------------------------------------------ DXF
const DXF = [
  "0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
  "0", "SECTION", "2", "BLOCKS",
  "0", "BLOCK", "8", "0", "2", "DOORBLK", "10", "0", "20", "0",
  "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "900", "21", "0",
  "0", "ENDBLK",
  "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "A-WALL", "10", "0", "20", "0", "30", "0", "11", "10000", "21", "0", "31", "0",
  "0", "LWPOLYLINE", "8", "A-WALL", "90", "3", "70", "1", "10", "0", "20", "5000", "10", "4000", "20", "5000", "10", "4000", "20", "8000",
  "0", "POLYLINE", "8", "OBST", "66", "1", "70", "1",
  "0", "VERTEX", "8", "OBST", "10", "1000", "20", "1000",
  "0", "VERTEX", "8", "OBST", "10", "2000", "20", "1000",
  "0", "VERTEX", "8", "OBST", "10", "2000", "20", "2000",
  "0", "SEQEND", "8", "OBST",
  "0", "ARC", "8", "A-WALL", "10", "5000", "20", "5000", "40", "1000", "50", "0", "51", "90",
  "0", "CIRCLE", "8", "OBST", "10", "7000", "20", "2000", "40", "500",
  "0", "LINE", "8", "EXIT", "10", "10000", "20", "0", "11", "10000", "21", "2000",
  "0", "INSERT", "8", "A-DOOR", "2", "DOORBLK", "10", "3000", "20", "0", "41", "1", "42", "1", "50", "0",
  "0", "ENDSEC", "0", "EOF", "",
].join("\n");
test("DXF parser reads lines, polylines, arcs, circles, blocks and layers", () => {
  const d = parseDXF(DXF);
  assert(d.units === 4, `units ${d.units}`);
  const layers = Object.keys(d.layers).sort().join(",");
  assert(layers === "A-DOOR,A-WALL,EXIT,OBST", `layers ${layers}`);
  const types = d.entities.map((e) => e.type).join(",");
  assert(types === "LINE,POLYLINE,POLYLINE,ARC,CIRCLE,LINE,LINE", `entity types ${types}`);
  const lw = d.entities[1];
  assert(lw.closed && lw.pts.length === 3 && lw.pts[1][0] === 4000, "LWPOLYLINE vertices");
  const arc = d.entities[3];
  assert(arc.type === "ARC" && arc.pts.length > 8 && Math.abs(arc.pts[arc.pts.length - 1][1] - 6000) < 1e-6, "ARC tessellation end point");
  const ins = d.entities[6];
  assert(ins.layer === "A-DOOR" && ins.pts[0][0] === 3000 && ins.pts[1][0] === 3900, "INSERT expanded onto the insert's layer");
  const { elements } = dxfToElements(d, { "A-WALL": "walls", OBST: "obstacles", EXIT: "exits", "A-DOOR": "doors" }, { scale: 0.001, level: "L" });
  const count = (k: string) => elements.filter((e) => e.kind === k).length;
  assert(count("wall") === 3 && count("obstacle") === 2 && count("exit") === 1 && count("door") === 1, `elements ${elements.map((e) => e.kind).join(",")}`);
  return `${d.entities.length} entities on ${Object.keys(d.layers).length} layers → ${elements.length} elements (mm → m)`;
});

// ------------------------------------------------------------------ hand calc sanity
test("Hydraulic hand calculation on the office sample is consistent", () => {
  const p = buildSample("office");
  const sim = new Sim(p);
  const hc = handCalc(sim);
  assert(hc.population === sim.n, "population mismatch");
  assert(hc.tHydraulic > 0 && isFinite(hc.tHydraulic), "hydraulic time");
  assert(hc.obcRequiredMm > 0, "OBC width");
  return `N = ${hc.population}, hydraulic RSET ${hc.tHydraulic.toFixed(0)} s, OBC requires ${hc.obcRequiredMm.toFixed(0)} mm, provides ${hc.obcProvidedMm.toFixed(0)} mm`;
});

console.log(failed ? `\n${failed} test(s) failed` : "\nall tests passed");
process.exit(failed ? 1 : 0);
