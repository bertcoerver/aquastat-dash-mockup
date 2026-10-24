import { MVTLayer } from "@deck.gl/geo-layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import type { Color } from "../theme";
import { localTiles, ignoreMissingTile } from "./tile-urls";

/** The UN boundary line types (bdytyp) in the tiles; scripts/build-tiles.sh lists them. */
type BoundaryProperties = { bdytyp: number };

/**
 * Dash and gap lengths, in line widths, after FAO's style for these lines: disputed
 * lines (special boundaries, armistice lines and undetermined boundaries) dashed,
 * other lines of separation dotted, autonomous regions finely dashed. [0, 0] is solid.
 * (deck.gl dashes take one dash and one gap, so the special boundary's dash-dot is a dash.)
 */
const DASHES: Record<number, [number, number]> = {
  2: [5, 2.5],
  3: [5, 2.5],
  4: [1.5, 2],
  8: [3, 2],
};

/** Lines inside a country (autonomous regions, sovereign bases): drawn thinner. */
const MINOR = new Set([8, 9]);

/**
 * Country borders and coastlines: the UN boundary lines, the ones FAO's maps draw, with
 * disputed lines dashed. Lines (not stroked polygons), because tiles cut polygons at
 * their edges and a stroke would outline every cut. Opaque, because neighbouring line
 * tiles overlap slightly and a translucent colour would show the overlap.
 */
export function bordersLayer({ color, visible }: { color: Color; visible: boolean }) {
  return new MVTLayer({
    id: "borders",
    data: localTiles("borders"),
    visible,
    minZoom: 0,
    maxZoom: 5,
    onTileError: ignoreMissingTile,
    getLineColor: color,
    // Sized in metres so borders thicken as you zoom in, clamped to stay legible.
    getLineWidth: (f: { properties: BoundaryProperties }) => (MINOR.has(f.properties.bdytyp) ? 5_000 : 10_000),
    lineWidthMinPixels: 0.6,
    lineWidthMaxPixels: 2.5,
    lineJointRounded: true,
    // Dashes run on along each line ("path"), not restarting at every vertex.
    extensions: [new PathStyleExtension({ dashMode: "path" })],
    getDashArray: (f: { properties: BoundaryProperties }) => DASHES[f.properties.bdytyp] ?? [0, 0],
    dashJustified: true,
    // The lines lie on the globe surface, coplanar with MapLibre's sphere: skip the
    // depth test (the GlobeView still culls the far side). visgl/deck.gl#9592
    parameters: { depthCompare: "always" },
  });
}
