/*
 * VapourLayer: evapotranspiration as vapour rising from the map, as much as a grid says
 * (from river-flow-poc's evapotranspiration page).
 *
 * Built like RainLayer, the other way up: every puff is computed from scratch each frame,
 * from its index and the time, so the layer keeps no particle state. Each instance (a
 * puff) rises from the ground to `height` in `period` seconds, swaying from side to side,
 * drifting with the wind, growing and fading, then starts again elsewhere. It rises only
 * where the grid's evapotranspiration is high enough (a random number below it, relative
 * to `reference`), so the puffs per area grow with the water going up. Puffs are also
 * thinned with distance from the camera, so on a tilted map their density on the screen
 * follows the data, not the squeezed horizon.
 *
 * The grid's second channel is transpiration's share: a puff is transpiration (from
 * plants) with that chance and coloured `transpirationColor`, otherwise evaporation
 * (from soil, water and wet leaves) and coloured `evaporationColor`.
 */
import type { DefaultProps } from "@deck.gl/core";
import type { RenderPass } from "@luma.gl/core";
import { FACING_GLSL, GRID_GLSL, GridEffectLayer, MERCATOR_GLSL, PREMULTIPLIED, RANDOM_GLSL, SCREEN_GLSL, clock, uniformBlock, unit, type EffectGrid } from "./effects-common";

export type VapourLayerProps = {
  /** Two channels: the amount, and transpiration's share of it. */
  grid: EffectGrid;
  /** Puffs at once (most aren't shown: only where water goes up). */
  count: number;
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
};

/** How far back (as a share of the rise) a puff's trail goes. */
const TRAIL = 0.03;

// --- Shaders -----------------------------------------------------------------------

const vapourUniforms = uniformBlock(
  "vapour",
  {
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
    transpirationColor: "vec3<f32>",
    evaporationColor: "vec3<f32>",
    opacity: "f32",
  },
  ["vs"],
);

const VAPOUR_VS = `\
#version 300 es
#define SHADER_NAME vapour-vs
uniform sampler2D uGrid;
out vec2 vUv;
flat out float vTrail;
out vec4 vColor;

const float VAPOUR_PI = 3.141592653589793;

${RANDOM_GLSL}
${FACING_GLSL}
${MERCATOR_GLSL}
${GRID_GLSL}
${SCREEN_GLSL}

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
  vec2 uv = gridUv(vapour.gridBounds, lngLat);
  if (!inGrid(uv)) return vec2(0.0);
  vec2 v = texture(uGrid, uv).rg;
  return vec2(v.x * 255.0, v.y);
}

void main() {
  uint id = pcg(uint(gl_InstanceID));
  // Each puff starts at its own moment and speed, and gets a new place each time.
  float t = vapour.time / (vapour.period * (0.8 + 0.4 * random(id, 5u))) + random(id, 0u);
  float progress = fract(t);
  uint key = pcg(id ^ pcg(uint(t) + 0x9e3779b9u));

  // Its place: evenly over the region, in Web Mercator.
  vec2 lngLat = mercatorToLngLat(vapour.region.xy + vec2(random(key, 1u), random(key, 2u)) * vapour.region.zw);

  // Shown with a chance that grows with the water going up there.
  vec2 here = vapourAtPoint(lngLat);
  float density = pow(clamp(here.x / vapour.reference, 0.0, 1.0), vapour.gamma);
  // Fewer the further from the camera, where the ground is squeezed on the screen, so the
  // puffs per pixel follow the water going up and not the tilt.
  float wNear = project_position_to_clipspace(vec3(vapour.near, 0.0), vec3(0.0), vec3(0.0)).w;
  float wHere = project_position_to_clipspace(vec3(lngLat, 0.0), vec3(0.0), vec3(0.0)).w;
  density *= min(1.0, pow(wNear / wHere, 2.0));
  if (random(key, 3u) >= density || !facing(lngLat)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vColor.rgb = random(key, 4u) < here.y ? vapour.transpirationColor : vapour.evaporationColor;

  // Rising fast off the ground, slowing as it goes up, swaying more the higher it is.
  vec2 drift = vapour.wind / vec2(111320.0 * cos(radians(lngLat.y)), 111320.0);
  float phase = random(key, 6u) * 2.0 * VAPOUR_PI;
  float rise = riseAt(progress);
  vec4 clip = project_position_to_clipspace(puffAt(lngLat, drift, rise), vec3(0.0), vec3(0.0));
  vec2 head = toScreen(clip, vapour.viewportSize) + vec2(swayAt(progress, rise, phase), 0.0);
  // Its trail: where it was a moment ago (long while it's quick, gone once it hangs).
  float before = max(progress - ${TRAIL}, 0.0);
  vec4 clipBefore = project_position_to_clipspace(puffAt(lngLat, drift, riseAt(before)), vec3(0.0), vec3(0.0));
  vec2 tail = toScreen(clipBefore, vapour.viewportSize) + vec2(swayAt(before, riseAt(before), phase), 0.0);

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

const defaultProps: DefaultProps<VapourLayerProps> = {
  count: 300000,
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

export class VapourLayer extends GridEffectLayer<VapourLayerProps> {
  static layerName = "VapourLayer";
  static defaultProps = defaultProps;

  protected shaders() {
    return { vs: VAPOUR_VS, fs: VAPOUR_FS, modules: [vapourUniforms], topology: "triangle-strip" as const, vertexCount: 4, instanceCount: 0, parameters: PREMULTIPLIED };
  }

  draw({ renderPass }: { renderPass: RenderPass }) {
    const s = this.state;
    const p = this.props;
    const f = this.frame();
    if (!f) return;
    const { viewport, region, dpr, metresPerPixel } = f;
    // The ground at the bottom of the view, nearest the camera (on the globe zoomed out,
    // off it: then the middle of the view).
    const bottom = viewport.unproject([viewport.width / 2, viewport.height]);
    const middle = viewport.unproject([viewport.width / 2, viewport.height / 2]);
    const near = (bottom.every(Number.isFinite) ? bottom : middle).slice(0, 2) as [number, number];

    s.model.setBindings({ uGrid: s.texture! });
    s.model.shaderInputs.setProps({
      vapour: {
        region,
        gridBounds: p.grid.bounds,
        near,
        viewportSize: [viewport.width * dpr, viewport.height * dpr],
        time: clock(),
        period: p.period,
        heightM: p.height * metresPerPixel,
        size: [p.size[0] * dpr, p.size[1] * dpr],
        sway: p.sway * dpr,
        wind: p.wind,
        reference: p.reference,
        gamma: p.gamma,
        transpirationColor: unit(p.transpirationColor),
        evaporationColor: unit(p.evaporationColor),
        opacity: p.opacity,
      },
    });
    // deck.gl gives the models of getModels() the layer's blending before each draw.
    s.model.setParameters(PREMULTIPLIED);
    s.model.setInstanceCount(p.count);
    s.model.draw(renderPass);
  }
}
