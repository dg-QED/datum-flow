// Run controls: play / pause / step / reset / run to end, speed, timeline scrubber, view and colour modes.
import { useEffect, useState } from "react";
import { setState, useStore, type ColorBy, type Overlay } from "../store";
import { Icon } from "../ui";
import { pause, play, reset, runToEnd, setSpeed, stepOnce } from "../simctl";
import { live, onLive } from "../live";
import { fmtTime } from "./charts";
import { canRecord, startRecording, stopRecording } from "../io/video";

const SPEEDS = [0.5, 1, 2, 4, 8, 16, 1000];

export default function Transport({ mobile }: { mobile: boolean }) {
  const sim = useStore((s) => s.sim);
  const scrub = useStore((s) => s.scrub);
  const view = useStore((s) => s.view);
  const colorBy = useStore((s) => s.colorBy);
  const overlay = useStore((s) => s.overlay);
  const trails = useStore((s) => s.trails);
  const recording = useStore((s) => s.recording);
  const [tmax, setTmax] = useState(0);
  useEffect(() => onLive(() => { const k = live.keys; setTmax(k.length ? k[k.length - 1].t : 0); }), []);
  const playing = sim.status === "playing";
  const busy = sim.status === "loading" || sim.progress !== null;
  const t = scrub ?? sim.t;
  return (
    <div className="transport" data-testid="transport">
      <div className="row tr-main">
        <button className="btn sm icon" title="Reset (rebuild the scenario)" aria-label="Reset" onClick={() => reset()} data-testid="reset"><Icon name="rewind" size={14} /></button>
        {playing && sim.progress === null
          ? <button className="btn sm icon primary" title="Pause (Space)" aria-label="Pause" onClick={pause} data-testid="pause"><Icon name="pause" size={14} /></button>
          : <button className="btn sm icon primary" title="Play (Space)" aria-label="Play" onClick={() => play()} disabled={sim.status === "finished" || busy} data-testid="play"><Icon name="play" size={14} /></button>}
        <button className="btn sm icon" title="Step 0.5 s (.)" aria-label="Step" onClick={() => stepOnce(10)} disabled={busy || sim.status === "finished"} data-testid="step"><Icon name="stepf" size={14} /></button>
        <select className="select sm" value={sim.speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed" data-testid="speed" title="Simulated seconds per second">
          {SPEEDS.map((s) => <option key={s} value={s}>{s >= 1000 ? "max" : `${s}×`}</option>)}
        </select>
        {!mobile && <button className="btn sm" onClick={() => runToEnd()} disabled={busy || sim.status === "finished"} data-testid="run-to-end" title="Run to completion as fast as possible"><Icon name="flow" size={14} />Run to end</button>}
        <span className="tr-time mono" data-testid="sim-time">{busy && sim.progress !== null ? <><span className="spin" /> {fmtTime(sim.progress)}</> : sim.status === "loading" ? <><span className="spin" /> building</> : fmtTime(t)}</span>
        <input className="grow tr-scrub" type="range" min={0} max={Math.max(1, tmax)} step={0.5} value={Math.min(t, Math.max(1, tmax))} aria-label="Timeline"
          disabled={!tmax} data-testid="timeline"
          onChange={(e) => { if (playing) pause(); setState({ scrub: Number(e.target.value) }); }} />
        {scrub !== null && <button className="btn sm" onClick={() => setState({ scrub: null })} title="Back to the live state">Live</button>}
        {!mobile && <span className="tr-count mono">{sim.n ? `${sim.done.toLocaleString("en-CA")}/${sim.n.toLocaleString("en-CA")}` : ""}</span>}
      </div>
      <div className="row tr-opts">
        <div className="seg" role="group" aria-label="View">
          <button className={view === "2d" ? "on" : ""} onClick={() => setState({ view: "2d" })} data-testid="view-2d">2D</button>
          <button className={view === "3d" ? "on" : ""} onClick={() => setState({ view: "3d" })} data-testid="view-3d">3D</button>
        </div>
        <select className="select sm" value={overlay} onChange={(e) => setState({ overlay: e.target.value as Overlay })} aria-label="Overlay" data-testid="overlay">
          <option value="none">No overlay</option><option value="density">Density (live)</option><option value="los">LOS (live)</option><option value="maxdensity">Max density · LOS</option><option value="congestion">Time in congestion</option><option value="usage">Usage heatmap</option>
        </select>
        <select className="select sm" value={colorBy} onChange={(e) => setState({ colorBy: e.target.value as ColorBy })} aria-label="Colour agents by" data-testid="color-by">
          <option value="speed">Colour: speed</option><option value="profile">Colour: profile</option><option value="density">Colour: local LOS</option><option value="state">Colour: state</option>
        </select>
        <label className="row tr-chk"><input type="checkbox" checked={trails} onChange={(e) => setState({ trails: e.target.checked })} />Trails</label>
        {canRecord() && (recording
          ? <button className="btn sm danger" onClick={stopRecording} data-testid="rec-stop"><span className="rec-dot" />Stop</button>
          : <button className="btn sm" onClick={() => { if (startRecording() && !playing) play(); }} title="Record the view to WebM" data-testid="rec"><Icon name="video" size={14} />{mobile ? "" : "Record"}</button>)}
      </div>
    </div>
  );
}
