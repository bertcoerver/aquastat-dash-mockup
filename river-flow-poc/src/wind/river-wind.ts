/*
 * RiverWind: river discharge drawn the way wind maps draw wind (after Mapbox's
 * webgl-wind, which windy-style maps follow), in plain WebGL 2 on a canvas over the map.
 *
 * Wind maps keep three textures on the GPU:
 *   - a vector field: the wind's (u, v) per pixel;
 *   - particle positions, one particle per texel; each frame a shader moves every
 *     particle by the field under it, and sends one that leaves the field, or randomly
 *     "dies", to a random new place;
 *   - the screen of trails: each frame the previous one, faded a little, with the
 *     particles drawn on it as dots. Nothing remembers a path; the fade makes the tails.
 *
 * Here the vector field is the river network, drawn for the current view (again only
 * when the view moves) into an offscreen half-float texture. Every river pixel holds
 * (R, G) its segment's downstream direction times a speed, (B) where it lies across
 * the river, −1 to 1, and (A) 1 + a spawn weight. Pixels off the rivers are 0, so a
 * particle that leaves a river respawns on one: a random pixel, accepted if it's on a
 * river, with probability its spawn weight. Rivers are as wide as their discharge asks,
 * so big rivers have room for, and draw, many more particles.
 *
 * The field pass also writes each river's particle colour to a second texture; particles
 * take the colour under them each frame, so they change colour as they flow into
 * another river.
 *
 * Each particle keeps the across position it was born at, and steers back to it as it
 * goes. Without that (steering everything towards the centre line near the banks), the
 * jumps in direction where segments meet kicked particles sideways, and they piled up
 * along both banks with the middle of the river empty.
 *
 * Positions are in device pixels of the field (y up). When the map pans, particles and
 * trails are shifted with it; when it zooms, they start afresh.
 */
import type { Network } from "../network";

/** Particle state texture side: up to STATE_SIZE² particles. */
const STATE_SIZE = 256;
/** Arcs per row of the arc texture (two texels each). */
const ARC_ROW = 1024;

export interface View {
  /** Map centre, Web Mercator (0–1, y down). */
  centerX: number;
  centerY: number;
  /** Size of the whole world in device pixels (512 × 2^zoom × pixel ratio). */
  worldSize: number;
}

export interface Params {
  /** Particles alive at once. */
  count: number;
  /** Device pixels per frame at speed factor 1. */
  speed: number;
  /** Share of a trail kept from one frame to the next (0–1). */
  fade: number;
  /** Chance a particle respawns elsewhere each frame. */
  drop: number;
  /** Rivers' line width multiplier (CSS px per unit of arc width). */
  widthScale: number;
  pixelRatio: number;
  /** Brightness of the rivers under the particles, 0–1 (0: rivers not drawn). */
  riverBrightness: number;
  /** Particle size, device pixels. */
  pointSize: number;
}

