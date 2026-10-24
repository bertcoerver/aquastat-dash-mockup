import { MVTLayer } from "@deck.gl/geo-layers";
import type { Color } from "../theme";
import { localTiles, ignoreMissingTile } from "./tile-urls";

export interface CountryProperties {
  m49: number;
  name: string;
}

/**
 * Country areas, filled with the land colour. With no basemap this is the land, and
 * it's what a click on the map hits. The borders are a separate layer (borders.ts).
 * The selected country (by M49 code) is filled with `selectedColor`.
 */
export function countriesLayer({
  color,
  selected,
  selectedColor,
  visible,
}: {
  color: Color;
  selected: number | null;
  selectedColor: Color;
  visible: boolean;
}) {
  return new MVTLayer<CountryProperties>({
    id: "m49-countries",
    data: localTiles("m49"),
    visible,
    pickable: visible,
    minZoom: 0,
    maxZoom: 5,
    onTileError: ignoreMissingTile,
    stroked: false,
    getFillColor: color,
    uniqueIdProperty: "m49",
    highlightedFeatureId: selected,
    highlightColor: selectedColor,
    parameters: { depthCompare: "always" },
  });
}
