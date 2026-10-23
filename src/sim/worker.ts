/// <reference lib="webworker" />
// Simulation worker: owns one Sim, steps it on a timer and posts transferable snapshots.
import { Sim, ST_DONE, ST_INACTIVE, ST_MOVE, ST_QUEUE, ST_SERVICE, ST_SEATED, ST_WAIT } from "./engine";
import { handCalc } from "./handcalc";
import { cellIndex } from "./world";
import { Q, type Frame, type FromWorker, type KeyFrame, type ToWorker, type WorldInfo } from "./protocol";
import { benchProject } from "./bench";

declare const self: DedicatedWorkerGlobalScope;
let sim: Sim | null = null;
let speed = 1;
let playing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWall = 0;
let lastKey = -1;
let lastDensityStep = -1;
let origin: [number, number] = [0, 0];
let finishedSent = false;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function info(s: Sim, seed: number): WorldInfo {
  let ox = Infinity, oy = Infinity;
  for (const L of s.w.levels) { ox = Math.min(ox, L.grid.x0); oy = Math.min(oy, L.grid.y0); }
  origin = [ox, oy];
  let hc = null;
  try { if (s.sc.kind === "evacuation" || s.sc.kind === "egress") hc = handCalc(s); } catch { hc = null; }
  return {
    n: s.n,
    levels: s.w.levels.map((L, i) => ({ id: L.id, name: L.name, elev: L.elev, height: L.height, dens: { nx: s.density[i].nx, ny: s.density[i].ny, cs: s.density[i].cs, x0: s.density[i].x0, y0: s.density[i].y0 } })),
    openings: s.w.openings.map((o) => ({ id: o.id, name: o.name, level: o.level, width: o.width, isExit: o.isExit, ax: o.ax, ay: o.ay, bx: o.bx, by: o.by })),
    attractors: s.w.attractors.map((a) => ({ id: a.id, name: a.name, level: a.level, type: a.el.type })),
    stairs: s.w.stairs.map((t) => ({ id: t.id, la: t.la, lb: t.lb, ax: t.ax, ay: t.ay, bx: t.bx, by: t.by, hw: t.hw, nx: t.nx, ny: t.ny })),
    prof: s.prof.slice(),
    origin, warnings: s.warnings, handCalc: hc, seed,
  };
}

function elevations(s: Sim): Float32Array {
  const z = new Float32Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const L = s.w.levels[s.lvl[i]];
    let e = L.elev;
    const c = cellIndex(L, s.x[i], s.y[i]);
    const si = c >= 0 ? L.stairCell[c] : -1;
    if (si >= 0) {
      const S = s.w.stairs[si];
      const along = Math.max(0, Math.min(S.L, (s.x[i] - S.ax) * S.ux + (s.y[i] - S.ay) * S.uy));
      e = L.elev + (s.w.levels[S.lb].elev - L.elev) * (along / S.L);
    }
    z[i] = e;
  }
  return z;
}

function sendFrame(withSeries: boolean) {
  const s = sim!;
  const n = s.n;
  const x = new Float32Array(n), y = new Float32Array(n), lvl = s.lvl.slice(), st = s.st.slice(), spd = new Uint8Array(n), dens = new Uint8Array(n);
  let done = 0, active = 0, moving = 0, waiting = 0, queued = 0;
  for (let i = 0; i < n; i++) {
    x[i] = s.x[i]; y[i] = s.y[i];
    spd[i] = Math.min(255, Math.round(Math.hypot(s.vx[i], s.vy[i]) * 100));
    dens[i] = Math.min(255, Math.round(s.localD[i] * 20));
    const k = st[i];
    if (k === ST_DONE || k === ST_SEATED) done++;
    else if (k !== ST_INACTIVE) { active++; if (k === ST_MOVE) moving++; else if (k === ST_WAIT) waiting++; else if (k === ST_QUEUE || k === ST_SERVICE) queued++; }
  }
  const z = elevations(s);
  const frame: Frame = { t: s.t, x, y, z, lvl, st, spd, dens, counts: { done, active, moving, waiting, queued } };
  const transfer: Transferable[] = [x.buffer, y.buffer, z.buffer, lvl.buffer, st.buffer, spd.buffer, dens.buffer];
  if (lastDensityStep < 0 || s.stepCount - lastDensityStep >= 10) {
    frame.densDt = lastDensityStep < 0 ? 0 : (s.stepCount - lastDensityStep) * s.dt;
    lastDensityStep = s.stepCount;
    frame.density = s.density.map((D) => { const u = new Uint8Array(D.dens.length); for (let c = 0; c < u.length; c++) u[c] = D.count[c] ? Math.min(255, Math.round(D.dens[c] * 20)) : 0; transfer.push(u.buffer); return u; });
  }
  frame.doorsOpen = s.doorOpen.slice();
  post({ type: "frame", frame, series: withSeries ? s.series : undefined }, transfer);
}

