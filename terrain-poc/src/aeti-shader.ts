import type { ShaderModule } from "@luma.gl/shadertools";

/** WaPOR L1-AETI-A: physical value (mm/year) = raw * 0.1. */
const SCALE = 0.1;
/** Ramp range, in mm/year. */
export const RAMP_MIN = 0;
export const RAMP_MAX = 1500;
/** WaPOR's AETI colours, light to dark. Kept in sync with .ramp in style.css. */
const RAMP_COLORS = ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"];

const glslColor = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(4));
  return `vec3(${c.join(", ")})`;
};

export type AetiRampProps = { opacity: number };

const MODULE_NAME = "aetiRamp";

/**
 * MultiCOGLayer puts the raw int16 AETI values (as float) in color.r. Scale them, drop
 * nodata and NaN, and colour with a linear ramp.
 */
export const AetiRamp = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float opacity;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": /* glsl */ `
vec3 aetiRamp_color(float t) {
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
  float aeti = color.r * ${SCALE.toFixed(4)};
  // Nodata is -9999. Also catches NaN, which fails every comparison.
  if (!(aeti >= 0.0)) discard;
  float t = clamp((aeti - ${RAMP_MIN.toFixed(1)}) / ${(RAMP_MAX - RAMP_MIN).toFixed(1)}, 0.0, 1.0);
  color = vec4(aetiRamp_color(t), ${MODULE_NAME}.opacity);
`,
  },
  uniformTypes: { opacity: "f32" },
  getUniforms: (props: Partial<AetiRampProps>) => ({ opacity: props.opacity ?? 1 }),
} as const satisfies ShaderModule<AetiRampProps>;
