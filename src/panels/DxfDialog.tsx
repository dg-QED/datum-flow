// DXF import: layer → role mapping, units / scale, target level, live preview.
import { useEffect, useMemo, useRef, useState } from "react";
import { Field, Modal, useToast } from "../ui";
import { dxfToElements, guessRole, guessScale, ROLES, UNIT_NAME, type DxfDoc, type Role } from "../io/dxf";
import { editProject, getState, setState } from "../store";
import { newLevel } from "../model/defaults";

const ROLE_COLOR: Record<Role, string> = { ignore: "#3a434c", walls: "#c9d0d7", obstacles: "#8a95a1", doors: "#f2a93b", exits: "#5cc28a", stairs: "#7cc4ff", seating: "#9aa4ad", spawn: "#5aa9e6", barriers: "#ff8a5b" };
const ROLE_LABEL: Record<Role, string> = { ignore: "Ignore", walls: "Walls", obstacles: "Obstacles", doors: "Doors / openings", exits: "Exits", stairs: "Stairs (outlines)", seating: "Seating (rectangles)", spawn: "Spawn zones", barriers: "One-way barriers" };

export default function DxfDialog({ doc, name, onClose }: { doc: DxfDoc; name: string; onClose: () => void }) {
  const toast = useToast();
  const layers = Object.entries(doc.layers).sort((a, b) => b[1].count - a[1].count);
  const [map, setMap] = useState<Record<string, Role>>(() => Object.fromEntries(layers.map(([l]) => [l, guessRole(l)])));
  const [scale, setScale] = useState(() => guessScale(doc));
  const [target, setTarget] = useState<string>(getState().level);
  const [recentre, setRecentre] = useState(true);
  const cv = useRef<HTMLCanvasElement>(null);
  const levels = getState().project.levels;
  const span = { w: (doc.bbox.x1 - doc.bbox.x0) * scale, h: (doc.bbox.y1 - doc.bbox.y0) * scale };

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const W = c.clientWidth || 460, H = 220;
    c.width = W * 2; c.height = H * 2;
    const g = c.getContext("2d")!;
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.fillStyle = "#0b0d10"; g.fillRect(0, 0, W, H);
    const bw = doc.bbox.x1 - doc.bbox.x0 || 1, bh = doc.bbox.y1 - doc.bbox.y0 || 1;
    const k = Math.min((W - 16) / bw, (H - 16) / bh);
    const ox = (W - bw * k) / 2, oy = (H - bh * k) / 2;
    for (const e of doc.entities) {
      const r = map[e.layer] ?? "ignore";
      g.strokeStyle = ROLE_COLOR[r];
      g.globalAlpha = r === "ignore" ? 0.35 : 1;
      g.lineWidth = r === "walls" ? 1.6 : r === "exits" ? 2.4 : 1;
      g.beginPath();
      e.pts.forEach((p, i) => { const x = ox + (p[0] - doc.bbox.x0) * k, y = H - oy - (p[1] - doc.bbox.y0) * k; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      if (e.closed) g.closePath();
      g.stroke();
    }
    g.globalAlpha = 1;
  }, [doc, map]);

  const counts = useMemo(() => {
    const res = dxfToElements(doc, map, { scale, level: "x" });
    const by: Record<string, number> = {};
    for (const e of res.elements) by[e.kind] = (by[e.kind] ?? 0) + 1;
    return by;
  }, [doc, map, scale]);

  const go = () => {
    let level = target;
    if (target === "__new") {
      const top = Math.max(...levels.map((l) => l.elevation));
      const L = newLevel(name.replace(/\.dxf$/i, ""), top + 4);
      editProject((p) => { p.levels = [...p.levels, L]; });
      level = L.id;
    }
    const origin: [number, number] | undefined = recentre ? [doc.bbox.x0, doc.bbox.y0] : undefined;
    const { elements, warnings } = dxfToElements(doc, map, { scale, level, origin });
    if (!elements.length) { toast("Nothing mapped — assign at least one layer a role", "err"); return; }
    editProject((p) => { p.elements = [...p.elements, ...elements]; });
    setState({ level, selection: [] });
    window.dispatchEvent(new Event("flow:fit"));
    toast(`Imported ${elements.length} elements from ${name}`, "ok");
    warnings.forEach((w) => toast(w, "info"));
    onClose();
  };

  return (
    <Modal title={`Import DXF · ${name}`} onClose={onClose} width={720} footer={<>
      <span className="hint grow">After import, use <b>Calibrate (K)</b> on two points of known distance if the scale is off.</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={go} data-testid="dxf-import">Import</button></>}>
      <div className="dxf-grid">
        <div className="col">
          <canvas ref={cv} className="dxf-preview" style={{ height: 220 }} data-testid="dxf-preview" />
          <div className="hint mono">{doc.entities.length} entities · {layers.length} layers · units: {UNIT_NAME[doc.units] ?? `code ${doc.units}`} · {span.w.toFixed(1)} × {span.h.toFixed(1)} m{Object.keys(doc.skipped).length ? ` · skipped ${Object.entries(doc.skipped).map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}</div>
          <Field label="Metres / unit"><input className="input sm mono" type="number" step="any" value={scale} onChange={(e) => setScale(Number(e.target.value) || 1)} data-testid="dxf-scale" />
            <select className="select sm" value="" onChange={(e) => e.target.value && setScale(Number(e.target.value))} aria-label="Unit preset"><option value="">preset…</option><option value="0.001">mm</option><option value="0.01">cm</option><option value="1">m</option><option value="0.0254">in</option><option value="0.3048">ft</option></select></Field>
          <Field label="Into level"><select className="select sm" value={target} onChange={(e) => setTarget(e.target.value)}>{levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}<option value="__new">New level…</option></select></Field>
          <label className="row"><input type="checkbox" checked={recentre} onChange={(e) => setRecentre(e.target.checked)} />Move drawing origin to its lower-left corner</label>
          <div className="hint mono">{Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ") || "nothing mapped yet"}</div>
        </div>
        <div className="dxf-layers" data-testid="dxf-layers">
          <div className="eyebrow">Layer → role</div>
          {layers.map(([l, info]) => (
            <div key={l} className="dxf-row">
              <span className="sw" style={{ background: ROLE_COLOR[map[l]] }} />
              <span className="nm" title={l}>{l}</span>
              <span className="faint mono">{info.count}</span>
              <select className="select sm" value={map[l]} onChange={(e) => setMap({ ...map, [l]: e.target.value as Role })} aria-label={`Role for ${l}`} data-testid={`role-${l}`}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