function keyFrame() {
  const s = sim!;
  const n = s.n;
  const k: KeyFrame = { t: s.t, x: new Uint16Array(n), y: new Uint16Array(n), z: new Uint16Array(n), lvl: s.lvl.slice(), st: s.st.slice() };
  const z = elevations(s);
  for (let i = 0; i < n; i++) {
    k.x[i] = Math.max(0, Math.min(65535, Math.round((s.x[i] - origin[0]) * Q)));
    k.y[i] = Math.max(0, Math.min(65535, Math.round((s.y[i] - origin[1]) * Q)));
    k.z[i] = Math.max(0, Math.min(65535, Math.round((z[i] + 100) * Q)));
  }
  post({ type: "key", key: k }, [k.x.buffer, k.y.buffer, k.z.buffer, k.lvl.buffer, k.st.buffer]);
}

function stepOnce() {
  const s = sim!;
  s.step();
  const sec = Math.floor(s.t + 1e-9);
  if (sec !== lastKey) { lastKey = sec; keyFrame(); }
}

function finish() {
  const s = sim!;
  if (finishedSent) return;
  finishedSent = true;
  playing = false;
  sendFrame(true);
  post({
    type: "finished",
    result: { summary: s.summary(), series: s.series, maxDensity: s.density.map((d) => d.max.slice()), congestion: s.density.map((d) => d.cong.slice()), crossings: s.crossings },
  });
}

function tick() {
  timer = null;
  if (!sim || !playing) return;
  const now = performance.now();
  const wall = Math.min(0.25, (now - lastWall) / 1000);
  lastWall = now;
  const budget = now + 28;
  if (!isFinite(speed)) {
    while (!sim.finished() && performance.now() < budget) stepOnce();
  } else {
    let target = wall * speed;
    while (target > 1e-9 && !sim.finished() && performance.now() < budget) { stepOnce(); target -= sim.dt; }
  }
  if (sim.finished()) { finish(); return; }
  sendFrame(sim.stepCount % 20 < 3);
  timer = setTimeout(tick, 16);
}

function runBatch(project: Extract<ToWorker, { type: "batch" }>) {
  for (const seed of project.seeds) {
    const s = new Sim(project.project, project.scenarioId, { seed });
    const tb = performance.now();
    s.runToEnd();
    const dt = (performance.now() - tb) / 1000;
    post({ type: "batchResult", seed, summary: s.summary(), stepsPerSec: s.stepCount / Math.max(1e-6, dt), agents: s.n });
  }
}

function handle(m: ToWorker) {
  switch (m.type) {
    case "load": {
      if (timer) clearTimeout(timer);
      playing = false; finishedSent = false; lastKey = -1; lastDensityStep = -1;
      const t0 = performance.now();
      sim = new Sim(m.project, m.scenarioId, { seed: m.seed });
      const buildMs = performance.now() - t0;
      post({ type: "ready", info: info(sim, m.seed), buildMs });
      keyFrame(); lastKey = 0;
      sendFrame(true);
      break;
    }
    case "play":
      if (!sim) return;
      speed = m.speed;
      if (sim.finished()) { finish(); return; }
      playing = true; lastWall = performance.now();
      if (!timer) timer = setTimeout(tick, 0);
      break;
    case "pause":
      playing = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (sim) sendFrame(true);
      break;
    case "step":
      if (!sim) return;
      for (let k = 0; k < m.steps && !sim.finished(); k++) stepOnce();
      if (sim.finished()) finish(); else sendFrame(true);
      break;
    case "runToEnd": {
      if (!sim) return;
      playing = false;
      if (timer) { clearTimeout(timer); timer = null; }
      let lastP = performance.now();
      while (!sim.finished()) {
        stepOnce();
        if (performance.now() - lastP > 120) { lastP = performance.now(); post({ type: "progress", t: sim.t, done: sim.completionTimes().length, n: sim.n }); }
      }
      finish();
      break;
    }
    case "batch": runBatch(m); break;
    case "bench": {
      const t0 = performance.now();
      const p = benchProject(m.agents);
      const s = new Sim(p);
      const buildMs = performance.now() - t0;
      for (let k = 0; k < 10; k++) s.step();   // warm-up (JIT)
      const t1 = performance.now();
      for (let k = 0; k < m.steps; k++) s.step();
      const ms = (performance.now() - t1) / m.steps;
      post({ type: "bench", agents: s.n, steps: m.steps, stepsPerSec: 1000 / ms, msPerStep: ms, buildMs });
      break;
    }
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  try { handle(e.data); } catch (err) { post({ type: "error", message: (err as Error).message ?? String(err) }); }
};
