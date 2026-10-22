// Fast marching solution of the eikonal equation |∇T| = s(x) on a regular grid (Sethian 1996).
// Each trial update takes the better of the axis-aligned stencil and the 45°-rotated (diagonal) stencil,
// after the multi-stencil idea of Hassouna & Farag (2007); this cuts the first-order scheme's
// direction-dependent error from ~8 % on diagonals to ~1–2 %.

export interface Grid { nx: number; ny: number; h: number; x0: number; y0: number }

/** Optional one-way constraint: cell c may take its value from neighbour n only if that is not a forbidden crossing. */
export interface OneWay { id: Int16Array; side: Int8Array }

class Heap {
  t = new Float64Array(1024); i = new Int32Array(1024); n = 0;
  push(t: number, i: number) {
    if (this.n === this.t.length) {
      const t2 = new Float64Array(this.n * 2); t2.set(this.t); this.t = t2;
      const i2 = new Int32Array(this.n * 2); i2.set(this.i); this.i = i2;
    }
    let k = this.n++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.t[p] <= t) break;
      this.t[k] = this.t[p]; this.i[k] = this.i[p]; k = p;
    }
    this.t[k] = t; this.i[k] = i;
  }
  pop(): number {   // returns index; read time via lastT
    const ri = this.i[0]; this.lastT = this.t[0];
    const t = this.t[--this.n], i = this.i[this.n];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.t[c + 1] < this.t[c]) c++;
      if (this.t[c] >= t) break;
      this.t[k] = this.t[c]; this.i[k] = this.i[c]; k = c;
    }
    this.t[k] = t; this.i[k] = i;
    return ri;
  }
  lastT = 0;
}

function solve2(a: number, b: number, hf: number): number {
  if (a > b) { const t = a; a = b; b = t; }
  if (!isFinite(a)) return Infinity;
  if (!isFinite(b) || b - a >= hf) return a + hf;
  const d = a - b;
  return (a + b + Math.sqrt(2 * hf * hf - d * d)) / 2;
}

/**
 * @param slow  slowness per cell (1 = nominal; Infinity = blocked)
 * @param T     in/out: seeds hold finite values (goal cells, portals); everything else Infinity
 */
export function fastMarch(g: Grid, slow: Float32Array, T: Float32Array, oneWay?: OneWay | null): Float32Array {
  const { nx, ny, h } = g;
  const N = nx * ny;
  const state = new Uint8Array(N);          // 0 far, 1 trial, 2 frozen
  const heap = new Heap();
  for (let c = 0; c < N; c++) if (isFinite(T[c]) && isFinite(slow[c])) { state[c] = 1; heap.push(T[c], c); }
  const h2 = h * Math.SQRT2;
  const ok = (c: number, n: number) => {
    if (!oneWay) return true;
    const id = oneWay.id[c];
    return !(id >= 0 && id === oneWay.id[n] && oneWay.side[c] < 0 && oneWay.side[n] > 0);
  };
  const val = (c: number, n: number) => (state[n] === 2 && ok(c, n) ? T[n] : Infinity);
  while (heap.n > 0) {
    const c = heap.pop();
    if (state[c] === 2) continue;
    if (heap.lastT > T[c]) continue;   // stale entry
    state[c] = 2;
    const cx = c % nx, cy = (c - cx) / nx;
    for (let dy = -1; dy <= 1; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= ny) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = cx + dx;
        if (x < 0 || x >= nx) continue;
        const k = y * nx + x;
        if (state[k] === 2 || !isFinite(slow[k])) continue;
        // re-evaluate cell k from its frozen neighbours
        const s = slow[k];
        const L = x > 0 ? val(k, k - 1) : Infinity, R = x < nx - 1 ? val(k, k + 1) : Infinity;
        const D = y > 0 ? val(k, k - nx) : Infinity, U = y < ny - 1 ? val(k, k + nx) : Infinity;
        let t = solve2(Math.min(L, R), Math.min(D, U), h * s);
        const hasL = x > 0, hasR = x < nx - 1, hasD = y > 0, hasU = y < ny - 1;
        // diagonal stencil — only through corners that are not blocked on both sides (no squeezing through wall joints)
        const SW = hasL && hasD && (isFinite(slow[k - 1]) || isFinite(slow[k - nx])) ? val(k, k - nx - 1) : Infinity;
        const NE = hasR && hasU && (isFinite(slow[k + 1]) || isFinite(slow[k + nx])) ? val(k, k + nx + 1) : Infinity;
        const SE = hasR && hasD && (isFinite(slow[k + 1]) || isFinite(slow[k - nx])) ? val(k, k - nx + 1) : Infinity;
        const NW = hasL && hasU && (isFinite(slow[k - 1]) || isFinite(slow[k + nx])) ? val(k, k + nx - 1) : Infinity;
        const td = solve2(Math.min(SW, NE), Math.min(SE, NW), h2 * s);
        if (td < t) t = td;
        if (t < T[k]) { T[k] = t; state[k] = 1; heap.push(T[k], k); }   // push the stored (float32) value so the stale check is exact
      }
    }
  }
  return T;
}

/** Chamfer (3-4) distance to the nearest blocked cell, in metres. */
export function obstacleDistance(g: Grid, blocked: Uint8Array): Float32Array {
  const { nx, ny, h } = g;
  const D = new Float32Array(nx * ny);
  const big = 1e9;
  for (let i = 0; i < D.length; i++) D[i] = blocked[i] ? 0 : big;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const c = y * nx + x;
    let v = D[c];
    if (x > 0) v = Math.min(v, D[c - 1] + a);
    if (y > 0) {
      v = Math.min(v, D[c - nx] + a);
      if (x > 0) v = Math.min(v, D[c - nx - 1] + b);
      if (x < nx - 1) v = Math.min(v, D[c - nx + 1] + b);
    }
    D[c] = v;
  }
  for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
    const c = y * nx + x;
    let v = D[c];
    if (x < nx - 1) v = Math.min(v, D[c + 1] + a);
    if (y < ny - 1) {
      v = Math.min(v, D[c + nx] + a);
      if (x < nx - 1) v = Math.min(v, D[c + nx + 1] + b);
      if (x > 0) v = Math.min(v, D[c + nx - 1] + b);
    }
    D[c] = v;
  }
  for (let i = 0; i < D.length; i++) D[i] = D[i] >= big ? 1e6 : D[i] * h;
  return D;
}
