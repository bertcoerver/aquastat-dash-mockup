import { LayerExtension } from "@deck.gl/core";

/**
 * Hides what lies beyond the horizon on the globe. The layers skip the depth test (they
 * lie on MapLibre's sphere and would fight it), and MapLibre puts the far plane behind
 * the whole globe, so nothing else stops the far side showing through: notably low-zoom
 * tiles, which cover both sides. visgl/deck.gl#9592
 *
 * In common space the globe is a sphere of radius 256 round the origin; a point P on it
 * faces camera C where dot(P̂, C) > 256. That is linear in P, so it can be interpolated
 * from the vertices and tested per fragment. Off the globe (MapLibre switches to
 * Mercator when zoomed in) everything passes.
 */
export class HorizonExtension extends LayerExtension {
  static extensionName = "HorizonExtension";

  getShaders() {
    return {
      inject: {
        "vs:#decl": /* glsl */ `
out float horizon_facing;
`,
        "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  horizon_facing = project.projectionMode == PROJECTION_MODE_GLOBE
    ? dot(normalize(geometry.position.xyz), project.cameraPosition) - GLOBE_RADIUS
    : 1.0;
`,
        "fs:#decl": /* glsl */ `
in float horizon_facing;
`,
        "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  if (horizon_facing < 0.0) discard;
`,
      },
    };
  }
}
