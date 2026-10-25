import type { ShaderModule } from "@luma.gl/shadertools";

/** A WaPOR colour map: five stops, in raw raster values (before the 0.1 scale). */
export interface WaporRamp {
  quantities: [number, number, number, number, number];
  colors: [string, string, string, string, string];
}

type Vec3 = [number, number, number];

export type AetiRampProps = {
  /** First four stops, and the last. */
  q0123: [number, number, number, number];
  q4: number;
  c0: Vec3;
  c1: Vec3;
  c2: Vec3;
  c3: Vec3;
  c4: Vec3;
  /** Hide pixels whose NDVI quality (in color.g) is a longer gap than this; -1: none. */
  maxGap: number;
  /** 1: negative values are shown too (a signed variable); 0: dropped. */
  signed: number;
};

const rgb = (hex: string): Vec3 => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const rampProps = ({ quantities: q, colors: c }: WaporRamp, maxGap: number | null = null, signed = false): AetiRampProps => ({
  q0123: [q[0], q[1], q[2], q[3]],
  q4: q[4],
  c0: rgb(c[0]),
  c1: rgb(c[1]),
  c2: rgb(c[2]),
  c3: rgb(c[3]),
  c4: rgb(c[4]),
  maxGap: maxGap ?? -1,
  signed: signed ? 1 : 0,
});

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
  vec4 q0123;
  float q4;
  vec3 c0;
  vec3 c1;
  vec3 c2;
  vec3 c3;
  vec3 c4;
  float maxGap;
  float signed;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": /* glsl */ `
vec3 aetiRamp_color(float v) {
  vec4 q = ${MODULE_NAME}.q0123;
  if (v <= q.x) return ${MODULE_NAME}.c0;
  if (v < q.y) return mix(${MODULE_NAME}.c0, ${MODULE_NAME}.c1, (v - q.x) / (q.y - q.x));
  if (v < q.z) return mix(${MODULE_NAME}.c1, ${MODULE_NAME}.c2, (v - q.y) / (q.z - q.y));
  if (v < q.w) return mix(${MODULE_NAME}.c2, ${MODULE_NAME}.c3, (v - q.z) / (q.w - q.z));
  if (v < ${MODULE_NAME}.q4) return mix(${MODULE_NAME}.c3, ${MODULE_NAME}.c4, (v - q.w) / (${MODULE_NAME}.q4 - q.w));
  return ${MODULE_NAME}.c4;
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
    q0123: "vec4<f32>",
    q4: "f32",
    c0: "vec3<f32>",
    c1: "vec3<f32>",
    c2: "vec3<f32>",
    c3: "vec3<f32>",
    c4: "vec3<f32>",
    maxGap: "f32",
    signed: "f32",
  },
  getUniforms: (props: Partial<AetiRampProps>) => props,
} as const satisfies ShaderModule<AetiRampProps>;
