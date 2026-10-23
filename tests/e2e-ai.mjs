// End-to-end check of Flow's AI control (Datum Bridge protocol v1, docs/mcp-bridge.md).
//
//   npm run build && npm run test:ai
//
// 1. A tiny in-test WebSocket server speaks the bridge side of the protocol (hello / welcome / call / result /
//    progress / ping), pairs with the app in headless Chromium and drives every Flow tool.
// 2. If the real bridge exists (../datum-form/bridge/dist/cli.js, or DATUM_BRIDGE=path), an MCP SDK client spawns it
//    over stdio and runs: open the office sample, close an exit, run an evacuation, read TET + hand calc,
//    screenshot with the LOS overlay, undo.
// Writes docs/screenshots/ai-*.png and test-results/e2e-ai.json.
import { chromium } from "playwright";
import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "docs", "screenshots");
const OUT = path.join(ROOT, "test-results");
fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"));
const serve = (headers = {}) => new Promise((res) => {
  const s = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }); r.end(html); }).listen(0, "127.0.0.1", () => res(s));
});
const results = {}; const fails = [];
const check = (name, ok, detail) => { results[name] = { ok: !!ok, detail }; if (!ok) fails.push(`${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail !== undefined ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""}`); };

// ------------------------------------------------------------------ mock bridge (app side of the protocol)
const PAIRING = "246810";
function mockBridge() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/app" });
  const st = { hellos: [], sock: null, pending: new Map(), progress: [], seq: 0, errors: [] };
  wss.on("connection", (ws, req) => {
    st.origin = req.headers.origin;
    ws.on("message", (buf) => {
      const m = JSON.parse(String(buf));
      if (m.type === "hello") {
        st.hellos.push(m);
        if (m.pairing !== PAIRING) { ws.send(JSON.stringify({ type: "error", code: "pairing", message: "wrong pairing code" })); ws.close(); return; }
        st.sock = ws;
        ws.send(JSON.stringify({ type: "welcome", protocol: 1, bridgeVersion: "test-0" }));
        ws.send(JSON.stringify({ type: "ping" }));
      } else if (m.type === "pong") st.pong = true;
      else if (m.type === "progress") st.progress.push(m);
      else if (m.type === "result") { const p = st.pending.get(m.id); if (p) { st.pending.delete(m.id); p(m); } }
    });
  });
  const call = (tool, args = {}, timeout = 180000) => new Promise((res, rej) => {
    const id = `c${++st.seq}`;
    const t = setTimeout(() => { st.pending.delete(id); rej(new Error(`${tool} timed out`)); }, timeout);
    st.pending.set(id, (m) => { clearTimeout(t); res(m); });
    st.sock.send(JSON.stringify({ type: "call", id, tool, args }));
  });
  return new Promise((res) => wss.on("listening", () => res({ wss, st, call, port: wss.address().port })));
}

