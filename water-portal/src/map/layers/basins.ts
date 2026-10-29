import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { MVTLayer, type GeoBoundingBox } from "@deck.gl/geo-layers";
import { PathLayer } from "@deck.gl/layers";
import type { Feature, Position } from "geojson";
import type { Color } from "../theme";
import type { Copy } from "../tween";
import { FAO_TILES, ignoreMissingTile } from "./tile-urls";

export interface MajorBasinProperties {
  SDG6_MB_ID: number;
  S6_MB_NAME: string;
}

export interface SubBasinProperties extends MajorBasinProperties {
  SDG6_SB_ID: number;
  S6_SB_NAME: string;
}

interface BasinOptions {
  fill: Color;
  border: Color;
  visible: boolean;
  /** Whether the outlines are drawn (default: as `visible`), and how wide (px; default 1.2). */
  outlined?: boolean;
  outlineWidth?: number;
  /** The selected basin (by ID), filled with `selectedColor`. */
  selected?: number | null;
  selectedColor?: Color;
  /**
   * The areas' copies (see createFade), each with the basins (by ID) it fills with their
   * own colour instead of `fill`.
   */
  fills: Copy<BasinFills | undefined>[];
}

/** Basins' own colours; `key` names the set (deck.gl only redraws the colours when it changes). */
export interface BasinFills {
  key: number | string;
  colors: Map<number, Color>;
}

/**
 * SDG 6 major basins, as the areas (filled with the land colour; a layer per copy) and
 * their outlines. Separate layers, so that all outlines are drawn after all areas: the tiles
 * overlap a little, and a neighbouring tile's area would cover part of an outline.
 */
export function majorBasinsLayers(options: BasinOptions) {
  return basinsLayers<MajorBasinProperties>("major-basins", FAO_TILES.majorBasins, "SDG6_MB_ID", options);
}

/** SDG 6 sub-basins (subdivisions of the major basins), as areas and outlines. */
export function subBasinsLayers(options: BasinOptions) {
  return basinsLayers<SubBasinProperties>("sub-basins", FAO_TILES.subBasins, "SDG6_SB_ID", options);
}

function basinsLayers<P>(
  id: string,
  data: string,
  idProperty: string,
  { fill, border, visible, outlined = visible, outlineWidth = 1.2, selected = null, selectedColor, fills: copies }: BasinOptions,
) {
  const common = {
    data,
    visible,
    minZoom: 0,
    maxZoom: 8,
    onTileError: ignoreMissingTile,
    parameters: { depthCompare: "always" as const },
  };

  const areas = copies.map(
    ({ slot, fills, opacity, visible: shown }) =>
      new MVTLayer<P>({
        ...common,
        id: slot ? `${id}-1` : id,
        visible: visible && shown,
        pickable: visible && shown,
        opacity,
        stroked: false,
        getFillColor: fills
          ? (f: { properties: P }) => fills.colors.get((f.properties as Record<string, number>)[idProperty]) ?? fill
          : fill,
        updateTriggers: { getFillColor: fills?.key },
        uniqueIdProperty: idProperty,
        highlightedFeatureId: selected,
        highlightColor: selectedColor,
      }),
  );

  // The outlines are the polygon rings as lines (see tileOutlines for why they aren't
  // simply a polygon stroke).
  const outlines = new MVTLayer<P>({
    ...common,
    id: `${id}-outlines`,
    visible: outlined,
    renderSubLayers: (props) => {
      const features = (props.data as Feature[] | null) ?? []; // null for an empty tile
      const local = props.coordinateSystem === COORDINATE_SYSTEM.CARTESIAN;
      return new PathLayer<Position[]>({
        ...props,
        id: `${props.id}-path`,
        data: tileOutlines(features, local ? LOCAL_BOUNDS : geoBounds(props.tile.bbox as GeoBoundingBox)),
        pickable: false,
        getPath: (path) => path as [number, number][],
        getColor: border,
        getWidth: outlineWidth,
        widthUnits: "pixels",
        jointRounded: true,
      });
    },
  });

  return { areas, outlines };
}

