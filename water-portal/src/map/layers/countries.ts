import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { MVTLayer, type GeoBoundingBox } from "@deck.gl/geo-layers";
import type { Accessor } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Feature, Position } from "geojson";
import type { Color } from "../theme";
import type { Copy } from "../tween";
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
 * names (deck.gl only redraws the colours when it changes). A layer per copy (see
 * createFade).
 */
export function countriesLayer({
  color,
  selected,
  selectedColor,
  visible,
  fills: copies,
}: {
  color: Color;
  selected: number | null;
  selectedColor: Color;
  visible: boolean;
  fills: Copy<CountryFills | undefined>[];
}) {
  return copies.map(
    ({ slot, fills, opacity, visible: shown }) =>
      new MVTLayer<CountryProperties>({
        id: slot ? "m49-countries-1" : "m49-countries",
        data: localTiles("m49"),
        visible: visible && shown,
        pickable: visible && shown,
        opacity,
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
      }),
  );
}

export interface CountryFills {
  key: string;
  colors: Map<number, Color>;
}

/**
 * An outline around one country (by M49 code), drawn like the basin outlines: a line on
 * a contrasting halo twice as wide, to stand out on any fill (the selected country's, thick; the hovered one's).
 */
export function countryOutlineLayer({
  id = "m49-outlined",
  m49,
  color,
  halo,
  width = 3,
  visible,
}: {
  id?: string;
  m49: number | null;
  color: Color;
  halo: Color;
  width?: number;
  visible: boolean;
}) {
  return new MVTLayer<CountryProperties>({
    id,
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
        { id: "halo", color: halo, width: width * 2 },
        { id: "path", color, width },
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
  /**
   * A pie: where its first three slices end, clockwise from the top, as shares of the
   * circle (cumulative, 0–1), and its four slices' colours, RGBA one after the other
   * (both plain lists of numbers, so they ease). None: a plain circle in `fill`.
   */
  pie?: number[];
  pieColors?: number[];
}

/** No pie: the circle in its fill. */
const NO_PIE = [-1, -1, -1];
const NO_COLOR = [0, 0, 0, 0];

interface PieProps {
  getPieCuts: Accessor<CountrySymbol, number[]>;
  getPieColor0: Accessor<CountrySymbol, number[]>;
  getPieColor1: Accessor<CountrySymbol, number[]>;
  getPieColor2: Accessor<CountrySymbol, number[]>;
  getPieColor3: Accessor<CountrySymbol, number[]>;
}

/**
 * Circles that can be pies: deck.gl's ScatterplotLayer, its fragment shader painting
 * the inside of a circle with pie cuts by the angle from the top (the ring stays the
 * line colour).
 */
class PieScatterLayer extends ScatterplotLayer<CountrySymbol, PieProps> {
  static layerName = "PieScatterLayer";
  // (deck.gl merges these with the base layer's; typed as those, which they extend.)
  static defaultProps = {
    getPieCuts: { type: "accessor", value: NO_PIE },
    getPieColor0: { type: "accessor", value: NO_COLOR },
    getPieColor1: { type: "accessor", value: NO_COLOR },
    getPieColor2: { type: "accessor", value: NO_COLOR },
    getPieColor3: { type: "accessor", value: NO_COLOR },
  } as unknown as typeof ScatterplotLayer.defaultProps;

  getShaders() {
    const shaders = super.getShaders();
    const colors = [0, 1, 2, 3];
    // (Added to what's injected already: the extensions' code, the horizon's.)
    const inject: Record<string, string> = { ...shaders.inject };
    const own: Record<string, string> = {
      "vs:#decl":
        "in vec3 instancePieCuts;\nout vec3 vPieCuts;\n" +
        colors.map((i) => `in vec4 instancePieColor${i};\nout vec4 vPieColor${i};\n`).join(""),
      "vs:#main-end":
        "vPieCuts = instancePieCuts;\n" +
        colors.map((i) => `vPieColor${i} = vec4(instancePieColor${i}.rgb, instancePieColor${i}.a * layer.opacity);\n`).join(""),
      "fs:#decl": "in vec3 vPieCuts;\n" + colors.map((i) => `in vec4 vPieColor${i};\n`).join(""),
      "fs:#main-end": `
  if (vPieCuts.x >= 0.0) {
    float angle = atan(unitPosition.x, unitPosition.y);
    float at = (angle < 0.0 ? angle + 6.28318531 : angle) / 6.28318531;
    vec4 slice = at < vPieCuts.x ? vPieColor0 : at < vPieCuts.y ? vPieColor1 : at < vPieCuts.z ? vPieColor2 : vPieColor3;
    float dist = length(unitPosition) * outerRadiusPixels;
    float isLine = scatterplot.stroked > 0.5 ? smoothedge(innerUnitRadius * outerRadiusPixels, dist) : 0.0;
    vec4 c = mix(slice, vLineColor, isLine);
    fragColor = vec4(c.rgb, c.a * inCircle);
  }
`,
    };
    for (const [hook, code] of Object.entries(own)) inject[hook] = (inject[hook] ?? "") + "\n" + code;
    return { ...shaders, inject };
  }

  initializeState() {
    super.initializeState();
    this.getAttributeManager()!.addInstanced({
      instancePieCuts: { size: 3, accessor: "getPieCuts", defaultValue: NO_PIE },
      instancePieColor0: { size: 4, type: "unorm8", accessor: "getPieColor0", defaultValue: NO_COLOR },
      instancePieColor1: { size: 4, type: "unorm8", accessor: "getPieColor1", defaultValue: NO_COLOR },
      instancePieColor2: { size: 4, type: "unorm8", accessor: "getPieColor2", defaultValue: NO_COLOR },
      instancePieColor3: { size: 4, type: "unorm8", accessor: "getPieColor3", defaultValue: NO_COLOR },
    });
  }
}

const pieColor = (k: number) => (s: CountrySymbol) => s.pieColors?.slice(k * 4, k * 4 + 4) ?? NO_COLOR;

/**
 * Circles on countries: proportional symbols (plain or pies), and rings that mark
 * countries; or on points (the Local view's vector maps: `pickable`, for their tooltips).
 */
export function countrySymbolsLayer({ symbols, pickable = false }: { symbols: { key: string; items: CountrySymbol[] } | null; pickable?: boolean }) {
  const key = symbols?.key;
  return new PieScatterLayer({
    id: "m49-symbols",
    data: symbols?.items ?? [],
    visible: Boolean(symbols),
    pickable,
    getPosition: (s) => s.position,
    radiusUnits: "pixels",
    getRadius: (s) => s.radius,
    stroked: true,
    getFillColor: (s) => s.fill,
    getLineColor: (s) => s.line,
    lineWidthUnits: "pixels",
    getLineWidth: 1.5,
    getPieCuts: (s) => s.pie ?? NO_PIE,
    getPieColor0: pieColor(0),
    getPieColor1: pieColor(1),
    getPieColor2: pieColor(2),
    getPieColor3: pieColor(3),
    updateTriggers: {
      getRadius: key,
      getFillColor: key,
      getLineColor: key,
      getPieCuts: key,
      getPieColor0: key,
      getPieColor1: key,
      getPieColor2: key,
      getPieColor3: key,
    },
    parameters: { depthCompare: "always" },
  });
}
