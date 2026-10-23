// Plan: levels (add / rename / elevation / delete) and the element list of the active level.
import { editProject, getState, setState, useStore } from "../store";
import { Icon, Section } from "../ui";
import { newLevel } from "../model/defaults";
import type { ElementKind } from "../model/types";
import { KIND_COLOR, KIND_LABEL } from "../view/palette";
import { seatingLayout, polyArea } from "../model/geom";

const ORDER: ElementKind[] = ["exit", "door", "stair", "seating", "spawn", "attractor", "barrier", "wall", "obstacle"];

export default function PlanPanel({ onImport }: { onImport: () => void }) {
  const levels = useStore((s) => s.project.levels);
  const elements = useStore((s) => s.project.elements);
  const level = useStore((s) => s.level);
  const selection = useStore((s) => s.selection);
  const sorted = [...levels].sort((a, b) => b.elevation - a.elevation);
  const mine = elements.filter((e) => e.level === level);
  const seats = mine.filter((e) => e.kind === "seating").reduce((a, e) => a + (e.kind === "seating" ? seatingLayout(e).capacity : 0), 0);
  const spawnPeople = mine.reduce((a, e) => a + (e.kind === "spawn" ? (e.mode === "count" ? e.count : Math.round(e.density * polyArea(e.pts))) : 0), 0);
  return (
    <div className="panel-body" data-testid="plan-panel">
      <Section title="Levels" n={levels.length} right={<button className="btn sm ghost icon" title="Add level" aria-label="Add level" onClick={() => {
        const top = Math.max(...levels.map((l) => l.elevation));
        const L = newLevel(`Level ${levels.length + 1}`, top + 4);
        editProject((p) => { p.levels = [...p.levels, L]; });
        setState({ level: L.id });
      }}><Icon name="plus" size={14} /></button>}>
        {sorted.map((l) => (
          <div key={l.id} className={`level-row ${l.id === level ? "active" : ""}`} onClick={() => setState({ level: l.id, selection: [] })} data-testid={`level-${l.name}`}>
            <Icon name="stack" size={14} />
            <input className="input sm" value={l.name} onClick={(e) => e.stopPropagation()} onChange={(e) => editProject((p) => { p.levels = p.levels.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)); }, { geometry: false })} aria-label="Level name" />
            <input className="input sm mono" style={{ width: 64 }} type="number" step={0.1} value={l.elevation} onClick={(e) => e.stopPropagation()} onChange={(e) => editProject((p) => { p.levels = p.levels.map((x) => (x.id === l.id ? { ...x, elevation: Number(e.target.value) } : x)); })} aria-label="Elevation" title="Elevation (m)" />
            <button className="btn sm ghost icon" disabled={levels.length < 2} title="Delete level and its elements (undo with Ctrl+Z)" aria-label="Delete level" onClick={(e) => {
              e.stopPropagation();
              editProject((p) => { p.levels = p.levels.filter((x) => x.id !== l.id); p.elements = p.elements.filter((x) => x.level !== l.id && !(x.kind === "stair" && x.toLevel === l.id)); });
              setState({ level: getState().project.levels[0].id });
            }}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        <label className="row hint"><input type="checkbox" checked={useStore((s) => s.ghostLevels)} onChange={(e) => setState({ ghostLevels: e.target.checked })} />Show other levels faintly</label>
      </Section>
      <Section title="On this level" n={mine.length}>
        <div className="hint">{seats ? `${seats.toLocaleString("en-CA")} seats · ` : ""}{spawnPeople ? `≈ ${spawnPeople.toLocaleString("en-CA")} people in spawn zones` : "No spawn zones"}</div>
        {ORDER.map((k) => {
          const list = mine.filter((e) => e.kind === k);
          if (!list.length) return null;
          return (
            <div key={k} className="el-group">
              <div className="el-kind"><span className="sw" style={{ background: KIND_COLOR[k] }} />{KIND_LABEL[k]}<span className="faint mono">{list.length}</span></div>
              {list.slice(0, k === "wall" || k === "obstacle" ? 8 : 60).map((e) => (
                <div key={e.id} className={`el-row ${selection.includes(e.id) ? "active" : ""}`} onClick={() => setState({ selection: [e.id], rightTab: "props" })}>
                  <span className="nm">{e.name || KIND_LABEL[k]}</span>
                  {"closed" in e && e.closed && e.kind !== "wall" && <span className="badge" style={{ color: "var(--err)" }}>closed</span>}
                </div>
              ))}
              {list.length > 8 && (k === "wall" || k === "obstacle") && <div className="hint" style={{ paddingLeft: 22 }}>+{list.length - 8} more</div>}
            </div>
          );
        })}
        {!mine.length && <div className="panel-empty">Draw with the tools on the left of the plan, or import a DXF.</div>}
        <button className="btn sm" onClick={onImport} data-testid="plan-import"><Icon name="upload" size={14} />Import DXF…</button>
      </Section>
    </div>
  );
}
