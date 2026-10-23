// Instanced WebGL2 discs for thousands of agents: one draw call per frame, crisp at every zoom.
// Falls back to Canvas 2D when WebGL2 is unavailable.
import type { ViewT } from "./render2d";

const VS = `#version 300 es
in vec2 corner;
in vec3 inst;      // x, y, radius (m)
in vec4 color;
uniform vec4 view; // cx, cy, scale(px/m), dpr
uniform vec2 size; // canvas px
out vec2 uv;
out vec4 vcol;
out float pxr;
void main() {
  float r = max(inst.z * view.z, 1.6);
  vec2 px = (inst.xy - view.xy) * view.z * view.w + corner * (r + 1.0) * view.w;
  gl_Position = vec4(px / (size * 0.5), 0.0, 1.0);
  uv = corner * (r + 1.0) / r;
  vcol = color;
  pxr = r * view.w;
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 uv;
in vec4 vcol;
in float pxr;
out vec4 o;
void main() {
  float d = length(uv);
  float aa = 1.5 / pxr;
  float a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  if (a <= 0.0) discard;
  float rim = smoothstep(0.62, 0.86, d) * step(4.0, pxr);
  vec3 c = mix(vcol.rgb, vcol.rgb * 0.45, rim);
  o = vec4(c * a * vcol.a, a * vcol.a);
}`;

export class AgentLayer {
  gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private inst: WebGLBuffer | null = null;
  private col: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private loc: { view: WebGLUniformLocation | null; size: WebGLUniformLocation | null } = { view: null, size: null };
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, alpha: true });
    if (this.gl) { try { this.init(this.gl); } catch { this.gl = null; } }
  }
  private init(gl: WebGL2RenderingContext) {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    this.prog = p;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const lc = gl.getAttribLocation(p, "corner");
    gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    const li = gl.getAttribLocation(p, "inst");
    gl.enableVertexAttribArray(li); gl.vertexAttribPointer(li, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(li, 1);
    this.col = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.col);
    const lcol = gl.getAttribLocation(p, "color");
    gl.enableVertexAttribArray(lcol); gl.vertexAttribPointer(lcol, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(lcol, 1);
    gl.bindVertexArray(null);
    this.loc = { view: gl.getUniformLocation(p, "view"), size: gl.getUniformLocation(p, "size") };
  }
  /** inst: x, y, r per agent (already filtered to the visible level); col: RGBA bytes. */
  draw(v: ViewT, dpr: number, inst: Float32Array, col: Uint8Array, count: number) {
    const gl = this.gl;
    if (!gl || !this.prog) return false;
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count) return true;
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, count * 3), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.col);
    gl.bufferData(gl.ARRAY_BUFFER, col.subarray(0, count * 4), gl.DYNAMIC_DRAW);
    // y flips: world y up → clip y up, so no flip is needed beyond the projection
    gl.uniform4f(this.loc.view, v.cx, v.cy, v.scale, dpr);
    gl.uniform2f(this.loc.size, W, H);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    return true;
  }
}

/** Canvas 2D fallback with the same inputs (also used for video frames and the report). */
export function drawAgents2D(ctx: CanvasRenderingContext2D, v: ViewT, inst: Float32Array, col: Uint8Array, count: number) {
  for (let i = 0; i < count; i++) {
    const x = (inst[i * 3] - v.cx) * v.scale + v.w / 2, y = v.h / 2 - (inst[i * 3 + 1] - v.cy) * v.scale;
    if (x < -5 || y < -5 || x > v.w + 5 || y > v.h + 5) continue;
    const r = Math.max(1.6, inst[i * 3 + 2] * v.scale);
    ctx.fillStyle = `rgba(${col[i * 4]},${col[i * 4 + 1]},${col[i * 4 + 2]},${col[i * 4 + 3] / 255})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}
