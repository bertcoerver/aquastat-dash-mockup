import { MVTLayer } from "@deck.gl/geo-layers";
import type { Feature } from "geojson";
import type { Color } from "../theme";
import { FAO_TILES, ignoreMissingTile } from "./tile-urls";

interface RiverProperties {
  SUBBAS_ID: number;
  Strahler: number; // stream order, 1 (headwater) to 7 (largest rivers)
}

/** The zoom from which the rivers are drawn. */
const RIVERS_MIN_ZOOM = 5;

/** HydroLAKES lake polygons. Opaque: the tiles overlap a little at their edges. */
export function lakesLayer({ color, visible }: { color: Color; visible: boolean }) {
  return new MVTLayer({
    id: "lakes",
    data: FAO_TILES.lakes,
    visible,
    minZoom: 0,
    maxZoom: 8,
    onTileError: ignoreMissingTile,
    stroked: false,
    getFillColor: color,
    parameters: { depthCompare: "always" },
  });
}

/**
 * Rivers, wider for higher stream (Strahler) order. `hidden`: leave out the rivers of
 * these sub-basins (drawn otherwise, as the river discharge map); `key` names the set.
 */
export function riversLayer({ color, visible, hidden }: { color: Color; visible: boolean; hidden?: { key: string; subBasins: Set<number> } }) {
  return new MVTLayer<RiverProperties>({
    id: "rivers",
    data: FAO_TILES.rivers,
    visible,
    // Below this zoom no tiles are loaded: the rivers show only zoomed in.
    minZoom: RIVERS_MIN_ZOOM,
    maxZoom: 8,
    onTileError: ignoreMissingTile,
    uniqueIdProperty: "SUBBAS_ID",
    getLineColor: hidden
      ? (f: Feature) => (hidden.subBasins.has((f.properties as RiverProperties).SUBBAS_ID) ? [0, 0, 0, 0] : color)
      : color,
    updateTriggers: { getLineColor: hidden?.key },
    // 250 m per Strahler order, so small streams fade out as you zoom out.
    getLineWidth: (f: Feature) => (f.properties as RiverProperties).Strahler,
    lineWidthUnits: "meters",
    lineWidthScale: 250,
    lineJointRounded: true,
    lineCapRounded: true,
    parameters: { depthCompare: "always" },
  });
}
