import type { ShaderModule } from "@luma.gl/shadertools";

/** Value range of the colour ramp, in GAEZ units (1000 ha per 5' cell). */
export const RAMP_MIN = 0.001; // 1 ha
export const RAMP_MAX = 10; // 10 000 ha

/** YlGnBu, light to dark. Kept in sync with the legend in index.html. */
export const RAMP_COLORS = ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"];

const glslColor = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(4));
  return `vec3(${c.join(", ")})`;
};

export type SumBandsProps = {
  /** Weights for the two composited bands (color.r, color.g). [1, 1] = sum. */
  weights: [number, number];
};

const MODULE_NAME = "sumBands";

/**
 * Raster arithmetic on the GPU: weighted sum of the two bands that
 * MultiCOGLayer composites into color.r and color.g, then a log-scaled colour
 * ramp. Pixels that sum to (near) zero — GAEZ nodata is 0 — or NaN are dropped.
 */
export const SumBands = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  vec2 weights;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": /* glsl */ `
vec3 sumBands_ramp(float t) {
  vec3 c0 = ${glslColor(RAMP_COLORS[0])};
  vec3 c1 = ${glslColor(RAMP_COLORS[1])};
  vec3 c2 = ${glslColor(RAMP_COLORS[2])};
  vec3 c3 = ${glslColor(RAMP_COLORS[3])};
  vec3 c4 = ${glslColor(RAMP_COLORS[4])};
  float s = t * 4.0;
  if (s < 1.0) return mix(c0, c1, s);
  if (s < 2.0) return mix(c1, c2, s - 1.0);
  if (s < 3.0) return mix(c2, c3, s - 2.0);
  return mix(c3, c4, s - 3.0);
}
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  float total = dot(vec2(color.r, color.g), ${MODULE_NAME}.weights);
  // Also catches NaN, which fails every comparison.
  if (!(total >= ${RAMP_MIN.toFixed(6)})) discard;
  float t = clamp(
    (log(total) - log(${RAMP_MIN.toFixed(6)})) /
      (log(${RAMP_MAX.toFixed(6)}) - log(${RAMP_MIN.toFixed(6)})),
    0.0, 1.0);
  color = vec4(sumBands_ramp(t), 1.0);
`,
  },
  uniformTypes: {
    weights: "vec2<f32>",
  },
  getUniforms: (props: Partial<SumBandsProps>) => ({
    weights: props.weights ?? [1, 1],
  }),
} as const satisfies ShaderModule<SumBandsProps>;