/** Thick outlines around a few sub-basins (by ID), drawn the same way as the others. */
export function subBasinOutlinesLayer({ ids, color, visible }: { ids: number[]; color: Color; visible: boolean }) {
  return basinOutlinesLayer({ id: "sub-basins-outlined", level: "sub", ids, color, width: 2.5, visible });
}

const LEVELS = {
  major: { data: FAO_TILES.majorBasins, idProperty: "SDG6_MB_ID" },
  sub: { data: FAO_TILES.subBasins, idProperty: "SDG6_SB_ID" },
};

/** Outlines around a few major basins or sub-basins (by ID), over a wider `halo` line if given. */
export function basinOutlinesLayer({
  id,
  level,
  ids,
  color,
  width,
  halo,
  visible,
}: {
  id: string;
  level: "major" | "sub";
  ids: number[];
  color: Color;
  width: number;
  halo?: Color;
  visible: boolean;
}) {
  const wanted = new Set(ids);
  const { data, idProperty } = LEVELS[level];
  return new MVTLayer<MajorBasinProperties>({
    id,
    data,
    visible: visible && ids.length > 0,
    minZoom: 0,
    maxZoom: 8,
    onTileError: ignoreMissingTile,
    parameters: { depthCompare: "always" as const },
    updateTriggers: { renderSubLayers: ids.join() },
    renderSubLayers: (props) => {
      const features = ((props.data as Feature[] | null) ?? []).filter((f) => wanted.has(f.properties?.[idProperty]));
      const local = props.coordinateSystem === COORDINATE_SYSTEM.CARTESIAN;
      const bounds = local ? LOCAL_BOUNDS : geoBounds(props.tile.bbox as GeoBoundingBox);
      const paths = tileOutlines(features, bounds);
      const lines = halo ? [{ id: "halo", color: halo, width: width + 3 }, { id: "path", color, width }] : [{ id: "path", color, width }];
      return lines.map(
        (line) =>
          new PathLayer<Position[]>({
            ...props,
            id: `${props.id}-${line.id}`,
            data: paths,
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

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Tile-local coordinates (used once MapLibre leaves globe mode at high zoom) run
// from 0 to 1 across the tile.
export const LOCAL_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

export function geoBounds({ west, south, east, north }: GeoBoundingBox): Bounds {
  return { minX: west, minY: south, maxX: east, maxY: north };
}

/**
 * The polygon rings of one tile as lines, without the parts outside the tile.
 *
 * The tiles were cut with a small buffer: each polygon runs a little past the tile
 * edge and is closed off there by an artificial edge. A polygon stroke would draw
 * those edges as lines along every tile seam. Keeping only segments that reach into
 * the tile drops them; the real borders in the buffer are drawn by the neighbouring
 * tile anyway. Tiles cut without a buffer (the countries) are closed off along the
 * tile edge itself, so segments that run along an edge are dropped too.
 */
export function tileOutlines(features: Feature[], b: Bounds): Position[][] {
  const paths: Position[][] = [];
  const eps = (b.maxX - b.minX) * 1e-4;
  const near = (v: number, edge: number) => Math.abs(v - edge) < eps;
  const alongEdge = (p: Position, q: Position) =>
    (near(p[0], b.minX) && near(q[0], b.minX)) ||
    (near(p[0], b.maxX) && near(q[0], b.maxX)) ||
    (near(p[1], b.minY) && near(q[1], b.minY)) ||
    (near(p[1], b.maxY) && near(q[1], b.maxY));
  const outside = (p: Position, q: Position) =>
    (p[0] < b.minX && q[0] < b.minX) ||
    (p[0] > b.maxX && q[0] > b.maxX) ||
    (p[1] < b.minY && q[1] < b.minY) ||
    (p[1] > b.maxY && q[1] > b.maxY) ||
    alongEdge(p, q);

  for (const { geometry } of features) {
    const polygons =
      geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
    for (const ring of polygons.flat()) {
      let path: Position[] = [];
      for (let i = 1; i < ring.length; i++) {
        if (outside(ring[i - 1], ring[i])) {
          if (path.length > 1) paths.push(path);
          path = [];
        } else {
          if (path.length === 0) path.push(ring[i - 1]);
          path.push(ring[i]);
        }
      }
      if (path.length > 1) paths.push(path);
    }
  }
  return paths;
}
