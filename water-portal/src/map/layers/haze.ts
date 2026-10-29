/*
 * HazeLayer: a heat shimmer over the map, as strong as an evapotranspiration grid says
 * (from river-flow-poc's evapotranspiration page).
 *
 * It copies what's been drawn so far (the basemap and the deck.gl layers before it) into
 * a texture, then draws the part of the grid in view again from that copy with each
 * pixel shifted a little: by ripples that rise up the screen, broken up by noise, the
 * shift growing with the grid's value there. So the map wobbles as if seen through warm,
 * moist air, where water goes up, and stays still where none does.
 *
 * The copy is the canvas MapLibre and deck.gl share (interleaved), made with WebGL
 * directly: luma.gl can't copy from the canvas it was handed. The part in view is a
 * mesh of cells, so it follows the globe's curve.
 */
import type { DefaultProps, LayerContext } from "@deck.gl/core";
import type { RenderPass, Texture } from "@luma.gl/core";
import { Geometry } from "@luma.gl/engine";
import { GRID_GLSL, GridEffectLayer, MERCATOR_GLSL, OVERWRITE, clock, uniformBlock, type EffectGrid, type GridEffectState } from "./effects-common";

export type HazeLayerProps = {
  grid: EffectGrid;
  /** Largest shift, CSS pixels (where the grid is at `reference` or more). */
  strength: number;
  /** Grid value (0–255) of the full shimmer; below it, it shrinks as value^gamma. */
  reference: number;
  gamma: number;
};

const hazeUniforms = uniformBlock("haze", {
  region: "vec4<f32>",
  gridBounds: "vec4<f32>",
  sceneSize: "vec2<f32>",
  time: "f32",
  strength: "f32",
  dpr: "f32",
  reference: "f32",
  gamma: "f32",
});

const HAZE_VS = `\
#version 300 es
#define SHADER_NAME haze-vs
in vec2 corners;
out vec2 vMercator;
out float vFacing;
${MERCATOR_GLSL}
void main() {
  // The region's mesh, in Web Mercator (0–1, y down), on the map.
  vMercator = haze.region.xy + corners * haze.region.zw;
  vec3 position = vec3(mercatorToLngLat(vMercator), 0.0);
  // Beyond the horizon on the globe (see horizon.ts).
  vFacing = project.projectionMode == PROJECTION_MODE_GLOBE
    ? dot(normalize(project_position(position, vec3(0.0))), project.cameraPosition) - GLOBE_RADIUS
    : 1.0;
  gl_Position = project_position_to_clipspace(position, vec3(0.0), vec3(0.0));
}`;

const HAZE_FS = `\
#version 300 es
#define SHADER_NAME haze-fs
precision highp float;
uniform sampler2D uGrid;
uniform sampler2D uScene;
in vec2 vMercator;
in float vFacing;
out vec4 fragColor;
${MERCATOR_GLSL}
${GRID_GLSL}

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
  if (vFacing < 0.0) discard;
  vec2 uv = gridUv(haze.gridBounds, mercatorToLngLat(vMercator));
  if (!inGrid(uv)) discard;
  float value = texture(uGrid, uv).r * 255.0;
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
  // A touch brighter on the crests, so it shows on a dark map too.
  scene.rgb += 0.025 * amount * gusts * max(ripple, 0.0);
  fragColor = scene;
}`;

/** Cells of the mesh across and down. */
const MESH = 48;

/** A MESH × MESH mesh of the unit square, as triangles. */
function meshCorners() {
  const out = new Float32Array(MESH * MESH * 12);
  let k = 0;
  for (let j = 0; j < MESH; j++) {
    for (let i = 0; i < MESH; i++) {
      const [x0, x1, y0, y1] = [i / MESH, (i + 1) / MESH, j / MESH, (j + 1) / MESH];
      out.set([x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1], k);
      k += 12;
    }
  }
  return out;
}

const defaultProps: DefaultProps<HazeLayerProps> = {
  strength: 2,
  reference: 128,
  gamma: 0.8,
};

export class HazeLayer extends GridEffectLayer<HazeLayerProps> {
  static layerName = "HazeLayer";
  static defaultProps = defaultProps;
  /** The copy of the canvas, besides the model and the grid's texture. */
  declare state: GridEffectState & { scene: Texture | null };

  protected shaders() {
    return {
      vs: HAZE_VS,
      fs: HAZE_FS,
      modules: [hazeUniforms],
      geometry: new Geometry({ topology: "triangle-list", attributes: { corners: { size: 2, value: meshCorners() } } }),
      parameters: OVERWRITE,
    };
  }

  initializeState(context: LayerContext) {
    super.initializeState(context);
    this.setState({ scene: null });
  }

  finalizeState(context: LayerContext) {
    super.finalizeState(context);
    this.state.scene?.destroy();
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
    const f = this.frame();
    if (!f || p.strength <= 0) return;
    const scene = this.copyScene();

    s.model.setBindings({ uGrid: s.texture!, uScene: scene });
    s.model.shaderInputs.setProps({
      haze: {
        region: f.region,
        gridBounds: p.grid.bounds,
        sceneSize: [scene.width, scene.height],
        time: clock(),
        strength: p.strength,
        dpr: f.dpr,
        reference: p.reference,
        gamma: p.gamma,
      },
    });
    s.model.setParameters(OVERWRITE);
    s.model.draw(renderPass);
  }
}
