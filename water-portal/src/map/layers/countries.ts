import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { MVTLayer, type GeoBoundingBox } from "@deck.gl/geo-layers";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Feature, Position } from "geojson";
import type { Color } from "../theme";
import { LOCAL_BOUNDS, geoBounds, tileOutlines } from "./basins";
import { localTiles, ignoreMissingTile } from "./tile-urls";

export interface CountryProperties {
  m49: number;
  name: string;
}

/**
 * Country areas, filled with the land colour. With no basemap this is the land, and
 * it's what a click on the map hits. The borders are a separate layer (borders.ts).
 * The selected country (by M49 code) is filled with `selectedColor`, unless the
 * countries have their own colours (`fills`: the Country view's map), which `key`
 * names (deck.gl only redraws the colours when it changes).
 */
export function countriesLayer({
  color,
  selected,
  selectedColor,
  visible,
  fills,
}: {
  color: Color;
  selected: number | null;
  selectedColor: Color;
  visible: boolean;
  fills?: { key: string; colors: Map<number, Color> };
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
    getFillColor: fills ? (f: { properties: CountryProperties }) => fills.colors.get(f.properties.m49) ?? color : color,
    updateTriggers: { getFillColor: fills?.key },
    uniqueIdProperty: "m49",
    highlightedFeatureId: fills ? null : selected,
    highlightColor: selectedColor,
    parameters: { depthCompare: "always" },
  });
}

/** A thick outline around one country (by M49 code), drawn like the basin outlines. */
export function countryOutlineLayer({ m49, color, visible }: { m49: number | null; color: Color; visible: boolean }) {
  return new MVTLayer<CountryProperties>({
    id: "m49-outlined",
    data: localTiles("m49"),
    visible: visible && m49 !== null,
    minZoom: 0,
    maxZoom: 5,
    onTileError: ignoreMissingTile,
    parameters: { depthCompare: "always" as const },
    updateTriggers: { renderSubLayers: m49 },
    renderSubLayers: (props) => {
      const features = ((props.data as Feature[] | null) ?? []).filter((f) => f.properties?.m49 === m49);
      const local = props.coordinateSystem === COORDINATE_SYSTEM.CARTESIAN;
      return new PathLayer<Position[]>({
        ...props,
        id: `${props.id}-path`,
        data: tileOutlines(features, local ? LOCAL_BOUNDS : geoBounds(props.tile.bbox as GeoBoundingBox)),
        pickable: false,
        getPath: (path) => path as [number, number][],
        getColor: color,
        getWidth: 2,
        widthUnits: "pixels",
        jointRounded: true,
      });
    },
  });
}

export interface CountrySymbol {
  position: [number, number];
  /** In pixels. */
  radius: number;
  fill: Color;
  line: Color;
}

/** Circles on countries: proportional symbols, and rings that mark countries. */
export function countrySymbolsLayer({ symbols }: { symbols: { key: string; items: CountrySymbol[] } | null }) {
  return new ScatterplotLayer<CountrySymbol>({
    id: "m49-symbols",
    data: symbols?.items ?? [],
    visible: Boolean(symbols),
    getPosition: (s) => s.position,
    radiusUnits: "pixels",
    getRadius: (s) => s.radius,
    stroked: true,
    getFillColor: (s) => s.fill,
    getLineColor: (s) => s.line,
    lineWidthUnits: "pixels",
    getLineWidth: 1.5,
    updateTriggers: { getRadius: symbols?.key, getFillColor: symbols?.key, getLineColor: symbols?.key },
    parameters: { depthCompare: "always" },
  });
}
