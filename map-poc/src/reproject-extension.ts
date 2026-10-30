/*
 * Draws any deck.gl layer in the flat map's projection. deck.gl projects lon/lat to Web
 * Mercator in every layer's vertex shader (project_position); this extension, added to
 * every layer, then moves the vertex by the difference between where the chosen
 * projection puts its anchor (geometry.worldPosition, in lon/lat) and where Mercator
 * put it. Offsets from the anchor (a circle's radius in pixels, a bar's height, a line's
 * width) come along unchanged, so pixel sizes stay pixel sizes.
 *
 * Zoomed in (from zoom 12), deck.gl keeps positions relative to the view's centre, for
 * precision (its "offset mode"); the same difference is then taken relative to the
 * centre, so the map stays sharp as far in as the globe goes.
 *
 * What's drawn is only as curved as its vertices: ProjectedViewport sets `resolution`
 * so deck.gl subdivides polygons, paths and bitmaps, and the tiles are dense anyway.
 *
 * The layers that project in shaders of their own (the rain, vapour, haze and river
 * particles) include the same module and call rp_reprojected (REPROJECT_GLSL below) on
 * what project_position gives them.
 *
 * The projection (and the one it's morphing from) are module state, not layer props,
 * so the tile layers' sublayers need no prop plumbing; the map redraws on change. On the
 * globe (setReprojection(null)) the module leaves every position as it is.
 */
import { LayerExtension, type Layer } from "@deck.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";
import { globeDistance, globeScale, PROJECTIONS_GLSL, type Projection } from "./projections";

const current: { from: Projection | null; to: Projection | null; t: number; center: [number, number]; zoom: number; height: number } = {
  from: null,
  to: null,
  t: 1,
  center: [0, 0],
  zoom: 0,
  height: 1,
};

/** The projection to draw in (null: the globe, nothing moved); `t` < 1: a morph from `from`, `t` of the way. */
export function setReprojection(to: Projection | null, from = to, t = 1) {
  current.from = from;
  current.to = to;
  current.t = t;
}

/** The view: its centre in degrees, zoom and height in pixels (the globe is seen from above the centre, in perspective). */
export function setReprojectionView(center: [number, number], zoom: number, height: number) {
  current.center = center;
  current.zoom = zoom;
  current.height = height;
}

export type ReprojectProps = { from: number; to: number; t: number; enabled: number; center: [number, number]; globeScale: number; globeDistance: number; globe: number };

/** The module's uniforms as set now (for the layers with shaders of their own). */
export const reprojectUniforms = (): ReprojectProps => {
  const { from, to, t, center, zoom, height } = current;
  const rad = Math.PI / 180;
  return {
    from: from?.glslId ?? 0,
    to: to?.glslId ?? 0,
    t,
    enabled: to ? 1 : 0,
    center: [center[0] * rad, center[1] * rad],
    globeScale: globeScale(center[1]),
    globeDistance: globeDistance(height, zoom, center[1]),
    // How much of the blend is the globe: the far side fades by as much.
    globe: (to?.centred ? t : 0) + (from?.centred ? 1 - t : 0),
  };
};

export const reprojectModule: ShaderModule<ReprojectProps> = {
  name: "reproject",
  vs: /* glsl */ `
layout(std140) uniform reprojectUniforms {
  int from;
  int to;
  float t;
  int enabled;
  vec2 center;
  float globeScale;
  float globeDistance;
  float globe;
} reproject;
${PROJECTIONS_GLSL}
// Degrees → common space (deck.gl's Mercator world is 512 units wide at zoom 0).
vec2 rp_forward(vec2 lnglat) {
  vec2 lp = radians(lnglat);
  vec2 p = rp_raw(reproject.to, lp);
  if (reproject.t < 1.0) p = mix(rp_raw(reproject.from, lp), p, reproject.t);
  return p * RP_SCALE;
}
// Where project_position put a lon/lat: in Web Mercator, or, zoomed in (deck.gl's
// offset mode), relative to the view's centre, linearised near it as deck.gl does.
vec2 rp_deck(vec2 lnglat) {
  if (project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET) {
    if (abs(lnglat.y - project.coordinateOrigin.y) > 0.25) return project_mercator_(lnglat) - project.commonOrigin.xy;
    vec2 d = lnglat - project.coordinateOrigin.xy;
    return d * (project.commonUnitsPerWorldUnit.xy + project.commonUnitsPerWorldUnit2.xy * d.y);
  }
  return project_mercator_(lnglat);
}
// Where the map's projection puts it, in the same frame.
vec2 rp_target(vec2 lnglat) {
  vec2 p = rp_forward(lnglat);
  if (project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET) p -= project.commonOrigin.xy;
  return p;
}
// A common-space position (project_position's) moved from where Web Mercator put its
// anchor, lon/lat \`lnglat\`, to where the map's projection does; as it is on the globe.
vec4 rp_reprojected(vec4 pos, vec2 lnglat) {
  if (reproject.enabled == 0) return pos;
  pos.xy += rp_target(lnglat) - rp_deck(lnglat);
  return pos;
}
// project_position_to_clipspace (no offset) in the map's projection.
vec4 rp_project_to_clipspace(vec3 position) {
  return project_common_position_to_clipspace(rp_reprojected(vec4(project_position(position), 1.0), position.xy));
}
// How much of a point at \`lnglat\` shows: all of it on a flat map; on the globe, nothing
// of the far side, and while the map morphs to or from the globe, the far side fades
// as the map folds (so the fold doesn't show through).
float rp_visibility(vec2 lnglat) {
  if (reproject.globe <= 0.0) return 1.0;
  // (Behind the rim: past what the camera sees, 1/distance towards it from the middle.)
  float behind = max(0.0, 1.0 / reproject.globeDistance - rp_turned(radians(lnglat), reproject.center).x);
  // (A soft fade while folding, a crisp rim once it's the globe.)
  return 1.0 - smoothstep(0.0, mix(0.08, 0.002, reproject.globe), reproject.globe * behind);
}
`,
  uniformTypes: { from: "i32", to: "i32", t: "f32", enabled: "i32", center: "vec2<f32>", globeScale: "f32", globeDistance: "f32", globe: "f32" },
};

const inject = {
  "vs:#decl": /* glsl */ `
out float rp_alpha;
`,
  "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  rp_alpha = 1.0;
  if (reproject.enabled != 0) {
    position = project_common_position_to_clipspace(rp_reprojected(geometry.position, geometry.worldPosition.xy));
    rp_alpha = rp_visibility(geometry.worldPosition.xy);
  }
`,
  "fs:#decl": /* glsl */ `
in float rp_alpha;
`,
  "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  if (rp_alpha < 0.01) discard;
  color.a *= rp_alpha;
`,
};

export class ReprojectExtension extends LayerExtension {
  static extensionName = "ReprojectExtension";

  getShaders() {
    return { modules: [reprojectModule], inject };
  }

  draw(this: Layer) {
    this.setShaderModuleProps({ reproject: reprojectUniforms() });
  }
}
