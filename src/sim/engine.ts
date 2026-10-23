// Social-force crowd engine (Helbing & Molnár 1995; Helbing, Farkas & Vicsek 2000) with floor-field navigation.
// Struct-of-arrays agents, per-level uniform spatial hash, fixed step with force sub-steps. No DOM: runs in a
// Web Worker in the app and under Node in the tests.
import type { AttractorType, Dist, Profile, ProfileId, Project, ResultSummary, Scenario } from "../model/types";
import { pointInPoly, queueSlot, seatingFrame } from "../model/geom";
import { PROFILE_ORDER } from "../model/defaults";
import { Rng } from "./rng";
import { compileWorld, hashCell, cellIndex, SEG_BARRIER, SEG_DOOR, type World } from "./world";
import { computeField, fieldDir, sampleT, type Field, type GoalSpec } from "./fields";

export const ST_INACTIVE = 0, ST_WAIT = 1, ST_MOVE = 2, ST_QUEUE = 3, ST_SERVICE = 4, ST_DONE = 5, ST_SEATED = 6, ST_IDLE = 7;
export { PROFILE_ORDER };

/** One leg of an agent's plan. */
export type Leg =
  | { k: "exit" }
  | { k: "attr"; type: AttractorType }
  | { k: "seat"; block: number; seat: number }
  | { k: "zone"; spawn: number };

export interface Series {
  t: number[]; done: number[]; active: number[]; moving: number[]; meanSpeed: number[]; maxDensity: number[];
  queue: number[][];     // per attractor
  exitCum: number[][];   // per opening (cumulative crossings; exits count leavers)
}

export interface DensityLevel { nx: number; ny: number; cs: number; x0: number; y0: number; count: Uint16Array; dens: Float32Array; max: Float32Array; cong: Float32Array }

const DENSITY_EVERY = 10;     // steps (0.5 s at dt 0.05)

export class Sim {
  readonly project: Project;
  readonly sc: Scenario;
  readonly w: World;
  readonly rng: Rng;
  readonly dt: number;
  readonly sub: number;
  t = 0;
  stepCount = 0;
  wallMs = 0;
  n = 0;
  // agent arrays
  x!: Float64Array; y!: Float64Array; vx!: Float64Array; vy!: Float64Array; px!: Float64Array; py!: Float64Array;
  ex!: Float64Array; ey!: Float64Array;
  lvl!: Uint8Array; st!: Uint8Array; prof!: Uint8Array;
  r!: Float32Array; v0!: Float32Array; tau!: Float32Array; mass!: Float32Array; sfac!: Float32Array;
  startT!: Float64Array;   // time the agent appears (ingress) — then pre-movement until moveT
  moveT!: Float64Array;
  doneT!: Float64Array;
  premove!: Float32Array;
  group!: Int32Array;
  exitSel!: Int16Array;    // index into w.exits
  attrSel!: Int16Array;    // attractor in use
  qpos!: Int32Array;       // position in queue
  server!: Int16Array;
  servEnd!: Float64Array;
  walked!: Float32Array;
  congT!: Float32Array;
  localD!: Float32Array;
  legs: Leg[][] = [];
  legIdx!: Int16Array;
  lastCross!: Int16Array; lastSign!: Int8Array; lastBin!: Int32Array;
  stuckT!: Float32Array;
  home: ({ block: number; seat: number } | { spawn: number } | null)[] = [];
  // fields
  fields = new Map<string, Field>();
  exitFields: Field[] = [];
  // queues
  queues: number[][] = [];
  servers: { agent: number; end: number }[][] = [];
  // doors
  tokens: Float64Array;
  doorOpen: Uint8Array;
  // metrics
  density: DensityLevel[] = [];
  crossings: number[][] = [];  // per opening: 10 s bins
  exitCount: Int32Array;
  series: Series;
  queuePeak: Int32Array;
  maxDensity = 0;
  warnings: string[] = [];
  // spatial hash
  private hOff: number[] = []; private hDims: { x0: number; y0: number; nx: number; ny: number }[] = [];
  private cellStart = new Int32Array(1); private order = new Int32Array(1); private key = new Int32Array(1);
  private tmp = new Float64Array(2);
  private exitSorted: Float64Array[] = [];
  private finishedAt: number | null = null;
  private profiles: Profile[];
  readonly seedUsed: number;
  private fxA = new Float64Array(0); private fyA = new Float64Array(0);
  private penD = new Float64Array(0); private penX = new Float64Array(0); private penY = new Float64Array(0);
  private attrF: (Field | null)[] = []; private seatF: (Field | null)[] = []; private zoneF: (Field | null)[] = [];

  constructor(project: Project, scenarioId?: string, opts: { seed?: number; agentLimit?: number } = {}) {
    this.project = project;
    this.sc = project.scenarios.find((s) => s.id === (scenarioId ?? project.activeScenario)) ?? project.scenarios[0];
    if (!this.sc) throw new Error("Project has no scenario");
    this.dt = project.settings.dt;
    this.sub = Math.max(1, Math.round(project.settings.substeps));
    this.seedUsed = opts.seed ?? this.sc.seed;
    this.rng = new Rng(this.seedUsed);
    this.profiles = PROFILE_ORDER.map((id) => project.profiles.find((p) => p.id === id)!).map((p, i) => p ?? project.profiles[i]);
    this.w = compileWorld(project, this.sc);
    this.warnings.push(...this.w.warnings);
    const nO = this.w.openings.length;
    this.tokens = new Float64Array(nO);
    this.doorOpen = new Uint8Array(nO).fill(1);
    this.w.openings.forEach((o, i) => { if (o.maxFlow) this.tokens[i] = Math.max(1, o.maxFlow); });
    this.exitCount = new Int32Array(nO);
    this.crossings = this.w.openings.map(() => []);
    this.queues = this.w.attractors.map(() => []);
    this.servers = this.w.attractors.map((a) => a.servers.map(() => ({ agent: -1, end: 0 })));
    this.queuePeak = new Int32Array(this.w.attractors.length);
    this.series = { t: [], done: [], active: [], moving: [], meanSpeed: [], maxDensity: [], queue: this.w.attractors.map(() => []), exitCum: this.w.openings.map(() => []) };
    this.populate(opts.agentLimit ?? 200_000);
    this.buildFields();
    this.chooseInitialTargets();
    this.initHash();
    this.initDensity();
  }

  // ------------------------------------------------------------------ population
  private alloc(n: number) {
    const F = () => new Float64Array(n), f = () => new Float32Array(n);
    this.x = F(); this.y = F(); this.vx = F(); this.vy = F(); this.px = F(); this.py = F(); this.ex = F(); this.ey = F();
    this.lvl = new Uint8Array(n); this.st = new Uint8Array(n); this.prof = new Uint8Array(n);
    this.r = f(); this.v0 = f(); this.tau = f(); this.mass = f(); this.sfac = f();
    this.startT = F(); this.moveT = F(); this.doneT = F().fill(NaN); this.premove = f();
    this.group = new Int32Array(n).fill(-1); this.exitSel = new Int16Array(n).fill(-1); this.attrSel = new Int16Array(n).fill(-1);
    this.qpos = new Int32Array(n).fill(-1); this.server = new Int16Array(n).fill(-1); this.servEnd = F();
    this.walked = f(); this.congT = f(); this.localD = f(); this.legIdx = new Int16Array(n);
    this.stuckT = new Float32Array(n);
    this.lastCross = new Int16Array(n).fill(-1); this.lastSign = new Int8Array(n); this.lastBin = new Int32Array(n);
  }

