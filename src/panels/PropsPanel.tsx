// Properties of the selected element (all kinds), plus a short reference when nothing is selected.
import { useEffect, useState, type ReactNode } from "react";
import { editProject, setState, updateElement, useStore } from "../store";
import { Field, Icon, Section } from "../ui";
import type { AttractorType, Dist, Element, ProfileId, ProfileMix } from "../model/types";
import { ATTRACTOR_LABEL, PROFILE_ORDER, distLabel } from "../model/defaults";
import { dist, lengthOf, polyArea, seatingLayout } from "../model/geom";
import { KIND_LABEL } from "../view/palette";

function Num({ value, onChange, step = 0.1, min, max, testid, width }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; testid?: string; width?: number }) {
  const [s, setS] = useState(String(value));
  useEffect(() => setS(String(+value.toFixed(4))), [value]);
  return <input className="input sm mono" type="number" step={step} min={min} max={max} value={s} style={width ? { width } : undefined} data-testid={testid}
    onChange={(e) => { setS(e.target.value); const v = Number(e.target.value); if (e.target.value !== "" && isFinite(v)) onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, v) : v) : v); }} />;
}

export function DistEditor({ value, onChange, label }: { value: Dist; onChange: (d: Dist) => void; label: ReactNode }) {
  return (
    <>
      <Field label={label}>
        <select className="select sm" value={value.type} onChange={(e) => {
          const t = e.target.value as Dist["type"];
          onChange(t === "lognormal" ? { type: t, a: 30, b: 0.5 } : t === "uniform" ? { type: t, a: 0, b: 60 } : t === "normal" ? { type: t, a: 30, b: 10 } : { type: t, a: 0, b: 0 });
        }}>
          <option value="lognormal">Log-normal</option><option value="uniform">Uniform</option><option value="normal">Normal</option><option value="fixed">Fixed</option>
        </select>
      </Field>
      <Field label={value.type === "lognormal" ? "median s · σ" : value.type === "uniform" ? "min · max s" : value.type === "normal" ? "mean · sd s" : "seconds"}>
        <Num value={value.a} step={1} min={0} onChange={(a) => onChange({ ...value, a })} />
        {value.type !== "fixed" && <Num value={value.b} step={value.type === "lognormal" ? 0.05 : 1} min={0} onChange={(b) => onChange({ ...value, b })} />}
      </Field>
      <div className="hint mono" style={{ marginTop: -4 }}>{distLabel(value)}</div>
    </>
  );
}

export function MixEditor({ value, onChange }: { value: ProfileMix; onChange: (m: ProfileMix) => void }) {
  const profiles = useStore((s) => s.project.profiles);
  const tot = PROFILE_ORDER.reduce((a, k) => a + (value[k] ?? 0), 0) || 1;
  return (
    <div className="mix">
      {PROFILE_ORDER.map((id: ProfileId) => {
        const p = profiles.find((q) => q.id === id)!;
        return (
          <div key={id} className="mix-row">
            <span className="sw pt" style={{ background: p.color }} />
            <span className="nm">{p.name}</span>
            <input type="range" min={0} max={1} step={0.01} value={value[id] ?? 0} onChange={(e) => onChange({ ...value, [id]: Number(e.target.value) })} aria-label={p.name} />
            <span className="val mono">{Math.round(((value[id] ?? 0) / tot) * 100)}%</span>
          </div>
        );
      })}
    </div>
  );
}

