// PDF report (jsPDF): summary, cross-checks, plans with max-density LOS maps, charts, metric tables and
// assumptions with sources. Plans and charts are embedded as images; text and tables are vector.
import type { jsPDF as JsPDF } from "jspdf";
import { getState, activeScenario } from "../store";
import { live } from "../live";
import { DARK, PRINT, drawGrid, drawOverlay, drawPlan, fitView, overlayCanvas } from "../view/render2d";
import { barChart, fmtTime, histogram, lineChart, PRINT_CHART, SERIES_COLORS } from "../panels/charts";
import { doorFlowSeries } from "../panels/ResultsPanel";
import { LOS_COLORS, LOS_LETTERS, LOS_TABLE, SOURCES, distLabel, losIndex } from "../model/defaults";
import { download } from "./download";

const PDF_MAP: [RegExp, string][] = [[/²/g, "2"], [/³/g, "3"], [/⁵/g, "^5"], [/≥/g, ">="], [/≤/g, "<="], [/≈/g, "~"], [/×/g, "x"], [/[−–—]/g, "-"], [/σ/g, "sigma"], [/λ/g, "lambda"], [/κ/g, "kappa"], [/φ/g, "phi"], [/τ/g, "tau"], [/Δ/g, "delta"], [/ω/g, "omega"], [/ξ/g, "xi"], [/∇/g, "grad "], [/μ/g, "mean "], [/→/g, "->"], [/↓/g, "down"], [/↑/g, "up"], [/✓/g, "ok"], [/✗/g, "x"], [/‘|’/g, "'"], [/“|”/g, '"'], [/…/g, "..."]];
function pdfSafe(t: string): string { let s = String(t); for (const [r, v] of PDF_MAP) s = s.replace(r, v); return s.replace(/[^\x00-\xff]/g, "?"); }

