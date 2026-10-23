// Small SVG chart builders (strings), used in the Results panel and rasterised for the PDF report.
export interface ChartTheme { bg: string; grid: string; axis: string; text: string; sub: string; font: string }
export const DARK_CHART: ChartTheme = { bg: "#13171b", grid: "#232a31", axis: "#3a434c", text: "#a9b1b9", sub: "#6f7983", font: "Inter Tight, system-ui, sans-serif" };
export const PRINT_CHART: ChartTheme = { bg: "#ffffff", grid: "#e6e9ec", axis: "#9aa4ad", text: "#2b3138", sub: "#6f7983", font: "Helvetica, Arial, sans-serif" };
export const SERIES_COLORS = ["#5aa9e6", "#f2a93b", "#5cc28a", "#c7a6ff", "#ef6a3a", "#d8d04a", "#7cc4ff", "#ff9ad5", "#9aa4ad"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function nice(max: number, ticks = 5): { step: number; top: number } {
  if (!(max > 0)) return { step: 1, top: 1 };
  const raw = max / ticks, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  return { step, top: Math.ceil(max / step) * step };
}
const fmt = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 2 : 1));
export const fmtTime = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${Math.round(s)} s`);

export interface LineSeries { name: string; color?: string; x: number[]; y: number[]; dash?: boolean; step?: boolean }
export interface LineSpec { series: LineSeries[]; xLabel?: string; yLabel?: string; width?: number; height?: number; theme?: ChartTheme; marks?: { x: number; label: string; color?: string }[]; yMax?: number; timeAxis?: boolean; hLines?: { y: number; label: string; color?: string }[] }

export function lineChart(s: LineSpec): string {
  const W = s.width ?? 520, H = s.height ?? 220, th = s.theme ?? DARK_CHART;
  const L = 46, R = 12, T = 12;
  // legend layout (wraps onto several lines in narrow charts)
  const leg: { x: number; line: number; label: string; c: string; dash?: boolean }[] = [];
  if (s.series.length > 1) {
    let x = L, line = 0;
    s.series.forEach((se, k) => {
      const label = esc(se.name.length > 22 ? se.name.slice(0, 21) + "…" : se.name);
      const w = 26 + label.length * 5.6;
      if (x + w > W - R && x > L) { x = L; line++; }
      leg.push({ x, line, label, c: se.color ?? SERIES_COLORS[k % SERIES_COLORS.length], dash: se.dash });
      x += w;
    });
  }
  const nLines = leg.length ? leg[leg.length - 1].line + 1 : 0;
  const B = 34 + nLines * 15;
  let xmax = 0, ymax = s.yMax ?? 0;
  for (const se of s.series) { for (const v of se.x) xmax = Math.max(xmax, v); if (s.yMax === undefined) for (const v of se.y) ymax = Math.max(ymax, v); }
  for (const m of s.marks ?? []) xmax = Math.max(xmax, m.x);
  for (const h of s.hLines ?? []) ymax = Math.max(ymax, h.y);
  const nx = nice(xmax || 1, 6), ny = nice(ymax || 1, 4);
  const X = (v: number) => L + (v / nx.top) * (W - L - R), Y = (v: number) => H - B - (v / ny.top) * (H - T - B);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${th.font}" font-size="10.5">`, `<rect width="${W}" height="${H}" fill="${th.bg}" rx="4"/>`];
  for (let v = 0; v <= ny.top + 1e-9; v += ny.step) out.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${th.grid}"/><text x="${L - 6}" y="${Y(v) + 3.5}" fill="${th.sub}" text-anchor="end">${fmt(+v.toFixed(6))}</text>`);
  for (let v = 0; v <= nx.top + 1e-9; v += nx.step) out.push(`<line x1="${X(v)}" x2="${X(v)}" y1="${T}" y2="${H - B}" stroke="${th.grid}"/><text x="${X(v)}" y="${H - B + 14}" fill="${th.sub}" text-anchor="middle">${s.timeAxis ? fmtTime(v) : fmt(+v.toFixed(6))}</text>`);
  out.push(`<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="${th.axis}"/>`);
  if (s.yLabel) out.push(`<text x="12" y="${(T + H - B) / 2}" fill="${th.sub}" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">${esc(s.yLabel)}</text>`);
  if (s.xLabel) out.push(`<text x="${W - R}" y="${H - B + 27}" fill="${th.sub}" text-anchor="end">${esc(s.xLabel)}</text>`);
  for (const h of s.hLines ?? []) out.push(`<line x1="${L}" x2="${W - R}" y1="${Y(h.y)}" y2="${Y(h.y)}" stroke="${h.color ?? th.text}" stroke-dasharray="3 3"/><text x="${W - R - 2}" y="${Y(h.y) - 4}" fill="${h.color ?? th.text}" text-anchor="end">${esc(h.label)}</text>`);
  s.series.forEach((se, k) => {
    const c = se.color ?? SERIES_COLORS[k % SERIES_COLORS.length];
    // thin long series for size
    const step = Math.max(1, Math.floor(se.x.length / 600));
    const pts: string[] = [];
    for (let i = 0; i < se.x.length; i += step) {
      if (se.step && i > 0) pts.push(`${X(se.x[i]).toFixed(1)},${Y(se.y[i - step]).toFixed(1)}`);
      pts.push(`${X(se.x[i]).toFixed(1)},${Y(se.y[i]).toFixed(1)}`);
    }
    if (pts.length) out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"${se.dash ? ' stroke-dasharray="5 4"' : ""}/>`);
  });
  for (const m of s.marks ?? []) out.push(`<line x1="${X(m.x)}" x2="${X(m.x)}" y1="${T}" y2="${H - B}" stroke="${m.color ?? th.text}" stroke-dasharray="2 3"/><text x="${X(m.x) + 4}" y="${T + 10}" fill="${m.color ?? th.text}">${esc(m.label)}</text>`);
  for (const g of leg) {
    const yy = H - B + 34 + g.line * 15 - 4;
    out.push(`<line x1="${g.x}" x2="${g.x + 14}" y1="${yy}" y2="${yy}" stroke="${g.c}" stroke-width="2"${g.dash ? ' stroke-dasharray="4 3"' : ""}/><text x="${g.x + 18}" y="${yy + 3.5}" fill="${th.text}">${g.label}</text>`);
  }
  out.push("</svg>");
  return out.join("");
}

