/*
 * Draws any deck.gl layer in the map's projection. deck.gl projects lon/lat to Web
 * Mercator in every layer's vertex shader (project_position); this extension, added to
 * every layer, then moves the vertex by the difference between where the chosen
 * projection puts its anchor (geometry.worldPosition, in lon/lat) and where Mercator
 * put it. Offsets from the anchor (a circle's radius in pixels, a bar's height, a line's
 * width) come along unchanged, so pixel sizes stay pixel sizes.
 *
 * What's drawn is only as curved as its vertices: ProjectedViewport sets `resolution`
 * so deck.gl subdivides polygons, paths and bitmaps, and the tiles are dense anyway.
 *
 * The projection (and the one it's morphing from) are module state, not layer props,
 * so the tile layers' sublayers need no prop plumbing; the map redraws on change.
 */
import { LayerExtension, type Layer } from "@deck.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { PROJECTIONS_GLSL, projectionById, type Projection } from "./projections";

const current = { from: projectionById("robinson"), to: projectionById("robinson"), t: 1 };

/** The projection to draw in; `t` < 1: a morph from `from`, `t` of the way. */
export function setReprojection(to: Projection, from = to, t = 1) {
  current.from = from;
  current.to = to;
  current.t = t;
}

type ReprojectProps = { from: number; to: number; t: number };

const module: ShaderModule<ReprojectProps> = {
  name: "reproject",
  vs: /* glsl */ `
layout(std140) uniform reprojectUniforms {
  int from;
  int to;
  float t;
} reproject;
${PROJECTIONS_GLSL}
// Degrees → common space (deck.gl's Mercator world is 512 units wide at zoom 0).
vec2 rp_forward(vec2 lnglat) {
  vec2 lp = radians(lnglat);
  vec2 p = rp_raw(reproject.to, lp);
  if (reproject.t < 1.0) p = mix(rp_raw(reproject.from, lp), p, reproject.t);
  return p * RP_SCALE;
}
`,
  uniformTypes: { from: "i32", to: "i32", t: "f32" },
};

const inject = {
  "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  {
    vec2 rp_mercator = project_mercator_(geometry.worldPosition.xy);
    vec2 rp_target = rp_forward(geometry.worldPosition.xy);
    vec4 rp_common = geometry.position;
    rp_common.xy += rp_target - rp_mercator;
    position = project_common_position_to_clipspace(rp_common);
  }
`,
};

export class ReprojectExtension extends LayerExtension {
  static extensionName = "ReprojectExtension";

  getShaders() {
    return { modules: [module], inject };
  }

  draw(this: Layer) {
    this.setShaderModuleProps({ reproject: { from: current.from.glslId, to: current.to.glslId, t: current.t } });
  }
}
