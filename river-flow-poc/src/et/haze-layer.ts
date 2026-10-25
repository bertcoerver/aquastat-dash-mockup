/*
 * HazeLayer: a heat shimmer over the map, as strong as an evapotranspiration grid says.
 *
 * It copies what's been drawn so far (the basemap, its relief, and the deck.gl layers
 * before it) into a texture, then draws the view's land again from that copy with each
 * pixel shifted a little: by ripples that rise up the screen, broken up by noise, the
 * shift growing with the grid's value there. So the map wobbles as if seen through warm,
 * moist air, where water goes up, and stays still where none does.
 *
 * The copy is the canvas MapLibre and deck.gl share (interleaved), made with WebGL
 * directly: luma.gl can't copy from the canvas it was handed.
 */
import { Layer, project32, type DefaultProps, type LayerContext, type UpdateParameters } from "@deck.gl/core";
import type { RenderPass, Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { viewRegion } from "../rain/rain-layer";
import { gridTextures, type VapourGrid } from "./vapour-layer";

export type HazeLayerProps = {
  grid: VapourGrid;
  previous: VapourGrid | null;
  mix: number;
  /** Seconds, for the animation. */
  time: number;
  /** Largest shift, CSS pixels (where the grid is at `reference` or more). */
  strength: number;
  /** Grid value (0–255) of the full shimmer; below it, it shrinks as value^gamma. */
  reference: number;
  gamma: number;
  /** The MapLibre layer it's drawn beneath (MapboxOverlay, interleaved). */
  beforeId?: string;
};

type HazeProps = {
  region: [number, number, number, number];
  gridBounds: [number, number, number, number];
  sceneSize: [number, number];
  time: number;
  strength: number;
  dpr: number;
  reference: number;
  gamma: number;
  mixGrids: number;
};
const HAZE_BLOCK = `\
layout(std140) uniform hazeUniforms {
  vec4 region;
  vec4 gridBounds;
  vec2 sceneSize;
  float time;
  float strength;
  float dpr;
  float reference;
  float gamma;
  float mixGrids;
} haze;
`;
const hazeUniforms = {
  name: "haze",
  vs: HAZE_BLOCK,
  fs: HAZE_BLOCK,
  uniformTypes: {
    region: "vec4<f32>",
    gridBounds: "vec4<f32>",
    sceneSize: "vec2<f32>",
    time: "f32",
    strength: "f32",
    dpr: "f32",
    reference: "f32",
    gamma: "f32",
    mixGrids: "f32",
  },
} as const satisfies ShaderModule<HazeProps>;

const HAZE_VS = `\
#version 300 es
#define SHADER_NAME haze-vs
in vec2 corners;
out vec2 vMercator;
const float HAZE_PI = 3.141592653589793;
void main() {
  // The region's corners, in Web Mercator (0–1, y down): a flat quad on the map.
  vMercator = haze.region.xy + corners * haze.region.zw;
  vec2 lngLat = vec2(vMercator.x * 360.0 - 180.0, degrees(atan(sinh(HAZE_PI * (1.0 - 2.0 * vMercator.y)))));
  gl_Position = project_position_to_clipspace(vec3(lngLat, 0.0), vec3(0.0), vec3(0.0));
}`;

const HAZE_FS = `\
#version 300 es
#define SHADER_NAME haze-fs
precision highp float;
uniform sampler2D uGrid;
uniform sampler2D uPrevious;
uniform sampler2D uScene;
in vec2 vMercator;
out vec4 fragColor;
const float HAZE_PI = 3.141592653589793;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// Smooth noise (0–1).
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  // Lat/lng from the Web Mercator position (interpolated straight on the flat quad).
  float lat = degrees(atan(sinh(HAZE_PI * (1.0 - 2.0 * vMercator.y))));
  vec2 lngLat = vec2(vMercator.x * 360.0 - 180.0, lat);
  vec4 b = haze.gridBounds;
  vec2 uv = vec2((lngLat.x - b.x) / (b.z - b.x), (b.w - lngLat.y) / (b.w - b.y));
  float value = mix(texture(uPrevious, uv).r, texture(uGrid, uv).r, haze.mixGrids) * 255.0;
  float amount = pow(clamp(value / haze.reference, 0.0, 1.0), haze.gamma);
  if (amount < 0.01) discard;

  // Ripples rising up the screen (in CSS pixels), their fronts bent by noise, in patches
  // that drift up and come and go.
  vec2 p = gl_FragCoord.xy / haze.dpr;
  float t = haze.time;
  float bend = noise(vec2(p.x * 0.03, p.y * 0.02 - t * 0.6)) * 8.0;
  float ripple = sin(p.y * 0.22 - t * 6.0 + bend);
  float gusts = smoothstep(0.3, 0.8, noise(vec2(p.x * 0.01 + t * 0.1, p.y * 0.012 - t * 0.4)));
  vec2 shift = vec2(ripple, 0.35 * cos(p.y * 0.17 - t * 4.5 + bend * 1.3)) * (0.25 + 0.75 * gusts);
  vec2 at = (gl_FragCoord.xy + shift * haze.strength * amount * haze.dpr) / haze.sceneSize;
  vec4 scene = texture(uScene, at);
  // A touch brighter on the crests, so it shows on the dark map too.
  scene.rgb += 0.025 * amount * gusts * max(ripple, 0.0);
  fragColor = scene;
}`;

const OPAQUE = {
  blend: false,
  depthCompare: "always",
  depthWriteEnabled: false,
  cullMode: "none",
} as const;

type State = {
  model: Model;
  textures: Map<VapourGrid, Texture>;
  /** The copy of the canvas. */
  scene: Texture | null;
};

const defaultProps: DefaultProps<HazeLayerProps> = {
  previous: null,
  mix: 1,
  time: 0,
  strength: 2,
  reference: 128,
  gamma: 0.8,
};

export class HazeLayer extends Layer<HazeLayerProps> {
  static layerName = "HazeLayer";
  static defaultProps = defaultProps;
  declare state: State;

  initializeState(context: LayerContext) {
    const model = new Model(context.device, {
      ...this.getShaders({ vs: HAZE_VS, fs: HAZE_FS, modules: [project32, hazeUniforms] }),
      id: `${this.props.id}-quad`,
      geometry: new Geometry({
        topology: "triangle-strip",
        attributes: { corners: { size: 2, value: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) } },
      }),
      parameters: OPAQUE,
    });
    this.setState({ model, textures: new Map(), scene: null });
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
    this.state.scene?.destroy();
    for (const texture of this.state.textures?.values() ?? []) texture.destroy();
  }

  /** Copies the canvas drawn so far into the scene texture. */
  private copyScene(): Texture {
    const device = this.context.device;
    const gl = (device as unknown as { gl: WebGL2RenderingContext }).gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    let scene = this.state.scene;
    if (!scene || scene.width !== width || scene.height !== height) {
      scene?.destroy();
      scene = device.createTexture({
        format: "rgba8unorm",
        width,
        height,
        sampler: { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
      });
      this.state.scene = scene;
    }
    gl.bindTexture(gl.TEXTURE_2D, (scene as unknown as { handle: WebGLTexture }).handle);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return scene;
  }

  draw({ renderPass }: { renderPass: RenderPass }) {
    const s = this.state;
    const p = this.props;
    const region = viewRegion(this.context.viewport, p.grid.bounds);
    const grid = s.textures.get(p.grid);
    if (!region || !grid || p.strength <= 0) return;
    const scene = this.copyScene();

    s.model.setBindings({ uGrid: grid, uPrevious: (p.previous && s.textures.get(p.previous)) || grid, uScene: scene });
    s.model.shaderInputs.setProps({
      haze: {
        region,
        gridBounds: p.grid.bounds,
        sceneSize: [scene.width, scene.height],
        time: p.time,
        strength: p.strength,
        dpr: this.context.device.getDefaultCanvasContext().cssToDeviceRatio(),
        reference: p.reference,
        gamma: p.gamma,
        mixGrids: p.previous ? p.mix : 1,
      },
    });
    s.model.setParameters(OPAQUE);
    s.model.draw(renderPass);
  }
}
