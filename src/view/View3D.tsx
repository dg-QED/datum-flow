// 3D view (three.js): levels stacked at their elevations, extruded walls, stair ramps, seating rows and
// agents as instanced figures. Optional follow-agent camera.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getState, setState, useStore } from "../store";
import { live, onLive } from "../live";
import { seatingLayout, stairFootprint } from "../model/geom";
import { wallSegmentsByLevel } from "../sim/world";
import type { Project } from "../model/types";
import { agentBuffers } from "./agentData";
import { C } from "./palette";

// plan (x, y) at elevation z → three (x, z, −y)
const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);

function buildScene(p: Project, group: THREE.Group) {
  group.clear();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa6b2, roughness: 0.85, metalness: 0, transparent: true, opacity: 0.92 });
  const obstMat = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.9 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x5f6b77, roughness: 0.9 });
  const stairMat = new THREE.MeshStandardMaterial({ color: 0x7cc4ff, roughness: 0.7, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x1a2027, roughness: 1, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const segs = wallSegmentsByLevel(p);
  p.levels.forEach((L, li) => {
    const z = L.elevation;
    // floor slab covering this level's elements
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of segs[li]) { x0 = Math.min(x0, s.ax, s.bx); x1 = Math.max(x1, s.ax, s.bx); y0 = Math.min(y0, s.ay, s.by); y1 = Math.max(y1, s.ay, s.by); }
    if (isFinite(x0)) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 2, y1 - y0 + 2), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.copy(V3((x0 + x1) / 2, (y0 + y1) / 2, z - 0.02));
      floor.receiveShadow = true;
      // cut nothing: stairs are drawn on top; the slab is translucent so lower levels stay visible
      group.add(floor);
    }
    const wallH = li === p.levels.length - 1 ? 1.4 : Math.min(1.4, L.height * 0.4);
    const geos: THREE.BufferGeometry[] = [];
    for (const s of segs[li]) {
      const len = Math.hypot(s.bx - s.ax, s.by - s.ay);
      if (len < 0.01) continue;
      const g = new THREE.BoxGeometry(len + s.t, wallH, Math.max(0.08, s.t));
      g.rotateY(Math.atan2(s.by - s.ay, s.bx - s.ax));
      const c = V3((s.ax + s.bx) / 2, (s.ay + s.by) / 2, z + wallH / 2);
      g.translate(c.x, c.y, c.z);
      geos.push(g);
    }
    if (geos.length) group.add(new THREE.Mesh(mergeGeometries(geos), wallMat));
    const obs: THREE.BufferGeometry[] = [], seats: THREE.BufferGeometry[] = [];
    for (const e of p.elements) {
      if (e.level !== L.id) continue;
      if (e.kind === "obstacle" && e.pts.length >= 3) {
        const shape = new THREE.Shape(e.pts.map((q) => new THREE.Vector2(q[0], q[1])));
        const g = new THREE.ExtrudeGeometry(shape, { depth: 1.0, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        g.translate(0, z, 0);
        obs.push(g);
      } else if (e.kind === "seating") {
        for (const r of seatingLayout(e).rows) {
          const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
          const g = new THREE.BoxGeometry(len, 0.45, 0.3);
          g.rotateY(Math.atan2(r.b[1] - r.a[1], r.b[0] - r.a[0]));
          const c = V3((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2, z + 0.225);
          g.translate(c.x, c.y, c.z);
          seats.push(g);
        }
      } else if (e.kind === "stair") {
        const to = p.levels.find((l) => l.id === e.toLevel);
        const zb = to ? to.elevation : z;
        const fp = stairFootprint(e);
        const pos = [V3(fp[0][0], fp[0][1], z), V3(fp[1][0], fp[1][1], zb), V3(fp[2][0], fp[2][1], zb), V3(fp[3][0], fp[3][1], z)];
        const g = new THREE.BufferGeometry().setFromPoints([pos[0], pos[1], pos[2], pos[0], pos[2], pos[3]]);
        g.computeVertexNormals();
        group.add(new THREE.Mesh(g, stairMat));
      } else if (e.kind === "exit" || e.kind === "door") {
        const col = e.kind === "exit" ? 0x5cc28a : 0xf2a93b;
        const g = new THREE.BufferGeometry().setFromPoints([V3(e.a[0], e.a[1], z + 0.05), V3(e.b[0], e.b[1], z + 0.05)]);
        group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: col })));
        if (e.kind === "exit") {
          for (const q of [e.a, e.b]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.4 })); post.position.copy(V3(q[0], q[1], z + 1.1)); group.add(post); }
        }
      } else if (e.kind === "attractor") {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.1, 16), new THREE.MeshStandardMaterial({ color: 0xc7a6ff, emissive: 0x5a3d8a, emissiveIntensity: 0.4 }));
        m.position.copy(V3(e.p[0], e.p[1], z + 0.55));
        group.add(m);
      }
    }
    if (obs.length) group.add(new THREE.Mesh(mergeGeometries(obs), obstMat));
    if (seats.length) group.add(new THREE.Mesh(mergeGeometries(seats), seatMat));
  });
}

