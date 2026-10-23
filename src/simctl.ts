// Main-thread side of the simulation: owns the worker, feeds live buffers and the store.
import SimWorker from "./sim/worker?worker&inline";
import type { FromWorker, ToWorker } from "./sim/protocol";
import { activeScenario, getState, setState } from "./store";
import { ingestFrame, live, resetLive, bumpLive } from "./live";

let worker: Worker | null = null;
let pendingStore: Partial<ReturnType<typeof getState>["sim"]> | null = null;
let storeTimer: ReturnType<typeof setTimeout> | null = null;
let onReady: (() => void) | null = null;
let onFinished: (() => void) | null = null;

function flushStore() {
  storeTimer = null;
  if (!pendingStore) return;
  const p = pendingStore;
  pendingStore = null;
  setState((s) => ({ sim: { ...s.sim, ...p } }));
}
function queueStore(p: Partial<ReturnType<typeof getState>["sim"]>) {
  pendingStore = { ...(pendingStore ?? {}), ...p };
  if (!storeTimer) storeTimer = setTimeout(flushStore, 120);
}

function send(m: ToWorker) { worker?.postMessage(m); }

function handle(m: FromWorker) {
  switch (m.type) {
    case "ready":
      resetLive(m.info);
      setState((s) => ({ info: m.info, handCalc: m.info.handCalc, results: null, series: null, scrub: null, follow: null, sim: { ...s.sim, status: "ready", n: m.info.n, t: 0, dirty: false, buildMs: m.buildMs, progress: null, error: null } }));
      onReady?.(); onReady = null;
      break;
    case "frame": {
      ingestFrame(m.frame, getState().project.settings.congestionDensity);
      const c = m.frame.counts;
      queueStore({ t: m.frame.t, ...c });
      if (m.series) setState({ series: m.series });
      break;
    }
    case "key":
      live.keys.push(m.key);
      break;
    case "progress":
      queueStore({ progress: m.t, t: m.t });
      break;
    case "finished":
      live.maxDensity = m.result.maxDensity;
      live.congestion = m.result.congestion;
      live.densVersion++;
      bumpLive();
      if (storeTimer) { clearTimeout(storeTimer); flushStore(); }
      setState((s) => {
        const summary = m.result.summary;
        const others = (s.project.results ?? []).filter((r) => r.scenarioId !== summary.scenarioId);
        return {
          results: { summary, series: m.result.series, crossings: m.result.crossings },
          series: m.result.series,
          project: { ...s.project, results: [...others, { ...summary, monteCarlo: s.project.results?.find((r) => r.scenarioId === summary.scenarioId)?.monteCarlo }] },
          sim: { ...s.sim, status: "finished", t: summary.simTime, progress: null },
          rightTab: "results",
        };
      });
      onFinished?.(); onFinished = null;
      break;
    case "error":
      setState((s) => ({ sim: { ...s.sim, status: "idle", error: m.message }, notice: `Simulation error: ${m.message}` }));
      break;
    default: break;
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new SimWorker();
  worker.onmessage = (e: MessageEvent<FromWorker>) => handle(e.data);
  worker.onerror = (e) => setState((s) => ({ sim: { ...s.sim, status: "idle", error: e.message }, notice: `Worker error: ${e.message}` }));
  return worker;
}

/** (Re)build the active scenario in the worker. Resolves when the population is placed and fields are built. */
export function loadScenario(seed?: number): Promise<void> {
  ensureWorker();
  const s = getState();
  const sc = activeScenario(s);
  setState((st) => ({ sim: { ...st.sim, status: "loading", t: 0, progress: null, error: null }, scrub: null }));
  return new Promise((res) => {
    onReady = res;
    send({ type: "load", project: s.project, scenarioId: sc.id, seed: seed ?? sc.seed });
  });
}

export async function play(speed?: number) {
  const s = getState();
  if (s.sim.status === "idle" || s.sim.dirty) await loadScenario();
  if (getState().sim.status === "finished") return;
  const sp = speed ?? getState().sim.speed;
  setState((st) => ({ sim: { ...st.sim, status: "playing", speed: sp }, scrub: null }));
  send({ type: "play", speed: sp >= 1000 ? Infinity : sp });
}
export function pause() {
  if (getState().sim.status !== "playing") return;
  send({ type: "pause" });
  setState((s) => ({ sim: { ...s.sim, status: "paused" } }));
}
export async function stepOnce(steps = 1) {
  const s = getState();
  if (s.sim.status === "idle" || s.sim.dirty) await loadScenario();
  if (getState().sim.status === "playing") pause();
  setState((st) => ({ sim: { ...st.sim, status: st.sim.status === "finished" ? "finished" : "paused" }, scrub: null }));
  send({ type: "step", steps });
}
export function setSpeed(speed: number) {
  setState((s) => ({ sim: { ...s.sim, speed } }));
  if (getState().sim.status === "playing") send({ type: "play", speed: speed >= 1000 ? Infinity : speed });
}
export async function runToEnd(): Promise<void> {
  const s = getState();
  if (s.sim.status === "idle" || s.sim.dirty) await loadScenario();
  if (getState().sim.status === "finished") return;
  setState((st) => ({ sim: { ...st.sim, status: "playing", progress: st.sim.t }, scrub: null }));
  return new Promise((res) => { onFinished = res; send({ type: "runToEnd" }); });
}
export async function reset() {
  if (getState().sim.status === "playing") pause();
  await loadScenario();
}

/** Advance the live run to `t` seconds as fast as possible, then continue at `speed` (used on first open). */
export async function warmStart(t: number, speed: number) {
  await loadScenario();
  const steps = Math.round(t / getState().project.settings.dt);
  send({ type: "step", steps });
  await new Promise((r) => setTimeout(r, 30));
  await play(speed);
}

// ------------------------------------------------------------------ Monte-Carlo (parallel workers)
let mcWorkers: Worker[] = [];
export function cancelMonteCarlo() {
  mcWorkers.forEach((w) => w.terminate());
  mcWorkers = [];
  setState((s) => ({ mc: s.mc ? { ...s.mc, running: false } : null }));
}
export function runMonteCarlo(n: number, firstSeed = 1): Promise<void> {
  cancelMonteCarlo();
  const s = getState();
  const sc = activeScenario(s);
  const seeds = Array.from({ length: n }, (_, i) => firstSeed + i);
  const k = Math.max(1, Math.min(n, Math.max(1, (navigator.hardwareConcurrency || 2) - 1), 4));
  setState({ mc: { running: true, total: n, seeds, runs: [] } });
  return new Promise((res) => {
    let left = n;
    for (let w = 0; w < k; w++) {
      const mine = seeds.filter((_, i) => i % k === w);
      if (!mine.length) continue;
      const wk = new SimWorker();
      mcWorkers.push(wk);
      wk.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === "batchResult") {
          setState((st) => ({ mc: st.mc ? { ...st.mc, runs: [...st.mc.runs, { seed: m.seed, tet: m.summary.tet, p90: m.summary.p90, agents: m.agents, stepsPerSec: m.stepsPerSec }].sort((a, b) => a.seed - b.seed) } : st.mc }));
          if (--left === 0) {
            mcWorkers.forEach((x) => x.terminate()); mcWorkers = [];
            setState((st) => {
              const mc = st.mc ? { ...st.mc, running: false } : null;
              const tets = (mc?.runs ?? []).map((r) => r.tet);
              const ok = tets.filter((v): v is number => v !== null).sort((a, b) => a - b);
              const q = (p: number) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor(p * (ok.length - 1) + 0.5))] : null);
              const monteCarlo = { seeds: (mc?.runs ?? []).map((r) => r.seed), tets, p50: q(0.5), p90: q(0.9), mean: ok.length ? +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(1) : null, min: ok[0] ?? null, max: ok[ok.length - 1] ?? null };
              const results = (st.project.results ?? []).map((r) => (r.scenarioId === sc.id ? { ...r, monteCarlo } : r));
              if (!results.some((r) => r.scenarioId === sc.id) && st.results) results.push({ ...st.results.summary, monteCarlo });
              return { mc, project: { ...st.project, results } };
            });
            res();
          }
        } else if (m.type === "error") {
          setState({ notice: `Monte-Carlo run failed: ${m.message}` });
        }
      };
      wk.postMessage({ type: "batch", project: s.project, scenarioId: sc.id, seeds: mine } satisfies ToWorker);
    }
  });
}

/** Steps per second of the engine in a worker for a synthetic hall of `agents` people. */
export function benchmark(agents: number, steps = 100): Promise<Extract<FromWorker, { type: "bench" }>> {
  return new Promise((res, rej) => {
    const wk = new SimWorker();
    wk.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.type === "bench") { wk.terminate(); res(e.data); } else if (e.data.type === "error") { wk.terminate(); rej(new Error(e.data.message)); } };
    wk.postMessage({ type: "bench", agents, steps } satisfies ToWorker);
  });
}
