import { MVTLayer } from "@deck.gl/geo-layers";
import type { Color } from "../theme";
import { localTiles, ignoreMissingTile } from "./tile-urls";

/**
 * Country borders. Lines (not stroked polygons), because tiles cut polygons at their
 * edges and a stroke would outline every cut. Opaque, because neighbouring line tiles
 * overlap slightly and a translucent colour would show the overlap.
 */
export function bordersLayer({ color, visible }: { color: Color; visible: boolean }) {
  return new MVTLayer({
    id: "m49-borders",
    data: localTiles("m49-borders"),
    visible,
    minZoom: 0,
    maxZoom: 5,
    onTileError: ignoreMissingTile,
    getLineColor: color,
    // Sized in metres so borders thicken as you zoom in, clamped to stay legible.
    getLineWidth: 10_000,
    lineWidthMinPixels: 0.6,
    lineWidthMaxPixels: 2.5,
    lineJointRounded: true,
    // The lines lie on the globe surface, coplanar with MapLibre's sphere: skip the
    // depth test (the GlobeView still culls the far side). visgl/deck.gl#9592
    parameters: { depthCompare: "always" },
  });
}