function twoRoomsDXF() {
  const L = []; const g = (c, v) => L.push(String(c), String(v));
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$INSUNITS"); g(70, 4); g(0, "ENDSEC"); g(0, "SECTION"); g(2, "ENTITIES");
  const line = (layer, x1, y1, x2, y2) => { g(0, "LINE"); g(8, layer); g(10, x1); g(20, y1); g(11, x2); g(21, y2); };
  const poly = (layer, pts, closed) => { g(0, "LWPOLYLINE"); g(8, layer); g(90, pts.length); g(70, closed ? 1 : 0); for (const [x, y] of pts) { g(10, x); g(20, y); } };
  poly("A-WALL", [[0, 0], [20000, 0], [20000, 5000]], false); poly("A-WALL", [[20000, 7000], [20000, 12000], [0, 12000], [0, 0]], false);
  line("EXIT", 20000, 5000, 20000, 7000);
  poly("CROWD", [[1000, 1000], [15000, 1000], [15000, 11000], [1000, 11000]], true);
  g(0, "ENDSEC"); g(0, "EOF");
  return L.join("\n") + "\n";
}
const png = (m) => m.content?.find((c) => c.type === "image");
const text = (m) => m.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const watch = (p, tag) => { p.on("console", (m) => { if (m.type() === "error" && !/WebSocket connection|ERR_CONNECTION_REFUSED|Content Security Policy/.test(m.text())) errors.push(`[${tag}] ${m.text()}`); }); p.on("pageerror", (e) => errors.push(`[${tag}] ${e.message}`)); };
const servers = [];
try {
  const site = await serve(); servers.push(site);
  const URL = `http://127.0.0.1:${site.address().port}/`;
  const mb = await mockBridge(); servers.push(mb.wss);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page, "ai");
  await page.goto(URL);
  await page.waitForFunction(() => window.__flow?.getState().sim.status === "playing", null, { timeout: 120000 });
  await page.evaluate(() => window.__flow.simctl.pause());

  // ---------------------------------------------------------------- connect: wrong code, then the right one
  await page.click("[data-testid=connect-ai]");
  await page.fill("[data-testid=ai-pairing]", "111111");
  await page.fill("[data-testid=ai-port]", String(mb.port));
  await page.click("[data-testid=ai-on]");
  await page.waitForFunction(() => window.__flow.bridge.state.status === "error", null, { timeout: 20000 });
  const wrong = await page.evaluate(() => window.__flow.bridge.state.message);
  check("wrong pairing code rejected", /pairing/i.test(wrong), wrong);
  await page.fill("[data-testid=ai-pairing]", PAIRING);
  await page.click("[data-testid=ai-on]");
  await page.waitForFunction(() => window.__flow.bridge.state.status === "connected", null, { timeout: 20000 });
  await page.waitForTimeout(400);
  const hello = mb.st.hellos[mb.st.hellos.length - 1];
  const names = hello.tools.map((t) => t.name);
  const required = ["get_state", "screenshot", "open_sample", "export_file", "undo", "redo"];
  const extra = ["list_elements", "add_element", "update_element", "delete_element", "import_dxf", "set_scenario", "run_simulation", "run_monte_carlo", "get_results", "hand_calc", "close_exit", "open_exit"];
  check("hello frame", hello.protocol === 1 && hello.app === "flow" && hello.appVersion === "1.1.0" && /^[a-z0-9]{4,}$/.test(hello.instance) && hello.pairing === PAIRING && [...required, ...extra].every((n) => names.includes(n)) && hello.tools.every((t) => t.inputSchema?.type === "object"), { app: hello.app, version: hello.appVersion, tools: names.length, origin: mb.st.origin });
  check("ping answered", mb.st.pong === true);
  await page.screenshot({ path: path.join(SHOTS, "ai-connect.png") });
  await page.keyboard.press("Escape");
  const stored = await page.evaluate(() => [localStorage.getItem("datum-bridge.code"), localStorage.getItem("datum-bridge.port")]);
  check("pairing + port remembered", stored[0] === PAIRING && stored[1] === String(mb.port), stored);

  // ---------------------------------------------------------------- required tools
  let r = await mb.call("get_state");
  check("get_state", r.ok && r.structured?.title && r.structured.levels.length >= 1, text(r).slice(0, 120));
  r = await mb.call("open_sample", { name: "office" });
  check("open_sample office", r.ok && /office/i.test(text(r)) && await page.evaluate(() => window.__flow.getState().project.sample === "office"), text(r));
  r = await mb.call("open_sample", { name: "stadium" });
  check("bad input → clear error", !r.ok && /must be one of/.test(r.error), r.error);
  r = await mb.call("list_elements", { kind: "exit" });
  check("list_elements exits", r.ok && r.structured.count === 3, r.structured?.elements?.map((e) => e.name));
  r = await mb.call("close_exit", { exit: "East stair discharge" });
  check("close_exit", r.ok && r.structured.closed.includes("East stair discharge"), text(r));
  mb.st.progress = [];
  r = await mb.call("run_simulation", { seed: 3 });
  const tet = r.structured?.tet_s;
  check("run_simulation (evacuation, one exit closed)", r.ok && tet > 0 && r.structured.exit_usage["East stair discharge"] === 0 && r.structured.rset?.p90_s > 0 && r.structured.los?.levels && mb.st.progress.length >= 2,
    { tet_s: tet, p90: r.structured?.rset?.p90_s, exit_usage: r.structured?.exit_usage, peak: r.structured?.peak_density_ppm2, progress_msgs: mb.st.progress.length, los: r.structured?.los?.levels });
  r = await mb.call("hand_calc");
  check("hand_calc", r.ok && r.structured.sfpe_hydraulic_rset_s > 0 && r.structured.obc_3_4_3_2.required_exit_width_mm > 0, text(r));
  r = await mb.call("get_results");
  check("get_results", r.ok && r.structured.tet_s === tet, { tet: r.structured?.tet_s, completed: r.structured?.completed });
  r = await mb.call("screenshot", { overlay: "maxdensity", width: 1280, height: 800 });
  let img = png(r);
  const buf = img ? Buffer.from(img.data, "base64") : Buffer.alloc(0);
  if (img) fs.writeFileSync(path.join(SHOTS, "ai-screenshot-maxdensity.png"), buf);
  check("screenshot 2D + max density", r.ok && img?.mimeType === "image/png" && buf.subarray(1, 4).toString() === "PNG" && buf.readUInt32BE(16) === 1280 && buf.readUInt32BE(20) === 800, `${buf.length} bytes`);
  r = await mb.call("screenshot", { overlay: "los", trails: true, width: 900, height: 600, level: "Ground" });
  img = png(r); if (img) fs.writeFileSync(path.join(SHOTS, "ai-screenshot-los-trails.png"), Buffer.from(img.data, "base64"));
  check("screenshot LOS + trails, other level", r.ok && !!img, text(r));
  r = await mb.call("screenshot", { view: "3d", width: 800, height: 500 });
  img = png(r); if (img) fs.writeFileSync(path.join(SHOTS, "ai-screenshot-3d.png"), Buffer.from(img.data, "base64"));
  check("screenshot 3D", r.ok && !!img && Buffer.from(img.data, "base64").length > 20000, text(r));
  r = await mb.call("undo");
  const reopened = await page.evaluate(() => { const s = window.__flow.getState(); const sc = s.project.scenarios.find((x) => x.id === s.project.activeScenario); return sc.closedExits.length; });
  check("undo (re-opens the exit)", r.ok && reopened === 0, text(r));
  r = await mb.call("redo");
  check("redo", r.ok && await page.evaluate(() => { const s = window.__flow.getState(); return s.project.scenarios.find((x) => x.id === s.project.activeScenario).closedExits.length === 1; }), text(r));

  // ---------------------------------------------------------------- editing tools + per-call undo in the panel
  const n0 = await page.evaluate(() => window.__flow.getState().project.elements.length);
  r = await mb.call("add_element", { kind: "door", level: "Ground", a: [8, 0], width: 1.2, name: "AI door" });
  const doorId = r.structured?.id;
  check("add_element door", r.ok && Math.abs(r.structured.width_m - 1.2) < 1e-6, text(r));
  r = await mb.call("update_element", { id: "AI door", width: 1.8, max_flow: 1.5 });
  check("update_element", r.ok && Math.abs(r.structured.width_m - 1.8) < 1e-6 && r.structured.max_flow === 1.5, text(r));
  r = await mb.call("add_element", { kind: "spawn", level: "Ground", rect: { x0: 6, y0: 6, x1: 12, y1: 10 }, count: 30, profile: { adult: 0.8, older: 0.2 } });
  check("add_element spawn (count + profile mix)", r.ok && r.structured.count === 30 && r.structured.profile.older === 0.2, text(r));
  r = await mb.call("add_element", { kind: "seating", level: "Ground", origin: [24, 2], width: 8, depth: 4, aisles: "both" });
  check("add_element seating", r.ok && r.structured.seats > 0, `${r.structured?.seats} seats`);
  r = await mb.call("add_element", { kind: "attractor", level: "Ground", p: [30, 12], type: "info", servers: 2, service: { type: "lognormal", a: 20, b: 0.3 } });
  check("add_element attractor", r.ok, text(r));
  r = await mb.call("add_element", { kind: "stair", a: [10, 10], b: [10, 16], width: 1.6 });
  check("add_element stair", r.ok && r.structured.to_level === "Ground", text(r));
  r = await mb.call("add_element", { kind: "wall", points: [[0, 0]] });
  check("add_element validation", !r.ok && /at least 2/.test(r.error), r.error);
  r = await mb.call("delete_element", { id: doorId });
  check("delete_element", r.ok, text(r));
  await page.click("[data-testid=tab-ai]");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "ai-activity.png") });
  // per-call Undo: the most recent mutating entry with an Undo button is the stair → removing it
  const before = await page.evaluate(() => window.__flow.getState().project.elements.filter((e) => e.kind === "stair").length);
  await page.locator("[data-testid=ai-undo]").first().click(); // delete_element entry → restores the door
  await page.waitForTimeout(200);
  const doorBack = await page.evaluate((id) => !!window.__flow.getState().project.elements.find((e) => e.id === id), doorId);
  await page.locator("[data-testid=ai-entry]", { hasText: "add_element" }).filter({ hasText: "Stair" }).locator("[data-testid=ai-undo]").click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.__flow.getState().project.elements.filter((e) => e.kind === "stair").length);
  check("per-call Undo in AI activity", doorBack && after === before - 1, { doorRestored: doorBack, stairs: `${before} → ${after}` });

  // ---------------------------------------------------------------- scenario, DXF, Monte-Carlo, exports
  r = await mb.call("set_scenario", { create: "evacuation", name: "AI test", seed: 5, exit_choice: "nearest", seat_premove: { type: "uniform", a: 0, b: 30 }, closed_exits: ["Main entrance"] });
  check("set_scenario (create)", r.ok && await page.evaluate(() => window.__flow.getState().project.scenarios.some((s) => s.name === "AI test" && s.closedExits.length === 1)), text(r));
  r = await mb.call("open_exit", { exit: "Main entrance" });
  check("open_exit", r.ok && !r.structured.closed.includes("Main entrance"), text(r));
  r = await mb.call("run_monte_carlo", { n: 3 });
  check("run_monte_carlo", r.ok && r.structured.runs.length === 3 && r.structured.p50_s > 0, text(r));
  r = await mb.call("import_dxf", { content: twoRoomsDXF(), mapping: { CROWD: "spawn" }, level: "new", level_name: "DXF test" });
  check("import_dxf", r.ok && r.structured.counts.wall === 2 && r.structured.counts.exit === 1 && r.structured.counts.spawn === 1 && r.structured.scale === 0.001, text(r));
  r = await mb.call("import_dxf", { content: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n" });
  check("import_dxf bad content", !r.ok && /No supported entities/.test(r.error), r.error);
  r = await mb.call("export_file", { format: "csv" });
  check("export_file csv", r.ok && /^t_s,completed/.test(r.content[1]?.text ?? ""), text(r).slice(0, 80));
  r = await mb.call("export_file", { format: "dflow" });
  check("export_file dflow", r.ok && JSON.parse(r.content[1].text).format === "datum-flow", r.content?.[0]?.text);
  r = await mb.call("export_file", { format: "pdf" });
  check("export_file pdf", r.ok && Buffer.from(r.structured.base64, "base64").subarray(0, 5).toString() === "%PDF-", r.content?.[0]?.text);
  r = await mb.call("export_file", { format: "webm" });
  check("export_file webm → out of scope", !r.ok && /out of scope/.test(r.error), r.error);

  // ---------------------------------------------------------------- pause
  await page.evaluate(() => window.__flow.bridge.setPaused(true));
  r = await mb.call("get_state");
  check("Pause AI rejects calls", !r.ok && r.error === "paused by user", r.error);
  await page.evaluate(() => window.__flow.bridge.setPaused(false));
  r = await mb.call("nope");
  check("unknown tool → error", !r.ok && /Unknown tool/.test(r.error), r.error);

  // ---------------------------------------------------------------- reconnect after the bridge restarts
  await new Promise((res) => { for (const c of mb.wss.clients) c.terminate(); setTimeout(res, 300); });
  await page.waitForFunction(() => window.__flow.bridge.state.status === "connected", null, { timeout: 20000 });
  check("auto-reconnect", mb.st.hellos.length >= 3, `${mb.st.hellos.length} hellos`);
  await ctx.close();

  // ---------------------------------------------------------------- localhost blocked (CSP like the artifact viewer)
  const csp = await serve({ "content-security-policy": "connect-src 'self'" }); servers.push(csp);
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await c2.newPage(); watch(p2, "csp");
  await p2.goto(`http://127.0.0.1:${csp.address().port}/`);
  await p2.waitForFunction(() => window.__flow?.getState().sim.status !== "idle", null, { timeout: 120000 });
  await p2.evaluate(() => window.__flow.simctl.pause());
  await p2.click("[data-testid=connect-ai]");
  await p2.fill("[data-testid=ai-pairing]", PAIRING);
  await p2.fill("[data-testid=ai-port]", String(mb.port));
  await p2.click("[data-testid=ai-on]");
  await p2.waitForSelector("[data-testid=ai-blocked]", { timeout: 15000 });
  await p2.screenshot({ path: path.join(SHOTS, "ai-blocked.png") });
  const msg = await p2.evaluate(() => window.__flow.bridge.state.message);
  check("can't-reach-localhost message", /GitHub Pages or a downloaded file/.test(msg), msg);
  await c2.close();

  // ---------------------------------------------------------------- the real Datum Bridge over MCP (if present)
  const cli = process.env.DATUM_BRIDGE ?? path.resolve(ROOT, "../datum-form/bridge/dist/cli.js");
  if (fs.existsSync(cli)) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const wsPort = 47300 + Math.floor(Math.random() * 500);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bridge-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "--ws-port", String(wsPort)], env: { ...process.env, HOME: home, USERPROFILE: home }, stderr: "pipe" });
    const client = new Client({ name: "flow-e2e", version: "1.0.0" });
    await client.connect(transport);
    let code = null;
    for (let k = 0; k < 50 && !code; k++) { const f = path.join(home, ".datum-bridge", "pairing-code"); if (fs.existsSync(f)) code = fs.readFileSync(f, "utf8").trim(); else await new Promise((r2) => setTimeout(r2, 100)); }
    const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p3 = await c3.newPage(); watch(p3, "bridge");
    await p3.goto(URL);
    await p3.waitForFunction(() => window.__flow?.getState().sim.status !== "idle", null, { timeout: 120000 });
    await p3.evaluate(() => window.__flow.simctl.pause());
    await p3.click("[data-testid=connect-ai]");
    await p3.fill("[data-testid=ai-pairing]", code ?? "");
    await p3.fill("[data-testid=ai-port]", String(wsPort));
    await p3.click("[data-testid=ai-on]");
    await p3.waitForFunction(() => window.__flow.bridge.state.status === "connected", null, { timeout: 20000 });
    await p3.keyboard.press("Escape");
    let tools = [];
    for (let k = 0; k < 30; k++) { tools = (await client.listTools()).tools.map((t) => t.name); if (tools.includes("flow_run_simulation")) break; await new Promise((r2) => setTimeout(r2, 200)); }
    const mcp = async (name, args = {}) => { const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); return res; };
    const t = (res) => res.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
    const real = {};
    real.apps = t(await mcp("datum_list_apps"));
    real.open = t(await mcp("flow_open_sample", { name: "office" }));
    real.close = t(await mcp("flow_close_exit", { exit: "West stair discharge" }));
    const run = await mcp("flow_run_simulation", { seed: 1 });
    real.tet = (run.structuredContent ?? {}).tet_s;
    real.run = t(run).split("\n")[1];
    const hcr = await mcp("flow_hand_calc");
    real.hand = (hcr.structuredContent ?? {}).sfpe_hydraulic_rset_s;
    const shot = await mcp("flow_screenshot", { overlay: "los", width: 1280, height: 800 });
    const im = shot.content?.find((c) => c.type === "image");
    if (im) fs.writeFileSync(path.join(SHOTS, "ai-bridge-screenshot-los.png"), Buffer.from(im.data, "base64"));
    const un = await mcp("flow_undo");
    real.undo = t(un);
    real.reopened = await p3.evaluate(() => { const s = window.__flow.getState(); return s.project.scenarios.find((x) => x.id === s.project.activeScenario).closedExits.length === 0; });
    check("real Datum Bridge (MCP stdio)", tools.includes("flow_run_simulation") && real.tet > 0 && real.hand > 0 && !!im && real.reopened, { tools: tools.length, ...real });
    await c3.close();
    await client.close();
  } else {
    results["real Datum Bridge (MCP stdio)"] = { ok: null, detail: `skipped — ${cli} not found` };
    console.log(`  skip real Datum Bridge — ${cli} not found`);
  }
} catch (e) {
  fails.push(`exception: ${e.message}`);
  console.error(e);
} finally {
  check("no console errors", errors.length === 0, errors.length ? errors.slice(0, 6) : "none");
  fs.writeFileSync(path.join(OUT, "e2e-ai.json"), JSON.stringify(results, null, 2));
  await browser.close();
  for (const s of servers) try { s.close(); } catch { /* ignore */ }
  console.log(fails.length ? `\n${fails.length} AI check(s) failed` : "\nall AI checks passed");
  process.exit(fails.length ? 1 : 0);
}
