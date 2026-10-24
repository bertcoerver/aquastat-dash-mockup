import { MVTLayer } from "@deck.gl/geo-layers";
import type { Feature } from "geojson";
import type { Color } from "../theme";
import { FAO_TILES, ignoreMissingTile } from "./tile-urls";

interface RiverProperties {
  SUBBAS_ID: number;
  Strahler: number; // stream order, 1 (headwater) to 7 (largest rivers)
}

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

/** Rivers, wider for higher stream (Strahler) order. */
export function riversLayer({ color, visible }: { color: Color; visible: boolean }) {
  return new MVTLayer<RiverProperties>({
    id: "rivers",
    data: FAO_TILES.rivers,
    visible,
    minZoom: 0,
    maxZoom: 8,
    onTileError: ignoreMissingTile,
    uniqueIdProperty: "SUBBAS_ID",
    getLineColor: color,
    // 250 m per Strahler order, so small streams fade out as you zoom out.
    getLineWidth: (f: Feature) => (f.properties as RiverProperties).Strahler,
    lineWidthUnits: "meters",
    lineWidthScale: 250,
    lineJointRounded: true,
    lineCapRounded: true,
    parameters: { depthCompare: "always" },
  });
}
