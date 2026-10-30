/*
 * The map's layers: the portal's data (its M49 country and border tiles, FAO's basin,
 * lake and river tiles, a WaPOR raster) drawn with ordinary deck.gl layers. Nothing here
 * knows about the projection: main.ts adds ReprojectExtension to each.
 */
import type { Color, Layer } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { MVTLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, ColumnLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { Feature } from "geojson";
import { BoxTileset } from "./box-tileset";

export const THEME = {
  ocean: [212, 225, 231, 255] as Color,
  land: [250, 250, 247, 255] as Color,
  border: [120, 136, 143, 255] as Color,
  basinBorder: [150, 112, 70, 255] as Color,
  river: [0, 0, 138, 255] as Color,
  graticule: [70, 90, 100, 170] as Color,
  outline: [19, 35, 43, 255] as Color,
  selected: [215, 228, 230, 255] as Color,
};

const LOCAL_TILES = (name: string) => `${window.location.origin}/tiles/${name}/{z}/{x}/{y}.pbf`;
const FAO_TILES = (name: string) => `https://storage.googleapis.com/fao-cog-data/basins/${name}/{z}/{x}/{y}.pbf`;
/** Tile sets have no files for empty tiles: a 404 means "nothing here". */
const ignoreMissingTile = () => {};
/** All layers lie in one plane: no depth test (the bars are the exception). */
const FLAT = { depthCompare: "always" as const };

/** What every tile layer shares. */
const TILES = { TilesetClass: BoxTileset, onTileError: ignoreMissingTile, parameters: FLAT };

const range = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

/**
 * The whole world as one polygon, in the ocean colour: the map's outline. (deck.gl
 * subdivides it every few degrees, see ProjectedViewport's resolution, so its edges
 * curve as the projection's do.) Latitudes stop just short of the poles: at a pole that
 * is a point, every meridian maps to it.
 */
const WORLD_RING: [number, number][] = [
  ...range(-89.99, 89.99, 1).map((lat): [number, number] => [-180, lat]),
  ...range(-180, 180, 1).map((lon): [number, number] => [lon, 89.99]),
  ...range(89.99, -89.99, -1).map((lat): [number, number] => [180, lat]),
  ...range(180, -180, -1).map((lon): [number, number] => [lon, -89.99]),
];

export function oceanLayer() {
  return new PolygonLayer<[number, number][]>({
    id: "ocean",
    data: [WORLD_RING],
    getPolygon: (d) => d,
    getFillColor: THEME.ocean,
    stroked: false,
    pickable: false,
    parameters: FLAT,
  });
}

/**
 * Web Mercator tiles stop at 85.05° S, so Antarctica has no tiles south of it; on a
 * globe that's a hole at the pole, on a flat world map a band along the bottom edge.
 * Filled with the land colour here (Antarctica is all of it).
 */
export function polarCapLayer() {
  const ring: [number, number][] = [
    ...range(-180, 180, 1).map((lon): [number, number] => [lon, -85.04]),
    ...range(180, -180, -1).map((lon): [number, number] => [lon, -89.99]),
  ];
  return new PolygonLayer<[number, number][]>({
    id: "polar-cap",
    data: [ring],
    getPolygon: (d) => d,
    getFillColor: THEME.land,
    stroked: false,
    pickable: false,
    parameters: FLAT,
  });
}

export interface CountryProperties {
  m49: number;
  name: string;
}

/** The M49 countries: land, coloured by `colors` where it has them (the choropleth), and what a click hits. */
export function countriesLayer({ colors, selected, hovered }: { colors: Map<number, Color> | null; selected: number | null; hovered: number | null }) {
  return new MVTLayer<CountryProperties>({
    id: "countries",
    data: LOCAL_TILES("m49"),
    minZoom: 0,
    maxZoom: 5,
    ...TILES,
    pickable: true,
    stroked: false,
    getFillColor: (f: Feature) => {
      const { m49 } = f.properties as CountryProperties;
      if (m49 === selected) return THEME.selected;
      return colors?.get(m49) ?? THEME.land;
    },
    updateTriggers: { getFillColor: [colors, selected] },
    uniqueIdProperty: "m49",
    highlightedFeatureId: hovered,
    highlightColor: [19, 35, 43, 70],
  });
}

/** The UN boundary lines: borders and coastlines, disputed ones dashed. */
export function bordersLayer() {
  const DASHES: Record<number, [number, number]> = { 2: [5, 2.5], 3: [5, 2.5], 4: [1.5, 2], 8: [3, 2] };
  return new MVTLayer({
    id: "borders",
    data: LOCAL_TILES("borders"),
    minZoom: 0,
    maxZoom: 5,
    ...TILES,
    getLineColor: THEME.border,
    getLineWidth: (f: Feature) => ([8, 9].includes((f.properties as { bdytyp: number }).bdytyp) ? 5_000 : 10_000),
    lineWidthMinPixels: 0.6,
    lineWidthMaxPixels: 2.5,
    lineJointRounded: true,
    extensions: [new PathStyleExtension({ dashMode: "path" })],
    getDashArray: (f: Feature) => DASHES[(f.properties as { bdytyp: number }).bdytyp] ?? [0, 0],
    dashJustified: true,
  });
}

/** SDG 6 major basins, each in a pale colour of its own (no outlines: tiles cut polygons, and a stroke would show every cut). */
export function majorBasinsLayer() {
  return new MVTLayer({
    id: "major-basins",
    data: FAO_TILES("SDG6_MBM_v1_tiles"),
    minZoom: 0,
    maxZoom: 8,
    ...TILES,
    pickable: true,
    stroked: false,
    getFillColor: (f: Feature) => pastel((f.properties as { SDG6_MB_ID: number }).SDG6_MB_ID),
  });
}

/** HydroLAKES. */
export function lakesLayer() {
  return new MVTLayer({
    id: "lakes",
    data: FAO_TILES("HydroLAKES_polys_v10_tiles"),
    minZoom: 0,
    maxZoom: 8,
    ...TILES,
    stroked: false,
    getFillColor: THEME.river,
  });
}

/** Rivers, from zoom 5 (as in the portal), wider for higher Strahler order. */
export function riversLayer() {
  return new MVTLayer({
    id: "rivers",
    data: FAO_TILES("rivers_world_47950_tiles"),
    minZoom: 5,
    maxZoom: 8,
    ...TILES,
    getLineColor: THEME.river,
    getLineWidth: (f: Feature) => (f.properties as { Strahler: number }).Strahler,
    lineWidthUnits: "meters",
    lineWidthScale: 250,
    lineJointRounded: true,
    lineCapRounded: true,
  });
}

/** Meridians and parallels every 30° (points 2° apart; the equator and prime meridian stronger), labelled along the equator. */
export function graticuleLayers(): Layer[] {
  const lines = [
    ...range(-60, 60, 30).map((lat) => ({ path: range(-180, 180, 2).map((lon): [number, number] => [lon, lat]), main: lat === 0 })),
    ...range(-180, 180, 30).map((lon) => ({ path: range(-89.99, 89.99, 2).map((lat): [number, number] => [lon, lat]), main: lon === 0 })),
  ];
  const faint: Color = [THEME.graticule[0], THEME.graticule[1], THEME.graticule[2], 95];
  return [
    new PathLayer<(typeof lines)[number]>({
      id: "graticule",
      data: lines,
      getPath: (d) => d.path,
      getColor: (d) => (d.main ? THEME.graticule : faint),
      getWidth: (d) => (d.main ? 1.5 : 1),
      widthUnits: "pixels",
      parameters: FLAT,
    }),
    new TextLayer<{ lon: number }>({
      id: "graticule-labels",
      data: range(-150, 180, 30).map((lon) => ({ lon })),
      getPosition: (d) => [d.lon, 0],
      getText: (d) => (d.lon === 0 || d.lon === 180 ? `${d.lon}°` : `${Math.abs(d.lon)}° ${d.lon < 0 ? "W" : "E"}`),
      getSize: 11,
      getColor: [70, 90, 100, 220],
      getTextAnchor: "start",
      getAlignmentBaseline: "bottom",
      getPixelOffset: [3, -2],
      fontFamily: "system-ui, sans-serif",
      characterSet: "0123456789° WE",
      parameters: FLAT,
    }),
  ];
}

export interface Symbol {
  m49: number;
  position: [number, number];
  /** 0–1. */
  value: number;
  color: Color;
}

/** Proportional circles on the countries, radius in pixels. */
export function circlesLayer(symbols: Symbol[]) {
  return new ScatterplotLayer<Symbol>({
    id: "circles",
    data: symbols,
    pickable: true,
    getPosition: (s) => s.position,
    getRadius: (s) => 3 + 22 * Math.sqrt(s.value),
    radiusUnits: "pixels",
    getFillColor: (s) => [s.color[0], s.color[1], s.color[2], 200],
    getLineColor: [255, 255, 255, 230],
    getLineWidth: 1,
    lineWidthUnits: "pixels",
    stroked: true,
    parameters: FLAT,
  });
}

/** The reference bar's height, in CSS pixels at any zoom (as the portal's bars.ts). */
const BAR_PX = 110;
const M_PER_PX = 40075016.7 / 512;

/** 3D bars on the countries, their height in pixels at the zoom drawn for; depth-tested so near bars hide those behind. */
export function barsLayer(symbols: Symbol[], zoom: number) {
  return new ColumnLayer<Symbol>({
    id: "bars",
    data: symbols,
    pickable: true,
    getPosition: (s) => s.position,
    getElevation: (s) => s.value,
    elevationScale: (BAR_PX * M_PER_PX) / 2 ** zoom,
    radius: 5,
    radiusUnits: "pixels",
    diskResolution: 12,
    extruded: true,
    flatShading: true,
    getFillColor: (s) => s.color,
    updateTriggers: { elevationScale: zoom },
    parameters: { depthCompare: "less-equal" },
  });
}

export interface Raster {
  image: ImageData;
  /** [west, south, east, north]. */
  bounds: [number, number, number, number];
}

/**
 * A raster in lon/lat (EPSG:4326, WaPOR's and GAEZ's grid) as a BitmapLayer: deck.gl
 * subdivides the image's quad (ProjectedViewport's resolution), and the extension
 * moves each vertex, so the image is reprojected to within a cell's curvature.
 */
export function rasterLayer(raster: Raster | null, opacity: number) {
  return new BitmapLayer({
    id: "raster",
    image: raster?.image ?? null,
    bounds: raster?.bounds ?? [0, 0, 1, 1],
    visible: Boolean(raster),
    opacity,
    textureParameters: { minFilter: "linear", magFilter: "nearest" },
    parameters: FLAT,
  });
}

/** A pale, distinct colour for an integer id. */
export function pastel(id: number): Color {
  const h = ((id * 137.508) % 360) / 60;
  const c = 0.22;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = 0.74;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 255];
}

/** A sequential ramp (light to dark teal) for 0–1. */
export function ramp(v: number): Color {
  const stops: Color[] = [
    [247, 252, 253, 255],
    [204, 236, 230, 255],
    [153, 216, 201, 255],
    [102, 194, 164, 255],
    [65, 174, 118, 255],
    [35, 139, 69, 255],
    [0, 88, 36, 255],
  ];
  const t = Math.max(0, Math.min(0.9999, v)) * (stops.length - 1);
  const i = Math.floor(t);
  const f = t - i;
  const a = stops[i];
  const b = stops[i + 1];
  const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * f);
  return [mix(0), mix(1), mix(2), 255];
}
