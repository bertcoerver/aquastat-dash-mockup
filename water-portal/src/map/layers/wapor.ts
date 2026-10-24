/*
 * WaPOR v3 actual evapotranspiration and interception (L1-AETI, global, 300 m), as
 * the COG for the selected period, read straight from FAO's bucket (it sends CORS
 * headers). There's one COG per dekad, calendar month and calendar year, which is
 * exactly what the Local view lets you select.
 *
 * Catalogue: https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets/L1-AETI-D
 * (-M, -A). Colour maps are WaPOR's own styles AETI-D-INT16, AETI-M and AETI-A.
 */
import type { Viewport } from "@deck.gl/core";
import type { TileLayer } from "@deck.gl/geo-layers";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import { MONTHS, dkD, dkM, dkY } from "../../toolbar/dekads";
import type { DekadRange } from "../../toolbar/range-rules";
import { AetiRamp, rampProps, type WaporRamp } from "./wapor-shader";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";

export type WaporResolution = "dekadal" | "monthly" | "annual";

interface Mapset {
  code: string;
  unit: string;
  scale: number; // physical value = raw * scale
  ramp: WaporRamp;
}

const MAPSETS: Record<WaporResolution, Mapset> = {
  dekadal: {
    code: "L1-AETI-D",
    unit: "mm/day", // the average day of the dekad
    scale: 0.1,
    ramp: {
      quantities: [1, 25, 50, 75, 100],
      colors: ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"],
    },
  },
  monthly: {
    code: "L1-AETI-M",
    unit: "mm/month",
    scale: 0.1,
    ramp: {
      quantities: [100, 400, 800, 1200, 1600],
      colors: ["#f0f9e8", "#bae4bc", "#7bccc4", "#43a2ca", "#0868ac"],
    },
  },
  annual: {
    code: "L1-AETI-A",
    unit: "mm/year",
    scale: 0.1,
    ramp: {
      quantities: [1000, 4000, 8000, 12000, 16000],
      colors: ["#f0f9e8", "#bae4bc", "#7bccc4", "#43a2ca", "#0868ac"],
    },
  },
};

