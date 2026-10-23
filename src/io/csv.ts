// CSV exports: time series (1 s) of a run.
import type { Series } from "../sim/engine";
import type { WorldInfo } from "../sim/protocol";

const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function seriesCSV(series: Series, info: WorldInfo): string {
  const head = ["t_s", "completed", "in_model", "moving", "mean_speed_mps", "peak_density_ppm2",
    ...info.openings.map((o) => `${o.isExit ? "exit" : "door"}_cum:${o.name}`),
    ...info.openings.map((o) => `${o.isExit ? "exit" : "door"}_flow_ppmmin:${o.name}`),
    ...info.attractors.map((a) => `queue:${a.name}`)];
  const rows = [head.map(q).join(",")];
  for (let i = 0; i < series.t.length; i++) {
    const j = Math.max(0, i - 10);
    const dt = series.t[i] - (series.t[j] ?? 0);
    rows.push([
      series.t[i], series.done[i], series.active[i], series.moving[i], series.meanSpeed[i], series.maxDensity[i],
      ...info.openings.map((_, k) => series.exitCum[k]?.[i] ?? 0),
      ...info.openings.map((o, k) => (dt > 0 ? +((((series.exitCum[k]?.[i] ?? 0) - (series.exitCum[k]?.[j] ?? 0)) / dt) * 60 / Math.max(0.1, o.width)).toFixed(2) : 0)),
      ...info.attractors.map((_, k) => series.queue[k]?.[i] ?? 0),
    ].join(","));
  }
  return rows.join("\n") + "\n";
}