// Each segment of the network is an instance, drawn twice: a quad from its start to its
// end vertex as wide as its arc (uDisc false), and a disc on its start vertex (uDisc
// true), which rounds the corners where segments meet.
const SEGMENT_VS = `#version 300 es
layout(location = 0) in vec2 aStart;
layout(location = 1) in vec2 aEnd;
layout(location = 2) in float aArc;
uniform vec2 uCenter;
uniform float uWorldSize;
uniform vec2 uViewport;
uniform float uWidthScale;
uniform float uMinWidth;
uniform bool uDisc;
uniform highp sampler2D uArcs;
out float vAcross;
out vec2 vDisc;
flat out vec2 vDir;
flat out vec4 vArc;
flat out vec4 vArc2;
void main() {
  int i = int(aArc);
  ivec2 texel = ivec2((i % ${ARC_ROW}) * 2, i / ${ARC_ROW});
  vec4 arc = texelFetch(uArcs, texel, 0);
  vArc = arc;
  vArc2 = texelFetch(uArcs, texel + ivec2(1, 0), 0);
  vec2 p0 = (aStart - uCenter) * uWorldSize;
  vec2 p1 = (aEnd - uCenter) * uWorldSize;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float hw = arc.r > 0.0 ? 0.5 * max(arc.r * uWidthScale, uMinWidth) : 0.0;
  float along = float(gl_VertexID & 1);
  float side = (gl_VertexID & 2) == 0 ? -1.0 : 1.0;
  vec2 p = uDisc ? p0 + (dir * (along * 2.0 - 1.0) + perp * side) * hw : mix(p0, p1, along) + perp * side * hw;
  vDisc = uDisc ? vec2(along * 2.0 - 1.0, side) : vec2(0.0);
  vAcross = side;
  vDir = dir;
  vec2 clip = p / (0.5 * uViewport);
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FIELD_FS = `#version 300 es
precision highp float;
in float vAcross;
in vec2 vDisc;
flat in vec2 vDir;
flat in vec4 vArc;
flat in vec4 vArc2;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 particleColor;
void main() {
  if (length(vDisc) > 1.0) discard;
  particleColor = vec4(vArc2.rgb, 1.0);
  // Across the river, -1 to 1 (on a corner disc: its coordinate across the segment).
  // Screen y is down here and up in the field texture.
  float across = vDisc == vec2(0.0) ? vAcross : vDisc.y;
  fragColor = vec4(vDir.x * vArc.b, -vDir.y * vArc.b, across, 1.0 + vArc.g);
}`;

const RIVER_FS = `#version 300 es
precision highp float;
in vec2 vDisc;
flat in vec4 vArc;
uniform float uBrightness;
out vec4 fragColor;
void main() {
  if (length(vDisc) > 1.0) discard;
  float c = vArc.a; // packed r × 65536 + g × 256 + b
  vec3 rgb = vec3(floor(c / 65536.0), mod(floor(c / 256.0), 256.0), mod(c, 256.0)) / 255.0;
  fragColor = vec4(rgb * uBrightness, 1.0);
}`;

const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// One texel per particle: (x, y) in field pixels, z: 1 alive, 0 not, w: its place across
// the river (-1 to 1), which it steers back to.
const UPDATE_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uState;
uniform highp sampler2D uField;
uniform vec2 uSize;
uniform vec2 uShift;
uniform float uSpeed;
uniform float uDrop;
uniform float uSeed;
uniform float uActive;
uniform float uHold;
uniform bool uReset;
out vec4 state;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float index = float(texel.y * ${STATE_SIZE} + texel.x);
  vec4 s = texelFetch(uState, texel, 0);
  vec2 seed = gl_FragCoord.xy / ${STATE_SIZE}.0 + vec2(uSeed, uSeed * 1.37);
  if (index >= uActive) {
    state = vec4(0.0);
    return;
  }
  bool alive = s.z > 0.5 && !uReset;
  if (alive) {
    vec2 p = s.xy + uShift;
    vec4 f = (p.x < 0.0 || p.y < 0.0 || p.x >= uSize.x || p.y >= uSize.y) ? vec4(0.0) : texelFetch(uField, ivec2(p), 0);
    if (f.a < 0.5 || rand(seed + 0.71) < uDrop) {
      alive = false;
    } else {
      float speed = length(f.xy);
      vec2 dir = f.xy / max(speed, 1e-6);
      vec2 towardsLeft = vec2(dir.y, -dir.x); // the way 'across' grows
      s.xy = p + (dir + towardsLeft * (s.w - f.z) * uHold) * speed * uSpeed;
    }
  }
  if (!alive) {
    // Respawn: try random pixels; take one on a river, with its spawn weight.
    s = vec4(0.0);
    for (int t = 0; t < 12; t++) {
      vec2 r = seed + vec2(float(t) * 1.618, float(t) * 2.414);
      vec2 p = vec2(rand(r), rand(r + 0.5)) * uSize;
      vec4 f = texelFetch(uField, ivec2(p), 0);
      if (f.a > 0.5 && rand(r + 0.25) < f.a - 1.0) {
        s = vec4(p, 1.0, f.z);
        break;
      }
    }
  }
  state = s;
}`;

const PARTICLE_VS = `#version 300 es
uniform highp sampler2D uState;
uniform sampler2D uColors;
uniform vec2 uSize;
uniform float uPointSize;
flat out vec3 vColor;
void main() {
  vec4 s = texelFetch(uState, ivec2(gl_VertexID % ${STATE_SIZE}, gl_VertexID / ${STATE_SIZE}), 0);
  vColor = texelFetch(uColors, ivec2(s.xy), 0).rgb;
  gl_Position = s.z > 0.5 ? vec4(s.xy / uSize * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = uPointSize;
}`;

const PARTICLE_FS = `#version 300 es
precision highp float;
flat in vec3 vColor;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.6, 1.0, d)) * 0.75;
  fragColor = vec4(vColor * a, a); // premultiplied
}`;

