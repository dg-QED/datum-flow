// Scenario definition (kind, exits, sources, timing) and model settings / profiles.
import { activeScenario, editProject, useStore } from "../store";
import { Field, Icon, Section } from "../ui";
import { DistEditor, Num } from "./PropsPanel";
import { ATTRACTOR_LABEL, LOS_TABLE, newScenario, SOURCES, uid } from "../model/defaults";
import type { AttractorType, Scenario, Settings } from "../model/types";

export default function ScenarioPanel() {
  const project = useStore((s) => s.project);
  const sc = useStore((s) => activeScenario(s));
  const set = (patch: Partial<Scenario>) => editProject((p) => { p.scenarios = p.scenarios.map((x) => (x.id === sc.id ? { ...x, ...patch } : x)); }, { undoable: false });
  const setS = (patch: Partial<Settings>) => editProject((p) => { p.settings = { ...p.settings, ...patch }; }, { undoable: false });
  const exits = project.elements.filter((e) => e.kind === "exit" || e.kind === "door");
  const spawns = project.elements.filter((e) => e.kind === "spawn");
  const seating = project.elements.filter((e) => e.kind === "seating");
  const types = [...new Set(project.elements.filter((e) => e.kind === "attractor").map((e) => (e.kind === "attractor" ? e.type : "other")))] as AttractorType[];
  const toggleIn = (key: "spawns" | "seating", id: string, on: boolean, all: string[]) => {
    const cur = sc[key] === "all" ? all : (sc[key] as string[]);
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    set({ [key]: next.length === all.length ? "all" : next } as Partial<Scenario>);
  };
  return (
    <div className="panel-body" data-testid="scenario-panel">
      <Section title="Scenario" n={project.scenarios.length}>
        <div className="row">
          <select className="select sm grow" value={sc.id} onChange={(e) => editProject((p) => { p.activeScenario = e.target.value; }, { undoable: false })} aria-label="Scenario" data-testid="scenario-select">
            {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn sm icon" title="Duplicate scenario" aria-label="Duplicate scenario" onClick={() => editProject((p) => { const c = { ...structuredClone(sc), id: uid("sc"), name: `${sc.name} (copy)` }; p.scenarios = [...p.scenarios, c]; p.activeScenario = c.id; }, { undoable: false })}><Icon name="copy" size={13} /></button>
          <button className="btn sm icon" title="Delete scenario" aria-label="Delete scenario" disabled={project.scenarios.length < 2} onClick={() => editProject((p) => { p.scenarios = p.scenarios.filter((x) => x.id !== sc.id); p.activeScenario = p.scenarios[0].id; }, { undoable: false })}><Icon name="trash" size={13} /></button>
        </div>
        <div className="row wrap">
          {(["evacuation", "egress", "ingress", "circulation"] as const).map((k) => (
            <button key={k} className="btn sm ghost" onClick={() => editProject((p) => { const n = newScenario(k); p.scenarios = [...p.scenarios, n]; p.activeScenario = n.id; }, { undoable: false })}><Icon name="plus" size={12} />{k}</button>
          ))}
        </div>
        <Field label="Name"><input className="input sm" value={sc.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Type"><select className="select sm" value={sc.kind} onChange={(e) => set({ kind: e.target.value as Scenario["kind"] })} data-testid="scenario-kind">
          <option value="evacuation">Evacuation — everyone to exits</option><option value="egress">Egress after the event</option><option value="ingress">Ingress — gates to seats</option><option value="circulation">Free circulation with attractors</option></select></Field>
        <Field label="Seed"><Num value={sc.seed} step={1} min={0} onChange={(seed) => set({ seed: Math.round(seed) })} testid="seed" /></Field>
        <Field label="Max duration s"><Num value={sc.duration} step={60} min={10} onChange={(duration) => set({ duration })} /></Field>
        <Field label="Population ×"><Num value={sc.agentScale} step={0.1} min={0} max={10} onChange={(agentScale) => set({ agentScale })} /></Field>
        {(sc.kind === "evacuation" || sc.kind === "egress") && <Field label="Exit choice"><select className="select sm" value={sc.exitChoice} onChange={(e) => set({ exitChoice: e.target.value as Scenario["exitChoice"] })}>
          <option value="nearest">Nearest (shortest route)</option><option value="least-time">Least time (congestion-aware)</option></select></Field>}
        {sc.kind !== "ingress" && <DistEditor label="Seated pre-move" value={sc.seatPremove} onChange={(seatPremove) => set({ seatPremove })} />}
        {sc.kind === "ingress" && <>
          <Field label="Arrival window s"><Num value={sc.arrivalWindow} step={60} min={0} onChange={(arrivalWindow) => set({ arrivalWindow })} /></Field>
          <label className="row"><input type="checkbox" checked={sc.useGates} onChange={(e) => set({ useGates: e.target.checked })} />Screen at gate attractors</label>
          <div className="hint">Ingress uses spawn zones flagged “arrivals”; people pass a gate attractor (if any) and walk to a seat in a block chosen by remaining capacity.</div>
        </>}
        {sc.kind === "circulation" && <>
          <div className="eyebrow">Visit probability</div>
          {types.length ? types.map((t) => (
            <Field key={t} label={ATTRACTOR_LABEL[t]}><input type="range" min={0} max={1} step={0.01} value={sc.visit[t] ?? 0} onChange={(e) => set({ visit: { ...sc.visit, [t]: Number(e.target.value) } })} /><span className="val">{Math.round((sc.visit[t] ?? 0) * 100)}%</span></Field>
          )) : <div className="hint">Add attractors (A) — concessions, washrooms…</div>}
          <div className="hint">Each person visits at most one attractor (by the probabilities above), queues, is served, then returns to their seat or zone.</div>
        </>}
      </Section>
      <Section title="Exits & doors" n={exits.length}>
        {exits.length ? exits.map((e) => (
          <label key={e.id} className="row" style={{ fontSize: 12.5 }}>
            <input type="checkbox" checked={!sc.closedExits.includes(e.id) && !("closed" in e && e.closed)} disabled={"closed" in e && e.closed} data-testid={`open-${e.name}`}
              onChange={(ev) => set({ closedExits: ev.target.checked ? sc.closedExits.filter((x) => x !== e.id) : [...sc.closedExits, e.id] })} />
            <span className="grow">{e.name || e.kind}</span><span className="faint mono">{e.kind === "exit" ? "exit" : "door"}</span>
          </label>
        )) : <div className="hint">No exits yet — draw one with E.</div>}
        <div className="hint">Unticked = closed / blocked for this scenario (fire, security hold…).</div>
      </Section>
      {(spawns.length > 0 || seating.length > 0) && (
        <Section title="Population sources" defaultOpen={false}>
          {spawns.map((e) => <label key={e.id} className="row" style={{ fontSize: 12.5 }}><input type="checkbox" checked={sc.spawns === "all" || sc.spawns.includes(e.id)} onChange={(ev) => toggleIn("spawns", e.id, ev.target.checked, spawns.map((x) => x.id))} />{e.name}{e.kind === "spawn" && e.arrivals ? <span className="badge pending">arrivals</span> : null}</label>)}
          {seating.map((e) => <label key={e.id} className="row" style={{ fontSize: 12.5 }}><input type="checkbox" checked={sc.seating === "all" || sc.seating.includes(e.id)} onChange={(ev) => toggleIn("seating", e.id, ev.target.checked, seating.map((x) => x.id))} />{e.name} <span className="faint">seated</span></label>)}
        </Section>
      )}
      <Section title="Model settings" defaultOpen={false}>
        <Field label="Grid cell m"><Num value={project.settings.gridCell} step={0.05} min={0.1} max={1} onChange={(gridCell) => setS({ gridCell })} /></Field>
        <Field label="Step dt s · sub"><Num value={project.settings.dt} step={0.01} min={0.01} max={0.1} onChange={(dt) => setS({ dt })} /><Num value={project.settings.substeps} step={1} min={1} max={6} onChange={(substeps) => setS({ substeps: Math.round(substeps) })} /></Field>
        <Field label="Wall clearance"><Num value={project.settings.wallClearance} step={0.1} min={0} max={1.5} onChange={(wallClearance) => setS({ wallClearance })} /></Field>
        <Field label="LOS standard"><select className="select sm" value={project.settings.losStandard} onChange={(e) => setS({ losStandard: e.target.value as Settings["losStandard"] })}>{(Object.keys(LOS_TABLE) as Settings["losStandard"][]).map((k) => <option key={k} value={k}>{LOS_TABLE[k].name}</option>)}</select></Field>
        <Field label="Congested ≥ p/m²"><Num value={project.settings.congestionDensity} step={0.1} min={0.5} max={6} onChange={(congestionDensity) => setS({ congestionDensity })} /></Field>
        <Field label="Anisotropy λ"><Num value={project.settings.anisotropy} step={0.05} min={0} max={1} onChange={(anisotropy) => setS({ anisotropy })} /></Field>
        <Field label="A N · B m"><Num value={project.settings.sf.A} step={100} min={0} onChange={(A) => setS({ sf: { ...project.settings.sf, A, Aw: A } })} /><Num value={project.settings.sf.B} step={0.01} min={0.01} onChange={(B) => setS({ sf: { ...project.settings.sf, B, Bw: B } })} /></Field>
        <Field label="k · κ"><Num value={project.settings.sf.k} step={10000} min={0} onChange={(k) => setS({ sf: { ...project.settings.sf, k } })} /><Num value={project.settings.sf.kappa} step={10000} min={0} onChange={(kappa) => setS({ sf: { ...project.settings.sf, kappa } })} /></Field>
        <div className="hint">{SOURCES.sf} {SOURCES.anis}</div>
      </Section>
      <Section title="Profiles" defaultOpen={false}>
        <table className="stats-tbl"><thead><tr><th>Profile</th><th>v m/s</th><th>sd</th><th>r m</th></tr></thead><tbody>
          {project.profiles.map((p) => (
            <tr key={p.id} title={p.source}>
              <td><span className="sw pt" style={{ background: p.color }} /> {p.name}</td>
              {(["speedMean", "speedSd", "radius"] as const).map((k) => <td key={k} className="n"><input className="input sm mono" style={{ width: 58 }} type="number" step={0.01} value={p[k]} onChange={(e) => editProject((pp) => { pp.profiles = pp.profiles.map((q) => (q.id === p.id ? { ...q, [k]: Number(e.target.value) } : q)); }, { undoable: false })} /></td>)}
            </tr>
          ))}
        </tbody></table>
        <div className="hint">Hover a row for its source. {SOURCES.stairs}</div>
      </Section>
    </div>
  );
}
