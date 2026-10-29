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
import type { DefaultProps } from "@deck.gl/core";
import type { RenderPass } from "@luma.gl/core";
import { FACING_GLSL, GRID_GLSL, GridEffectLayer, MERCATOR_GLSL, PREMULTIPLIED, RANDOM_GLSL, SCREEN_GLSL, clock, uniformBlock, unit, type EffectGrid } from "./effects-common";

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

// Both stages read it (the fragment shader its colour and opacity).
const rainUniforms = uniformBlock("rain", {
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
});

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
${GRID_GLSL}
${SCREEN_GLSL}

float rainAtPoint(vec2 lngLat) {
  vec2 uv = gridUv(rain.gridBounds, lngLat);
  return inGrid(uv) ? texture(uGrid, uv).r * 255.0 : 0.0;
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
    vec2 s0 = toScreen(c0, rain.viewportSize);
    vec2 s1 = toScreen(c1, rain.viewportSize);
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

// --- Layer -------------------------------------------------------------------------

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

export class RainLayer extends GridEffectLayer<RainLayerProps> {
  static layerName = "RainLayer";
  static defaultProps = defaultProps;

  protected shaders() {
    return { vs: RAIN_VS, fs: RAIN_FS, modules: [rainUniforms], topology: "triangle-strip" as const, vertexCount: 4, instanceCount: 0, parameters: PREMULTIPLIED };
  }

  draw({ renderPass }: { renderPass: RenderPass }) {
    const s = this.state;
    const p = this.props;
    const f = this.frame();
    if (!f) return;
    const { viewport, region, dpr, metresPerPixel } = f;

    s.model.setBindings({ uGrid: s.texture! });
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
        color: unit(p.color),
        opacity: p.opacity,
      },
    });
    // deck.gl gives the models of getModels() the layer's blending before each draw.
    s.model.setParameters(PREMULTIPLIED);
    s.model.setInstanceCount(p.count);
    s.model.draw(renderPass);
  }
}
