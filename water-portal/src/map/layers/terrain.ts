import { LayerExtension } from "@deck.gl/core";
import { TerrainLayer } from "@deck.gl/geo-layers";
import type { Color } from "../theme";

/** AWS Open Data terrain tiles (Mapzen terrarium encoding), up to zoom 15. CORS: *. */
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_MAX_ZOOM = 15;
const EXAGGERATION = 1.5;

/**
 * Terrarium: height = (r * 256 + g + b / 256) - 32768 metres, here times the
 * exaggeration. TerrainLayer reloads every tile when it gets a new decoder object, so
 * there's one.
 */
const DECODER = {
  rScaler: 256 * EXAGGERATION,
  gScaler: EXAGGERATION,
  bScaler: EXAGGERATION / 256,
  offset: -32768 * EXAGGERATION,
};

/**
 * Shades the relief from the north-west, relative to flat ground: flat ground (the
 * sea, plains) keeps exactly the colour draped on it, slopes facing the light are
 * lighter, slopes facing away darker. In place of deck.gl's lighting, which shades
 * flat ground too, differently across the globe, with a highlight. The normal comes
 * from the mesh (as SimpleMeshLayer's flat shading does it), "up" from the globe.
 */
class HillshadeExtension extends LayerExtension {
  static extensionName = "HillshadeExtension";

  getShaders() {
    return {
      inject: {
        "vs:#decl": /* glsl */ `
out vec3 hillshade_up;
out vec3 hillshade_east;
`,
        "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  bool hillshade_globe = project.projectionMode == PROJECTION_MODE_GLOBE;
  hillshade_up = hillshade_globe ? normalize(geometry.position.xyz) : vec3(0.0, 0.0, 1.0);
  hillshade_east = hillshade_globe ? normalize(cross(vec3(0.0, 0.0, 1.0), hillshade_up)) : vec3(1.0, 0.0, 0.0);
`,
        "fs:#decl": /* glsl */ `
in vec3 hillshade_up;
in vec3 hillshade_east;
`,
        "fs:#main-end": /* glsl */ `
  // (prefixed: main() has a "normal" of its own)
  vec3 hillshade_u = normalize(hillshade_up);
  vec3 hillshade_e = normalize(hillshade_east);
  vec3 hillshade_light = normalize(hillshade_u + 0.8 * (cross(hillshade_u, hillshade_e) - hillshade_e));
  vec3 hillshade_n = normalize(cross(dFdx(position_commonspace.xyz), dFdy(position_commonspace.xyz)));
  if (dot(hillshade_n, hillshade_u) < 0.0) hillshade_n = -hillshade_n;
  float hillshade = mix(1.0, dot(hillshade_n, hillshade_light) / dot(hillshade_u, hillshade_light), 0.8);
  fragColor.rgb *= clamp(hillshade, 0.45, 1.25);
`,
      },
    };
  }
}
const HILLSHADE = new HillshadeExtension();

/**
 * The relief, as terrain-poc showed it: deck.gl draws the terrain itself, and the
 * other layers are draped on it with TerrainExtension (map.ts). MapLibre's own terrain
 * wouldn't do: deck.gl layers don't follow it. The mesh is drawn in `color` wherever
 * nothing is draped: the sea, kept flat (the tiles have the sea floor's depth).
 */
export function terrainLayer({ color }: { color: Color }) {
  return new TerrainLayer({
    id: "terrain",
    elevationData: DEM_TILES,
    elevationDecoder: DECODER,
    color: color.slice(0, 3) as [number, number, number],
    // Unlit: only the (full) ambient light, so the colours come out as they went in.
    // (`material: false` falls back to the default material, lit.)
    material: { ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] },
    extensions: [HILLSHADE],
    minZoom: 0,
    maxZoom: DEM_MAX_ZOOM,
    meshMaxError: 4,
    // terrain: the draped layers' TerrainExtension reads heights from it; draw: show it.
    operation: "terrain+draw",
    onTileError: () => {},
    // The mesh (lon, lat, metres) before it's drawn: the sea floor up to sea level.
    onTileLoad: (tile) => {
      // (typed as MeshAttributes, though it's the loaders.gl mesh)
      const [mesh] = tile.content as unknown as [{ attributes: { POSITION: { value: Float32Array } } } | null];
      const positions = mesh?.attributes.POSITION.value;
      if (positions) for (let i = 2; i < positions.length; i += 3) positions[i] = Math.max(0, positions[i]);
    },
  });
}
