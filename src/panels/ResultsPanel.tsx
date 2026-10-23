// Results: KPIs, simulation vs hand-calculation cross-check, charts, Monte-Carlo distribution.
import { useMemo, useState } from "react";
import { activeScenario, setState, useStore } from "../store";
import { Field, Icon, Section } from "../ui";
import { barChart, fmtTime, histogram, lineChart, SERIES_COLORS } from "./charts";
import { runMonteCarlo, cancelMonteCarlo } from "../simctl";
import type { Series } from "../sim/engine";
import type { WorldInfo } from "../sim/protocol";
import { SOURCES } from "../model/defaults";

export function doorFlowSeries(series: Series, info: WorldInfo, k: number) {
  const cum = series.exitCum[k] ?? [];
  const w = Math.max(0.1, info.openings[k].width);
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < cum.length; i++) {
    const j = Math.max(0, i - 10);
    const dt = series.t[i] - (series.t[j] ?? 0);
    if (dt <= 0) continue;
    x.push(series.t[i]); y.push(+(((cum[i] - cum[j]) / dt) * 60 / w).toFixed(2));
  }
  return { x, y };
}

const CW = 340;
const Svg = ({ svg, testid }: { svg: string; testid?: string }) => <div className="chart" data-testid={testid} dangerouslySetInnerHTML={{ __html: svg }} />;

