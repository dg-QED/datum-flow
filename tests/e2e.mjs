// Headless end-to-end check for Datum Flow.
//
//   npm run build && npm run test:e2e
//
// Serves dist/index.html, drives Chromium (SwiftShader WebGL), exercises the app and writes
// docs/screenshots/*.png and test-results/e2e.json. Set PLAYWRIGHT_BROWSERS_PATH if Chromium is not in
// the default location (e.g. /opt/pw-browsers).
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "docs", "screenshots");
const OUT = path.join(ROOT, "test-results");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"));
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); }).listen(0);
const URL = `http://127.0.0.1:${server.address().port}/`;

const results = {};
const fails = [];
const check = (name, ok, detail) => { results[name] = { ok: !!ok, detail }; if (!ok) fails.push(`${name}: ${detail}`); console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); };

// a small two-room plan in millimetres with layers for walls, doors, exits and a spawn zone
function makeDXF() {
  const L = [];
  const g = (c, v) => L.push(String(c), String(v));
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$INSUNITS"); g(70, 4); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  const line = (layer, x1, y1, x2, y2) => { g(0, "LINE"); g(8, layer); g(10, x1); g(20, y1); g(30, 0); g(11, x2); g(21, y2); g(31, 0); };
  const poly = (layer, pts, closed) => { g(0, "LWPOLYLINE"); g(8, layer); g(90, pts.length); g(70, closed ? 1 : 0); for (const [x, y] of pts) { g(10, x); g(20, y); } };
  // outer walls 24 × 14 m with a gap for the exit (east wall, y 6–8 m) and a partition at x = 12 m with a door gap
  poly("A-WALL", [[0, 0], [24000, 0], [24000, 6000]], false);
  poly("A-WALL", [[24000, 8000], [24000, 14000], [0, 14000], [0, 0]], false);
  line("A-WALL", 12000, 0, 12000, 6000);
  line("A-WALL", 12000, 7200, 12000, 14000);
  line("A-DOOR", 12000, 6000, 12000, 7200);
  g(0, "ARC"); g(8, "A-DOOR"); g(10, 12000); g(20, 6000); g(40, 1200); g(50, 0); g(51, 90);
  line("EXIT", 24000, 6000, 24000, 8000);
  poly("FURNITURE", [[3000, 3000], [6000, 3000], [6000, 4000], [3000, 4000]], true);
  g(0, "CIRCLE"); g(8, "FURNITURE"); g(10, 8000); g(20, 10000); g(40, 600);
  poly("OCCUPANCY", [[1000, 1000], [11000, 1000], [11000, 13000], [1000, 13000]], true);
  g(0, "TEXT"); g(8, "A-ANNO"); g(10, 1000); g(20, 500); g(40, 300); g(1, "Room 101");
  g(0, "ENDSEC"); g(0, "EOF");
  return L.join("\n") + "\n";
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const watch = (page, tag) => {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${tag}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${tag}] ${e.message}`));
};
const state = (page) => page.evaluate(() => { const s = window.__flow.getState(); return { status: s.sim.status, t: s.sim.t, n: s.sim.n, done: s.sim.done, title: s.project.title }; });
const waitFor = async (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, "desktop");
  await page.goto(URL);

  // ---------------------------------------------------------------- 1. opens on the arena, alive
  await waitFor(page, () => { const s = window.__flow?.getState(); return s && s.sim.status === "playing" && s.sim.t > 50; });
  const s0 = await state(page);
  check("opens on arena sample", /Arena/.test(s0.title) && s0.n > 1000, `${s0.title}, ${s0.n} people, t=${s0.t.toFixed(1)} s`);
  const pos = () => page.evaluate(() => { const f = window.__flow.live.frame; return { t: f.t, x: Array.from(f.x.slice(0, 400)), y: Array.from(f.y.slice(0, 400)) }; });
  const a = await pos();
  await page.waitForTimeout(1500);
  const b = await pos();
  let moved = 0;
  for (let i = 0; i < a.x.length; i++) if (Math.hypot(a.x[i] - b.x[i], a.y[i] - b.y[i]) > 0.05) moved++;
  check("agents move", b.t > a.t && moved > 20, `${moved}/400 sampled agents moved between t=${a.t.toFixed(1)} and ${b.t.toFixed(1)} s`);
  await page.screenshot({ path: path.join(SHOTS, "arena-live.png") });

  // live LOS map
  await page.selectOption("[data-testid=overlay]", "los");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS, "arena-density-los.png") });

  // run the egress to completion → charts
  await page.evaluate(() => window.__flow.simctl.runToEnd());
  await waitFor(page, () => window.__flow.getState().sim.status === "finished", null, 300000);
  const arena = await page.evaluate(() => window.__flow.getState().results.summary);
  check("arena egress completes", arena.tet !== null && arena.completed === arena.agents, `TET ${arena.tet} s for ${arena.agents} people; usage ${JSON.stringify(Object.values(arena.exitUsage))}`);
  await page.selectOption("[data-testid=overlay]", "maxdensity");
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, "arena-max-density.png") });
  // charts: scroll the results panel to the charts
  await page.locator("[data-testid=chart-flow]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "charts.png") });

  // ---------------------------------------------------------------- 2. office evacuation + hand calc
  await page.click("[data-testid=project-menu]");
  await page.click("[data-testid=sample-office]");
  await page.selectOption("[data-testid=overlay]", "none");
  await page.evaluate(() => window.__flow.simctl.runToEnd());
  await waitFor(page, () => window.__flow.getState().sim.status === "finished", null, 300000);
  const office = await page.evaluate(() => { const s = window.__flow.getState(); return { sum: s.results.summary, hc: s.handCalc && { t: s.handCalc.tHydraulic, ctrl: s.handCalc.controlling, req: s.handCalc.obcRequiredMm, prov: s.handCalc.obcProvidedCountedMm } }; });
  check("office evacuation TET + hand calc", office.sum.tet > 0 && office.hc && office.hc.t > 0, { TET_s: office.sum.tet, P90_s: office.sum.p90, people: office.sum.agents, hydraulic_s: Math.round(office.hc.t), controlling: office.hc.ctrl, obc_required_mm: Math.round(office.hc.req), obc_provided_mm: Math.round(office.hc.prov) });
  await page.selectOption("[data-testid=overlay]", "maxdensity");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, "office-evacuation.png") });

  // Monte-Carlo with 3 seeds
  await page.fill("[data-testid=mc-n]", "3");
  await page.click("[data-testid=mc-run]");
  await waitFor(page, () => { const m = window.__flow.getState().mc; return m && !m.running && m.runs.length === 3; }, null, 300000);
  const mc = await page.evaluate(() => { const s = window.__flow.getState(); const r = s.project.results.find((x) => x.scenarioId === s.project.activeScenario); return { runs: s.mc.runs, mc: r?.monteCarlo }; });
  check("Monte-Carlo 3 seeds", mc.runs.length === 3 && mc.mc && mc.mc.p50 > 0, { tets: mc.runs.map((r) => r.tet), p50: mc.mc?.p50, p90: mc.mc?.p90 });
  await page.locator("[data-testid=mc-kpis]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, "office-montecarlo.png") });

  // ---------------------------------------------------------------- 3. exports
  const grab = async (trigger) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), trigger()]); const p = path.join(OUT, d.suggestedFilename()); await d.saveAs(p); return p; };
  const pdfPath = await grab(async () => { await page.click("[data-testid=report]"); });
  const pdf = fs.readFileSync(pdfPath);
  check("PDF report", pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 50000, `${path.basename(pdfPath)} ${(pdf.length / 1024).toFixed(0)} kB, header ${JSON.stringify(pdf.subarray(0, 8).toString())}`);
  const csvPath = await grab(async () => { await page.click("[data-testid=project-menu]"); await page.click("[data-testid=export-csv]"); });
  const csv = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  check("CSV time series", csv[0].startsWith("t_s,completed") && csv.length > 50, `${path.basename(csvPath)}: ${csv.length - 1} rows, ${csv[0].split(",").length} columns`);
  const jsonPath = await grab(async () => { await page.click("[data-testid=project-menu]"); await page.click("[data-testid=save-project]"); });
  const saved = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  // round trip: load another sample, then open the saved file
  await page.click("[data-testid=project-menu]");
  await page.click("[data-testid=sample-theatre]");
  await page.setInputFiles("[data-testid=project-input]", jsonPath);
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => { const p = window.__flow.getState().project; return { title: p.title, n: p.elements.length, levels: p.levels.length, scen: p.scenarios.length, results: (p.results ?? []).length, json: window.__flow.serializeProject(p) }; });
  const same = JSON.stringify(JSON.parse(back.json).elements) === JSON.stringify(saved.elements);
  check(".dflow.json round-trip", saved.format === "datum-flow" && back.title === saved.title && back.n === saved.elements.length && same && back.results >= 1, `${back.n} elements, ${back.levels} levels, ${back.scen} scenarios, ${back.results} result summaries; elements identical: ${same}`);

  // ---------------------------------------------------------------- 4. DXF import
  const dxfPath = path.join(OUT, "two-rooms.dxf");
  fs.writeFileSync(dxfPath, makeDXF());
  await page.click("[data-testid=project-menu]");
  await page.click("text=New empty model");
  await page.setInputFiles("[data-testid=file-input]", dxfPath);
  await page.waitForSelector("[data-testid=dxf-layers]");
  await page.selectOption("[data-testid=role-FURNITURE]", "obstacles");
  await page.selectOption("[data-testid=role-OCCUPANCY]", "spawn");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "dxf-import-mapping.png") });
  await page.click("[data-testid=dxf-import]");
  await page.waitForTimeout(400);
  const imp = await page.evaluate(() => { const p = window.__flow.getState().project; const c = {}; for (const e of p.elements) c[e.kind] = (c[e.kind] ?? 0) + 1; const ex = p.elements.find((e) => e.kind === "exit"); return { c, exit: ex && [ex.a, ex.b] }; });
  check("DXF import (generated)", imp.c.wall >= 4 && imp.c.door >= 1 && imp.c.exit === 1 && imp.c.obstacle === 2 && imp.c.spawn === 1 && Math.abs(Math.hypot(imp.exit[1][0] - imp.exit[0][0], imp.exit[1][1] - imp.exit[0][1]) - 2) < 1e-6, imp.c);
  // and evacuate it
  await page.evaluate(async () => { const st = window.__flow.getState(); const sp = st.project.elements.find((e) => e.kind === "spawn"); window.__flow.setState({ project: { ...st.project, elements: st.project.elements.map((e) => (e.id === sp.id ? { ...e, mode: "count", count: 120 } : e)) } }); await window.__flow.simctl.runToEnd(); });
  await waitFor(page, () => window.__flow.getState().sim.status === "finished", null, 120000);
  const dxfRun = await page.evaluate(() => window.__flow.getState().results.summary);
  check("DXF model evacuates", dxfRun.tet !== null && dxfRun.completed === dxfRun.agents, `${dxfRun.agents} people out in ${dxfRun.tet} s`);
  await page.screenshot({ path: path.join(SHOTS, "dxf-imported-run.png") });
  // a DXF written by another Datum app (Datum BIM sample plan with block INSERT doors), if present
  const sibling = ["/home/claude/datum/samples/qed-sample-plan.dxf"].find((f) => fs.existsSync(f));
  if (sibling) {
    const text = fs.readFileSync(sibling, "utf8");
    const r = await page.evaluate((t) => { const d = window.__flow.parseDXF(t); return { n: d.entities.length, layers: Object.keys(d.layers), units: d.units, skipped: d.skipped }; }, text);
    check("DXF from Datum (sample plan)", r.n > 10 && r.layers.includes("A-WALL"), r);
  }

  // ---------------------------------------------------------------- 5. 3D view
  await page.click("[data-testid=project-menu]");
  await page.click("[data-testid=sample-arena]");
  await page.selectOption("[data-testid=overlay]", "none");
  await page.evaluate(() => window.__flow.simctl.warmStart(70, 1));
  await waitFor(page, () => window.__flow.getState().sim.t > 72);
  await page.click("[data-testid=view-3d]");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, "arena-3d.png") });
  const px3d = await page.evaluate(() => { const c = document.querySelector("[data-testid=view3d] canvas"); const t = document.createElement("canvas"); t.width = 120; t.height = 80; const g = t.getContext("2d"); g.drawImage(c, 0, 0, 120, 80); const d = g.getImageData(0, 0, 120, 80).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4)); return seen.size; });
  check("3D view renders", px3d > 20, `${px3d} distinct colours`);
  await page.click("[data-testid=view-2d]");

  // ---------------------------------------------------------------- 5b. video
  const vidPath = await grab(async () => { await page.click("[data-testid=rec]"); await page.waitForTimeout(2500); await page.click("[data-testid=rec-stop]"); });
  const vid = fs.readFileSync(vidPath);
  check("WebM video recording", vid.length > 10000 && vid.subarray(0, 4).toString("hex") === "1a45dfa3", `${path.basename(vidPath)} ${(vid.length / 1024).toFixed(0)} kB (EBML header ${vid.subarray(0, 4).toString("hex")})`);

  // ---------------------------------------------------------------- 6. performance in the worker
  await page.evaluate(() => window.__flow.simctl.pause());
  const b5 = await page.evaluate(() => window.__flow.simctl.benchmark(5000, 100));
  const b20 = await page.evaluate(() => window.__flow.simctl.benchmark(20000, 40));
  check("worker performance", b5.stepsPerSec > 0, { "5k_steps_per_s": +b5.stepsPerSec.toFixed(1), "5k_x_realtime": +(b5.stepsPerSec * 0.05).toFixed(2), "20k_steps_per_s": +b20.stepsPerSec.toFixed(1), "20k_x_realtime": +(b20.stepsPerSec * 0.05).toFixed(2), build_ms_5k: Math.round(b5.buildMs) });
  results.performance = { b5, b20, cpus: await page.evaluate(() => navigator.hardwareConcurrency) };
  await ctx.close();

  // ---------------------------------------------------------------- 7. mobile
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  watch(m, "mobile");
  await m.goto(URL);
  await waitFor(m, () => { const s = window.__flow?.getState(); return s && s.sim.status === "playing" && s.sim.t > 50; });
  await m.waitForTimeout(800);
  await m.screenshot({ path: path.join(SHOTS, "mobile.png") });
  await m.click("[data-testid=sheet-results]");
  await m.waitForTimeout(800);
  await m.screenshot({ path: path.join(SHOTS, "mobile-results.png") });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("mobile layout (no horizontal scroll)", !overflow, overflow ? "page wider than viewport" : "ok");
  await mctx.close();
} catch (e) {
  fails.push(`exception: ${e.message}`);
  console.error(e);
} finally {
  check("no console errors", errors.length === 0, errors.length ? errors.slice(0, 8) : "none");
  fs.writeFileSync(path.join(OUT, "e2e.json"), JSON.stringify(results, null, 2));
  await browser.close();
  server.close();
  console.log(fails.length ? `\n${fails.length} e2e check(s) failed` : "\nall e2e checks passed");
  process.exit(fails.length ? 1 : 0);
}
