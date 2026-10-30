/*
 * What the effect layers share (rain.ts, vapour.ts, haze.ts; river-particles.ts some of
 * it): a grid of values as a texture, the part of it in view, the clock, the blending
 * parameters, GLSL for random numbers, the globe's far side, Web Mercator and the grid's
 * texture coordinates, a uniform block declared once (from its types), and the layer
 * itself: one model drawn with the grid's texture, made and freed the same way.
 *
 * These layers project in shaders of their own, so they draw in the flat map's
 * projection by including its module (flat/reproject-extension.ts) and projecting
 * through rp_project_to_clipspace; on the globe it leaves positions as they are.
 */
import { Layer, project32, type LayerContext, type UpdateParameters, type Viewport } from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import { Model, type ModelProps } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { reprojectModule, reprojectUniforms } from "../flat/reproject-extension";

/** A grid of values: row 0 north, `channels` bytes a cell (0–255, relative to the layer's reference). */
export interface EffectGrid {
  data: Uint8Array;
  channels: 1 | 2;
  width: number;
  height: number;
  /** [west, south, east, north], degrees (an equirectangular grid). */
  bounds: [number, number, number, number];
}

// --- Uniform blocks ------------------------------------------------------------------

type UType = "f32" | "vec2<f32>" | "vec3<f32>" | "vec4<f32>";
const GLSL_TYPE: Record<UType, string> = { f32: "float", "vec2<f32>": "vec2", "vec3<f32>": "vec3", "vec4<f32>": "vec4" };

/**
 * A shader module that is one uniform block, `name` in the shaders (`name.field`),
 * declared from its uniforms' types in their order (std140: the order matters, and it's
 * written once here rather than three times by hand), in the stages given.
 */
export function uniformBlock(name: string, uniformTypes: Record<string, UType>, stages: ("vs" | "fs")[] = ["vs", "fs"]): ShaderModule {
  const glsl = `layout(std140) uniform ${name}Uniforms {\n${Object.entries(uniformTypes).map(([k, t]) => `  ${GLSL_TYPE[t]} ${k};`).join("\n")}\n} ${name};\n`;
  return { name, ...Object.fromEntries(stages.map((s) => [s, glsl])), uniformTypes };
}

// --- GLSL ----------------------------------------------------------------------------

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

/** Where a point lies in a grid's texture (bounds b: west, south, east, north), and whether it's inside. */
export const GRID_GLSL = `\
vec2 gridUv(vec4 b, vec2 lngLat) {
  return vec2((lngLat.x - b.x) / (b.z - b.x), (b.w - lngLat.y) / (b.w - b.y));
}
bool inGrid(vec2 uv) {
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}
`;

/** A clip-space position on the screen, in pixels from its middle. */
export const SCREEN_GLSL = `\
vec2 toScreen(vec4 clip, vec2 viewportSize) {
  return clip.xy / clip.w * 0.5 * viewportSize;
}
`;

// --- Drawing -------------------------------------------------------------------------

/** Premultiplied alpha over what's drawn, no depth. */
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

/** Written as is, over what's drawn, no depth. */
export const OVERWRITE = { blend: false, depthCompare: "always", depthWriteEnabled: false, cullMode: "none" } as const;

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

/** A colour's channels as 0–1. */
export const unit = ([r, g, b]: [number, number, number]): [number, number, number] => [r / 255, g / 255, b / 255];

// --- The layer -----------------------------------------------------------------------

export type GridEffectState = {
  model: Model;
  /** The grid's texture (made from the grid prop as it changes). */
  texture: Texture | null;
};

/** What a frame draws with: the part of the grid in view, and the screen's scale. */
export interface Frame {
  viewport: Viewport;
  region: [number, number, number, number];
  /** Device pixels per CSS pixel. */
  dpr: number;
  /** Metres per CSS pixel at the ground in the middle of the view. */
  metresPerPixel: number;
}

/**
 * A layer that draws one model over the part of a grid in view, with the grid as a
 * texture (`uGrid`): the subclass gives the model's shaders and parameters (`shaders`)
 * and draws (`draw`); the model and texture are made, kept up to date and freed here.
 */
export abstract class GridEffectLayer<P extends { grid: EffectGrid }> extends Layer<P> {
  static layerName = "GridEffectLayer"; // (each layer names itself; deck.gl asks the base too)
  declare state: GridEffectState;

  /** The model's shaders (the projection module is added) and the rest of its props. */
  protected abstract shaders(): { vs: string; fs: string; modules: ShaderModule[] } & Omit<ModelProps, "vs" | "fs" | "modules">;

  initializeState(context: LayerContext) {
    const { vs, fs, modules, ...rest } = this.shaders();
    const model = new Model(context.device, { ...this.getShaders({ vs, fs, modules: [project32, reprojectModule, ...modules] }), id: `${this.props.id}-model`, ...rest });
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

  /** This frame's view of the grid (null: none of it is in view, or there's no texture yet); the map's projection set for the shaders. */
  protected frame(): Frame | null {
    const viewport = this.context.viewport;
    const region = viewRegion(viewport, this.props.grid.bounds);
    if (!region || !this.state.texture) return null;
    this.state.model.shaderInputs.setProps({ reproject: reprojectUniforms() });
    return { viewport, region, dpr: this.context.device.getDefaultCanvasContext().cssToDeviceRatio(), metresPerPixel: viewport.metersPerPixel };
  }
}