/** The WaPOR raster for one period. */
export interface WaporPeriod {
  resolution: WaporResolution;
  /** As in WaPOR's raster names: 2025, 2025-03 or 2025-03-D2. */
  code: string;
  label: string;
  url: string;
  unit: string;
  scale: number;
  ramp: WaporRamp;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The raster for a Local view range (one dekad, month or year), or null for others. */
export function waporPeriod({ start, end }: DekadRange): WaporPeriod | null {
  const len = end - start + 1;
  const y = dkY(start);
  const m = dkM(start);
  const [resolution, code, label]: [WaporResolution, string, string] | [null] =
    len === 1
      ? ["dekadal", `${y}-${pad(m + 1)}-D${dkD(start) + 1}`, `${["1st", "2nd", "3rd"][dkD(start)]} dekad of ${MONTHS[m]} ${y}`]
      : len === 3 && dkD(start) === 0
        ? ["monthly", `${y}-${pad(m + 1)}`, `${MONTHS[m]} ${y}`]
        : len === 36 && start % 36 === 0
          ? ["annual", String(y), String(y)]
          : [null];
  if (!resolution) return null;
  const mapset = MAPSETS[resolution];
  return {
    resolution,
    code,
    label,
    url: `${BUCKET}/${mapset.code}/WAPOR-3.${mapset.code}.${code}.tif`,
    unit: mapset.unit,
    scale: mapset.scale,
    ramp: mapset.ramp,
  };
}

// Recent periods are published with a delay, so check a raster exists before opening it.
const exists = new Map<string, Promise<boolean>>();

export function waporAvailable(period: WaporPeriod): Promise<boolean> {
  let check = exists.get(period.url);
  if (!check) {
    check = fetch(period.url, { method: "HEAD" }).then(
      (res) => res.ok,
      () => false,
    );
    exists.set(period.url, check);
    // A network error shouldn't stick: try again next time.
    check.then((ok) => ok || exists.delete(period.url));
  }
  return check;
}

/**
 * Which overview to show: the coarsest whose pixels are at most this many CSS pixels on
 * screen, at the centre of the view. At 2, the raster is magnified up to 2× (4× in
 * device pixels on a retina screen), and the full 300 m only loads from about zoom 8.
 */
const CSS_PX_PER_RASTER_PX = 2;

/** Which overview the raster covers the view with, for the debug window. */
export interface WaporTiles {
  zoom: number;
  overview: string;
  pixelSize: string;
  /** How big one raster pixel is on screen, at the centre of the view. */
  pixelOnScreen: string;
  tiles: number;
  /** The visible part of the globe, in degrees. */
  area: string;
}

let reportTiles: ((tiles: WaporTiles) => void) | null = null;

/** Run `callback` whenever the raster picks tiles for a new view. */
export function onWaporTiles(callback: (tiles: WaporTiles) => void) {
  reportTiles = callback;
}

const fmtMeters = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${+(m / 1000).toFixed(1)} km`);

/** Great-circle distance in metres. */
function metersBetween([lon1, lat1]: number[], [lon2, lat2]: number[]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

interface Box {
  west: number; // may be below -180 or east above 180: longitudes run on around the view
  east: number;
  south: number;
  north: number;
}

/**
 * The part of the globe in view, as a lon/lat box, from a grid of screen points. Where
 * a row or column of the grid crosses the globe's edge, the edge is found by bisection,
 * as the parts near it span many degrees on very few pixels.
 */
function visibleBox(viewport: Viewport): Box | null {
  const { width, height } = viewport;
  const longitude = viewport.unproject([width / 2, height / 2])[0];
  // Off the globe, unproject gives the nearest point on the horizon instead; that
  // point doesn't project back onto the same pixel.
  const onGlobe = (x: number, y: number) => {
    const lngLat = viewport.unproject([x, y]);
    const [px, py] = viewport.project(lngLat);
    return Math.hypot(px - x, py - y) < 1 ? lngLat : null;
  };
  const box: Box = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  const add = ([lon, lat]: number[]) => {
    const l = longitude + ((((lon - longitude) % 360) + 540) % 360) - 180; // unwrapped around the view
    box.west = Math.min(box.west, l);
    box.east = Math.max(box.east, l);
    box.south = Math.min(box.south, lat);
    box.north = Math.max(box.north, lat);
  };
  const N = 16;
  const line = (at: (t: number) => [number, number]) => {
    let prev: { t: number; hit: boolean } | null = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const hit = onGlobe(...at(t));
      if (hit) add(hit);
      if (prev && prev.hit !== !!hit) {
        // Bisect for the edge between the two samples.
        let [a, b] = prev.hit ? [prev.t, t] : [t, prev.t]; // a on the globe, b off it
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2;
          if (onGlobe(...at(m))) a = m;
          else b = m;
        }
        add(onGlobe(...at(a))!);
      }
      prev = { t, hit: !!hit };
    }
  };
  for (let i = 0; i <= N; i++) {
    line((t) => [t * width, (i / N) * height]);
    line((t) => [(i / N) * width, t * height]);
  }
  if (box.west > box.east) return null;
  // A pole in view: every longitude is.
  for (const lat of [90, -90]) {
    const [x, y] = viewport.project([longitude, lat]);
    const near = x >= 0 && x <= width && y >= 0 && y <= height && onGlobe(x, y);
    if (near && Math.abs(near[1]) > 89) {
      Object.assign(box, { west: longitude - 180, east: longitude + 180 });
      if (lat > 0) box.north = 90;
      else box.south = -90;
    }
  }
  return box;
}

type Level = { metersPerPixel: number; matrixWidth: number; matrixHeight: number };

/**
 * MultiCOGLayer with its own choice of tiles: one overview for the whole view (see
 * CSS_PX_PER_RASTER_PX), and only the tiles on the visible part of the globe.
 *
 * deck.gl-raster picks a level per tile, from the Web Mercator scale at the tile's
 * latitude. On a globe that asks for ever finer tiles towards the poles, and it doesn't
 * leave out the far side of the globe: at zoom 9 it picked over 16,000 tiles.
 */
class GlobeMultiCOGLayer extends MultiCOGLayer {
  static layerName = "GlobeMultiCOGLayer";

  renderLayers() {
    // The inner TileLayer's tileset picks the tiles. deck.gl builds it once, from the
    // first class it's given, so the subclass holds no per-render state.
    const layer = super.renderLayers() as TileLayer | null;
    if (!layer) return null;
    const Tileset = layer.props.TilesetClass;
    class GlobeTileset extends Tileset {
      getTileIndices({ viewport }: { viewport: Viewport }) {
        // Levels run from the coarsest (z = 0) to full resolution (the last); the
        // descriptor is private in the typings.
        const { levels } = (this as unknown as { descriptor: { levels: Level[] } }).descriptor;
        const last = levels.length - 1;
        const box = visibleBox(viewport);
        const { width, height } = viewport;
        const a = viewport.unproject([width / 2 - 5, height / 2]);
        const b = viewport.unproject([width / 2 + 5, height / 2]);
        if (!box) return [];

        const metersPerCssPixel = metersBetween(a, b) / 10;
        let z = 0;
        while (z < last && levels[z].metersPerPixel > CSS_PX_PER_RASTER_PX * metersPerCssPixel) z++;

        // A global lon/lat grid with square pixels: every tile spans the same degrees.
        const { matrixWidth, matrixHeight, metersPerPixel } = levels[z];
        const deg = 360 / matrixWidth;
        const x0 = Math.floor((box.west + 180) / deg);
        const x1 = Math.min(Math.floor((box.east + 180) / deg), x0 + matrixWidth - 1);
        const y0 = Math.max(0, Math.floor((90 - box.north) / deg));
        const y1 = Math.min(matrixHeight - 1, Math.floor((90 - box.south) / deg));
        const indices = [];
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) indices.push({ x: ((x % matrixWidth) + matrixWidth) % matrixWidth, y, z });
        }

        const round = (v: number) => Math.round(v);
        reportTiles?.({
          zoom: viewport.zoom,
          overview: z === last ? "full resolution" : `overview ${last - z} of ${last}`,
          pixelSize: fmtMeters(metersPerPixel),
          pixelOnScreen: `${+(metersPerPixel / metersPerCssPixel).toFixed(2)} CSS px`,
          tiles: indices.length,
          area: `lon ${round(box.west)}…${round(box.east)}, lat ${round(box.south)}…${round(box.north)}`,
        });
        return indices;
      }
    }
    return layer.clone({ TilesetClass: GlobeTileset });
  }
}

/**
 * The raster, coloured with WaPOR's colour map; nothing where it has no data. No
 * layer without a period: a hidden MultiCOGLayer would still open its source.
 */
export function waporLayer({ period, onLoad }: { period: WaporPeriod | null; onLoad?: () => void }) {
  if (!period) return null;
  return new GlobeMultiCOGLayer({
    id: "wapor-aeti",
    sources: { aeti: { url: period.url } },
    composite: { r: "aeti" },
    renderPipeline: [{ module: AetiRamp, props: rampProps(period.ramp) }],
    // Linear filtering would blend values with the -9999 nodata at coasts.
    resampling: "nearest",
    parameters: { depthCompare: "always" },
    onGeoTIFFLoad: onLoad,
  });
}
