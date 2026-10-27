/*
 * RainLayer: rain in 3D, as dense as a precipitation grid says, falling onto the map
 * (from river-flow-poc's rain page).
 *
 * Every drop is computed from scratch each frame, from its index and the time, so the
 * layer keeps no particle state and needs no buffers: each instance (a drop) falls from
 * `dropHeight` to the ground in `period` seconds, splashes, and starts again elsewhere
 * (its place is a hash of its index and how many times it has fallen). It falls only
 * where the grid's precipitation is high enough: each fall draws a random number, and
 * the drop is shown if that's below the precipitation there (relative to `reference`),
 * so the drops per area grow with the rain.
 *
 * The drops are spread evenly (in Web Mercator) over the part of the grid in view,
 * snapped to powers of two, so they stay put on the ground while the map pans a little.
 * Heights and lengths are in screen pixels at the ground (converted to metres for
 * deck.gl's projection), so the rain looks the same at every zoom. On the globe, drops
 * beyond the horizon are left out.
 *
 * It times itself (performance.now), so it moves on each of the map's repaints without
 * new props.
 */
import { Layer, project32, type DefaultProps, type LayerContext, type UpdateParameters, type Viewport } from "@deck.gl/core";
import type { Device, RenderPass, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";

/** A grid of values: row 0 north, `channels` bytes a cell (0–255, relative to the layer's reference). */
export interface EffectGrid {
  data: Uint8Array;
  channels: 1 | 2;
  width: number;
  height: number;
  /** [west, south, east, north], degrees (an equirectangular grid). */
  bounds: [number, number, number, number];
}

export type RainLayerProps = {
  grid: EffectGrid;
  /** Drops at once (most aren't shown: only where it rains). */
  count: number;
  /** Seconds a drop takes to fall. */
  period: number;
  /** Height drops fall from, and their length, in CSS pixels at the ground. */
  dropHeight: number;
  dropLength: number;
  /** Drop width, CSS pixels. */
  dropWidth: number;
  /** Splash radius, CSS pixels (0: none). */
  splash: number;
  /** Sideways drift of the drops while falling (as a share of the height), east and north. */
  wind: [number, number];
  /** Grid value (0–255) at which every drop is shown; the density grows as value^gamma below it. */
  reference: number;
  gamma: number;
  color: [number, number, number];
  opacity: number;
};

// --- Shaders -----------------------------------------------------------------------

type RainProps = {
  region: [number, number, number, number];
  gridBounds: [number, number, number, number];
  viewportSize: [number, number];
  time: number;
  period: number;
  heightM: number;
  lengthM: number;
  widthPx: number;
  splashM: number;
  wind: [number, number];
  reference: number;
  gamma: number;
  color: [number, number, number];
  opacity: number;
};
// Both stages read it (the fragment shader its colour and opacity).
const RAIN_BLOCK = `\
layout(std140) uniform rainUniforms {
  vec4 region;
  vec4 gridBounds;
  vec2 viewportSize;
  float time;
  float period;
  float heightM;
  float lengthM;
  float widthPx;
  float splashM;
  vec2 wind;
  float reference;
  float gamma;
  vec3 color;
  float opacity;
} rain;
`;
const rainUniforms = {
  name: "rain",
  vs: RAIN_BLOCK,
  fs: RAIN_BLOCK,
  uniformTypes: {
    region: "vec4<f32>",
    gridBounds: "vec4<f32>",
    viewportSize: "vec2<f32>",
    time: "f32",
    period: "f32",
    heightM: "f32",
    lengthM: "f32",
    widthPx: "f32",
    splashM: "f32",
    wind: "vec2<f32>",
    reference: "f32",
    gamma: "f32",
    color: "vec3<f32>",
    opacity: "f32",
  },
} as const satisfies ShaderModule<RainProps>;

// Random numbers (0–1) from integers (PCG): a float hash of the instance's index loses
// precision for large indices, and lines drops up.
export const RANDOM_GLSL = `\
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float random(uint key, uint salt) {
  return float(pcg(key ^ pcg(salt))) / 4294967296.0;
}
`;

/** Whether a point on the ground faces the camera (always off the globe). See horizon.ts. */
export const FACING_GLSL = `\
bool facing(vec2 lngLat) {
  if (project.projectionMode != PROJECTION_MODE_GLOBE) return true;
  vec3 p = project_position(vec3(lngLat, 0.0), vec3(0.0));
  return dot(normalize(p), project.cameraPosition) > GLOBE_RADIUS;
}
`;

/** A Web Mercator position (0–1, y down) in degrees. */
export const MERCATOR_GLSL = `\
vec2 mercatorToLngLat(vec2 m) {
  return vec2(m.x * 360.0 - 180.0, degrees(atan(sinh(3.141592653589793 * (1.0 - 2.0 * m.y)))));
}
`;

/** Share of a drop's period spent splashing (the rest it falls). */
const SPLASH_SHARE = 0.14;

const RAIN_VS = `\
#version 300 es
#define SHADER_NAME rain-vs
uniform sampler2D uGrid;
out vec2 vUv;
out float vAlpha;
flat out float vSplash;

${RANDOM_GLSL}
${FACING_GLSL}
${MERCATOR_GLSL}

float rainAtPoint(vec2 lngLat) {
  vec4 b = rain.gridBounds;
  vec2 uv = vec2((lngLat.x - b.x) / (b.z - b.x), (b.w - lngLat.y) / (b.w - b.y));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(uGrid, uv).r * 255.0;
}

vec2 toScreen(vec4 clip) {
  return clip.xy / clip.w * 0.5 * rain.viewportSize;
}

void main() {
  uint id = pcg(uint(gl_InstanceID));
  // Each drop starts at its own moment, and gets a new place each fall.
  float t = rain.time / rain.period + random(id, 0u);
  float progress = fract(t);
  uint key = pcg(id ^ pcg(uint(t) + 0x9e3779b9u));

  // Its place: evenly over the region, in Web Mercator.
  vec2 lngLat = mercatorToLngLat(rain.region.xy + vec2(random(key, 1u), random(key, 2u)) * rain.region.zw);

  // Shown with a chance that grows with the rain there.
  float density = pow(clamp(rainAtPoint(lngLat) / rain.reference, 0.0, 1.0), rain.gamma);
  if (random(key, 3u) >= density || !facing(lngLat)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float corner = float(gl_VertexID & 1);
  float side = (gl_VertexID & 2) == 0 ? -1.0 : 1.0;
  float falling = progress / (1.0 - ${SPLASH_SHARE});
  vSplash = falling < 1.0 ? 0.0 : 1.0;
  vUv = vec2(side, corner * 2.0 - 1.0);

  if (falling < 1.0) {
    // A streak from its head (lower end) up to its tail, drifting with the wind.
    float metresPerDegree = 111320.0;
    vec2 drift = rain.wind / vec2(metresPerDegree * cos(radians(lngLat.y)), metresPerDegree);
    float zHead = rain.heightM * (1.0 - falling);
    float zTail = zHead + rain.lengthM;
    vec3 head = vec3(lngLat + drift * zHead, zHead);
    vec3 tail = vec3(lngLat + drift * zTail, zTail);
    vec4 c0 = project_position_to_clipspace(head, vec3(0.0), vec3(0.0));
    vec4 c1 = project_position_to_clipspace(tail, vec3(0.0), vec3(0.0));
    vec2 s0 = toScreen(c0);
    vec2 s1 = toScreen(c1);
    vec2 d = s1 - s0;
    float len = length(d);
    // Straight down onto the camera a streak is a dot: give it the drop's width.
    vec2 dir = len > rain.widthPx ? d / len : vec2(0.0, 1.0);
    if (len <= rain.widthPx) s1 = s0 + dir * rain.widthPx;
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 s = mix(s0, s1, corner) + perp * side * 0.5 * rain.widthPx;
    vec4 c = mix(c0, c1, corner);
    gl_Position = vec4(s / (0.5 * rain.viewportSize) * c.w, c.z, c.w);
    // Faint as it appears, brightest at its head.
    vAlpha = smoothstep(0.0, 0.2, falling) * mix(1.0, 0.15, corner);
  } else {
    // A ring on the ground, growing and fading.
    float splash = (falling - 1.0) / (${SPLASH_SHARE} / (1.0 - ${SPLASH_SHARE}));
    float r = rain.splashM * (0.3 + 0.7 * splash);
    vec2 offset = vec2(side, corner * 2.0 - 1.0) * r;
    vec2 degreesOffset = offset / vec2(111320.0 * cos(radians(lngLat.y)), 110540.0);
    gl_Position = project_position_to_clipspace(vec3(lngLat + degreesOffset, 0.0), vec3(0.0), vec3(0.0));
    vAlpha = 1.0 - splash;
  }
}`;

const RAIN_FS = `\
#version 300 es
#define SHADER_NAME rain-fs
precision highp float;
in vec2 vUv;
in float vAlpha;
flat in float vSplash;
out vec4 fragColor;
void main() {
  float a;
  if (vSplash > 0.5) {
    float d = length(vUv);
    a = smoothstep(0.55, 0.8, d) * (1.0 - smoothstep(0.8, 1.0, d)) * 0.8;
  } else {
    a = 1.0 - smoothstep(0.4, 1.0, abs(vUv.x)); // soft sides
  }
  a *= vAlpha * rain.opacity;
  fragColor = vec4(rain.color * a, a); // premultiplied
}`;

export const PREMULTIPLIED = {
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "one",
  blendColorDstFactor: "one-minus-src-alpha",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
  depthCompare: "always",
  depthWriteEnabled: false,
  cullMode: "none",
} as const;

/** Seconds, for the animations: the same clock for every layer. */
const T0 = performance.now();
export const clock = () => (performance.now() - T0) / 1000;

/**
 * The part of a grid in view, in Web Mercator (0–1, y down) as [left, top, width,
 * height], snapped to powers of two, so things spread over it stay put on the ground
 * while the map pans a little. The whole grid where the view's edges are off the globe.
 */
export function viewRegion(viewport: Viewport, [gw, gs, ge, gn]: [number, number, number, number]): [number, number, number, number] | null {
  let [w, s, e, n] = viewport.getBounds();
  if (![w, s, e, n].every(Number.isFinite)) [w, s, e, n] = [gw, gs, ge, gn];
  const west = Math.max(w, gw);
  const east = Math.min(e, ge);
  const south = Math.max(s, gs);
  const north = Math.min(n, gn);
  if (south >= north || west >= east) return null;
  const mx = (lng: number) => (lng + 180) / 360;
  const my = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const x0 = mx(west);
  const x1 = mx(east);
  const y0 = my(north);
  const y1 = my(south);
  const step = 2 ** Math.ceil(Math.log2(Math.max(x1 - x0, y1 - y0) / 8));
  const left = Math.floor(x0 / step) * step;
  const top = Math.floor(y0 / step) * step;
  return [left, top, Math.ceil(x1 / step) * step - left, Math.ceil(y1 / step) * step - top];
}

/** A grid's texture (linear, so drops and puffs fade at its cells' edges). */
export function gridTexture(device: Device, grid: EffectGrid): Texture {
  return device.createTexture({
    format: grid.channels === 2 ? "rg8unorm" : "r8unorm",
    width: grid.width,
    height: grid.height,
    data: grid.data,
    sampler: { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
  });
}

// --- Layer -------------------------------------------------------------------------

type State = {
  model: Model;
  texture: Texture | null;
};

const defaultProps: DefaultProps<RainLayerProps> = {
  count: 60000,
  period: 1.4,
  dropHeight: 140,
  dropLength: 8,
  dropWidth: 1.4,
  splash: 4,
  wind: [0.12, 0.04],
  reference: 160,
  gamma: 0.7,
  color: [200, 220, 255],
  opacity: 0.9,
};

export class RainLayer extends Layer<RainLayerProps> {
  static layerName = "RainLayer";
  static defaultProps = defaultProps;
  declare state: State;

  initializeState(context: LayerContext) {
    const model = new Model(context.device, {
      ...this.getShaders({ vs: RAIN_VS, fs: RAIN_FS, modules: [project32, rainUniforms] }),
      id: `${this.props.id}-drops`,
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount: 0,
      parameters: PREMULTIPLIED,
    });
    this.setState({ model, texture: null });
  }

  getModels() {
    return this.state.model ? [this.state.model] : [];
  }

  updateState({ props, oldProps }: UpdateParameters<this>) {
    if (props.grid !== oldProps.grid || !this.state.texture) {
      this.state.texture?.destroy();
      this.setState({ texture: gridTexture(this.context.device, props.grid) });
    }
  }

  finalizeState(context: LayerContext) {
    super.finalizeState(context);
    this.state.model?.destroy();
    this.state.texture?.destroy();
  }

  draw({ renderPass }: { renderPass: RenderPass }) {
    const s = this.state;
    const p = this.props;
    const viewport = this.context.viewport;
    const region = viewRegion(viewport, p.grid.bounds);
    if (!region || !s.texture) return;
    const dpr = this.context.device.getDefaultCanvasContext().cssToDeviceRatio();
    // Metres per CSS pixel at the ground in the middle of the view.
    const metresPerPixel = (viewport as unknown as { metersPerPixel: number }).metersPerPixel;
    const [r, g, b] = p.color;

    s.model.setBindings({ uGrid: s.texture });
    s.model.shaderInputs.setProps({
      rain: {
        region,
        gridBounds: p.grid.bounds,
        viewportSize: [viewport.width * dpr, viewport.height * dpr],
        time: clock(),
        period: p.period,
        heightM: p.dropHeight * metresPerPixel,
        lengthM: p.dropLength * metresPerPixel,
        widthPx: p.dropWidth * dpr,
        splashM: p.splash * metresPerPixel,
        wind: p.wind,
        reference: p.reference,
        gamma: p.gamma,
        color: [r / 255, g / 255, b / 255],
        opacity: p.opacity,
      },
    });
    // deck.gl gives the models of getModels() the layer's blending before each draw.
    s.model.setParameters(PREMULTIPLIED);
    s.model.setInstanceCount(p.count);
    s.model.draw(renderPass);
  }
}
