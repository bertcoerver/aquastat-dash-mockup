/*
 * VapourLayer: evapotranspiration as vapour rising from the map, as much as a grid says.
 *
 * Built like RainLayer, the other way up: every puff is computed from scratch each frame,
 * from its index and the time, so the layer keeps no particle state. Each instance (a
 * puff) rises from the ground to `height` in `period` seconds, swaying from side to side,
 * drifting with the wind, growing and fading, then starts again elsewhere. It rises only
 * where the grid's evapotranspiration is high enough (a random number below it, relative
 * to `reference`), so the puffs per area grow with the water going up.
 *
 * The grid's second channel is transpiration's share: a puff is transpiration (from
 * plants) with that chance and coloured `transpirationColor`, otherwise evaporation
 * (from soil, water and wet leaves) and coloured `evaporationColor`.
 */
import { Layer, project32, type DefaultProps, type LayerContext, type UpdateParameters } from "@deck.gl/core";
import type { RenderPass, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { PREMULTIPLIED, RANDOM_GLSL, viewRegion } from "../rain/rain-layer";

/** An evapotranspiration grid: row 0 north, two bytes a cell (the amount relative to the
 * layer's reference, and transpiration's share of it). */
export interface VapourGrid {
  data: Uint8Array;
  width: number;
  height: number;
  /** [west, south, east, north], degrees (an equirectangular grid). */
  bounds: [number, number, number, number];
}

export type VapourLayerProps = {
  grid: VapourGrid;
  /** The grid faded from (with `mix` 0 → 1). */
  previous: VapourGrid | null;
  mix: number;
  /** Puffs at once (most aren't shown: only where water goes up). */
  count: number;
  /** Seconds, for the animation. */
  time: number;
  /** Seconds a puff takes to rise. */
  period: number;
  /** Height puffs rise to, CSS pixels at the ground. */
  height: number;
  /** Puff diameter at the ground and at the top, CSS pixels. */
  size: [number, number];
  /** Sway from side to side, CSS pixels. */
  sway: number;
  /** Sideways drift while rising (as a share of the height), east and north. */
  wind: [number, number];
  /** Grid value (0–255) at which every puff is shown; the density grows as value^gamma below it. */
  reference: number;
  gamma: number;
  transpirationColor: [number, number, number];
  evaporationColor: [number, number, number];
  opacity: number;
  /** The MapLibre layer it's drawn beneath (MapboxOverlay, interleaved). */
  beforeId?: string;
};

/** How far back (as a share of the rise) a puff's trail goes. */
const TRAIL = 0.03;

// --- Shaders -----------------------------------------------------------------------

type VapourProps = {
  region: [number, number, number, number];
  gridBounds: [number, number, number, number];
  near: [number, number];
  viewportSize: [number, number];
  time: number;
  period: number;
  heightM: number;
  size: [number, number];
  sway: number;
  wind: [number, number];
  reference: number;
  gamma: number;
  mixGrids: number;
  transpirationColor: [number, number, number];
  evaporationColor: [number, number, number];
  opacity: number;
};
const vapourUniforms = {
  name: "vapour",
  vs: `\
layout(std140) uniform vapourUniforms {
  vec4 region;
  vec4 gridBounds;
  vec2 near;
  vec2 viewportSize;
  float time;
  float period;
  float heightM;
  vec2 size;
  float sway;
  vec2 wind;
  float reference;
  float gamma;
  float mixGrids;
  vec3 transpirationColor;
  vec3 evaporationColor;
  float opacity;
} vapour;
`,
  uniformTypes: {
    region: "vec4<f32>",
    gridBounds: "vec4<f32>",
    near: "vec2<f32>",
    viewportSize: "vec2<f32>",
    time: "f32",
    period: "f32",
    heightM: "f32",
    size: "vec2<f32>",
    sway: "f32",
    wind: "vec2<f32>",
    reference: "f32",
    gamma: "f32",
    mixGrids: "f32",
    transpirationColor: "vec3<f32>",
    evaporationColor: "vec3<f32>",
    opacity: "f32",
  },
} as const satisfies ShaderModule<VapourProps>;

const VAPOUR_VS = `\
#version 300 es
#define SHADER_NAME vapour-vs
uniform sampler2D uGrid;
uniform sampler2D uPrevious;
out vec2 vUv;
flat out float vTrail;
out vec4 vColor;

const float VAPOUR_PI = 3.141592653589793;

${RANDOM_GLSL}

vec2 toScreen(vec4 clip) {
  return clip.xy / clip.w * 0.5 * vapour.viewportSize;
}
// Share of the height reached (0–1) at a moment of the rise (0–1).
float riseAt(float progress) {
  return 1.0 - (1.0 - progress) * (1.0 - progress);
}
vec3 puffAt(vec2 lngLat, vec2 drift, float rise) {
  float z = vapour.heightM * rise;
  return vec3(lngLat + drift * z, z);
}
float swayAt(float progress, float rise, float phase) {
  return vapour.sway * rise * sin(phase + progress * 3.0 * VAPOUR_PI);
}

// The amount (0–255) and transpiration's share (0–1) at a point.
vec2 vapourAtPoint(vec2 lngLat) {
  vec4 b = vapour.gridBounds;
  vec2 uv = vec2((lngLat.x - b.x) / (b.z - b.x), (b.w - lngLat.y) / (b.w - b.y));
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(0.0);
  vec2 v = mix(texture(uPrevious, uv).rg, texture(uGrid, uv).rg, vapour.mixGrids);
  return vec2(v.x * 255.0, v.y);
}

void main() {
  uint id = pcg(uint(gl_InstanceID));
  // Each puff starts at its own moment and speed, and gets a new place each time.
  float t = vapour.time / (vapour.period * (0.8 + 0.4 * random(id, 5u))) + random(id, 0u);
  float progress = fract(t);
  uint key = pcg(id ^ pcg(uint(t) + 0x9e3779b9u));

  // Its place: evenly over the region, in Web Mercator (0–1, y down), then in degrees.
  vec2 m = vapour.region.xy + vec2(random(key, 1u), random(key, 2u)) * vapour.region.zw;
  vec2 lngLat = vec2(m.x * 360.0 - 180.0, degrees(atan(sinh(VAPOUR_PI * (1.0 - 2.0 * m.y)))));

  // Shown with a chance that grows with the water going up there.
  vec2 here = vapourAtPoint(lngLat);
  float density = pow(clamp(here.x / vapour.reference, 0.0, 1.0), vapour.gamma);
  // Fewer the further from the camera, where the ground is squeezed on the screen, so the
  // puffs per pixel follow the water going up and not the tilt.
  float wNear = project_position_to_clipspace(vec3(vapour.near, 0.0), vec3(0.0), vec3(0.0)).w;
  float wHere = project_position_to_clipspace(vec3(lngLat, 0.0), vec3(0.0), vec3(0.0)).w;
  density *= min(1.0, pow(wNear / wHere, 2.0));
  if (random(key, 3u) >= density) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vColor.rgb = random(key, 4u) < here.y ? vapour.transpirationColor : vapour.evaporationColor;

  // Rising fast off the ground, slowing as it goes up, swaying more the higher it is.
  vec2 drift = vapour.wind / vec2(111320.0 * cos(radians(lngLat.y)), 111320.0);
  float phase = random(key, 6u) * 2.0 * VAPOUR_PI;
  float rise = riseAt(progress);
  vec4 clip = project_position_to_clipspace(puffAt(lngLat, drift, rise), vec3(0.0), vec3(0.0));
  vec2 head = toScreen(clip) + vec2(swayAt(progress, rise, phase), 0.0);
  // Its trail: where it was a moment ago (long while it's quick, gone once it hangs).
  float before = max(progress - ${TRAIL}, 0.0);
  vec4 clipBefore = project_position_to_clipspace(puffAt(lngLat, drift, riseAt(before)), vec3(0.0), vec3(0.0));
  vec2 tail = toScreen(clipBefore) + vec2(swayAt(before, riseAt(before), phase), 0.0);

  // A quad on the screen around the head and its trail.
  vec2 d = tail - head;
  float len = length(d);
  vec2 dir = len > 0.01 ? d / len : vec2(0.0, -1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float r = 0.5 * mix(vapour.size.x, vapour.size.y, progress);
  vec2 corner = vec2(gl_VertexID & 1, (gl_VertexID & 2) >> 1);
  float across = mix(-r, r, corner.x);
  float along = mix(-r, len + r, corner.y);
  vec2 s = head + dir * along + perp * across;
  vUv = vec2(across, along) / r;
  vTrail = len / r;
  gl_Position = vec4(s / (0.5 * vapour.viewportSize) * clip.w, clip.z, clip.w);
  // Appearing quickly, thinning out as it spreads.
  vColor.a = smoothstep(0.0, 0.12, progress) * (1.0 - smoothstep(0.35, 1.0, progress)) * vapour.opacity;
}`;

const VAPOUR_FS = `\
#version 300 es
#define SHADER_NAME vapour-fs
precision highp float;
in vec2 vUv;
flat in float vTrail;
in vec4 vColor;
out vec4 fragColor;
void main() {
  // A soft blob at the head (0, 0), drawn out along its trail (0, 0 → vTrail), fading.
  float along = clamp(vUv.y, 0.0, vTrail);
  vec2 d = vec2(vUv.x, vUv.y - along);
  float a = exp(-4.0 * dot(d, d)) * (1.0 - 0.9 * along / max(vTrail, 1.0)) * vColor.a;
  if (a < 0.003) discard;
  fragColor = vec4(vColor.rgb * a, a); // premultiplied
}`;

// --- Layer -------------------------------------------------------------------------

type State = {
  model: Model;
  /** A texture per grid shown (both while fading). */
  textures: Map<VapourGrid, Texture>;
};

const defaultProps: DefaultProps<VapourLayerProps> = {
  previous: null,
  mix: 1,
  count: 300000,
  time: 0,
  period: 3,
  height: 160,
  size: [3, 14],
  sway: 5,
  wind: [0.15, 0.05],
  reference: 128,
  gamma: 0.7,
  transpirationColor: [150, 235, 170],
  evaporationColor: [190, 220, 255],
  opacity: 0.4,
};

export class VapourLayer extends Layer<VapourLayerProps> {
  static layerName = "VapourLayer";
  static defaultProps = defaultProps;
  declare state: State;

  initializeState(context: LayerContext) {
    const model = new Model(context.device, {
      ...this.getShaders({ vs: VAPOUR_VS, fs: VAPOUR_FS, modules: [project32, vapourUniforms] }),
      id: `${this.props.id}-puffs`,
      topology: "triangle-strip",
      vertexCount: 4,
      instanceCount: 0,
      parameters: PREMULTIPLIED,
    });
    this.setState({ model, textures: new Map() });
  }

  getModels() {
    return this.state.model ? [this.state.model] : [];
  }

  updateState({ props }: UpdateParameters<this>) {
    this.setState({ textures: gridTextures(this.context.device, this.state.textures, [props.grid, props.previous]) });
  }

  finalizeState(context: LayerContext) {
    super.finalizeState(context);
    this.state.model?.destroy();
    for (const texture of this.state.textures?.values() ?? []) texture.destroy();
  }

  draw({ renderPass }: { renderPass: RenderPass }) {
    const s = this.state;
    const p = this.props;
    const viewport = this.context.viewport;
    const region = viewRegion(viewport, p.grid.bounds);
    const grid = s.textures.get(p.grid);
    if (!region || !grid) return;
    const dpr = this.context.device.getDefaultCanvasContext().cssToDeviceRatio();
    const metresPerPixel = (viewport as unknown as { metersPerPixel: number }).metersPerPixel;
    const rgb = ([r, g, b]: [number, number, number]): [number, number, number] => [r / 255, g / 255, b / 255];

    s.model.setBindings({ uGrid: grid, uPrevious: (p.previous && s.textures.get(p.previous)) || grid });
    s.model.shaderInputs.setProps({
      vapour: {
        region,
        gridBounds: p.grid.bounds,
        // The ground at the bottom of the view, nearest the camera.
        near: viewport.unproject([viewport.width / 2, viewport.height]) as [number, number],
        viewportSize: [viewport.width * dpr, viewport.height * dpr],
        time: p.time,
        period: p.period,
        heightM: p.height * metresPerPixel,
        size: [p.size[0] * dpr, p.size[1] * dpr],
        sway: p.sway * dpr,
        wind: p.wind,
        reference: p.reference,
        gamma: p.gamma,
        mixGrids: p.previous ? p.mix : 1,
        transpirationColor: rgb(p.transpirationColor),
        evaporationColor: rgb(p.evaporationColor),
        opacity: p.opacity,
      },
    });
    // deck.gl gives the models of getModels() the layer's blending before each draw.
    s.model.setParameters(PREMULTIPLIED);
    s.model.setInstanceCount(p.count);
    s.model.draw(renderPass);
  }
}

/** Textures (two bytes a cell, linear) for the grids shown now; the others are destroyed. */
export function gridTextures(
  device: LayerContext["device"],
  textures: Map<VapourGrid, Texture>,
  grids: (VapourGrid | null)[],
): Map<VapourGrid, Texture> {
  const wanted = new Set(grids.filter((g): g is VapourGrid => !!g));
  for (const [grid, texture] of textures) if (!wanted.has(grid)) texture.destroy(), textures.delete(grid);
  for (const grid of wanted) {
    if (textures.has(grid)) continue;
    textures.set(
      grid,
      device.createTexture({
        format: "rg8unorm",
        width: grid.width,
        height: grid.height,
        data: grid.data,
        sampler: { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
      }),
    );
  }
  return textures;
}