function svgToPng(svg: string, w: number, h: number, k = 2): Promise<string> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * k; c.height = h * k;
      const g = c.getContext("2d")!;
      g.scale(k, k);
      g.drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/png"));
    };
    img.onerror = () => rej(new Error("chart rasterisation failed"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

function planImage(levelIndex: number, overlay: "maxdensity" | "none", w = 1500, h = 950): string {
  const s = getState();
  const L = s.project.levels[levelIndex];
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  const v = fitView(s.project, L.id, w, h, 40);
  drawGrid(g, v, PRINT, 1);
  const info = live.info?.levels[levelIndex];
  if (overlay === "maxdensity" && info && live.maxDensity[levelIndex]) {
    const cv = overlayCanvas("maxdensity", levelIndex, info, { max: live.maxDensity[levelIndex] }, s.project.settings.losStandard, `report:${live.densVersion}`);
    if (cv) drawOverlay(g, v, cv, info, false);
  }
  const sc = activeScenario(s);
  drawPlan(g, v, s.project, { level: L.id, ghost: false, closed: new Set(sc.closedExits), theme: PRINT, labels: true });
  // scale bar
  const target = 160 / v.scale, pow = Math.pow(10, Math.floor(Math.log10(target)));
  const m = [1, 2, 5, 10].map((x) => x * pow).filter((x) => x <= target).pop() ?? pow;
  g.fillStyle = "#1d232a"; g.fillRect(30, h - 34, m * v.scale, 5);
  g.font = "16px Helvetica, Arial"; g.fillText(`${m} m`, 30, h - 42);
  void DARK;
  return c.toDataURL("image/jpeg", 0.88);
}

export async function buildReport(): Promise<{ pdf: JsPDF; name: string }> {
  const { jsPDF } = await import("jspdf");
  const s = getState();
  const p = s.project, sc = activeScenario(s), info = s.info, series = s.series, sum = s.results?.summary, hc = s.handCalc;
  const pdf = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait", compress: true });
  // the standard PDF fonts are WinAnsi only: map the symbols used in the app's text to plain equivalents
  const origText = pdf.text.bind(pdf), origSplit = pdf.splitTextToSize.bind(pdf);
  (pdf as unknown as { text: unknown }).text = (t: string | string[], ...rest: unknown[]) => (origText as (...a: unknown[]) => JsPDF)(Array.isArray(t) ? t.map(pdfSafe) : pdfSafe(t), ...rest);
  (pdf as unknown as { splitTextToSize: unknown }).splitTextToSize = (t: string, w: number, o?: unknown) => origSplit(pdfSafe(t), w, o as never);
  const W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight(), M = 42;
  let y = M;
  let page = 1;
  const footer = () => {
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7.5); pdf.setTextColor(120);
    pdf.text(`Datum Flow 1.0 · ${p.title} · ${sc.name} · planning tool — not a code-compliance or life-safety engineering analysis`, M, H - 22);
    pdf.text(`${page}`, W - M, H - 22, { align: "right" });
  };
  const newPage = () => { footer(); pdf.addPage(); page++; y = M; };
  const need = (h: number) => { if (y + h > H - 40) newPage(); };
  const h1 = (t: string) => { need(30); pdf.setFont("helvetica", "bold"); pdf.setFontSize(14); pdf.setTextColor(20); pdf.text(t, M, y + 12); y += 24; pdf.setDrawColor(242, 169, 59); pdf.setLineWidth(1.2); pdf.line(M, y - 6, M + 40, y - 6); y += 6; };
  const para = (t: string, size = 9, color = 60) => {
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(size); pdf.setTextColor(color);
    const lines = pdf.splitTextToSize(t, W - 2 * M) as string[];
    for (const l of lines) { need(size + 3); pdf.text(l, M, y + size); y += size + 3; }
    y += 4;
  };
  const table = (head: string[], rows: (string | number)[][], widths: number[]) => {
    const rowH = 15;
    const draw = (cells: (string | number)[], bold: boolean) => {
      need(rowH);
      let x = M;
      pdf.setFont("helvetica", bold ? "bold" : "normal"); pdf.setFontSize(8.5); pdf.setTextColor(bold ? 30 : 50);
      cells.forEach((c, i) => {
        const s2 = String(c);
        const txt = (pdf.splitTextToSize(s2, widths[i] - 6) as string[])[0] ?? "";
        if (i === 0) pdf.text(txt, x + 3, y + 10.5); else pdf.text(txt, x + widths[i] - 3, y + 10.5, { align: "right" });
        x += widths[i];
      });
      pdf.setDrawColor(225); pdf.setLineWidth(0.5); pdf.line(M, y + rowH, M + widths.reduce((a, b) => a + b, 0), y + rowH);
      y += rowH;
    };
    draw(head, true);
    rows.forEach((r) => draw(r, false));
    y += 8;
  };
  const image = async (svg: string, w: number, h: number) => {
    const png = await svgToPng(svg, w, h);
    const dw = W - 2 * M, dh = (dw * h) / w;
    need(dh + 6);
    pdf.addImage(png, "PNG", M, y, dw, dh);
    y += dh + 10;
  };

  // ---------------------------------------------------------------- cover / summary
  pdf.setFillColor(23, 28, 33); pdf.rect(0, 0, W, 86, "F");
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(20); pdf.setTextColor(242, 169, 59); pdf.text("Datum Flow", M, 42);
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(11); pdf.setTextColor(230); pdf.text("Crowd movement & egress simulation report", M, 62);
  pdf.setFontSize(8.5); pdf.setTextColor(170); pdf.text(`QED Architecture & Engineering · ${new Date().toLocaleString("en-CA")}`, W - M, 62, { align: "right" });
  y = 110;
  pdf.setFont("helvetica", "bold"); pdf.setFontSize(15); pdf.setTextColor(20); pdf.text(p.title, M, y); y += 18;
  pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(70); pdf.text(`Scenario: ${sc.name} (${sc.kind}) · seed ${sum?.seed ?? sc.seed} · ${p.levels.length} level${p.levels.length > 1 ? "s" : ""}`, M, y); y += 20;
  if (p.sample) para("This is a FICTIONAL sample model supplied with Datum Flow for demonstration. It does not represent a real QED building.", 9, 140);
  para("Important: Datum Flow is a planning and communication tool. Results depend on the model, inputs and assumptions listed in this report and are not a substitute for a code-compliance review or a life-safety / fire-protection engineer's analysis.", 9, 120);

  h1("Key results");
  const evac = sc.kind === "evacuation" || sc.kind === "egress";
  table(["Metric", "Value"], [
    ["People simulated", (info?.n ?? 0).toLocaleString("en-CA")],
    [evac ? "Total evacuation time (last person out)" : "Time until all done", sum?.tet != null ? `${sum.tet.toFixed(0)} s (${fmtTime(sum.tet)})` : "not completed within the duration"],
    ["Completion P50 / P90", sum ? `${sum.p50?.toFixed(0) ?? "—"} s / ${sum.p90?.toFixed(0) ?? "—"} s` : "—"],
    ["Mean pre-movement / P90", sum ? `${sum.premoveMean} s / ${sum.premoveP90} s` : "—"],
    ["Mean travel time after pre-movement", sum ? `${sum.travelMean} s` : "—"],
    ["Peak local density", sum ? `${sum.maxDensity} p/m² (LOS ${LOS_LETTERS[losIndex(sum.maxDensity, p.settings.losStandard)]})` : "—"],
    [`Mean time per person at ≥ ${p.settings.congestionDensity} p/m²`, sum ? `${sum.congestedAgentS} s` : "—"],
    ["Simulated time / steps / wall time", sum ? `${sum.simTime} s / ${sum.steps} / ${(sum.wallMs / 1000).toFixed(1)} s` : "—"],
    ...(p.results?.find((r) => r.scenarioId === sc.id)?.monteCarlo ? (() => { const mc = p.results!.find((r) => r.scenarioId === sc.id)!.monteCarlo!; return [["Monte-Carlo TET P50 / P90 (" + mc.seeds.length + " seeds)", `${mc.p50 ?? "—"} s / ${mc.p90 ?? "—"} s (min ${mc.min ?? "—"}, max ${mc.max ?? "—"})`]]; })() : []),
  ], [330, W - 2 * M - 330]);

  if (evac && hc) {
    h1("Cross-check: simulation vs hand calculation");
    table(["Method", "Result"], [
      ["Simulation TET", sum?.tet != null ? `${sum.tet.toFixed(0)} s` : "—"],
      ["SFPE hydraulic RSET (P99 pre-movement + controlling flow)", `${hc.tHydraulic.toFixed(0)} s`],
      ["Controlling component (hydraulic)", hc.controlling],
      [`OBC 3.4.3.2 required exit width (${hc.population} × 6.1 mm)`, `${(hc.obcRequiredMm / 1000).toFixed(2)} m`],
      ["Exit width provided (counted per 3.4.3.2.(7))", `${(hc.obcProvidedCountedMm / 1000).toFixed(2)} m — ${hc.obcOk ? "meets" : "BELOW"} the capacity rule`],
      ...(hc.upperPopulation ? [[`Stair width required (${hc.upperPopulation} × 8 mm) / provided`, `${(hc.obcStairRequiredMm / 1000).toFixed(2)} m / ${(hc.obcStairProvidedMm / 1000).toFixed(2)} m`]] : []),
    ], [330, W - 2 * M - 330]);
    table(["Exit / stair (hydraulic)", "People", "We m", "Flow time s", "Exit time s"], [
      ...hc.exits.map((x) => [x.name, x.people, x.effWidth.toFixed(2), x.tFlow.toFixed(0), x.t.toFixed(0)]),
      ...hc.stairs.map((x) => [`${x.name} (stair)`, x.people, x.effWidth.toFixed(2), x.tFlow.toFixed(0), "—"]),
    ], [200, 70, 70, 90, W - 2 * M - 430]);
    para(hc.notes.join(" "), 8, 100);
    para(`${SOURCES.sfpe} ${SOURCES.obc} Both hand methods are coarse cross-checks shown beside the simulation; neither is a compliance calculation.`, 8, 100);
  }

  // ---------------------------------------------------------------- plans
  for (let li = 0; li < p.levels.length; li++) {
    newPage();
    h1(`Plan · ${p.levels[li].name} — maximum density (LOS)`);
    const img = planImage(li, live.info ? "maxdensity" : "none");
    const dw = W - 2 * M, dh = (dw * 950) / 1500;
    pdf.addImage(img, "JPEG", M, y, dw, dh);
    pdf.setDrawColor(200); pdf.rect(M, y, dw, dh);
    y += dh + 10;
    // LOS legend
    const t = LOS_TABLE[p.settings.losStandard].m2pp;
    let x = M;
    pdf.setFontSize(8);
    LOS_LETTERS.forEach((L, i) => {
      const [r, g, b] = [1, 3, 5].map((o) => parseInt(LOS_COLORS[i].slice(o, o + 2), 16));
      pdf.setFillColor(r, g, b); pdf.rect(x, y, 10, 10, "F");
      pdf.setTextColor(40);
      const rng = i === 0 ? `< ${(1 / t[0]).toFixed(2)}` : i === 5 ? `> ${(1 / t[4]).toFixed(2)}` : `${(1 / t[i - 1]).toFixed(2)}–${(1 / t[i]).toFixed(2)}`;
      pdf.text(`${L}  ${rng} p/m²`, x + 14, y + 8);
      x += 84;
    });
    y += 20;
    para(`${LOS_TABLE[p.settings.losStandard].source}. Colour = highest density reached in each 0.5 m cell during the run (3 × 3 cell window). Exits green, doors amber dashed, closed openings red; stairs blue with arrow from the upper (a) to the lower (b) end.`, 8, 100);
  }

  // ---------------------------------------------------------------- charts
  if (series && info) {
    newPage();
    h1("Charts");
    const cw = 640, ch = 240;
    await image(lineChart({ width: cw, height: ch, theme: PRINT_CHART, series: [{ name: evac ? "Evacuated" : "Done", x: series.t, y: series.done, color: "#2f8f5b" }, { name: "Moving", x: series.t, y: series.moving, color: "#2a6f97" }], timeAxis: true, yLabel: "people", marks: evac && hc ? [{ x: hc.tHydraulic, label: "hydraulic", color: "#c77700" }] : [] }), cw, ch);
    const exits = info.openings.map((o, k) => [o, k] as const).filter(([o]) => o.isExit);
    if (exits.length) await image(barChart({ width: cw, theme: PRINT_CHART, labels: exits.map(([o]) => o.name), values: exits.map(([, k]) => series.exitCum[k]?.[series.exitCum[k].length - 1] ?? 0), unit: "p", pct: true, colors: exits.map(() => "#2f8f5b") }), cw, 16 + exits.length * 22);
    const busiest = info.openings.map((o, k) => [o, k, series.exitCum[k]?.[series.exitCum[k].length - 1] ?? 0] as const).sort((a, b) => b[2] - a[2]).slice(0, 6);
    if (busiest.length) await image(lineChart({ width: cw, height: ch, theme: PRINT_CHART, series: busiest.map(([o, k], i) => ({ name: o.name, ...doorFlowSeries(series, info, k), color: SERIES_COLORS[i] })), yLabel: "p/m/min", timeAxis: true, hLines: [{ y: 79, label: "SFPE 1.32 p/(m·s)", color: "#888" }] }), cw, ch);
    await image(lineChart({ width: cw, height: 200, theme: PRINT_CHART, series: [{ name: "Peak local density p/m²", x: series.t, y: series.maxDensity, color: "#c0392b" }, { name: "Mean speed m/s", x: series.t, y: series.meanSpeed, color: "#2a6f97", dash: true }], timeAxis: true }), cw, 200);
    if (info.attractors.length && series.queue.some((q) => q.some((v) => v > 0))) await image(lineChart({ width: cw, height: 200, theme: PRINT_CHART, series: info.attractors.map((a, k) => ({ name: a.name, x: series.t, y: series.queue[k] ?? [], color: SERIES_COLORS[k % 9] })).filter((s2) => s2.y.some((v) => v > 0)), timeAxis: true, yLabel: "queue" }), cw, 200);
    const mc = p.results?.find((r) => r.scenarioId === sc.id)?.monteCarlo;
    const tets = (mc?.tets ?? []).filter((v): v is number => v !== null);
    if (tets.length >= 3) { para(`Monte-Carlo: ${tets.length} seeds, total evacuation time distribution.`, 9); await image(histogram(tets, { width: cw, height: 170, theme: PRINT_CHART, marks: [{ x: mc!.p50!, label: "P50" }, { x: mc!.p90!, label: "P90", color: "#c0392b" }] }), cw, 170); }
  }

  // ---------------------------------------------------------------- tables
  if (sum && info) {
    newPage();
    h1("Openings");
    table(["Opening", "Kind", "Width m", "People through", "Peak p/(m·s)"], info.openings.map((o, k) => [o.name, o.isExit ? "exit" : "door", o.width.toFixed(2), series?.exitCum[k]?.[series.exitCum[k].length - 1] ?? 0, (sum.doorPeak[o.id] ?? 0).toFixed(2)]), [190, 60, 70, 100, W - 2 * M - 420]);
    if (info.attractors.length) { h1("Attractors"); table(["Attractor", "Type", "Peak queue"], info.attractors.map((a) => [a.name, a.type, sum.queuePeak[a.id] ?? 0]), [260, 120, W - 2 * M - 380]); }
  }

  // ---------------------------------------------------------------- assumptions
  newPage();
  h1("Assumptions & inputs");
  table(["Scenario input", "Value"], [
    ["Type / exit choice", `${sc.kind} / ${sc.exitChoice}`],
    ["Seed / max duration", `${sc.seed} / ${sc.duration} s`],
    ["Seated pre-movement", distLabel(sc.seatPremove)],
    ["Closed openings", sc.closedExits.map((id) => p.elements.find((e) => e.id === id)?.name ?? id).join(", ") || "none"],
    ["Population scale", `× ${sc.agentScale}`],
    ...(sc.kind === "ingress" ? [["Arrival window / screening", `${sc.arrivalWindow} s / ${sc.useGates ? "yes" : "no"}`]] : []),
    ...(sc.kind === "circulation" ? [["Visit probabilities", Object.entries(sc.visit).map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)} %`).join(", ")]] : []),
    ["Grid / step / sub-steps", `${p.settings.gridCell} m / ${p.settings.dt} s / ${p.settings.substeps}`],
    ["Social force A, B, k, κ, λ", `${p.settings.sf.A} N, ${p.settings.sf.B} m, ${p.settings.sf.k}, ${p.settings.sf.kappa}, ${p.settings.anisotropy}`],
    ["Wall clearance (navigation)", `${p.settings.wallClearance} m`],
  ], [200, W - 2 * M - 200]);
  for (const sp of p.elements.filter((e) => e.kind === "spawn")) if (sp.kind === "spawn") para(`Spawn “${sp.name}”: ${sp.mode === "count" ? sp.count + " people" : sp.density + " p/m²"}, pre-movement ${distLabel(sp.premove)}, ${Math.round(sp.groupFrac * 100)} % in groups of ${sp.groupSize.join("–")}${sp.arrivals ? ", ingress arrivals" : ""}.`, 8, 80);
  h1("Occupant profiles");
  table(["Profile", "Speed m/s", "sd", "Radius m", "Stair ×"], p.profiles.map((q) => [q.name, q.speedMean.toFixed(2), q.speedSd.toFixed(2), q.radius.toFixed(2), q.stairFactor.toFixed(2)]), [200, 80, 60, 80, W - 2 * M - 420]);
  for (const q of p.profiles) para(`${q.name}: ${q.source}`, 7.5, 100);
  h1("Method and sources");
  for (const k of ["sf", "anis", "fmm", "groups", "stairs", "los", "fd"] as const) para(SOURCES[k], 8, 80);
  para("Known limits: 2D plan model per level (stairs as plan runs with speed factors); circular bodies (wheelchairs and children approximated); no smoke, visibility, fire growth or behavioural response beyond the pre-movement distribution; exit choice is nearest or congestion-aware least time, not familiarity-based; seats are spawned / filled at the block, not walked to individually. Validate important results against measured data and have them reviewed by a qualified engineer.", 8, 80);
  footer();
  const name = `${p.title.replace(/[^\w.-]+/g, "_")}_${sc.name.replace(/[^\w.-]+/g, "_")}.pdf`;
  return { pdf, name };
}

export async function exportReport() {
  const { pdf, name } = await buildReport();
  const blob = pdf.output("blob");
  download(name, blob, "application/pdf");
  return name;
}
