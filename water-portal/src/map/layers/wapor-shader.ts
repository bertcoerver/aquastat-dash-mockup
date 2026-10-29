import type { ShaderModule } from "@luma.gl/shadertools";

/** The most stops a colour map can have (WaPOR's PCP-M and PCP-A have 11). */
export const MAX_STOPS = 12;

/** A WaPOR colour map: 2 to MAX_STOPS stops, rising, and a colour for each. */
export interface WaporRamp {
  quantities: number[];
  colors: string[];
}

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

export type AetiRampProps = {
  /** The stops, four at a time (the last repeated after the ramp's own). */
  q0: Vec4;
  q1: Vec4;
  q2: Vec4;
  c0: Vec3;
  c1: Vec3;
  c2: Vec3;
  c3: Vec3;
  c4: Vec3;
  c5: Vec3;
  c6: Vec3;
  c7: Vec3;
  c8: Vec3;
  c9: Vec3;
  c10: Vec3;
  c11: Vec3;
  /** Hide pixels whose NDVI quality (in color.g) is a longer gap than this; -1: none. */
  maxGap: number;
  /** 1: negative values are shown too (a signed variable); 0: dropped. */
  signed: number;
};

const rgb = (hex: string): Vec3 => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** A value's colour, as the shader gives it (aetiRamp_color), as CSS. */
export function rampColor({ quantities: q, colors }: WaporRamp, v: number) {
  const c = colors.map(rgb);
  let mixed = c[c.length - 1];
  if (v <= q[0]) mixed = c[0];
  else {
    const i = q.findIndex((stop) => v < stop);
    if (i > 0) mixed = c[i - 1].map((a, k) => a + (c[i][k] - a) * ((v - q[i - 1]) / (q[i] - q[i - 1]))) as Vec3;
  }
  return `rgb(${mixed.map((x) => Math.round(x * 255)).join(" ")})`;
}

/** Stops past a ramp's last are its last again: the shader never mixes towards them. */
export function rampProps({ quantities, colors }: WaporRamp, maxGap: number | null = null, signed = false): AetiRampProps {
  const at = (i: number) => Math.min(i, quantities.length - 1);
  const q = Array.from({ length: MAX_STOPS }, (_, i) => quantities[at(i)]);
  const c = Array.from({ length: MAX_STOPS }, (_, i) => rgb(colors[at(i)]));
  return {
    q0: [q[0], q[1], q[2], q[3]],
    q1: [q[4], q[5], q[6], q[7]],
    q2: [q[8], q[9], q[10], q[11]],
    c0: c[0],
    c1: c[1],
    c2: c[2],
    c3: c[3],
    c4: c[4],
    c5: c[5],
    c6: c[6],
    c7: c[7],
    c8: c[8],
    c9: c[9],
    c10: c[10],
    c11: c[11],
    maxGap: maxGap ?? -1,
    signed: signed ? 1 : 0,
  };
}

const COLORS = Array.from({ length: MAX_STOPS }, (_, i) => `c${i}`);

const MODULE_NAME = "aetiRamp";

/**
 * Colours a single-band WaPOR raster, which MultiCOGLayer puts in color.r as raw
 * values: linear between the stops, clamped outside them. Nodata (-9999), any other
 * negative value and NaN are dropped; a signed variable's negative values are kept.
 *
 * With a quality mask, color.g holds L1-QUAL-NDVI-D: dekads since the last valid
 * observation, as a byte read normalised to 0-1. Pixels with a longer gap are dropped,
 * and so are those without a quality value (255). Without the quality band g is 0.
 */
export const AetiRamp = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  vec4 q0;
  vec4 q1;
  vec4 q2;
${COLORS.map((c) => `  vec3 ${c};`).join("\n")}
  float maxGap;
  float signed;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": /* glsl */ `
vec3 aetiRamp_color(float v) {
  vec4 q0 = ${MODULE_NAME}.q0;
  vec4 q1 = ${MODULE_NAME}.q1;
  vec4 q2 = ${MODULE_NAME}.q2;
  float q[${MAX_STOPS}] = float[${MAX_STOPS}](q0.x, q0.y, q0.z, q0.w, q1.x, q1.y, q1.z, q1.w, q2.x, q2.y, q2.z, q2.w);
  vec3 c[${MAX_STOPS}] = vec3[${MAX_STOPS}](${COLORS.map((c) => `${MODULE_NAME}.${c}`).join(", ")});
  if (v <= q[0]) return c[0];
  for (int i = 1; i < ${MAX_STOPS}; i++) {
    if (v < q[i]) return mix(c[i - 1], c[i], (v - q[i - 1]) / (q[i] - q[i - 1]));
  }
  return c[${MAX_STOPS - 1}];
}
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  float value = color.r;
  // Also catches NaN, which fails every comparison.
  if (!(value >= 0.0) && !(${MODULE_NAME}.signed > 0.5 && value < 0.0)) discard;
  if (${MODULE_NAME}.maxGap >= 0.0 && floor(color.g * 255.0 + 0.5) > ${MODULE_NAME}.maxGap) discard;
  color = vec4(aetiRamp_color(value), 1.0);
`,
  },
  uniformTypes: {
    q0: "vec4<f32>",
    q1: "vec4<f32>",
    q2: "vec4<f32>",
    c0: "vec3<f32>",
    c1: "vec3<f32>",
    c2: "vec3<f32>",
    c3: "vec3<f32>",
    c4: "vec3<f32>",
    c5: "vec3<f32>",
    c6: "vec3<f32>",
    c7: "vec3<f32>",
    c8: "vec3<f32>",
    c9: "vec3<f32>",
    c10: "vec3<f32>",
    c11: "vec3<f32>",
    maxGap: "f32",
    signed: "f32",
  },
  getUniforms: (props: Partial<AetiRampProps>) => props,
} as const satisfies ShaderModule<AetiRampProps>;