export default function PropsPanel() {
  const sel = useStore((s) => s.selection);
  const e = useStore((s) => s.project.elements.find((x) => x.id === s.selection[0]));
  const levels = useStore((s) => s.project.levels);
  const scenario = useStore((s) => s.project.scenarios.find((x) => x.id === s.project.activeScenario));
  if (!e || sel.length !== 1) return (
    <div className="panel-body"><div className="panel-pad col">
      <div className="hint"><b>Select</b> an element on the plan (V) to edit it. Drag to move, drag the square handles to reshape, <span className="kbd">Del</span> to delete. Click a person while a run is loaded to follow them.</div>
      <div className="hint">Draw: <span className="kbd">W</span> wall · <span className="kbd">O</span> obstacle · <span className="kbd">D</span> door · <span className="kbd">E</span> exit · <span className="kbd">S</span> stair · <span className="kbd">B</span> seating · <span className="kbd">Z</span> spawn · <span className="kbd">A</span> attractor · <span className="kbd">N</span> one-way · <span className="kbd">K</span> calibrate · <span className="kbd">M</span> measure.</div>
    </div></div>
  );
  const up = (patch: Partial<Element>) => updateElement(e.id, patch);
  const closedInScenario = scenario?.closedExits.includes(e.id) ?? false;
  return (
    <div className="panel-body" data-testid="props">
      <div className="panel-pad col">
        <div className="row"><b style={{ fontSize: 14 }}>{KIND_LABEL[e.kind]}</b><span className="grow" />
          <button className="btn sm ghost icon" title="Delete (Del)" aria-label="Delete element" onClick={() => { editProject((p) => { p.elements = p.elements.filter((x) => x.id !== e.id); }); setState({ selection: [] }); }}><Icon name="trash" size={14} /></button>
        </div>
        <Field label="Name"><input className="input sm" value={e.name} onChange={(ev) => updateElement(e.id, { name: ev.target.value }, false)} data-testid="prop-name" /></Field>
        <Field label="Level"><select className="select sm" value={e.level} onChange={(ev) => up({ level: ev.target.value })}>{levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        {e.kind === "wall" && <>
          <Field label="Thickness m"><Num value={e.thickness} step={0.05} min={0.02} onChange={(thickness) => up({ thickness })} /></Field>
          <label className="row"><input type="checkbox" checked={e.closed} onChange={(ev) => up({ closed: ev.target.checked })} />Closed loop</label>
          <div className="hint mono">{e.pts.length} vertices · {lengthOf(e).toFixed(2)} m</div>
        </>}
        {e.kind === "obstacle" && <div className="hint mono">{e.pts.length} vertices · {polyArea(e.pts).toFixed(2)} m²</div>}
        {(e.kind === "door" || e.kind === "exit") && <>
          <div className="hint mono">clear width {dist(e.a, e.b).toFixed(2)} m{e.kind === "door" ? "" : ` · SFPE effective ${(dist(e.a, e.b) - 0.3).toFixed(2)} m`}</div>
          <label className="row"><input type="checkbox" checked={e.closed} onChange={(ev) => up({ closed: ev.target.checked })} />Closed / blocked (all scenarios)</label>
          {scenario && <label className="row"><input type="checkbox" checked={closedInScenario} data-testid="prop-closed-scenario" onChange={(ev) => editProject((p) => { p.scenarios = p.scenarios.map((s) => (s.id === scenario.id ? { ...s, closedExits: ev.target.checked ? [...s.closedExits, e.id] : s.closedExits.filter((x) => x !== e.id) } : s)); })} />Closed in “{scenario.name}”</label>}
          {e.kind === "door" && <Field label="Max flow p/s"><input className="input sm mono" type="number" min={0} step={0.1} placeholder="unlimited" value={e.maxFlow ?? ""} onChange={(ev) => up({ maxFlow: ev.target.value === "" ? null : Math.max(0, Number(ev.target.value)) })} /></Field>}
          {e.kind === "door" && <div className="hint">A max flow models a controlled door, turnstile or ticket check: people are held at the door when the rate is exceeded.</div>}
        </>}
        {e.kind === "barrier" && <div className="hint">People may cross from the left of a→b to the right (arrows), never back. Swap the ends to reverse.<button className="btn sm" style={{ marginTop: 6 }} onClick={() => up({ a: e.b, b: e.a })}>Reverse direction</button></div>}
        {e.kind === "stair" && <>
          <Field label="Connects to"><select className="select sm" value={e.toLevel} onChange={(ev) => up({ toLevel: ev.target.value })}>{levels.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.elevation} m)</option>)}</select></Field>
          <Field label="Width m"><Num value={e.width} step={0.1} min={0.6} onChange={(width) => up({ width })} /></Field>
          <label className="row"><input type="checkbox" checked={e.ramp} onChange={(ev) => up({ ramp: ev.target.checked, ...(ev.target.checked ? { speedDown: 0.9, speedUp: 0.8 } : { speedDown: 0.52, speedUp: 0.45 }) })} />Ramp (no treads)</label>
          <Field label="Speed ↓ · ↑"><Num value={e.speedDown} step={0.01} min={0.1} max={1.2} onChange={(speedDown) => up({ speedDown })} /><Num value={e.speedUp} step={0.01} min={0.1} max={1.2} onChange={(speedUp) => up({ speedUp })} /></Field>
          <div className="hint">Factors of free walking speed, horizontal component. Defaults from Fujiyama & Tyler (2004): ≈ 0.52 descending, 0.45 ascending on 30–35° flights. Plan run {dist(e.a, e.b).toFixed(2)} m; drawn from a (opens onto this level) to b (arrives on “{levels.find((l) => l.id === e.toLevel)?.name}”).</div>
          <button className="btn sm" onClick={() => up({ a: e.b, b: e.a })}>Swap ends</button>
        </>}
        {e.kind === "seating" && <>
          <Field label="Width · depth m"><Num value={e.width} step={0.5} min={1} onChange={(width) => up({ width })} /><Num value={e.depth} step={0.5} min={0.8} onChange={(depth) => up({ depth })} /></Field>
          <Field label="Rotation °"><Num value={+((e.angle * 180) / Math.PI).toFixed(2)} step={5} onChange={(d) => up({ angle: (d * Math.PI) / 180 })} />
            <button className="btn sm icon" title="Rotate 90°" aria-label="Rotate 90 degrees" onClick={() => up({ angle: e.angle + Math.PI / 2 })}><Icon name="redo" size={13} /></button></Field>
          <Field label="Row pitch · seat"><Num value={e.rowPitch} step={0.05} min={0.6} onChange={(rowPitch) => up({ rowPitch })} /><Num value={e.seatWidth} step={0.025} min={0.4} onChange={(seatWidth) => up({ seatWidth })} /></Field>
          <Field label="Aisles"><select className="select sm" value={e.aisles} onChange={(ev) => up({ aisles: ev.target.value as typeof e.aisles })}>
            <option value="both">Both sides</option><option value="center">Centre</option><option value="left">Left only</option><option value="right">Right only</option><option value="open">Open row ends</option><option value="none">None (walled)</option></select></Field>
          <Field label="Aisle width m"><Num value={e.aisleWidth} step={0.1} min={0.6} onChange={(aisleWidth) => up({ aisleWidth })} /></Field>
          <Field label="Occupancy"><input type="range" min={0} max={1} step={0.01} value={e.occupancy} onChange={(ev) => updateElement(e.id, { occupancy: Number(ev.target.value) }, false)} /><span className="val">{Math.round(e.occupancy * 100)}%</span></Field>
          <div className="hint mono">{seatingLayout(e).rows.length} row segments · {seatingLayout(e).capacity} seats · ≈ {Math.round(seatingLayout(e).capacity * e.occupancy)} occupied</div>
          <div className="eyebrow">Occupant mix</div>
          <MixEditor value={e.profile} onChange={(profile) => updateElement(e.id, { profile }, false)} />
          <div className="hint">Wheelchair users are seated at aisle positions only. The front row is the solid edge; rows step back from it.</div>
        </>}
        {e.kind === "spawn" && <>
          <div className="seg full"><button className={e.mode === "count" ? "on" : ""} onClick={() => up({ mode: "count" })}>Count</button><button className={e.mode === "density" ? "on" : ""} onClick={() => up({ mode: "density" })}>Density</button></div>
          {e.mode === "count" ? <Field label="People"><Num value={e.count} step={10} min={0} onChange={(count) => up({ count: Math.round(count) })} testid="prop-count" /></Field>
            : <Field label="p/m²"><Num value={e.density} step={0.05} min={0} max={4} onChange={(density) => up({ density })} /></Field>}
          <div className="hint mono">area {polyArea(e.pts).toFixed(1)} m² · ≈ {e.mode === "count" ? e.count : Math.round(e.density * polyArea(e.pts))} people</div>
          <DistEditor label="Pre-movement" value={e.premove} onChange={(premove) => up({ premove })} />
          <Field label="In groups"><input type="range" min={0} max={1} step={0.05} value={e.groupFrac} onChange={(ev) => updateElement(e.id, { groupFrac: Number(ev.target.value) }, false)} /><span className="val">{Math.round(e.groupFrac * 100)}%</span></Field>
          <Field label="Group size"><Num value={e.groupSize[0]} step={1} min={2} onChange={(v) => up({ groupSize: [Math.round(v), Math.max(Math.round(v), e.groupSize[1])] })} /><Num value={e.groupSize[1]} step={1} min={2} onChange={(v) => up({ groupSize: [Math.min(e.groupSize[0], Math.round(v)), Math.round(v)] })} /></Field>
          <label className="row"><input type="checkbox" checked={e.arrivals} onChange={(ev) => up({ arrivals: ev.target.checked })} />Ingress arrivals (used only by ingress scenarios)</label>
          <div className="eyebrow">Profile mix</div>
          <MixEditor value={e.profile} onChange={(profile) => updateElement(e.id, { profile }, false)} />
        </>}
        {e.kind === "attractor" && <>
          <Field label="Type"><select className="select sm" value={e.type} onChange={(ev) => up({ type: ev.target.value as AttractorType })}>{(Object.keys(ATTRACTOR_LABEL) as AttractorType[]).map((t) => <option key={t} value={t}>{ATTRACTOR_LABEL[t]}</option>)}</select></Field>
          <Field label="Servers"><Num value={e.servers} step={1} min={1} max={40} onChange={(servers) => up({ servers: Math.round(servers) })} /></Field>
          <DistEditor label="Service time" value={e.service} onChange={(service) => up({ service })} />
          <Field label="Queue dir °"><Num value={+((e.queueDir * 180) / Math.PI).toFixed(1)} step={15} onChange={(d) => up({ queueDir: (d * Math.PI) / 180 })} /></Field>
          <div className="hint">Servers stand side by side at the service point; one shared queue grows in the queue direction and snakes back every 10 places.</div>
        </>}
      </div>
    </div>
  );
}

export { Num, Section };
