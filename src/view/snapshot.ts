// Offscreen PNG renders of the model (used by the AI `screenshot` tool): 2D plan + overlay + agents + trails
// drawn at any size independent of the on-screen view, or a capture of the live 3D view.
import { getState, setState, type ColorBy, type Overlay } from "../store";
import { live } from "../live";
import { DARK, drawGrid, drawOverlay, drawPlan, drawTrails, fitView, overlayCanvas } from "./render2d";
import { agentBuffers } from "./agentData";
import { drawAgents2D } from "./agentsGL";
import { LOS_COLORS, LOS_LETTERS, LOS_TABLE } from "../model/defaults";
import { fmtTime } from "../panels/charts";

const OVERLAY_NAME: Record<Overlay, string> = { none: "", density: "live density", los: "live LOS", maxdensity: "max density · LOS", congestion: "time in congestion", usage: "usage heatmap" };

export function render2D(o: { width: number; height: number; level: string; overlay: Overlay; trails: boolean; colorBy: ColorBy }): HTMLCanvasElement {
  const s = getState();
  const c = document.createElement("canvas");
  c.width = o.width; c.height = o.height;
  const g = c.getContext("2d")!;
  const v = fitView(s.project, o.level, o.width, o.height - 34, 26);
  v.h = o.height;
  v.cy -= 17 / v.scale;   // leave the caption strip at the bottom free
  drawGrid(g, v, DARK, 1);
  const li = s.project.levels.findIndex((l) => l.id === o.level);
  const L = live.info?.levels[li];
  if (o.overlay !== "none" && L && live.info?.levels.length === s.project.levels.length) {
    const cv = overlayCanvas(o.overlay, li, L, { density: live.density[li], max: live.maxDensity[li], cong: live.congestion[li], occ: live.occupancy[li] }, s.project.settings.losStandard, `shot:${live.densVersion}:${live.version}:${o.overlay}`);
    if (cv) drawOverlay(g, v, cv, L, o.overlay === "density" || o.overlay === "usage" || o.overlay === "congestion");
  }
  const sc = s.project.scenarios.find((x) => x.id === s.project.activeScenario);
  drawPlan(g, v, s.project, { level: o.level, ghost: s.ghostLevels, closed: new Set(sc?.closedExits ?? []), running: !!live.frame });
  if (o.trails && live.keys.length > 1 && live.info) drawTrails(g, v, li, s.scrub);
  const ab = agentBuffers(s.project, li, o.colorBy, s.scrub, null);
  if (ab) drawAgents2D(g, v, ab.inst, ab.col, ab.count);
  // caption strip: model · scenario · level · time · overlay legend
  g.fillStyle = "rgba(14,17,20,0.92)"; g.fillRect(0, o.height - 34, o.width, 34);
  g.font = `500 13px "Inter Tight", system-ui, sans-serif`; g.textBaseline = "middle"; g.fillStyle = "#e6e9ec";
  const lvl = s.project.levels[li]?.name ?? "";
  g.fillText(`${s.project.title} · ${sc?.name ?? ""} · ${lvl} · t = ${fmtTime(s.sim.t)} · ${s.sim.done}/${s.sim.n} done${o.overlay !== "none" ? ` · ${OVERLAY_NAME[o.overlay]}` : ""}`, 12, o.height - 17, o.width - 340);
  if (o.overlay === "los" || o.overlay === "maxdensity") {
    let x = o.width - 12 - 6 * 44;
    const t = LOS_TABLE[s.project.settings.losStandard].m2pp;
    LOS_LETTERS.forEach((Lt, i) => {
      g.fillStyle = LOS_COLORS[i]; g.fillRect(x, o.height - 26, 16, 16);
      g.fillStyle = "#e6e9ec"; g.font = `600 11px "JetBrains Mono", monospace`;
      g.fillText(Lt, x + 20, o.height - 17);
      void t;
      x += 44;
    });
  }
  return c;
}

/** Capture the live 3D view at the requested size (switches to 3D briefly if needed). */
export async function render3D(width: number, height: number): Promise<HTMLCanvasElement> {
  const prev = getState().view;
  if (prev !== "3d") setState({ view: "3d" });
  let src: HTMLCanvasElement | null = null;
  for (let k = 0; k < 40 && !src; k++) { await new Promise((r) => setTimeout(r, 50)); src = document.querySelector("[data-testid=view3d] canvas"); }
  await new Promise((r) => setTimeout(r, 700));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!src) throw new Error("3D view is not available");
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0b0d10"; g.fillRect(0, 0, width, height);
  const k = Math.max(width / src.width, height / src.height);
  const w = src.width * k, h = src.height * k;
  g.drawImage(src, (width - w) / 2, (height - h) / 2, w, h);
  if (prev !== "3d") setState({ view: prev });
  return c;
}

export const canvasPNG = (c: HTMLCanvasElement) => c.toDataURL("image/png").split(",")[1];
