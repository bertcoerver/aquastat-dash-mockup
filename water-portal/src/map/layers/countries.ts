import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { MVTLayer, type GeoBoundingBox } from "@deck.gl/geo-layers";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Feature, Position } from "geojson";
import type { Color } from "../theme";
import type { Timing } from "../tween";
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
 * names (deck.gl only redraws the colours when it changes), eased in by `transition`.
 */
export function countriesLayer({
  color,
  selected,
  selectedColor,
  visible,
  fills,
  transition,
}: {
  color: Color;
  selected: number | null;
  selectedColor: Color;
  visible: boolean;
  fills?: { key: string; colors: Map<number, Color> };
  transition?: Timing;
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
    transitions: transition && { getFillColor: transition },
    uniqueIdProperty: "m49",
    highlightedFeatureId: fills ? null : selected,
    highlightColor: selectedColor,
    parameters: { depthCompare: "always" },
  });
}

/** A thick outline around one country (by M49 code), drawn like the basin outlines. */
/** The selected country's outline: a thick line on a contrasting halo, to stand out on any fill. */
export function countryOutlineLayer({ m49, color, halo, visible }: { m49: number | null; color: Color; halo: Color; visible: boolean }) {
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
      const data = tileOutlines(features, local ? LOCAL_BOUNDS : geoBounds(props.tile.bbox as GeoBoundingBox));
      return [
        { id: "halo", color: halo, width: 6 },
        { id: "path", color, width: 3 },
      ].map(
        (line) =>
          new PathLayer<Position[]>({
            ...props,
            id: `${props.id}-${line.id}`,
            data,
            pickable: false,
            getPath: (path) => path as [number, number][],
            getColor: line.color,
            getWidth: line.width,
            widthUnits: "pixels",
            jointRounded: true,
          }),
      );
    },
  });
}

export interface CountrySymbol {
  /** Names it, so a change of its size or colour is eased (map.ts). */
  id: string;
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
