// Record the live view to WebM with MediaRecorder; composited from the view's canvases plus a HUD.
import { download } from "./download";
import { viewRef } from "../view/TopView";
import { getState, setState } from "../store";
import { fmtTime } from "../panels/charts";

let rec: MediaRecorder | null = null;
let raf = 0;

export const canRecord = () => typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";

export function startRecording(): boolean {
  if (rec || !canRecord()) return false;
  const s0 = getState();
  const src3d = s0.view === "3d" ? (document.querySelector("[data-testid=view3d] canvas") as HTMLCanvasElement | null) : null;
  const layers = src3d ? [src3d] : [viewRef.base, viewRef.gl, viewRef.top].filter((c): c is HTMLCanvasElement => !!c);
  if (!layers.length) return false;
  const W = layers[0].width - (layers[0].width % 2), H = layers[0].height - (layers[0].height % 2);
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const g = out.getContext("2d")!;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    g.fillStyle = "#0b0d10"; g.fillRect(0, 0, W, H);
    for (const c of layers) g.drawImage(c, 0, 0, W, H);
    const s = getState();
    const k = W / Math.max(1, layers[0].clientWidth || W);
    g.font = `600 ${Math.round(13 * k)}px "JetBrains Mono", monospace`;
    const sc = s.project.scenarios.find((x) => x.id === s.project.activeScenario);
    const text = `${s.project.title} · ${sc?.name ?? ""} · t = ${fmtTime(s.sim.t)} · ${s.sim.done}/${s.sim.n} done`;
    const w = g.measureText(text).width + 20 * k;
    g.fillStyle = "rgba(14,17,20,0.85)"; g.fillRect(10 * k, H - 36 * k, w, 26 * k);
    g.fillStyle = "#e6e9ec"; g.fillText(text, 20 * k, H - 18 * k);
    g.fillStyle = "#f2a93b"; g.fillText("Datum Flow", W - 120 * k, 24 * k);
  };
  draw();
  const stream = out.captureStream(30);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const chunks: Blob[] = [];
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    cancelAnimationFrame(raf);
    const blob = new Blob(chunks, { type: "video/webm" });
    const name = `${getState().project.title.replace(/[^\w.-]+/g, "_")}_run.webm`;
    download(name, blob, "video/webm");
    setState({ recording: false, notice: `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB)` });
    rec = null;
  };
  rec.start(500);
  setState({ recording: true });
  return true;
}
export function stopRecording() { rec?.stop(); }