// The previous trail screen, moved with the map and faded (premultiplied; the small
// subtraction lets 8-bit values reach 0 instead of leaving ghosts).
const FADE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uShift;
uniform float uFade;
out vec4 fragColor;
void main() {
  vec4 c = texture(uTex, vUv - uShift);
  fragColor = max(c * uFade - 1.5 / 255.0, 0.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, vUv);
}`;

type Program = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

export class RiverWind {
  private gl: WebGL2RenderingContext;
  private segments: WebGLVertexArrayObject;
  private nSegments = 0;
  private arcs: WebGLTexture;
  private arcRows = 1;
  private fieldProgram: Program;
  private riverProgram: Program;
  private updateProgram: Program;
  private particleProgram: Program;
  private fadeProgram: Program;
  private copyProgram: Program;
  private empty: WebGLVertexArrayObject;
  private state: [WebGLTexture, WebGLTexture];
  private stateFb: [WebGLFramebuffer, WebGLFramebuffer];
  private field!: { tex: WebGLTexture; colors: WebGLTexture; fb: WebGLFramebuffer };
  private trails!: [{ tex: WebGLTexture; fb: WebGLFramebuffer }, { tex: WebGLTexture; fb: WebGLFramebuffer }];
  private width = 0;
  private height = 0;
  private last: View | null = null;
  private fieldDirty = true;
  private seed = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error("This browser has no WebGL 2.");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("This browser can't render to float textures.");
    this.gl = gl;
    this.fieldProgram = this.program(SEGMENT_VS, FIELD_FS);
    this.riverProgram = this.program(SEGMENT_VS, RIVER_FS);
    this.updateProgram = this.program(FULLSCREEN_VS, UPDATE_FS);
    this.particleProgram = this.program(PARTICLE_VS, PARTICLE_FS);
    this.fadeProgram = this.program(FULLSCREEN_VS, FADE_FS);
    this.copyProgram = this.program(FULLSCREEN_VS, COPY_FS);
    this.empty = gl.createVertexArray()!;
    this.segments = gl.createVertexArray()!;
    this.arcs = this.texture(gl.RGBA32F, 1, 1, gl.RGBA, gl.FLOAT, gl.NEAREST);
    const zeros = new Float32Array(STATE_SIZE * STATE_SIZE * 4);
    this.state = [0, 1].map(() => {
      const tex = this.texture(gl.RGBA32F, STATE_SIZE, STATE_SIZE, gl.RGBA, gl.FLOAT, gl.NEAREST);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STATE_SIZE, STATE_SIZE, gl.RGBA, gl.FLOAT, zeros);
      return tex;
    }) as [WebGLTexture, WebGLTexture];
    this.stateFb = this.state.map((t) => this.framebuffer(t)) as [WebGLFramebuffer, WebGLFramebuffer];
    this.resize();
  }

  /** The network's segments, in Web Mercator. */
  setNetwork(net: Network) {
    const gl = this.gl;
    const data = new Float32Array((net.nVerts - net.nArcs) * 5);
    let n = 0;
    const mx = (lon: number) => (lon + 180) / 360;
    const my = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    for (let a = 0; a < net.nArcs; a++) {
      for (let v = net.starts[a]; v < net.starts[a + 1] - 1; v++) {
        data.set([mx(net.coords[2 * v]), my(net.coords[2 * v + 1]), mx(net.coords[2 * v + 2]), my(net.coords[2 * v + 3]), a], n * 5);
        n++;
      }
    }
    this.nSegments = n;
    gl.bindVertexArray(this.segments);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [loc, size, offset] of [[0, 2, 0], [1, 2, 8], [2, 1, 16]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 20, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    this.arcRows = Math.ceil(net.nArcs / ARC_ROW);
    gl.bindTexture(gl.TEXTURE_2D, this.arcs);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ARC_ROW * 2, this.arcRows, 0, gl.RGBA, gl.FLOAT, null);
  }

  /**
   * Per arc, eight floats: width (CSS px at width scale 1; 0 hides it), spawn weight 0–1,
   * speed factor 0–1, river colour packed as r × 65536 + g × 256 + b; then the particle
   * colour as r, g, b (0–1), and one spare.
   */
  setArcs(values: Float32Array) {
    const gl = this.gl;
    const padded = new Float32Array(ARC_ROW * 2 * this.arcRows * 4);
    padded.set(values);
    gl.bindTexture(gl.TEXTURE_2D, this.arcs);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ARC_ROW * 2, this.arcRows, gl.RGBA, gl.FLOAT, padded);
    this.fieldDirty = true;
  }

  /** Match the canvas to its size on screen. */
  resize() {
    const gl = this.gl;
    const dpr = window.devicePixelRatio;
    this.width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    this.height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const target = () => {
      const tex = this.texture(gl.RGBA8, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
      return { tex, fb: this.framebuffer(tex) };
    };
    // The field and the particle colours: one pass, two targets.
    const field = this.texture(gl.RGBA16F, this.width, this.height, gl.RGBA, gl.HALF_FLOAT, gl.NEAREST);
    const colors = this.texture(gl.RGBA8, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    const fb = this.framebuffer(field);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, colors, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.field = { tex: field, colors, fb };
    this.trails = [target(), target()];
    for (const t of this.trails) gl.bindTexture(gl.TEXTURE_2D, t.tex), gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.last = null;
    this.fieldDirty = true;
  }

  /** Draw a frame for `view`; `frameScale` is the frame's length in 60 fps frames. */
  frame(view: View, params: Params, frameScale: number) {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;

    // How the view moved: a pan shifts particles and trails, anything else restarts them.
    let reset = false;
    let shift = [0, 0];
    const last = this.last;
    if (!last || last.worldSize !== view.worldSize) {
      reset = true;
      this.fieldDirty = true;
    } else if (last.centerX !== view.centerX || last.centerY !== view.centerY) {
      shift = [(last.centerX - view.centerX) * view.worldSize, -(last.centerY - view.centerY) * view.worldSize];
      this.fieldDirty = true;
    }
    this.last = { ...view };

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const drawSegments = (p: Program) => {
      gl.useProgram(p.program);
      gl.uniform2f(p.u.uCenter, view.centerX, view.centerY);
      gl.uniform1f(p.u.uWorldSize, view.worldSize);
      gl.uniform2f(p.u.uViewport, w, h);
      gl.uniform1f(p.u.uWidthScale, params.widthScale * params.pixelRatio);
      gl.uniform1f(p.u.uMinWidth, 1.5 * params.pixelRatio);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.arcs);
      gl.uniform1i(p.u.uArcs, 0);
      gl.bindVertexArray(this.segments);
      for (const disc of [1, 0]) {
        gl.uniform1i(p.u.uDisc, disc);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nSegments);
      }
    };

    // 1. The vector field, when the view or the rivers changed.
    if (this.fieldDirty) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.field.fb);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawSegments(this.fieldProgram);
      this.fieldDirty = false;
    }

    // 2. Move the particles (ping-pong between the two state textures).
    const [from, to] = [this.state[0], this.stateFb[1]];
    gl.bindFramebuffer(gl.FRAMEBUFFER, to);
    gl.viewport(0, 0, STATE_SIZE, STATE_SIZE);
    const up = this.updateProgram;
    gl.useProgram(up.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from);
    gl.uniform1i(up.u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.field.tex);
    gl.uniform1i(up.u.uField, 1);
    gl.uniform2f(up.u.uSize, w, h);
    gl.uniform2f(up.u.uShift, shift[0], shift[1]);
    gl.uniform1f(up.u.uSpeed, params.speed * frameScale);
    gl.uniform1f(up.u.uDrop, params.drop * frameScale);
    gl.uniform1f(up.u.uSeed, (this.seed = (this.seed + 0.6180339) % 1) * 100);
    gl.uniform1f(up.u.uActive, Math.min(params.count, STATE_SIZE * STATE_SIZE));
    gl.uniform1f(up.u.uHold, 1.5);
    gl.uniform1i(up.u.uReset, reset ? 1 : 0);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.state.reverse();
    this.stateFb.reverse();

    // 3. Trails: the previous screen faded (and moved with the map), then the particles.
    const [prev, next] = this.trails;
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fb);
    gl.viewport(0, 0, w, h);
    const fade = this.fadeProgram;
    gl.useProgram(fade.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    gl.uniform1i(fade.u.uTex, 0);
    gl.uniform2f(fade.u.uShift, shift[0] / w, shift[1] / h);
    gl.uniform1f(fade.u.uFade, reset ? 0 : Math.pow(params.fade, frameScale));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pp = this.particleProgram;
    gl.useProgram(pp.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state[0]);
    gl.uniform1i(pp.u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.field.colors);
    gl.uniform1i(pp.u.uColors, 1);
    gl.uniform2f(pp.u.uSize, w, h);
    gl.uniform1f(pp.u.uPointSize, params.pointSize);
    gl.drawArrays(gl.POINTS, 0, Math.min(params.count, STATE_SIZE * STATE_SIZE));
    gl.disable(gl.BLEND);
    this.trails.reverse();

    // 4. The screen: the rivers, then the trails over them.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (params.riverBrightness > 0) {
      gl.useProgram(this.riverProgram.program);
      gl.uniform1f(this.riverProgram.u.uBrightness, params.riverBrightness);
      drawSegments(this.riverProgram);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.copyProgram.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, next.tex);
    gl.uniform1i(this.copyProgram.u.uTex, 0);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  // --- WebGL helpers ---------------------------------------------------------------

  private program(vs: string, fs: string): Program {
    const gl = this.gl;
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(program)}`);
    return { program, u: this.uniforms(program) };
  }

  private uniforms(program: WebGLProgram) {
    const gl = this.gl;
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(program, i)!.name;
      u[name] = gl.getUniformLocation(program, name);
    }
    return u;
  }

  private texture(internal: number, w: number, h: number, format: number, type: number, filter: number) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private framebuffer(tex: WebGLTexture) {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }
}
