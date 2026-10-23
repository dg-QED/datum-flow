// Map legend card: overlay scale (LOS / density / congestion) and the agent colouring.
import { useStore } from "../store";
import { LOS_COLORS, LOS_LETTERS, LOS_TABLE, PROFILE_ORDER } from "../model/defaults";
import { DENSITY_STOPS, SPEED_STOPS, STATE_COLORS, STATE_LABELS } from "../view/palette";

export function Legend() {
  const overlay = useStore((s) => s.overlay);
  const colorBy = useStore((s) => s.colorBy);
  const std = useStore((s) => s.project.settings.losStandard);
  const profiles = useStore((s) => s.project.profiles);
  const thr = useStore((s) => s.project.settings.congestionDensity);
  const t = LOS_TABLE[std].m2pp;
  const losRows = LOS_LETTERS.map((L, i) => {
    const hi = i === 0 ? Infinity : t[i - 1], lo = i < 5 ? t[i] : 0;
    const dens = i === 0 ? `< ${(1 / t[0]).toFixed(2)}` : i === 5 ? `> ${(1 / t[4]).toFixed(2)}` : `${(1 / hi).toFixed(2)}–${(1 / lo).toFixed(2)}`;
    return { L, color: LOS_COLORS[i], dens };
  });
  const showLos = overlay === "los" || overlay === "maxdensity" || colorBy === "density";
  return (
    <div className="ov legend-card" onPointerDown={(e) => e.stopPropagation()} data-testid="legend">
      {showLos && (
        <div>
          <div className="eyebrow">{overlay === "maxdensity" ? "Max density · " : ""}LOS · {LOS_TABLE[std].name}</div>
          <div className="los-grid">
            {losRows.map((r) => <div key={r.L} className="los-row"><span className="sw" style={{ background: r.color }} /><b>{r.L}</b><span className="mono">{r.dens} p/m²</span></div>)}
          </div>
        </div>
      )}
      {overlay === "density" && (
        <div>
          <div className="eyebrow">Density p/m²</div>
          <div className="ramp-bar" style={{ background: `linear-gradient(90deg, ${DENSITY_STOPS.join(",")})` }} />
          <div className="ramp-ticks mono"><span>0</span><span>2</span><span>4</span><span>6+</span></div>
        </div>
      )}
      {overlay === "congestion" && <div><div className="eyebrow">Time ≥ {thr} p/m²</div><div className="ramp-bar" style={{ background: "linear-gradient(90deg,#1b3a5c,#6a3d9a,#d2304a,#ffd166)" }} /><div className="ramp-ticks mono"><span>0 s</span><span>max</span></div></div>}
      {overlay === "usage" && <div><div className="eyebrow">Usage (person-seconds)</div><div className="ramp-bar" style={{ background: "linear-gradient(90deg,#0f2a3f,#2a6f97,#61a5c2,#e9c46a,#f4a261,#e76f51)" }} /><div className="ramp-ticks mono"><span>low</span><span>high</span></div></div>}
      {colorBy === "speed" && !showLos && (
        <div>
          <div className="eyebrow">Agents · speed m/s</div>
          <div className="ramp-bar" style={{ background: `linear-gradient(90deg, ${SPEED_STOPS.join(",")})` }} />
          <div className="ramp-ticks mono"><span>0</span><span>0.75</span><span>1.5</span></div>
          <div className="lg-r"><span className="sw pt" style={{ background: STATE_COLORS[1] }} />waiting <span className="sw pt" style={{ background: STATE_COLORS[3], marginLeft: 8 }} />queuing</div>
        </div>
      )}
      {colorBy === "profile" && (
        <div>
          <div className="eyebrow">Agents · profile</div>
          {PROFILE_ORDER.map((id) => { const p = profiles.find((q) => q.id === id); return p ? <div key={id} className="lg-r"><span className="sw pt" style={{ background: p.color }} />{p.name}</div> : null; })}
        </div>
      )}
      {colorBy === "state" && (
        <div>
          <div className="eyebrow">Agents · state</div>
          {[1, 2, 3, 4, 6].map((i) => <div key={i} className="lg-r"><span className="sw pt" style={{ background: STATE_COLORS[i] }} />{STATE_LABELS[i]}</div>)}
        </div>
      )}
    </div>
  );
}