export default function ResultsPanel() {
  const series = useStore((s) => s.series);
  const info = useStore((s) => s.info);
  const hc = useStore((s) => s.handCalc);
  const results = useStore((s) => s.results);
  const sim = useStore((s) => s.sim);
  const mc = useStore((s) => s.mc);
  const sc = useStore((s) => activeScenario(s));
  const [mcN, setMcN] = useState(10);
  const [doorSel, setDoorSel] = useState<"exits" | "doors">("exits");
  const sum = results?.summary;
  const evac = sc.kind === "evacuation" || sc.kind === "egress";

  const charts = useMemo(() => {
    if (!series || !info) return null;
    const t = series.t;
    const n = info.n;
    const cum = lineChart({
      width: CW, height: 210,
      series: [
        { name: sc.kind === "ingress" ? "Seated" : sc.kind === "circulation" ? "Seated / returned" : "Evacuated", x: t, y: series.done, color: "#5cc28a" },
        { name: "Moving", x: t, y: series.moving, color: "#5aa9e6" },
        { name: "In the model", x: t, y: series.active, color: "#9aa4ad", dash: true },
      ],
      yLabel: "people", timeAxis: true, yMax: n,
      marks: evac && hc ? [{ x: hc.tHydraulic, label: `hand calc ${fmtTime(hc.tHydraulic)}`, color: "#f2a93b" }, ...(sum?.tet ? [{ x: sum.tet, label: `TET ${fmtTime(sum.tet)}`, color: "#5cc28a" }] : [])] : sum?.tet ? [{ x: sum.tet, label: `last ${fmtTime(sum.tet)}` }] : [],
    });
    const idx = info.openings.map((o, k) => [o, k] as const).filter(([o]) => (doorSel === "exits" ? o.isExit : !o.isExit));
    const busiest = idx.map(([o, k]) => [o, k, series.exitCum[k]?.[series.exitCum[k].length - 1] ?? 0] as const).sort((a, b) => b[2] - a[2]).slice(0, 6);
    const flows = busiest.length ? lineChart({ width: CW, height: 220, series: busiest.map(([o, k], i) => ({ name: o.name, x: doorFlowSeries(series, info, k).x, y: doorFlowSeries(series, info, k).y, color: SERIES_COLORS[i] })), yLabel: "p/m/min", timeAxis: true, hLines: [{ y: 79, label: "SFPE 1.32 p/(m·s)", color: "#6f7983" }] }) : "";
    const exits = info.openings.map((o, k) => [o, k] as const).filter(([o]) => o.isExit);
    const usage = exits.length ? barChart({ width: CW, labels: exits.map(([o]) => o.name), values: exits.map(([, k]) => series.exitCum[k]?.[series.exitCum[k].length - 1] ?? 0), unit: "p", pct: true, colors: exits.map(() => "#5cc28a") }) : "";
    const dens = lineChart({ width: CW, height: 200, series: [{ name: "Peak local density", x: t, y: series.maxDensity, color: "#ef6a3a" }, { name: "Mean speed m/s", x: t, y: series.meanSpeed, color: "#5aa9e6", dash: true }], yLabel: "p/m²", timeAxis: true, hLines: [{ y: 2.17, label: "LOS F", color: "#d2304a" }] });
    const q = info.attractors.length && series.queue.some((a) => a.some((v) => v > 0)) ? lineChart({ width: CW, height: 210, series: info.attractors.map((a, k) => ({ name: a.name, x: t, y: series.queue[k] ?? [], color: SERIES_COLORS[k % SERIES_COLORS.length] })).filter((s) => s.y.some((v) => v > 0)), yLabel: "in queue", timeAxis: true }) : "";
    return { cum, flows, usage, dens, q };
  }, [series, info, hc, sum, sc.kind, evac, doorSel]);

  const mcOk = (mc?.runs ?? []).map((r) => r.tet).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const pct = (p: number) => (mcOk.length ? mcOk[Math.min(mcOk.length - 1, Math.floor(p * (mcOk.length - 1) + 0.5))] : null);

  if (!info) return <div className="panel-body"><div className="panel-empty">Press <b>Play</b> to run “{sc.name}”.<br />Results, charts and the hand-calculation cross-check appear here.</div></div>;

  return (
    <div className="panel-body" data-testid="results">
      <div className="panel-pad col">
        <div className="kpis" data-testid="kpis">
          <div><span>{sim.status !== "finished" ? "Time" : evac ? "TET" : sc.kind === "ingress" ? "All seated" : "Sim time"}</span><b data-testid="kpi-tet">{sum?.tet != null ? fmtTime(sum.tet) : sim.status === "finished" ? "—" : fmtTime(sim.t)}</b></div>
          <div><span>People</span><b>{info.n.toLocaleString("en-CA")}</b></div>
          <div><span>{evac ? "Out" : "Done"}</span><b>{sim.done.toLocaleString("en-CA")}</b></div>
          <div><span>Peak p/m²</span><b>{(sum?.maxDensity ?? Math.max(0, ...(series?.maxDensity ?? [0]))).toFixed(2)}</b></div>
          {sum && <>
            <div><span>P50</span><b>{sum.p50 != null ? fmtTime(sum.p50) : "—"}</b></div>
            <div><span>P90</span><b>{sum.p90 != null ? fmtTime(sum.p90) : "—"}</b></div>
            <div><span>Pre-move μ</span><b>{fmtTime(sum.premoveMean)}</b></div>
            <div><span>Congested</span><b title="Mean time per person at or above the congestion density">{fmtTime(sum.congestedAgentS)}</b></div>
          </>}
        </div>
        {sim.status !== "finished" && <div className="hint">Live — final metrics appear when the run completes (or use <b>Run to end</b>).</div>}
      </div>

      {evac && hc && (
        <Section title="Cross-check · simulation vs hand calculation" n={<span className="badge accent">cross-check</span>}>
          <table className="stats-tbl" data-testid="handcalc">
            <tbody>
              <tr><td>Simulation TET (last person out)</td><td className="n">{sum?.tet != null ? `${sum.tet.toFixed(0)} s` : "run to end"}</td></tr>
              <tr><td>Simulation RSET P90</td><td className="n">{sum?.p90 != null ? `${sum.p90.toFixed(0)} s` : "—"}</td></tr>
              <tr><td>SFPE hydraulic RSET (P99 pre-move + flow)</td><td className="n" data-testid="hc-time">{hc.tHydraulic.toFixed(0)} s</td></tr>
              <tr><td colSpan={2} className="hint" style={{ whiteSpace: "normal" }}>Controlling: {hc.controlling}</td></tr>
              <tr><td>OBC 3.4.3.2 exit width required ({hc.population} × 6.1 mm)</td><td className="n">{(hc.obcRequiredMm / 1000).toFixed(2)} m</td></tr>
              <tr><td>Exit width provided (counted)</td><td className="n" style={{ color: hc.obcOk ? "var(--ok)" : "var(--err)" }}>{(hc.obcProvidedCountedMm / 1000).toFixed(2)} m {hc.obcOk ? "✓" : "✗"}</td></tr>
              {hc.upperPopulation > 0 && <tr><td>Stair width required ({hc.upperPopulation} × 8 mm)</td><td className="n" style={{ color: hc.obcStairOk ? "var(--ok)" : "var(--err)" }}>{(hc.obcStairRequiredMm / 1000).toFixed(2)} / {(hc.obcStairProvidedMm / 1000).toFixed(2)} m</td></tr>}
            </tbody>
          </table>
          <details className="hint"><summary>Per exit</summary>
            <table className="stats-tbl"><thead><tr><th>Exit</th><th>N</th><th>We m</th><th>flow s</th><th>t s</th></tr></thead>
              <tbody>{hc.exits.map((x) => <tr key={x.id}><td>{x.name}</td><td className="n">{x.people}</td><td className="n">{x.effWidth.toFixed(2)}</td><td className="n">{x.tFlow.toFixed(0)}</td><td className="n">{x.t.toFixed(0)}</td></tr>)}
                {hc.stairs.map((x) => <tr key={x.id}><td>{x.name} (stair)</td><td className="n">{x.people}</td><td className="n">{x.effWidth.toFixed(2)}</td><td className="n">{x.tFlow.toFixed(0)}</td><td className="n">—</td></tr>)}</tbody></table>
            {hc.notes.map((n) => <div key={n}>· {n}</div>)}
          </details>
          <div className="hint">{SOURCES.sfpe} {SOURCES.obc} These hand methods are cross-checks for orientation only — not a code-compliance analysis.</div>
        </Section>
      )}

      {charts && <>
        <Section title={sc.kind === "ingress" ? "Cumulative seated" : sc.kind === "circulation" ? "People over time" : "Cumulative evacuated"}><Svg svg={charts.cum} testid="chart-cum" /></Section>
        {charts.usage && <Section title="Exit usage"><Svg svg={charts.usage} testid="chart-usage" /></Section>}
        <Section title="Flow through openings" right={<div className="seg"><button className={doorSel === "exits" ? "on" : ""} onClick={() => setDoorSel("exits")}>Exits</button><button className={doorSel === "doors" ? "on" : ""} onClick={() => setDoorSel("doors")}>Doors</button></div>}>
          {charts.flows ? <Svg svg={charts.flows} testid="chart-flow" /> : <div className="hint">No crossings yet.</div>}
          <div className="hint">10 s moving window, persons per metre of clear width per minute (SFPE design max ≈ 79 p/m/min of effective width).</div>
        </Section>
        <Section title="Density & speed"><Svg svg={charts.dens} /></Section>
        {charts.q && <Section title="Queues at attractors"><Svg svg={charts.q} testid="chart-queue" /></Section>}
      </>}

      <Section title="Monte-Carlo" n={mc?.runs.length ? `${mc.runs.length}/${mc.total}` : undefined}>
        <div className="hint">Re-runs the scenario with different seeds (spawn positions, speeds, pre-movement, exit choice) in parallel workers.</div>
        <div className="row">
          <Field label="Seeds"><input className="input sm mono" type="number" min={2} max={200} value={mcN} onChange={(e) => setMcN(Math.max(2, Math.min(200, Number(e.target.value) || 2)))} data-testid="mc-n" /></Field>
          {mc?.running ? <button className="btn sm" onClick={cancelMonteCarlo}><span className="spin" />Cancel</button>
            : <button className="btn sm primary" onClick={() => runMonteCarlo(mcN)} data-testid="mc-run"><Icon name="dice" size={14} />Run {mcN}</button>}
        </div>
        {mcOk.length > 0 && <>
          <div className="kpis" data-testid="mc-kpis">
            <div><span>P50 TET</span><b data-testid="mc-p50">{fmtTime(pct(0.5)!)}</b></div>
            <div><span>P90 TET</span><b data-testid="mc-p90">{fmtTime(pct(0.9)!)}</b></div>
            <div><span>Min</span><b>{fmtTime(mcOk[0])}</b></div>
            <div><span>Max</span><b>{fmtTime(mcOk[mcOk.length - 1])}</b></div>
          </div>
          {mcOk.length >= 3 && <Svg svg={histogram(mcOk, { width: CW, height: 150, marks: [{ x: pct(0.5)!, label: "P50" }, { x: pct(0.9)!, label: "P90", color: "#ef6a3a" }], xLabel: "total evacuation time" })} testid="mc-hist" />}
          <div className="hint mono">{mc!.runs.map((r) => `#${r.seed}: ${r.tet != null ? r.tet.toFixed(0) + " s" : "not cleared"}`).join(" · ")}</div>
          {(mc?.runs.length ?? 0) > 0 && <div className="hint mono">engine ≈ {Math.round(mc!.runs.reduce((a, r) => a + r.stepsPerSec, 0) / mc!.runs.length)} steps/s per worker · {mc!.runs[0].agents.toLocaleString("en-CA")} agents</div>}
        </>}
      </Section>
      <div className="panel-pad"><button className="btn sm ghost" onClick={() => setState({ rightTab: "props" })}>Properties</button></div>
    </div>
  );
}