  private pickProfile(mix: Partial<Record<ProfileId, number>>): number {
    const w: [number, number][] = PROFILE_ORDER.map((id, i) => [i, mix[id] ?? 0]);
    if (!w.some(([, v]) => v > 0)) return 0;
    return this.rng.pick(w);
  }
  private makeBody(i: number, pi: number) {
    const p = this.profiles[pi];
    const rng = this.rng;
    this.prof[i] = pi;
    this.v0[i] = Math.min(p.speedMax, Math.max(p.speedMin, p.speedMean + p.speedSd * rng.normal()));
    this.r[i] = Math.max(0.12, p.radius + p.radiusSd * Math.max(-2, Math.min(2, rng.normal())));
    this.tau[i] = p.tau; this.mass[i] = p.mass; this.sfac[i] = p.stairFactor;
  }

  private populate(limit: number) {
    const sc = this.sc, w = this.w, rng = this.rng;
    const scale = Math.max(0, sc.agentScale ?? 1);
    type Spec = { x: number; y: number; level: number; prof: number; premove: number; legs: Leg[]; startT: number; seated: boolean; group: number; home: Sim["home"][number] };
    const specs: Spec[] = [];
    const inc = <T extends { id: string }>(list: T[], sel: string[] | "all") => list.map((v, i) => [v, i] as const).filter(([v]) => sel === "all" || sel.includes(v.id));
    let groupSeq = 0;
    // free seats per block (for ingress) — shuffled with the seeded RNG
    const freeSeats = w.seating.map((s) => { const a = s.seats.map((_, i) => i); for (let i = a.length - 1; i > 0; i--) { const j = rng.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; });
    const visitTypes = (Object.entries(sc.visit ?? {}) as [AttractorType, number][]).filter(([t, p]) => p > 0 && w.attractors.some((a) => a.el.type === t));
    const visitLeg = (): Leg | null => {
      let u = rng.next();
      for (const [t, p] of visitTypes) { if (u < p) return { k: "attr", type: t }; u -= p; }
      return null;
    };
    const hasGates = w.attractors.some((a) => a.el.type === "gate");

    // seated occupants
    if (sc.kind !== "ingress") for (const [s, bi] of inc(w.seating, sc.seating)) {
      for (let si = 0; si < s.seats.length; si++) {
        if (rng.next() >= Math.min(1, s.el.occupancy * scale)) continue;
        const [x, y] = s.seats[si];
        let legs: Leg[] = [{ k: "exit" }];
        if (sc.kind === "circulation") { const v = visitLeg(); legs = v ? [v, { k: "seat", block: bi, seat: si }] : []; }
        // wheelchair users sit at wheelchair / aisle positions, never mid-row
        let prof = this.pickProfile(s.el.profile);
        if (prof === PROFILE_ORDER.indexOf("mobility") && !s.aisleSeat[si]) prof = PROFILE_ORDER.indexOf("older");
        specs.push({ x, y, level: s.level, prof, premove: rng.sample(sc.seatPremove), legs, startT: 0, seated: sc.kind === "circulation", group: -1, home: { block: bi, seat: si } });
      }
    }
    // spawn zones
    for (const [s, zi] of inc(w.spawns, sc.spawns)) {
      if (sc.kind === "ingress" && !s.el.arrivals) continue;
      if (sc.kind !== "ingress" && s.el.arrivals) continue;
      const target = Math.round((s.el.mode === "count" ? s.el.count : s.el.density * s.area) * scale);
      const pts = this.samplePoints(s.level, s.el.pts, target, 0.25);
      const groupSizes: number[] = [];
      if (pts.length < target) this.warnings.push(`${s.name}: placed ${pts.length} of ${target} people (zone too small or blocked)`);
      // groups are formed from people standing near each other
      const used = new Uint8Array(pts.length);
      const order: number[] = [];
      let k = 0;
      for (let lead = 0; lead < pts.length; lead++) {
        if (used[lead]) continue;
        const inGroup = rng.next() < s.el.groupFrac;
        const want = inGroup ? Math.max(2, Math.round(rng.range(s.el.groupSize[0], s.el.groupSize[1] + 0.999) - 0.5)) : 1;
        used[lead] = 1; order.push(lead);
        const near: [number, number][] = [];
        if (want > 1) for (let q = 0; q < pts.length; q++) if (!used[q]) { const d = Math.hypot(pts[q][0] - pts[lead][0], pts[q][1] - pts[lead][1]); if (d < 3) near.push([d, q]); }
        near.sort((x, y) => x[0] - y[0]);
        for (let m = 0; m < want - 1 && m < near.length; m++) { used[near[m][1]] = 1; order.push(near[m][1]); }
        groupSizes.push(Math.min(want, 1 + near.length));
      }
      const ordered = order.map((q) => pts[q]);
      pts.length = 0; pts.push(...ordered);
      let gi = 0;
      while (k < pts.length) {
        const size = groupSizes[gi++] ?? 1;
        const inGroup = size > 1;
        const gid = inGroup ? groupSeq++ : -1;
        const pre = rng.sample(s.el.premove);
        const arrive = sc.kind === "ingress" ? rng.range(0, Math.max(1, sc.arrivalWindow)) : 0;
        let legs: Leg[] = [{ k: "exit" }];
        if (sc.kind === "ingress") {
          legs = [];
          if (sc.useGates && hasGates) legs.push({ k: "attr", type: "gate" });
          // choose a block with free seats, weighted by remaining capacity
          const opts: [number, number][] = freeSeats.map((f, i) => [i, f.length]);
          if (opts.some(([, c]) => c > 0)) { const b = rng.pick(opts); legs.push({ k: "seat", block: b, seat: freeSeats[b].length ? freeSeats[b].pop()! : -1 }); }
          else if (w.seating.length) legs.push({ k: "seat", block: rng.int(w.seating.length), seat: -1 });
        } else if (sc.kind === "circulation") {
          const v = visitLeg();
          legs = v ? [v, { k: "zone", spawn: zi }] : [];
        }
        // group members share plan and start; seats for ingress groups are taken next to each other where possible
        for (let m = 0; m < size && k < pts.length; m++, k++) {
          const mLegs = m === 0 ? legs : legs.map((l) => (l.k === "seat" && freeSeats[l.block]?.length ? { ...l, seat: freeSeats[l.block].pop()! } : l));
          specs.push({ x: pts[k][0], y: pts[k][1], level: s.level, prof: this.pickProfile(s.el.profile), premove: pre + (gid >= 0 && m > 0 ? rng.range(0, 3) : 0), legs: mLegs, startT: arrive + m * 0.4, seated: false, group: gid, home: { spawn: zi } });
        }
      }
    }
    if (specs.length > limit) { this.warnings.push(`Population capped at ${limit.toLocaleString()} agents`); specs.length = limit; }
    const n = specs.length;
    this.n = n;
    this.alloc(n);
    const gMinV = new Map<number, number>();
    specs.forEach((s, i) => {
      this.x[i] = this.px[i] = s.x; this.y[i] = this.py[i] = s.y; this.lvl[i] = s.level;
      this.makeBody(i, s.prof);
      this.premove[i] = s.premove;
      this.startT[i] = s.startT;
      this.moveT[i] = s.startT + s.premove;
      this.legs[i] = s.legs;
      this.home[i] = s.home;
      this.group[i] = s.group;
      if (s.group >= 0) gMinV.set(s.group, Math.min(gMinV.get(s.group) ?? Infinity, this.v0[i]));
      if (s.startT > 0) this.st[i] = ST_INACTIVE;
      else if (!s.legs.length) this.st[i] = s.seated ? ST_SEATED : ST_IDLE;
      else this.st[i] = s.seated ? ST_SEATED : ST_WAIT;
    });
    // groups walk at the pace of their slowest member (Moussaïd et al. 2010)
    for (let i = 0; i < n; i++) if (this.group[i] >= 0) this.v0[i] = gMinV.get(this.group[i])!;
  }

  /** Random non-overlapping positions inside a polygon on free navigation cells. */
  private samplePoints(level: number, pts: [number, number][], n: number, r: number): [number, number][] {
    const L = this.w.levels[level];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    const out: [number, number][] = [];
    const cs = 0.5, gx = Math.ceil((x1 - x0) / cs) + 1;
    const buckets = new Map<number, number[]>();
    const minD = 2 * r + 0.04;
    let tries = 0;
    while (out.length < n && tries < n * 60 + 500) {
      tries++;
      const x = this.rng.range(x0, x1), y = this.rng.range(y0, y1);
      if (!pointInPoly(x, y, pts)) continue;
      const c = cellIndex(L, x, y);
      if (c < 0 || L.blocked[c]) continue;
      const bi = Math.floor((x - x0) / cs), bj = Math.floor((y - y0) / cs);
      let clash = false;
      for (let dj = -1; dj <= 1 && !clash; dj++) for (let di = -1; di <= 1 && !clash; di++) {
        const b = buckets.get((bj + dj) * gx + bi + di);
        if (b) for (const k of b) if (Math.hypot(out[k][0] - x, out[k][1] - y) < minD) { clash = true; break; }
      }
      if (clash) continue;
      const key = bj * gx + bi;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(out.length);
      out.push([x, y]);
    }
    return out;
  }

  // ------------------------------------------------------------------ fields
  attrField(i: number): Field { return (this.attrF[i] ??= this.field(`attr:${i}`)); }
  seatField(i: number): Field { return (this.seatF[i] ??= this.field(`seat:${i}`)); }
  zoneField(i: number): Field { return (this.zoneF[i] ??= this.field(`zone:${i}`)); }
  field(key: string): Field {
    let f = this.fields.get(key);
    if (f) return f;
    const w = this.w;
    const [kind, sidx] = key.split(":");
    const i = Number(sidx);
    let goals: GoalSpec[] = [];
    if (kind === "exit") { const o = w.openings[w.exits[i]]; goals = [{ kind: "segment", level: o.level, ax: o.ax, ay: o.ay, bx: o.bx, by: o.by }]; }
    else if (kind === "attr") { const a = w.attractors[i]; goals = [{ kind: "points", level: a.level, pts: [a.el.p, ...a.servers], r: 0.7 }]; }
    else if (kind === "seat") { const s = w.seating[i]; const { toWorld } = seatingFrame(s.el); goals = [{ kind: "polygon", level: s.level, pts: [toWorld(0, 0), toWorld(s.el.width, 0), toWorld(s.el.width, s.el.depth), toWorld(0, s.el.depth)] }]; }
    else if (kind === "zone") { const s = w.spawns[i]; goals = [{ kind: "polygon", level: s.level, pts: s.el.pts }]; }
    f = computeField(w, key, goals);
    this.fields.set(key, f);
    return f;
  }
  private buildFields() {
    const needExit = this.legs.some((l) => l.some((g) => g.k === "exit"));
    if (needExit) this.exitFields = this.w.exits.map((_, i) => this.field(`exit:${i}`));
    const types = new Set<AttractorType>();
    for (const l of this.legs) for (const g of l) {
      if (g.k === "attr") types.add(g.type);
      if (g.k === "seat") this.field(`seat:${g.block}`);
      if (g.k === "zone") this.field(`zone:${g.spawn}`);
    }
    this.w.attractors.forEach((a, i) => { if (types.has(a.el.type)) this.field(`attr:${i}`); });
    this.exitSorted = this.w.exits.map(() => new Float64Array(0));
  }

  private chooseInitialTargets() {
    for (let i = 0; i < this.n; i++) this.startLeg(i, true);
  }

  /** Called when an agent begins a leg: pick the concrete exit / attractor. */
  private startLeg(i: number, initial = false) {
    const leg = this.legs[i][this.legIdx[i]];
    if (!leg) return;
    if (leg.k === "exit") {
      const g = this.group[i];
      const lead = g >= 0 ? this.groupLeader(i) : i;
      if (lead !== i && this.exitSel[lead] >= 0) { this.exitSel[i] = this.exitSel[lead]; return; }
      this.exitSel[i] = this.bestExit(i, false);
    } else if (leg.k === "attr") {
      // least expected time: walk + queue wait
      let best = -1, bc = Infinity;
      const L = this.w.levels[this.lvl[i]];
      this.w.attractors.forEach((a, ai) => {
        if (a.el.type !== leg.type) return;
        const T = this.attrField(ai).T[this.lvl[i]];
        const walk = sampleT(L, T, this.x[i], this.y[i]) / Math.max(0.3, this.v0[i]);
        const mean = a.el.service.type === "lognormal" ? a.el.service.a * Math.exp(a.el.service.b ** 2 / 2) : a.el.service.type === "uniform" ? (a.el.service.a + a.el.service.b) / 2 : a.el.service.a;
        const wait = (this.queues[ai].length * mean) / Math.max(1, a.el.servers);
        const c = walk + wait;
        if (c < bc) { bc = c; best = ai; }
      });
      this.attrSel[i] = best;
      if (best < 0 && !initial) this.nextLeg(i);
    }
  }
  private groupLeader(i: number): number {
    const g = this.group[i];
    for (let k = i; k >= 0; k--) { if (this.group[k] !== g) return k + 1; }
    return 0;
  }

  private exitCapacity(e: number) { return 1.3 * Math.max(0.5, this.w.openings[this.w.exits[e]].width); }
  private bestExit(i: number, congestion: boolean): number {
    const L = this.w.levels[this.lvl[i]];
    let best = -1, bc = Infinity, curCost = Infinity;
    const cur = this.exitSel[i];
    for (let e = 0; e < this.exitFields.length; e++) {
      const T = sampleT(L, this.exitFields[e].T[this.lvl[i]], this.x[i], this.y[i]);
      if (!isFinite(T)) continue;
      let c = T / Math.max(0.3, this.v0[i]);
      if (congestion) {
        const arr = this.exitSorted[e];
        let lo = 0, hi = arr.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < T) lo = m + 1; else hi = m; }
        c = Math.max(c, lo / this.exitCapacity(e));
      }
      if (e === cur) curCost = c;
      if (c < bc) { bc = c; best = e; }
    }
    // hysteresis: only switch for a clear gain
    if (congestion && cur >= 0 && isFinite(curCost) && !(bc < curCost * 0.85 && curCost - bc > 4)) return cur;
    return best;
  }

  private nextLeg(i: number) {
    this.legIdx[i]++;
    this.attrSel[i] = -1;
    if (this.legIdx[i] >= this.legs[i].length) {
      this.st[i] = ST_IDLE; this.doneT[i] = this.t; this.vx[i] = this.vy[i] = 0;
      return;
    }
    this.st[i] = ST_MOVE;
    this.startLeg(i);
  }

  // ------------------------------------------------------------------ spatial hash
  private initHash() {
    let off = 0;
    this.hOff = []; this.hDims = [];
    for (const L of this.w.levels) {
      const g = L.grid;
      const nx = Math.ceil((g.nx * g.h) / 1.0) + 1, ny = Math.ceil((g.ny * g.h) / 1.0) + 1;
      this.hOff.push(off); this.hDims.push({ x0: g.x0, y0: g.y0, nx, ny });
      off += nx * ny;
    }
    this.cellStart = new Int32Array(off + 1);
    this.order = new Int32Array(this.n);
    this.key = new Int32Array(this.n);
  }
  private rebuildHash() {
    const n = this.n, cs = this.cellStart, key = this.key, st = this.st;
    cs.fill(0);
    for (let i = 0; i < n; i++) {
      const s = st[i];
      if (s === ST_INACTIVE || s === ST_DONE || s === ST_SEATED) { key[i] = -1; continue; }
      const d = this.hDims[this.lvl[i]];
      let cx = Math.floor(this.x[i] - d.x0), cy = Math.floor(this.y[i] - d.y0);
      cx = cx < 0 ? 0 : cx >= d.nx ? d.nx - 1 : cx; cy = cy < 0 ? 0 : cy >= d.ny ? d.ny - 1 : cy;
      const k = this.hOff[this.lvl[i]] + cy * d.nx + cx;
      key[i] = k; cs[k + 1]++;
    }
    for (let k = 1; k < cs.length; k++) cs[k] += cs[k - 1];
    const fill = cs.slice(0, cs.length - 1);
    for (let i = 0; i < n; i++) if (key[i] >= 0) this.order[fill[key[i]]++] = i;
    // cell-ordered copies of what the neighbour loop reads (cache-friendly)
    if (this.sX.length !== n) { this.sX = new Float64Array(n); this.sY = new Float64Array(n); this.sVX = new Float64Array(n); this.sVY = new Float64Array(n); this.sR = new Float64Array(n); }
    const m = cs[cs.length - 1];
    for (let q = 0; q < m; q++) {
      const i = this.order[q];
      this.sX[q] = this.x[i]; this.sY[q] = this.y[i]; this.sVX[q] = this.vx[i]; this.sVY[q] = this.vy[i];
      this.sR[q] = this.r[i] * (1 - 0.35 * Math.min(1, this.stuckT[i] / 8));
    }
  }
  private sX = new Float64Array(0); private sY = new Float64Array(0); private sVX = new Float64Array(0); private sVY = new Float64Array(0); private sR = new Float64Array(0);

  // ------------------------------------------------------------------ density
  private initDensity() {
    const cs = this.project.settings.densityCell;
    this.density = this.w.levels.map((L) => {
      const g = L.grid;
      const nx = Math.ceil((g.nx * g.h) / cs), ny = Math.ceil((g.ny * g.h) / cs);
      return { nx, ny, cs, x0: g.x0, y0: g.y0, count: new Uint16Array(nx * ny), dens: new Float32Array(nx * ny), max: new Float32Array(nx * ny), cong: new Float32Array(nx * ny) };
    });
  }
  private updateDensity(elapsed: number) {
    const thr = this.project.settings.congestionDensity;
    for (const D of this.density) D.count.fill(0);
    for (let i = 0; i < this.n; i++) {
      const s = this.st[i];
      if (s === ST_INACTIVE || s === ST_DONE || s === ST_SEATED) continue;
      const D = this.density[this.lvl[i]];
      const ci = Math.floor((this.x[i] - D.x0) / D.cs), cj = Math.floor((this.y[i] - D.y0) / D.cs);
      if (ci >= 0 && cj >= 0 && ci < D.nx && cj < D.ny) D.count[cj * D.nx + ci]++;
    }
    let gmax = 0;
    for (const D of this.density) {
      const { nx, ny, count, dens, max, cong } = D;
      // 3×3 box (1.5 m × 1.5 m at the default 0.5 m cell): density in persons per m²
      const area = 9 * D.cs * D.cs;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let dj = -1; dj <= 1; dj++) { const jj = j + dj; if (jj < 0 || jj >= ny) continue; for (let di = -1; di <= 1; di++) { const ii = i + di; if (ii < 0 || ii >= nx) continue; s += count[jj * nx + ii]; } }
        const c = j * nx + i;
        const d = s / area;
        dens[c] = d;
        if (count[c] > 0) {      // only where someone actually stands — no halo around isolated people
          if (d > max[c]) max[c] = d;
          if (d >= thr) cong[c] += elapsed;
        }
        if (d > gmax && count[c] > 0) gmax = d;
      }
    }
    this.maxDensity = Math.max(this.maxDensity, gmax);
    for (let i = 0; i < this.n; i++) {
      const s = this.st[i];
      if (s === ST_INACTIVE || s === ST_DONE || s === ST_SEATED) { this.localD[i] = 0; continue; }
      const D = this.density[this.lvl[i]];
      const ci = Math.floor((this.x[i] - D.x0) / D.cs), cj = Math.floor((this.y[i] - D.y0) / D.cs);
      const d = ci >= 0 && cj >= 0 && ci < D.nx && cj < D.ny ? D.dens[cj * D.nx + ci] : 0;
      this.localD[i] = d;
      if (d >= thr && (s === ST_MOVE || s === ST_QUEUE)) this.congT[i] += elapsed;
    }
    return gmax;
  }

  // ------------------------------------------------------------------ main step
  step() {
    const t0 = performance.now();
    const dt = this.dt, n = this.n, t = this.t;
    // activation, pre-movement, service completion
    for (let i = 0; i < n; i++) {
      const s = this.st[i];
      if (s === ST_INACTIVE && t >= this.startT[i]) this.activate(i);
      else if ((s === ST_WAIT || s === ST_SEATED) && t >= this.moveT[i] && this.legs[i].length > this.legIdx[i]) {
        this.st[i] = ST_MOVE;
        if (s === ST_SEATED) { /* stands up in place */ }
      }
    }
    this.updateServices();
    // periodic exit re-evaluation with congestion awareness
    if (this.sc.exitChoice === "least-time" && this.exitFields.length > 1) {
      if (this.stepCount % 20 === 0) this.sortExitLoads();
      const phase = this.stepCount % 40;
      for (let i = phase; i < n; i += 40) {
        if (this.st[i] !== ST_MOVE || this.legs[i][this.legIdx[i]]?.k !== "exit") continue;
        if (this.group[i] >= 0 && this.groupLeader(i) !== i) { this.exitSel[i] = this.exitSel[this.groupLeader(i)]; continue; }
        const e = this.bestExit(i, true);
        if (e >= 0) this.exitSel[i] = e;
      }
    }
    this.desiredDirections();
    for (let k = 0; k < n; k++) { this.px[k] = this.x[k]; this.py[k] = this.y[k]; }
    const h = dt / this.sub;
    for (let s = 0; s < this.sub; s++) { this.rebuildHash(); this.forces(h); }
    this.postMove();
    this.refillDoors(dt);
    this.t += dt;
    this.stepCount++;
    if (this.stepCount % DENSITY_EVERY === 0) this.updateDensity(dt * DENSITY_EVERY);
    if (this.stepCount % Math.round(1 / dt) === 0) this.record();
    this.wallMs += performance.now() - t0;
  }

  private activate(i: number) {
    // appear only if the spot is clear; otherwise try again next step
    const lv = this.lvl[i];
    for (let j = 0; j < this.n; j++) {
      if (j === i || this.lvl[j] !== lv) continue;
      const s = this.st[j];
      if (s === ST_INACTIVE || s === ST_DONE || s === ST_SEATED) continue;
      const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i];
      if (dx * dx + dy * dy < (this.r[i] + this.r[j]) ** 2) { this.startT[i] = this.t + 0.5; this.moveT[i] = this.startT[i] + this.premove[i]; return; }
    }
    this.st[i] = ST_WAIT;
    this.startLeg(i);
  }

  private sortExitLoads() {
    const lists: number[][] = this.w.exits.map(() => []);
    for (let i = 0; i < this.n; i++) {
      const e = this.exitSel[i];
      if (e < 0 || (this.st[i] !== ST_MOVE && this.st[i] !== ST_WAIT)) continue;
      lists[e].push(sampleT(this.w.levels[this.lvl[i]], this.exitFields[e].T[this.lvl[i]], this.x[i], this.y[i]));
    }
    this.exitSorted = lists.map((l) => Float64Array.from(l).sort());
  }

  private updateServices() {
    const t = this.t;
    this.w.attractors.forEach((a, ai) => {
      const srv = this.servers[ai];
      const q = this.queues[ai];
      for (let k = 0; k < srv.length; k++) {
        const sv = srv[k];
        if (sv.agent >= 0 && t >= sv.end) { const ag = sv.agent; sv.agent = -1; this.server[ag] = -1; this.nextLeg(ag); }
        if (sv.agent < 0 && q.length) {
          const ag = q[0];
          // the head of the queue must have reached the front of the line
          const s0 = queueSlot(a.el, 0);
          if (Math.hypot(this.x[ag] - s0[0], this.y[ag] - s0[1]) < 1.6 || Math.hypot(this.x[ag] - a.el.p[0], this.y[ag] - a.el.p[1]) < 2.0) {
            q.shift();
            for (let m = 0; m < q.length; m++) this.qpos[q[m]] = m;
            this.qpos[ag] = -1;
            sv.agent = ag; sv.end = t + Math.max(1, this.rng.sample(a.el.service));
            this.server[ag] = k; this.st[ag] = ST_SERVICE;
          }
        }
      }
      if (q.length > this.queuePeak[ai]) this.queuePeak[ai] = q.length;
    });
  }

  private desiredDirections() {
    const n = this.n, out = this.tmp, w = this.w;
    for (let i = 0; i < n; i++) {
      const s = this.st[i];
      if (s !== ST_MOVE && s !== ST_QUEUE && s !== ST_SERVICE) { this.ex[i] = 0; this.ey[i] = 0; continue; }
      const L = w.levels[this.lvl[i]];
      const leg = this.legs[i][this.legIdx[i]];
      let T: Float32Array | null = null;
      let tx = NaN, ty = NaN;
      if (s === ST_SERVICE) {
        const a = w.attractors[this.attrSel[i]];
        const p = a.servers[this.server[i]] ?? a.el.p;
        tx = p[0]; ty = p[1];
      } else if (s === ST_QUEUE) {
        const a = w.attractors[this.attrSel[i]];
        const p = queueSlot(a.el, Math.max(0, this.qpos[i]));
        if (Math.hypot(p[0] - this.x[i], p[1] - this.y[i]) < 6) { tx = p[0]; ty = p[1]; }
        else T = this.attrField(this.attrSel[i]).T[this.lvl[i]];
      } else if (leg) {
        if (leg.k === "exit") { const e = this.exitSel[i]; if (e >= 0) T = this.exitFields[e].T[this.lvl[i]]; }
        else if (leg.k === "attr") { if (this.attrSel[i] >= 0) T = this.attrField(this.attrSel[i]).T[this.lvl[i]]; }
        else if (leg.k === "seat") T = this.seatField(leg.block).T[this.lvl[i]];
        else if (leg.k === "zone") T = this.zoneField(leg.spawn).T[this.lvl[i]];
      }
      if (!isNaN(tx)) {
        const dx = tx - this.x[i], dy = ty - this.y[i], d = Math.hypot(dx, dy);
        // arrive smoothly: desired speed scales down inside 0.6 m
        const f = Math.min(1, d / 0.6);
        this.ex[i] = d > 1e-6 ? (dx / d) * f : 0; this.ey[i] = d > 1e-6 ? (dy / d) * f : 0;
      } else if (T && ((i + this.stepCount) & 1) === 0 && (this.ex[i] !== 0 || this.ey[i] !== 0) && this.stuckT[i] <= 2) {
        // field directions change slowly: refresh each agent every other step
      } else if (T && fieldDir(L, T, this.x[i], this.y[i], out)) { this.ex[i] = out[0]; this.ey[i] = out[1]; }
      else { this.ex[i] = 0; this.ey[i] = 0; }
      // fluctuation for people who have been blocked for > 2 s (the ξ term of HFV 2000, applied only when stuck):
      // the desired direction is turned by a pseudo-random angle up to ±70°, re-drawn every 1.5 s
      const stk = this.stuckT[i];
      if (stk > 2 && (this.ex[i] !== 0 || this.ey[i] !== 0)) {
        const k = Math.floor(this.t / 1.5);
        let hsh = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 7, 0x85ebca6b) ^ (this.seedUsed * 2654435761);
        hsh = Math.imul(hsh ^ (hsh >>> 15), 0x2c1b3c6d); hsh ^= hsh >>> 13;
        const ang = (((hsh >>> 0) / 4294967296) * 2 - 1) * Math.min(1.22, 0.3 * stk);
        const c = Math.cos(ang), sn = Math.sin(ang), ex = this.ex[i], ey = this.ey[i];
        this.ex[i] = ex * c - ey * sn; this.ey[i] = ex * sn + ey * c;
      }
    }
  }

  private forces(h: number) {
    const { n, x, y, vx, vy, r, st, lvl, ex, ey, v0, tau, mass, sfac } = this;
    void r;
    const sf = this.project.settings.sf;
    const A = sf.A, B = sf.B, K = sf.k, KAP = sf.kappa, Aw = sf.Aw, Bw = sf.Bw;
    const lam = this.project.settings.anisotropy;
    const cs = this.cellStart, order = this.order;
    const groupC = this.groupCentres();
    const sX = this.sX, sY = this.sY, sVX = this.sVX, sVY = this.sVY, sR = this.sR, stuckT = this.stuckT, group = this.group, gcn = this.gcn, gcx = this.gcx, gcy = this.gcy, doorOpen = this.doorOpen, penD = this.penD, penX = this.penX, penY = this.penY;
    const levels = this.w.levels;
    if (this.fxA.length !== n) { this.fxA = new Float64Array(n); this.fyA = new Float64Array(n); this.penD = new Float64Array(n); this.penX = new Float64Array(n); this.penY = new Float64Array(n); }
    const fxA = this.fxA, fyA = this.fyA;
    for (let i = 0; i < n; i++) {
      const s = st[i];
      if (s === ST_INACTIVE || s === ST_DONE || s === ST_SEATED) continue;
      const li = lvl[i];
      const L = levels[li];
      // people held still for a while squeeze (effective radius down to 75 %) — breaks rare symmetric deadlocks
      const xi = x[i], yi = y[i], vxi = vx[i], vyi = vy[i], ri = r[i] * (1 - 0.35 * Math.min(1, stuckT[i] / 8)), mi = mass[i];
      // driving term
      let vd = v0[i];
      const G = L.grid;
      const gi = Math.floor((xi - G.x0) / G.h), gj = Math.floor((yi - G.y0) / G.h);
      const sc = gi >= 0 && gj >= 0 && gi < G.nx && gj < G.ny ? L.stairCell[gj * G.nx + gi] : -1;
      if (sc >= 0) {
        const S = this.w.stairs[sc];
        const toB = ex[i] * S.ux + ey[i] * S.uy >= 0;
        vd *= (toB === S.descendsToB ? S.down : S.up) * sfac[i];
      }
      if (s === ST_WAIT || s === ST_IDLE) vd = 0;
      let fx = (mi * (vd * ex[i] - vxi)) / tau[i];
      let fy = (mi * (vd * ey[i] - vyi)) / tau[i];
      // direction of attention for the anisotropy (desired direction, else current velocity)
      let dirx = ex[i], diry = ey[i];
      if (dirx === 0 && diry === 0) { const sp = Math.hypot(vxi, vyi); if (sp > 1e-3) { dirx = vxi / sp; diry = vyi / sp; } }
      // neighbours
      const d = this.hDims[li], off = this.hOff[li];
      let cx = Math.floor(xi - d.x0), cy = Math.floor(yi - d.y0);
      cx = cx < 0 ? 0 : cx >= d.nx ? d.nx - 1 : cx; cy = cy < 0 ? 0 : cy >= d.ny ? d.ny - 1 : cy;
      for (let jy = cy - 1; jy <= cy + 1; jy++) {
        if (jy < 0 || jy >= d.ny) continue;
        for (let jx = cx - 1; jx <= cx + 1; jx++) {
          if (jx < 0 || jx >= d.nx) continue;
          const c = off + jy * d.nx + jx;
          for (let q = cs[c], qe = cs[c + 1]; q < qe; q++) {
            if (order[q] === i) continue;
            const dx = xi - sX[q], dy = yi - sY[q];
            const dd = dx * dx + dy * dy;
            const rij = ri + sR[q];
            const cut = rij + 0.55;      // beyond this the exponential term is < 2 % of A
            if (dd > cut * cut || dd < 1e-12) continue;
            const dist = Math.sqrt(dd);
            const nx = dx / dist, ny = dy / dist;
            const gap = rij - dist;
            let f = A * Math.exp(gap / B);
            if (lam < 1) {
              const cosPhi = -(nx * dirx + ny * diry);
              f *= lam + (1 - lam) * (1 + cosPhi) * 0.5;
            }
            if (gap > 0) {
              f += K * gap;
              const tx = -ny, ty = nx;
              const dvt = (sVX[q] - vxi) * tx + (sVY[q] - vyi) * ty;
              fx += KAP * gap * dvt * tx; fy += KAP * gap * dvt * ty;
            }
            fx += f * nx; fy += f * ny;
          }
        }
      }
      // walls
      let pen = 0, pnx = 0, pny = 0;
      const hc = hashCell(L.segHash, xi, yi);
      if (hc >= 0) {
        const segs = L.segs, items = L.segHash.items;
        for (let q = L.segHash.start[hc], qe = L.segHash.start[hc + 1]; q < qe; q++) {
          const k = items[q];
          const kind = L.segKind[k];
          const b5 = k * 5;
          const ax = segs[b5], ay = segs[b5 + 1], bx = segs[b5 + 2], by = segs[b5 + 3], ht = segs[b5 + 4];
          if (kind === SEG_DOOR && doorOpen[L.segRef[k]]) continue;
          if (kind === SEG_BARRIER && (bx - ax) * (yi - ay) - (by - ay) * (xi - ax) > 0) continue;   // allowed side
          const sx = bx - ax, sy = by - ay;
          const l2 = sx * sx + sy * sy;
          let tt = l2 > 0 ? ((xi - ax) * sx + (yi - ay) * sy) / l2 : 0;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const qx = xi - (ax + tt * sx), qy = yi - (ay + tt * sy);
          const dc = Math.sqrt(qx * qx + qy * qy);
          const dist = dc - ht;
          if (dist > 0.8 || dc < 1e-9) continue;
          const nx = qx / dc, ny = qy / dc;
          const gap = ri - dist;
          // social (exponential) wall term. Its component against the desired direction is dropped: with the
          // isotropic HFV term a slow walker (v0 < ~0.9 m/s) is otherwise held in equilibrium by door jambs.
          const fs = Aw * Math.exp(gap / Bw);
          let sx2 = fs * nx, sy2 = fs * ny;
          const back = nx * dirx + ny * diry;
          if (back < 0) { sx2 -= fs * back * dirx; sy2 -= fs * back * diry; }
          fx += sx2; fy += sy2;
          if (gap > pen) { pen = gap; pnx = nx; pny = ny; }
          if (gap > 0) {
            // body contact and sliding friction (always along the true normal)
            fx += K * gap * nx; fy += K * gap * ny;
            const tx = -ny, ty = nx;
            const vt = vxi * tx + vyi * ty;
            fx -= KAP * gap * vt * tx; fy -= KAP * gap * vt * ty;
          }
        }
      }
      // group cohesion (Moussaïd et al. 2010): pulled back toward the group centre beyond a comfort radius
      const g = group[i];
      if (g >= 0 && groupC && s === ST_MOVE) {
        const gn = gcn[g];
        if (gn > 1) {
          const dx = gcx[g] - xi, dy = gcy[g] - yi, dd = Math.hypot(dx, dy);
          const lim = 0.5 + 0.25 * (gn - 1);
          // gentle pull (at most 40 % of the driving force) and only while the group is together (< 4 m)
          if (dd > lim && dd < 4) { const f = Math.min(0.4 * (mi * v0[i]) / tau[i], (dd - lim) * mi * 0.8); fx += (f * dx) / dd; fy += (f * dy) / dd; }
        }
      }
      fxA[i] = fx; fyA[i] = fy;
      penD[i] = pen; penX[i] = pnx; penY[i] = pny;
    }
    // integrate (semi-implicit Euler) with the HFV speed cap v ≤ 1.3 v0
    for (let i = 0; i < n; i++) {
      const s = st[i];
      if (s === ST_INACTIVE || s === ST_DONE || s === ST_SEATED) continue;
      let nvx = vx[i] + (fxA[i] / mass[i]) * h, nvy = vy[i] + (fyA[i] / mass[i]) * h;
      const sp = Math.hypot(nvx, nvy), vmax = Math.max(0.6, 1.3 * v0[i]);
      if (sp > vmax) { nvx *= vmax / sp; nvy *= vmax / sp; }
      // hard limit on wall overlap (≤ 6 cm): a crowd must never push someone through a wall
      const pd = this.penD[i];
      if (pd > 0.06) {
        const nx = this.penX[i], ny = this.penY[i];
        const vn = nvx * nx + nvy * ny;
        if (vn < 0) { nvx -= vn * nx; nvy -= vn * ny; }
        x[i] += nx * (pd - 0.06); y[i] += ny * (pd - 0.06);
      }
      vx[i] = nvx; vy[i] = nvy;
      x[i] += nvx * h; y[i] += nvy * h;
    }
  }

  private gcx = new Float64Array(0); private gcy = new Float64Array(0); private gcn = new Int32Array(0);
  private groupCentres(): boolean {
    let maxG = -1;
    for (let i = 0; i < this.n; i++) if (this.group[i] > maxG) maxG = this.group[i];
    if (maxG < 0) return false;
    if (this.gcn.length <= maxG) { this.gcx = new Float64Array(maxG + 1); this.gcy = new Float64Array(maxG + 1); this.gcn = new Int32Array(maxG + 1); }
    this.gcx.fill(0); this.gcy.fill(0); this.gcn.fill(0);
    for (let i = 0; i < this.n; i++) {
      const g = this.group[i];
      if (g < 0 || this.st[i] !== ST_MOVE) continue;
      this.gcx[g] += this.x[i]; this.gcy[g] += this.y[i]; this.gcn[g]++;
    }
    for (let g = 0; g <= maxG; g++) if (this.gcn[g]) { this.gcx[g] /= this.gcn[g]; this.gcy[g] /= this.gcn[g]; }
    return true;
  }


  /** Exits, door crossings, barriers, stairs, arrivals. */
  private postMove() {
    const w = this.w, n = this.n, t = this.t + this.dt;
    for (let i = 0; i < n; i++) {
      const s = this.st[i];
      if (s !== ST_MOVE && s !== ST_QUEUE && s !== ST_SERVICE && s !== ST_WAIT && s !== ST_IDLE) continue;
      const L = w.levels[this.lvl[i]];
      const x0 = this.px[i], y0 = this.py[i];
      let x1 = this.x[i], y1 = this.y[i];
      // one-way barriers: undo a crossing from the right side to the left
      if (w.barriers.length) for (const b of w.barriers) {
        if (b.level !== this.lvl[i]) continue;
        const s0 = (b.bx - b.ax) * (y0 - b.ay) - (b.by - b.ay) * (x0 - b.ax), s1 = (b.bx - b.ax) * (y1 - b.ay) - (b.by - b.ay) * (x1 - b.ax);
        if (s0 <= 0 && s1 > 0 && crosses(x0, y0, x1, y1, b.ax, b.ay, b.bx, b.by)) { this.x[i] = x1 = x0; this.y[i] = y1 = y0; this.vx[i] *= 0.2; this.vy[i] *= 0.2; }
      }
      const moved = Math.hypot(x1 - x0, y1 - y0);
      this.walked[i] += moved;
      if (s === ST_MOVE && (this.ex[i] !== 0 || this.ey[i] !== 0) && moved < 0.1 * this.v0[i] * this.dt) this.stuckT[i] += this.dt;
      else this.stuckT[i] = Math.max(0, this.stuckT[i] - 2 * this.dt);
      // openings
      const hc = hashCell(L.lineHash, x1, y1);
      if (hc >= 0) for (let q = L.lineHash.start[hc], qe = L.lineHash.start[hc + 1]; q < qe; q++) {
        const oi = L.lines[L.lineHash.items[q]];
        const o = w.openings[oi];
        const crossed = crosses(x0, y0, x1, y1, o.ax, o.ay, o.bx, o.by);
        if (crossed) {
          // net counting: stepping back over the same line cancels the earlier crossing
          const sgn = (o.bx - o.ax) * (y1 - y0) - (o.by - o.ay) * (x1 - x0) > 0 ? 1 : -1;
          const arr = this.crossings[oi];
          if (this.lastCross[i] === oi && this.lastSign[i] === -sgn) {
            arr[this.lastBin[i]]--; this.lastCross[i] = -1;
          } else {
            const bin = Math.floor(t / 10);
            while (arr.length <= bin) arr.push(0);
            arr[bin]++;
            this.lastCross[i] = oi; this.lastSign[i] = sgn; this.lastBin[i] = bin;
            if (o.maxFlow) { this.tokens[oi] -= 1; if (this.tokens[oi] < 1) this.doorOpen[oi] = 0; }
          }
        }
        if (o.isExit && this.legs[i][this.legIdx[i]]?.k === "exit" && (crossed || segDistSq(x1, y1, o.ax, o.ay, o.bx, o.by) < 0.04)) {
          if (!crossed) { const bin = Math.floor(t / 10); const arr = this.crossings[oi]; while (arr.length <= bin) arr.push(0); arr[bin]++; }
          this.exitCount[oi]++;
          this.st[i] = ST_DONE; this.doneT[i] = t; this.vx[i] = this.vy[i] = 0;
          break;
        }
      }
      if (this.st[i] === ST_DONE) continue;
      // stairs: transfer between levels at the b end
      const ci = cellIndex(L, x1, y1);
      const sa = ci >= 0 ? L.stairCell[ci] : -1;
      if (sa >= 0) {
        const S = w.stairs[sa];
        const along = (x1 - S.ax) * S.ux + (y1 - S.ay) * S.uy, lat = (x1 - S.ax) * S.nx + (y1 - S.ay) * S.ny;
        if (S.lb !== S.la && along > S.L - 0.3 - this.r[i] && this.ex[i] * S.ux + this.ey[i] * S.uy > 0.2) {
          const d = 0.45 + this.r[i];
          let placed = false;
          for (const off of [0, 0.45, -0.45, 0.9, -0.9]) {
            const l2 = Math.max(-S.hw + this.r[i], Math.min(S.hw - this.r[i], lat + off));
            const nxp = S.bx + S.ux * d + S.nx * l2, nyp = S.by + S.uy * d + S.ny * l2;
            if (this.spotFree(i, S.lb, nxp, nyp)) { this.lvl[i] = S.lb; this.x[i] = this.px[i] = nxp; this.y[i] = this.py[i] = nyp; placed = true; break; }
          }
          if (placed) continue;
        }
      }
      for (const S of w.stairs) {
        if (S.lb !== this.lvl[i] || S.la === S.lb) continue;
        const along = (x1 - S.ax) * S.ux + (y1 - S.ay) * S.uy, lat = (x1 - S.ax) * S.nx + (y1 - S.ay) * S.ny;
        if (along < S.L || along > S.L + 0.55 + this.r[i] || Math.abs(lat) > S.hw) continue;
        if (this.ex[i] * S.ux + this.ey[i] * S.uy > -0.3) continue;
        const T = this.currentField(i);
        if (!T) continue;
        const here = sampleT(L, T[S.lb], x1, y1);
        const up = sampleT(w.levels[S.la], T[S.la], S.bx - S.ux * 0.35, S.by - S.uy * 0.35);
        if (up + 0.2 < here) {
          const d = 0.4 + this.r[i];
          const nxp = S.bx - S.ux * d + S.nx * lat, nyp = S.by - S.uy * d + S.ny * lat;
          if (!this.spotFree(i, S.la, nxp, nyp)) continue;
          this.lvl[i] = S.la; this.x[i] = this.px[i] = nxp; this.y[i] = this.py[i] = nyp;
          break;
        }
      }
      // arrivals for attractor / seat / zone legs
      const leg = this.legs[i][this.legIdx[i]];
      if (!leg || s !== ST_MOVE) continue;
      if (leg.k === "attr" && this.attrSel[i] >= 0) {
        const a = w.attractors[this.attrSel[i]];
        if (a.level === this.lvl[i]) {
          const q = this.queues[this.attrSel[i]];
          const tail = queueSlot(a.el, q.length);
          const near = Math.hypot(this.x[i] - a.el.p[0], this.y[i] - a.el.p[1]) < 4 || Math.hypot(this.x[i] - tail[0], this.y[i] - tail[1]) < 2.5;
          if (near) { this.qpos[i] = q.length; q.push(i); this.st[i] = ST_QUEUE; }
        }
      } else if (leg.k === "seat") {
        const b = w.seating[leg.block];
        if (b.level === this.lvl[i]) {
          const { toLocal } = seatingFrame(b.el);
          const [u, v] = toLocal(this.x[i], this.y[i]);
          const inside = u >= -0.05 && v >= -0.05 && u <= b.el.width + 0.05 && v <= b.el.depth + 0.05;
          if (inside || sampleT(L, this.seatField(leg.block).T[this.lvl[i]], this.x[i], this.y[i]) < 0.6) {
            if (leg.seat >= 0) { const p = b.seats[leg.seat]; this.x[i] = p[0]; this.y[i] = p[1]; }
            this.vx[i] = this.vy[i] = 0;
            this.legIdx[i]++;
            this.st[i] = ST_SEATED; this.doneT[i] = t;
          }
        }
      } else if (leg.k === "zone") {
        const z = w.spawns[leg.spawn];
        if (z.level === this.lvl[i] && pointInPoly(this.x[i], this.y[i], z.el.pts)) {
          // walk a little into the zone before settling
          const T = this.zoneField(leg.spawn).T[this.lvl[i]];
          if (sampleT(L, T, this.x[i], this.y[i]) <= 0.01) { this.nextLeg(i); }
        }
      }
    }
  }

  /** Nobody on level lv overlaps a body of agent i placed at (x, y). */
  private spotFree(i: number, lv: number, x: number, y: number): boolean {
    const d = this.hDims[lv], off = this.hOff[lv];
    const cx = Math.floor(x - d.x0), cy = Math.floor(y - d.y0);
    for (let jy = cy - 1; jy <= cy + 1; jy++) {
      if (jy < 0 || jy >= d.ny) continue;
      for (let jx = cx - 1; jx <= cx + 1; jx++) {
        if (jx < 0 || jx >= d.nx) continue;
        const c = off + jy * d.nx + jx;
        for (let q = this.cellStart[c], qe = this.cellStart[c + 1]; q < qe; q++) {
          const j = this.order[q];
          if (j === i || this.lvl[j] !== lv) continue;
          const st = this.st[j];
          if (st === ST_DONE || st === ST_SEATED || st === ST_INACTIVE) continue;
          const rr = this.r[i] + this.r[j];
          if ((this.x[j] - x) ** 2 + (this.y[j] - y) ** 2 < rr * rr * 0.81) return false;
        }
      }
    }
    return true;
  }

  private currentField(i: number): Float32Array[] | null {
    const leg = this.legs[i][this.legIdx[i]];
    if (!leg) return null;
    if (leg.k === "exit") return this.exitSel[i] >= 0 ? this.exitFields[this.exitSel[i]].T : null;
    if (leg.k === "attr") return this.attrSel[i] >= 0 ? this.attrField(this.attrSel[i]).T : null;
    if (leg.k === "seat") return this.seatField(leg.block).T;
    return this.zoneField(leg.spawn).T;
  }

  private refillDoors(dt: number) {
    this.w.openings.forEach((o, i) => {
      if (!o.maxFlow) return;
      this.tokens[i] = Math.min(Math.max(1, o.maxFlow), this.tokens[i] + o.maxFlow * dt);
      if (this.tokens[i] >= 1) this.doorOpen[i] = 1;
    });
  }

  private record() {
    const S = this.series;
    let done = 0, active = 0, moving = 0, sp = 0;
    for (let i = 0; i < this.n; i++) {
      const s = this.st[i];
      if (s === ST_DONE || s === ST_SEATED) done++;
      else if (s !== ST_INACTIVE) {
        active++;
        if (s === ST_MOVE) { moving++; sp += Math.hypot(this.vx[i], this.vy[i]); }
      }
    }
    S.t.push(+this.t.toFixed(2)); S.done.push(done); S.active.push(active); S.moving.push(moving);
    S.meanSpeed.push(moving ? +(sp / moving).toFixed(3) : 0);
    let md = 0;
    for (const D of this.density) for (let c = 0; c < D.dens.length; c++) if (D.count[c] && D.dens[c] > md) md = D.dens[c];
    S.maxDensity.push(+md.toFixed(2));
    this.queues.forEach((q, k) => S.queue[k].push(q.length));
    this.w.openings.forEach((_, k) => S.exitCum[k].push(this.crossings[k].reduce((a, b) => a + b, 0)));
  }

  // ------------------------------------------------------------------ status
  /** Everyone has finished their plan (or the scenario's duration is over). */
  finished(): boolean {
    if (this.t >= this.sc.duration) return true;
    if (this.finishedAt !== null) return true;
    for (let i = 0; i < this.n; i++) {
      const s = this.st[i];
      if (s === ST_DONE || s === ST_IDLE || (s === ST_SEATED && this.legIdx[i] >= this.legs[i].length)) continue;
      return false;
    }
    this.finishedAt = this.t;
    return true;
  }

  runToEnd(maxSteps = Infinity, onProgress?: (s: Sim) => void) {
    let k = 0;
    while (!this.finished() && k++ < maxSteps) {
      this.step();
      if (onProgress && this.stepCount % 200 === 0) onProgress(this);
    }
  }

  completionTimes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (!this.legs[i].length) continue;
      if ((this.st[i] === ST_DONE || this.st[i] === ST_SEATED || this.st[i] === ST_IDLE) && isFinite(this.doneT[i])) out.push(this.doneT[i]);
    }
    return out.sort((a, b) => a - b);
  }

  summary(): ResultSummary {
    const times = this.completionTimes();
    const pct = (p: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * (times.length - 1) + 0.5))] : null);
    const movers: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.legs[i].length) movers.push(i);
    const pre = movers.map((i) => this.premove[i]).sort((a, b) => a - b);
    const travel = movers.filter((i) => isFinite(this.doneT[i])).map((i) => this.doneT[i] - this.moveT[i]);
    const allDone = movers.every((i) => isFinite(this.doneT[i]));
    const exitUsage: Record<string, number> = {}, doorPeak: Record<string, number> = {}, queuePeak: Record<string, number> = {};
    this.w.openings.forEach((o, k) => {
      if (o.isExit) exitUsage[o.id] = this.exitCount[k];
      const peak = Math.max(0, ...this.crossings[k]);
      doorPeak[o.id] = +(peak / 10 / Math.max(0.1, o.width)).toFixed(3);
    });
    this.w.attractors.forEach((a, k) => { queuePeak[a.id] = this.queuePeak[k]; });
    const congested = movers.length ? movers.reduce((a, i) => a + this.congT[i], 0) / movers.length : 0;
    return {
      scenarioId: this.sc.id, scenarioName: this.sc.name, kind: this.sc.kind, seed: this.seedUsed,
      agents: this.n, completed: times.length,
      tet: movers.length && allDone && times.length ? +times[times.length - 1].toFixed(1) : null,
      p50: pct(0.5), p90: pct(0.9),
      premoveMean: pre.length ? +(pre.reduce((a, b) => a + b, 0) / pre.length).toFixed(1) : 0,
      premoveP90: pre.length ? +pre[Math.floor(0.9 * (pre.length - 1))].toFixed(1) : 0,
      travelMean: travel.length ? +(travel.reduce((a, b) => a + b, 0) / travel.length).toFixed(1) : 0,
      maxDensity: +this.maxDensity.toFixed(2), congestedAgentS: +congested.toFixed(1),
      exitUsage, doorPeak, queuePeak, simTime: +this.t.toFixed(2), wallMs: Math.round(this.wallMs), steps: this.stepCount,
    };
  }
}

function crosses(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): boolean {
  const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
  const d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
  if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0) || d1 === d2) return false;
  const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
  return !((d3 > 0 && d4 > 0) || (d3 < 0 && d4 < 0));
}
function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

export type { Dist };