function figureGeometry() {
  const body = new THREE.CylinderGeometry(0.75, 0.9, 1.25, 10);
  body.translate(0, 0.625, 0);
  const head = new THREE.SphereGeometry(0.55, 10, 8);
  head.translate(0, 1.55, 0);
  return mergeGeometries([body, head]);   // scaled per agent: radius r → width 2r, height ≈ 1.7 m
}

export default function View3D() {
  const wrap = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);
  const follow = useStore((s) => s.follow);
  const st = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; ctl: OrbitControls; plan: THREE.Group; agents: THREE.InstancedMesh | null; dirty: boolean } | null>(null);

  useEffect(() => {
    const el = wrap.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(new THREE.Color(C.bg));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.position = "absolute"; renderer.domElement.style.inset = "0";
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(C.bg, 250, 700);
    scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x1a2027, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(60, 120, 40);
    scene.add(sun);
    const cam = new THREE.PerspectiveCamera(45, 1, 0.3, 3000);
    const ctl = new OrbitControls(cam, renderer.domElement);
    ctl.enableDamping = true;
    ctl.maxPolarAngle = Math.PI * 0.49;
    const plan = new THREE.Group();
    scene.add(plan);
    st.current = { renderer, scene, cam, ctl, plan, agents: null, dirty: true };
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`; renderer.domElement.style.height = `${h}px`;
      cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix();
      st.current!.dirty = true;
    });
    ro.observe(el);
    ctl.addEventListener("change", () => { if (st.current) st.current.dirty = true; });
    const off = onLive(() => { if (st.current) st.current.dirty = true; });
    let raf = 0;
    const tmp = new THREE.Object3D(), col = new THREE.Color();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const S = st.current!;
      ctl.update();
      const s = getState();
      const ab = agentBuffers(s.project, null, s.colorBy, s.scrub, s.follow);
      const z = s.scrub === null ? live.frame?.z : null;
      if (ab) {
        if (!S.agents || S.agents.count < ab.count || (S.agents.instanceMatrix.count < ab.count)) {
          if (S.agents) { scene.remove(S.agents); S.agents.dispose(); }
          const cap = Math.max(ab.count, live.info?.n ?? 0, 16);
          S.agents = new THREE.InstancedMesh(figureGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.6 }), cap);
          S.agents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          S.agents.frustumCulled = false;
          scene.add(S.agents);
        }
        const f = s.scrub === null ? live.frame : null;
        for (let k = 0; k < ab.count; k++) {
          const i = ab.idx[k];
          const r = ab.inst[k * 3 + 2];
          const elev = f && z ? z[i] : (s.project.levels[(live.frame?.lvl ?? [])[i] ?? 0]?.elevation ?? 0);
          tmp.position.copy(V3(ab.inst[k * 3], ab.inst[k * 3 + 1], elev));
          tmp.scale.set(r, r < 0.2 ? 0.75 : 1, r);
          tmp.updateMatrix();
          S.agents.setMatrixAt(k, tmp.matrix);
          col.setRGB(ab.col[k * 4] / 255, ab.col[k * 4 + 1] / 255, ab.col[k * 4 + 2] / 255, THREE.SRGBColorSpace);
          S.agents.setColorAt(k, col);
        }
        S.agents.count = ab.count;
        S.agents.instanceMatrix.needsUpdate = true;
        if (S.agents.instanceColor) S.agents.instanceColor.needsUpdate = true;
        // follow camera: keep the orbit offset, move the target with the agent
        if (s.follow !== null && live.frame && s.follow < live.frame.x.length) {
          const i = s.follow;
          const tgt = V3(live.frame.x[i], live.frame.y[i], live.frame.z[i] + 1);
          const off3 = cam.position.clone().sub(ctl.target);
          ctl.target.copy(tgt);
          cam.position.copy(tgt.clone().add(off3.setLength(Math.min(off3.length(), 18))));
        }
      }
      renderer.render(scene, cam);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); off(); ctl.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); st.current = null; };
  }, []);

  // geometry rebuild + initial camera
  const camSet = useRef(false);
  useEffect(() => {
    const S = st.current;
    if (!S) return;
    buildScene(project, S.plan);
    const box = new THREE.Box3().setFromObject(S.plan);
    if (!camSet.current && !box.isEmpty()) {
      camSet.current = true;
      const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
      const R = Math.max(size.x, size.z) * 0.62 + 8;
      S.ctl.target.copy(c);
      S.cam.position.set(c.x + R * 0.15, c.y + R * 0.95, c.z + R * 0.6);
      S.cam.updateProjectionMatrix();
    }
  }, [project.elements, project.levels]);
  useEffect(() => { if (follow === null && st.current) st.current.dirty = true; }, [follow]);

  return (
    <div className="map-wrap" ref={wrap} data-testid="view3d">
      <div className="ov statusbar"><span>3D · drag to orbit · right-drag to pan · wheel to zoom</span>{follow !== null && <button className="btn sm ghost" onClick={() => setState({ follow: null })}>Stop following #{follow}</button>}</div>
    </div>
  );
}
