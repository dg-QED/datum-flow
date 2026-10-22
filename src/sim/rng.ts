// Seeded random numbers: sfc32 (Chris Doty-Humphrey's Small Fast Counter), seeded through splitmix32.
// Same seed → same stream on every JS engine, so runs are reproducible.
import type { Dist } from "../model/types";

export class Rng {
  private a: number; private b: number; private c: number; private d: number;
  private spare: number | null = null;
  constructor(seed: number) {
    let s = (seed >>> 0) ^ 0x9e3779b9;
    const sm = () => { s = (s + 0x9e3779b9) | 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();
  }
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  /** [0, 1) */
  next(): number { return this.u32() / 4294967296; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(n: number) { return Math.floor(this.next() * n); }
  normal(): number {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return u * m;
  }
  sample(d: Dist): number {
    switch (d.type) {
      case "fixed": return d.a;
      case "uniform": return this.range(Math.min(d.a, d.b), Math.max(d.a, d.b));
      case "normal": return Math.max(0, d.a + d.b * this.normal());
      case "lognormal": return d.a * Math.exp(d.b * this.normal());
    }
  }
  pick<T>(weights: [T, number][]): T {
    let tot = 0;
    for (const [, w] of weights) tot += Math.max(0, w);
    let r = this.next() * tot;
    for (const [k, w] of weights) { r -= Math.max(0, w); if (r <= 0) return k; }
    return weights[weights.length - 1][0];
  }
}
