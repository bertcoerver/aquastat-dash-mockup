/*
 * RiverParticlesLayer: particles streaming down the rivers, the way wind maps move
 * particles through the wind (from river-flow-poc's wind map). The Basin view's discharge
 * map draws them over a major basin's rivers (basin/scheme-map.ts).
 *
 * The technique: a vector field of the rivers in view, particles moved through it on
 * the GPU, and a screen of fading trails. All of it lives
 * in screen space, so only the field pass needs the map's projection, and here it goes
 * through deck.gl's: each segment's ends are projected with project_position_to_clipspace
 * and the segment is widened in screen pixels, so the field follows the globe's curve
 * like everything else. Far-side segments are dropped, as HorizonExtension does.
 *
 * Unlike the canvas version, the particles start afresh whenever the view changes: on
 * the globe a pan is a rotation, not a shift of the screen. The rivers themselves (and
 * hovering) are an ordinary PathLayer under this one.
 *
 * Each frame (draw): the field pass when the view or the rivers changed, then the
 * particle update, then the trails, each in its own offscreen render pass; then the
 * trails are drawn into deck.gl's render pass.
 */
import { Layer, project32, type DefaultProps, type LayerContext, type UpdateParameters } from "@deck.gl/core";
import type { Buffer, Framebuffer, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { OVERWRITE, PREMULTIPLIED, uniformBlock } from "./effects-common";

/** The rivers the particles follow (basin/rivers.ts's RiverNetwork is one). */
export interface ParticleNetwork {
  /** Number of arcs. */
  n: number;
  /** First vertex of each arc (n + 1). */
  starts: Uint32Array;
  /** lon, lat per vertex. */
  coords: Float32Array;
}

/** Particle state texture side: up to STATE_SIZE² particles. */
const STATE_SIZE = 256;
/** Arcs per row of the arc texture (two texels each). */
const ARC_ROW = 1024;

export type RiverParticlesLayerProps = {
  /** Read once: another network needs a layer of its own (another id). */
  network: ParticleNetwork;
  /**
   * Per arc, eight floats: width (CSS px at width scale 1; 0 hides it), spawn weight 0–1,
   * speed factor 0–1, spare; particle colour r, g, b (0–1), spare.
   */
  arcs: Float32Array;
  /** Particles alive at once. */
  count: number;
  /** CSS pixels per frame at speed factor 1. */
  speed: number;
  /** Share of a trail kept from one frame to the next (0–1). */
  fade: number;
  /** Chance a particle respawns elsewhere each frame. */
  drop: number;
  /** Rivers' width multiplier (CSS px per unit of arc width). */
  widthScale: number;
  /** Particle size, CSS pixels. */
  pointSize: number;
};

// --- Shaders -----------------------------------------------------------------------

const fieldUniforms = uniformBlock("riverField", { widthScale: "f32", minWidth: "f32", disc: "f32", viewportSize: "vec2<f32>" }, ["vs"]);

// Each segment is an instance, drawn twice: a quad from its start to its end vertex, as
// wide as its arc (disc 0), and a disc on its start vertex (disc 1) to round corners.
const FIELD_VS = `\
#version 300 es
#define SHADER_NAME river-field-vs
in vec2 aStart;
in vec2 aEnd;
in float aArc;
uniform highp sampler2D uArcs;
out float vFacing;
flat out vec2 vStart;
flat out vec2 vDir;
flat out float vHalfWidth;
flat out float vIsDisc;
flat out vec4 vArc;
flat out vec4 vArc2;
void main() {
  int i = int(aArc);
  ivec2 texel = ivec2((i % ${ARC_ROW}) * 2, i / ${ARC_ROW});
  vArc = texelFetch(uArcs, texel, 0);
  vArc2 = texelFetch(uArcs, texel + ivec2(1, 0), 0);

  vec4 common0;
  vec4 c0 = project_position_to_clipspace(vec3(aStart, 0.0), vec3(0.0), vec3(0.0), common0);
  vec4 c1 = project_position_to_clipspace(vec3(aEnd, 0.0), vec3(0.0), vec3(0.0));
  vec2 half_ = 0.5 * riverField.viewportSize;
  vec2 s0 = c0.xy / c0.w * half_;
  vec2 s1 = c1.xy / c1.w * half_;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float hw = vArc.r > 0.0 ? 0.5 * max(vArc.r * riverField.widthScale, riverField.minWidth) : 0.0;

  float along = float(gl_VertexID & 1);
  float side = (gl_VertexID & 2) == 0 ? -1.0 : 1.0;
  bool disc = riverField.disc > 0.5;
  vec2 s = disc ? s0 + (dir * (along * 2.0 - 1.0) + perp * side) * hw : mix(s0, s1, along) + perp * side * hw;
  vec4 c = disc ? c0 : mix(c0, c1, along);
  // The fragment shader works out where it lies across the river (and, for a disc,
  // whether it's inside it) from these.
  vStart = s0 + half_;
  vDir = dir;
  vHalfWidth = hw;
  vIsDisc = disc ? 1.0 : 0.0;
  // On the globe, only what faces the camera (as HorizonExtension).
  vFacing = project.projectionMode == PROJECTION_MODE_GLOBE
    ? dot(normalize(common0.xyz), project.cameraPosition) - GLOBE_RADIUS
    : 1.0;
  gl_Position = vec4(s / half_ * c.w, c.z, c.w);
}`;

// The field (velocity in screen pixels, y up; across −1…1; 1 + spawn weight) and,
// in the second target, the particle colour.
const FIELD_FS = `\
#version 300 es
#define SHADER_NAME river-field-fs
precision highp float;
in float vFacing;
flat in vec2 vStart;
flat in vec2 vDir;
flat in float vHalfWidth;
flat in float vIsDisc;
flat in vec4 vArc;
flat in vec4 vArc2;
layout(location = 0) out vec4 field;
layout(location = 1) out vec4 particleColor;
void main() {
  vec2 offset = (gl_FragCoord.xy - vStart) / max(vHalfWidth, 1e-3);
  if ((vIsDisc > 0.5 && length(offset) > 1.0) || vFacing < 0.0) discard;
  float across = clamp(dot(offset, vec2(-vDir.y, vDir.x)), -1.0, 1.0);
  field = vec4(vDir * vArc.b, across, 1.0 + vArc.g);
  particleColor = vec4(vArc2.rgb, 1.0);
}`;

const FULLSCREEN_VS = `\
#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const updateUniforms = uniformBlock("particleUpdate", { size: "vec2<f32>", speed: "f32", drop: "f32", seed: "f32", alive: "f32", hold: "f32", reset: "f32" }, ["fs"]);

// One texel per particle: (x, y) in field pixels, z: 1 alive, w: its place across the
// river, which it steers back to.
const UPDATE_FS = `\
#version 300 es
precision highp float;
uniform highp sampler2D uState;
uniform highp sampler2D uField;
out vec4 state;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  float index = float(texel.y * ${STATE_SIZE} + texel.x);
  vec2 size = particleUpdate.size;
  vec4 s = texelFetch(uState, texel, 0);
  vec2 seed = gl_FragCoord.xy / ${STATE_SIZE}.0 + vec2(particleUpdate.seed, particleUpdate.seed * 1.37);
  if (index >= particleUpdate.alive) {
    state = vec4(0.0);
    return;
  }
  bool alive = s.z > 0.5 && particleUpdate.reset < 0.5;
  if (alive) {
    vec2 p = s.xy;
    vec4 f = (p.x < 0.0 || p.y < 0.0 || p.x >= size.x || p.y >= size.y) ? vec4(0.0) : texelFetch(uField, ivec2(p), 0);
    if (f.a < 0.5 || rand(seed + 0.71) < particleUpdate.drop) {
      alive = false;
    } else {
      float speed = length(f.xy);
      vec2 dir = f.xy / max(speed, 1e-6);
      vec2 towardsLeft = vec2(-dir.y, dir.x); // the way 'across' grows (y up)
      s.xy = p + (dir + towardsLeft * (s.w - f.z) * particleUpdate.hold) * speed * particleUpdate.speed;
    }
  }
  if (!alive) {
    s = vec4(0.0);
    for (int t = 0; t < 12; t++) {
      vec2 r = seed + vec2(float(t) * 1.618, float(t) * 2.414);
      vec2 p = vec2(rand(r), rand(r + 0.5)) * size;
      vec4 f = texelFetch(uField, ivec2(p), 0);
      if (f.a > 0.5 && rand(r + 0.25) < f.a - 1.0) {
        s = vec4(p, 1.0, f.z);
        break;
      }
    }
  }
  state = s;
}`;

const dotUniforms = uniformBlock("particleDots", { size: "vec2<f32>", pointSize: "f32" }, ["vs"]);

const DOT_VS = `\
#version 300 es
uniform highp sampler2D uState;
uniform sampler2D uColors;
flat out vec3 vColor;
void main() {
  vec4 s = texelFetch(uState, ivec2(gl_VertexID % ${STATE_SIZE}, gl_VertexID / ${STATE_SIZE}), 0);
  vColor = texelFetch(uColors, ivec2(s.xy), 0).rgb;
  gl_Position = s.z > 0.5 ? vec4(s.xy / particleDots.size * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = particleDots.pointSize;
}`;

const DOT_FS = `\
#version 300 es
precision highp float;
flat in vec3 vColor;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.6, 1.0, d)) * 0.75;
  fragColor = vec4(vColor * a, a); // premultiplied
}`;

const fadeUniforms = uniformBlock("trailFade", { fade: "f32" }, ["fs"]);

// The previous trails, faded (premultiplied; the small subtraction lets 8-bit values
// reach 0 instead of leaving ghosts).
const FADE_FS = `\
#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  fragColor = max(texture(uTex, vUv) * trailFade.fade - 1.5 / 255.0, 0.0);
}`;

const COPY_FS = `\
#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, vUv);
}`;

// (deck.gl leaves blending on: passes that compute (field, update, fade) draw with
// OVERWRITE, or they'd blend into what they replace.)

// --- Layer -------------------------------------------------------------------------

type Target = { texture: Texture; framebuffer: Framebuffer };

type State = {
  segments: Buffer;
  arcTexture: Texture;
  fieldModel: Model;
  updateModel: Model;
  dotModel: Model;
  fadeModel: Model;
  copyModel: Model;
  state: [Target, Target];
  // Sized to the canvas (made on the first draw).
  size: [number, number];
  field: { texture: Texture; colors: Texture; framebuffer: Framebuffer } | null;
  trails: [Target, Target] | null;
  fieldDirty: boolean;
  lastViewport: unknown;
  seed: number;
  /** When the last frame was drawn (performance.now). */
  lastTime: number;
};

const defaultProps: DefaultProps<RiverParticlesLayerProps> = {
  count: 8000,
  speed: 1,
  fade: 0.9,
  drop: 0.003,
  widthScale: 1,
  pointSize: 1.8,
};

export class RiverParticlesLayer extends Layer<RiverParticlesLayerProps> {
  static layerName = "RiverParticlesLayer";
  static defaultProps = defaultProps;
  declare state: State;

  initializeState(context: LayerContext) {
    const device = context.device;
    for (const feature of ["float32-renderable-webgl", "float16-renderable-webgl"] as const) {
      if (!device.features.has(feature)) throw new Error(`RiverParticlesLayer needs ${feature}`);
    }
    const net = this.props.network;
    const data = new Float32Array((net.coords.length / 2 - net.n) * 5);
    let n = 0;
    for (let a = 0; a < net.n; a++) {
      for (let v = net.starts[a]; v < net.starts[a + 1] - 1; v++) {
        data.set([net.coords[2 * v], net.coords[2 * v + 1], net.coords[2 * v + 2], net.coords[2 * v + 3], a], n * 5);
        n++;
      }
    }
    const segments = device.createBuffer({ data });
    const arcRows = Math.ceil(net.n / ARC_ROW);
    const arcTexture = device.createTexture({ format: "rgba32float", width: ARC_ROW * 2, height: arcRows, sampler: { minFilter: "nearest", magFilter: "nearest" } });

    const fieldModel = new Model(device, {
      ...this.getShaders({ vs: FIELD_VS, fs: FIELD_FS, modules: [project32, fieldUniforms] }),
      id: `${this.props.id}-field`,
      bufferLayout: [
        {
          name: "segments",
          stepMode: "instance",
          byteStride: 20,
          attributes: [
            { attribute: "aStart", format: "float32x2", byteOffset: 0 },
            { attribute: "aEnd", format: "float32x2", byteOffset: 8 },
            { attribute: "aArc", format: "float32", byteOffset: 16 },
          ],
        },
      ],
      attributes: { segments },
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount: n,
      parameters: OVERWRITE,
    });
    const fullscreen = (id: string, fs: string, modules: ShaderModule[], parameters = {}) =>
      new Model(device, { id: `${this.props.id}-${id}`, vs: FULLSCREEN_VS, fs, modules, vertexCount: 3, topology: "triangle-list", parameters: { ...OVERWRITE, ...parameters } });
    const stateTarget = (): Target => {
      const texture = device.createTexture({ format: "rgba32float", width: STATE_SIZE, height: STATE_SIZE, sampler: { minFilter: "nearest", magFilter: "nearest" } });
      return { texture, framebuffer: device.createFramebuffer({ width: STATE_SIZE, height: STATE_SIZE, colorAttachments: [texture] }) };
    };

    this.setState({
      segments,
      arcTexture,
      fieldModel,
      updateModel: fullscreen("update", UPDATE_FS, [updateUniforms]),
      dotModel: new Model(device, {
        id: `${this.props.id}-dots`,
        vs: DOT_VS,
        fs: DOT_FS,
        modules: [dotUniforms],
        vertexCount: STATE_SIZE * STATE_SIZE,
        topology: "point-list",
        parameters: PREMULTIPLIED,
      }),
      fadeModel: fullscreen("fade", FADE_FS, [fadeUniforms]),
      copyModel: fullscreen("copy", COPY_FS, [], PREMULTIPLIED),
      state: [stateTarget(), stateTarget()],
      size: [0, 0],
      field: null,
      trails: null,
      fieldDirty: true,
      lastViewport: null,
      seed: 0,
      lastTime: 0,
    });
  }

  /** Only the field model needs deck.gl's uniforms (the projection). */
  getModels() {
    return this.state.fieldModel ? [this.state.fieldModel] : [];
  }

  updateState({ props, oldProps }: UpdateParameters<this>) {
    if (props.arcs !== oldProps.arcs) {
      const { arcTexture } = this.state;
      const padded = new Float32Array(arcTexture.width * arcTexture.height * 4);
      padded.set(props.arcs);
      arcTexture.writeData(padded);
      this.state.fieldDirty = true;
    }
    if (props.widthScale !== oldProps.widthScale) this.state.fieldDirty = true;
  }

  finalizeState(context: LayerContext) {
    super.finalizeState(context);
    const s = this.state;
    for (const model of [s.fieldModel, s.updateModel, s.dotModel, s.fadeModel, s.copyModel]) model?.destroy();
    s.segments?.destroy();
    s.arcTexture?.destroy();
    this.destroyTargets();
    for (const t of s.state ?? []) t.framebuffer.destroy(), t.texture.destroy();
  }

  private destroyTargets() {
    const s = this.state;
    if (s.field) s.field.framebuffer.destroy(), s.field.texture.destroy(), s.field.colors.destroy();
    for (const t of s.trails ?? []) t.framebuffer.destroy(), t.texture.destroy();
    s.field = null;
    s.trails = null;
  }

  /** Field and trail textures the size of the canvas (in device pixels). */
  private ensureTargets(width: number, height: number) {
    const s = this.state;
    if (s.field && s.size[0] === width && s.size[1] === height) return;
    this.destroyTargets();
    const device = this.context.device;
    const nearest = { minFilter: "nearest", magFilter: "nearest" } as const;
    const texture = device.createTexture({ format: "rgba16float", width, height, sampler: nearest });
    const colors = device.createTexture({ format: "rgba8unorm", width, height, sampler: nearest });
    s.field = { texture, colors, framebuffer: device.createFramebuffer({ width, height, colorAttachments: [texture, colors] }) };
    const trail = (): Target => {
      const t = device.createTexture({ format: "rgba8unorm", width, height, sampler: nearest });
      return { texture: t, framebuffer: device.createFramebuffer({ width, height, colorAttachments: [t] }) };
    };
    s.trails = [trail(), trail()];
    s.size = [width, height];
    s.fieldDirty = true;
  }

  draw({ renderPass }: { renderPass: import("@luma.gl/core").RenderPass }) {
    const device = this.context.device;
    const viewport = this.context.viewport;
    const dpr = device.getDefaultCanvasContext().cssToDeviceRatio();
    const width = Math.round(viewport.width * dpr);
    const height = Math.round(viewport.height * dpr);
    if (!width || !height) return;
    this.ensureTargets(width, height);
    const s = this.state;
    const p = this.props;
    // This frame's length in 60 fps frames, so the particles keep their speed at any frame rate.
    const now = performance.now();
    const frameScale = s.lastTime ? Math.min(6, (now - s.lastTime) / (1000 / 60)) : 1;
    s.lastTime = now;

    // Any change of view restarts the particles (on the globe a pan is a rotation).
    const moved = !s.lastViewport || !viewport.equals(s.lastViewport as typeof viewport);
    s.lastViewport = viewport;
    const reset = moved;

    // 1. The vector field, when the view or the rivers changed.
    if (moved || s.fieldDirty) {
      const pass = device.beginRenderPass({ framebuffer: s.field!.framebuffer, clearColor: [0, 0, 0, 0] });
      s.fieldModel.setBindings({ uArcs: s.arcTexture });
      // deck.gl gives the models of getModels() the layer's blending before each draw;
      // the field must overwrite.
      s.fieldModel.setParameters(OVERWRITE);
      for (const disc of [1, 0]) {
        s.fieldModel.shaderInputs.setProps({
          riverField: { widthScale: p.widthScale * dpr, minWidth: 1.5 * dpr, disc, viewportSize: [width, height] },
        });
        s.fieldModel.draw(pass);
      }
      pass.end();
      s.fieldDirty = false;
    }

    // 2. Move the particles (ping-pong between the two state textures).
    const [from, to] = s.state;
    const update = device.beginRenderPass({ framebuffer: to.framebuffer, clearColor: false as never });
    s.updateModel.setBindings({ uState: from.texture, uField: s.field!.texture });
    s.seed = (s.seed + 0.6180339) % 1;
    s.updateModel.shaderInputs.setProps({
      particleUpdate: {
        size: [width, height],
        speed: p.speed * dpr * frameScale,
        drop: p.drop * frameScale,
        seed: s.seed * 100,
        alive: Math.min(p.count, STATE_SIZE * STATE_SIZE),
        hold: 1.5,
        reset: reset ? 1 : 0,
      },
    });
    s.updateModel.draw(update);
    update.end();
    s.state.reverse();

    // 3. Trails: the previous ones faded, then the particles.
    const [prev, next] = s.trails!;
    const trails = device.beginRenderPass({ framebuffer: next.framebuffer, clearColor: [0, 0, 0, 0] });
    s.fadeModel.setBindings({ uTex: prev.texture });
    s.fadeModel.shaderInputs.setProps({ trailFade: { fade: reset ? 0 : Math.pow(p.fade, frameScale) } });
    s.fadeModel.draw(trails);
    s.dotModel.setBindings({ uState: s.state[0].texture, uColors: s.field!.colors });
    s.dotModel.shaderInputs.setProps({ particleDots: { size: [width, height], pointSize: p.pointSize * dpr } });
    s.dotModel.setVertexCount(Math.min(p.count, STATE_SIZE * STATE_SIZE));
    s.dotModel.draw(trails);
    trails.end();
    s.trails!.reverse();

    // 4. The trails, into deck.gl's pass.
    s.copyModel.setBindings({ uTex: next.texture });
    s.copyModel.draw(renderPass);
  }
}