export interface BarSpec { labels: string[]; values: number[]; colors?: string[]; unit?: string; width?: number; height?: number; theme?: ChartTheme; pct?: boolean }
export function barChart(s: BarSpec): string {
  const W = s.width ?? 520, th = s.theme ?? DARK_CHART;
  const rowH = 22, T = 8, labelW = Math.min(170, Math.max(70, Math.max(...s.labels.map((l) => l.length)) * 6.2));
  const H = s.height ?? T * 2 + s.labels.length * rowH;
  const max = Math.max(1e-9, ...s.values);
  const tot = s.values.reduce((a, b) => a + b, 0) || 1;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${th.font}" font-size="11">`, `<rect width="${W}" height="${H}" fill="${th.bg}" rx="4"/>`];
  const bw = W - labelW - 90;
  s.labels.forEach((l, i) => {
    const y = T + i * rowH;
    const w = (s.values[i] / max) * bw;
    const c = s.colors?.[i] ?? SERIES_COLORS[i % SERIES_COLORS.length];
    out.push(`<text x="${labelW - 6}" y="${y + 15}" fill="${th.text}" text-anchor="end">${esc(l.length > 26 ? l.slice(0, 25) + "…" : l)}</text>`);
    out.push(`<rect x="${labelW}" y="${y + 4}" width="${Math.max(1, w).toFixed(1)}" height="${rowH - 8}" fill="${c}" rx="2"/>`);
    out.push(`<text x="${labelW + w + 6}" y="${y + 15}" fill="${th.sub}">${fmt(+s.values[i].toFixed(2))}${s.unit ? " " + s.unit : ""}${s.pct ? ` · ${Math.round((s.values[i] / tot) * 100)} %` : ""}</text>`);
  });
  out.push("</svg>");
  return out.join("");
}

/** Histogram of values (e.g. Monte-Carlo TET). */
export function histogram(values: number[], o: { width?: number; height?: number; theme?: ChartTheme; marks?: { x: number; label: string; color?: string }[]; xLabel?: string }): string {
  const W = o.width ?? 520, H = o.height ?? 170, th = o.theme ?? DARK_CHART;
  const L = 36, R = 12, T = 14, B = 30;
  if (!values.length) return "";
  const lo = Math.min(...values), hi = Math.max(...values);
  const nb = Math.max(4, Math.min(16, Math.ceil(Math.sqrt(values.length) * 2)));
  const span = Math.max(1, hi - lo);
  const x0 = Math.floor(lo - span * 0.1), x1 = Math.ceil(hi + span * 0.1);
  const bins = new Array(nb).fill(0);
  for (const v of values) bins[Math.min(nb - 1, Math.floor(((v - x0) / (x1 - x0)) * nb))]++;
  const ymax = Math.max(...bins);
  const X = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (c: number) => H - B - (c / ymax) * (H - T - B);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${th.font}" font-size="10.5">`, `<rect width="${W}" height="${H}" fill="${th.bg}" rx="4"/>`];
  bins.forEach((c, i) => { const a = x0 + (i / nb) * (x1 - x0), b = x0 + ((i + 1) / nb) * (x1 - x0); out.push(`<rect x="${X(a) + 1}" y="${Y(c)}" width="${Math.max(1, X(b) - X(a) - 2)}" height="${H - B - Y(c)}" fill="#5aa9e6" opacity="0.85"/>`); });
  out.push(`<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="${th.axis}"/>`);
  for (let k = 0; k <= 4; k++) { const v = x0 + (k / 4) * (x1 - x0); out.push(`<text x="${X(v)}" y="${H - B + 14}" fill="${th.sub}" text-anchor="middle">${fmtTime(v)}</text>`); }
  out.push(`<text x="${L - 6}" y="${T + 6}" fill="${th.sub}" text-anchor="end">${ymax}</text>`);
  for (const m of o.marks ?? []) out.push(`<line x1="${X(m.x)}" x2="${X(m.x)}" y1="${T - 4}" y2="${H - B}" stroke="${m.color ?? "#f2a93b"}" stroke-dasharray="3 3"/><text x="${X(m.x) + 3}" y="${T + 4}" fill="${m.color ?? "#f2a93b"}">${esc(m.label)}</text>`);
  if (o.xLabel) out.push(`<text x="${W - R}" y="${H - 4}" fill="${th.sub}" text-anchor="end">${esc(o.xLabel)}</text>`);
  out.push("</svg>");
  return out.join("");
}

/** Door / exit flow per 10 s bin → persons per metre per minute. */
export function flowSeries(crossings: number[], width: number): { x: number[]; y: number[] } {
  const x: number[] = [], y: number[] = [];
  crossings.forEach((c, i) => { x.push(i * 10 + 5); y.push(+((c * 6) / Math.max(0.1, width)).toFixed(2)); });
  return { x, y };
}
