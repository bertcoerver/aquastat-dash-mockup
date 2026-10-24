/*
 * WaPOR v3 actual evapotranspiration and interception (L1-AETI, global, 300 m), read
 * straight from FAO's bucket (it sends CORS headers). WaPOR publishes one COG per
 * dekad, calendar month and calendar year; a range that is exactly one of those shows
 * that COG, in its own unit. Any other range is added up from several of them, as the
 * total in mm (see wapor-plan.ts for which), tile by tile as they load. A range can
 * start and end on any day: of a dekad it only partly covers, it takes those days'
 * share of the dekad's raster.
 *
 * Catalogue: https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets/L1-AETI-D
 * (-M, -A). Colour maps are WaPOR's own styles AETI-D-INT16, AETI-M and AETI-A.
 *
 * A dekad also comes with L1-QUAL-NDVI-D, on the same grid: for each pixel, how many
 * dekads it has been since the last valid satellite observation behind the NDVI (0:
 * observed this dekad). AETI is modelled from it, so a long gap means a less reliable
 * value; the quality slider hides those pixels. It's published some dekads after AETI.
 */
import type { Viewport } from "@deck.gl/core";
import type { TileLayer } from "@deck.gl/geo-layers";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import { GeoTIFF, PerOriginSemaphore, defaultDecoderPool, type RasterArray, type RasterTypedArray } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import { MONTHS, dkD, dkFirstDay, dkLastDay, dkM, dkY, fmtDay } from "../../toolbar/dekads";
import { isDekads, type DayRange } from "../../toolbar/range-rules";
import { blockName, formatPlan, planRange, type BlockKind } from "./wapor-plan";
import { AetiRamp, rampProps, type WaporRamp } from "./wapor-shader";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";
const QUALITY = "L1-QUAL-NDVI-D";
const SCALE = 0.1; // all three: physical value = raw * 0.1

export type WaporResolution = "dekadal" | "monthly" | "annual" | "custom";

interface Mapset {
  code: string;
  resolution: WaporResolution;
  unit: string;
  ramp: WaporRamp; // in raw values
}

const MAPSETS: Record<BlockKind, Mapset> = {
  D: {
    code: "L1-AETI-D",
    resolution: "dekadal",
    unit: "mm/day", // the average day of the dekad
    ramp: {
      quantities: [1, 25, 50, 75, 100],
      colors: ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"],
    },
  },
  M: {
    code: "L1-AETI-M",
    resolution: "monthly",
    unit: "mm/month",
    ramp: {
      quantities: [100, 400, 800, 1200, 1600],
      colors: ["#f0f9e8", "#bae4bc", "#7bccc4", "#43a2ca", "#0868ac"],
    },
  },
  A: {
    code: "L1-AETI-A",
    resolution: "annual",
    unit: "mm/year",
    ramp: {
      quantities: [1000, 4000, 8000, 12000, 16000],
      colors: ["#f0f9e8", "#bae4bc", "#7bccc4", "#43a2ca", "#0868ac"],
    },
  },
};

const rasterUrl = (mapset: string, code: string) => `${BUCKET}/${mapset}/WAPOR-3.${mapset}.${code}.tif`;

/** One raster in a period's sum: shown value += factor * raw value. */
export interface WaporTerm {
  url: string;
  name: string; // "M[2025-01]"
  factor: number;
}

/** What the map shows for a date range: one WaPOR raster, or a sum of them. */
export interface WaporPeriod {
  resolution: WaporResolution;
  label: string;
  terms: WaporTerm[];
  /** How the value is made, e.g. "ETIa (mm) = A[2025] − M[2025-01] − M[2025-12]". */
  equation: string;
  /** Of loading the rasters, in dekadal rasters (see wapor-plan.ts). */
  cost: number;
  /** Rasters a cheaper sum would have used, but which aren't published yet. */
  unpublished: string[];
  /** A single dekad: its NDVI quality raster (null: none). */
  qualityUrl: string | null;
  /** About how the value is made, if there's something to know (partial dekads). */
  note: string | null;
  unit: string;
  scale: number; // legend value = shown value * scale
  ramp: WaporRamp;
  /** Identifies the AETI rasters and how they're added up (not the quality raster). */
  key: string;
}

/** Round to two significant digits, for legend stops. */
const nice = (v: number) => {
  const step = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(Math.round(v / step) * step * 1e6) / 1e6;
};

/**
 * What to show for a Local view range, assuming every raster is published except
 * those in `unpublished` (by name, e.g. "A[2025]"). Null if no sum can make the range.
 */
export function waporPeriod(range: DayRange, unpublished: ReadonlySet<string> = new Set()): WaporPeriod | null {
  const plan = planRange(range, (b) => unpublished.has(blockName(b)));
  if (!plan) return null;
  const skipped = [...unpublished];
  const [only] = plan.terms;

  // Exactly one raster: as published, in its own unit.
  if (
    plan.terms.length === 1 &&
    only.coef === 1 &&
    dkFirstDay(only.block.start) === range.start &&
    dkLastDay(only.block.start + only.block.len - 1) === range.end
  ) {
    const b = only.block;
    const start = b.start;
    const mapset = MAPSETS[b.kind];
    const y = dkY(start);
    const m = dkM(start);
    const label =
      b.kind === "D" ? `${["1st", "2nd", "3rd"][dkD(start)]} dekad of ${MONTHS[m]} ${y}` : b.kind === "M" ? `${MONTHS[m]} ${y}` : String(y);
    const url = rasterUrl(mapset.code, b.code);
    const qualityUrl = b.kind === "D" ? rasterUrl(QUALITY, b.code) : null;
    return {
      resolution: mapset.resolution,
      label,
      terms: [{ url, name: blockName(b), factor: 1 }],
      equation: `ETIa (${mapset.unit}) = ${blockName(b)}`,
      cost: plan.cost,
      unpublished: skipped,
      qualityUrl,
      note: null,
      unit: mapset.unit,
      scale: SCALE,
      ramp: mapset.ramp,
      key: url,
    };
  }

  // A sum, as the total in mm: a dekadal raster is mm/day, so times its days.
  const terms = plan.terms.map(({ block: b, coef, days }) => ({
    url: rasterUrl(MAPSETS[b.kind].code, b.code),
    name: blockName(b),
    factor: SCALE * (days ?? coef),
  }));
  // The annual colour map, scaled to the length of the range.
  const days = range.end - range.start + 1;
  const annual = MAPSETS.A.ramp;
  const [first, last] = [fmtDay(range.start), fmtDay(range.end)];
  return {
    resolution: "custom",
    label: `${first.slice(-4) === last.slice(-4) ? first.slice(0, -5) : first} – ${last}`,
    terms,
    equation: `ETIa (mm) = ${formatPlan(plan)}`,
    cost: plan.cost,
    unpublished: skipped,
    qualityUrl: null,
    // A range that starts or ends within a dekad.
    note: isDekads(range) ? null : "Part of a dekad: its average per day, times the days in the range.",
    unit: "mm total",
    scale: 1,
    ramp: {
      quantities: annual.quantities.map((q) => nice((q * SCALE * days) / 365)) as WaporRamp["quantities"],
      colors: annual.colors,
    },
    key: terms.map((t) => `${t.factor}*${t.url}`).join(" + "),
  };
}

/**
 * What to show for a range, using only published rasters: a cheaper sum may need one
 * that isn't out yet (the latest year or month), so plan again without it. Null if the
 * range can't be made from published rasters. Rejects if the bucket can't be reached.
 */
export async function publishedWaporPeriod(range: DayRange): Promise<WaporPeriod | null> {
  const unpublished = new Set<string>();
  for (;;) {
    const period = waporPeriod(range, unpublished);
    if (!period) return null;
    const published = await Promise.all(period.terms.map((t) => waporAvailable(t.url)));
    if (published.every(Boolean)) return period;
    period.terms.forEach((t, i) => published[i] || unpublished.add(t.name));
  }
}

/** A period that has been checked, ready to show, and its quality raster's state. */
export interface CheckedWaporPeriod {
  /** Without its quality raster if that isn't published. */
  period: WaporPeriod;
  /** A dekad: whether its quality raster is published (null: not a dekad). */
  quality: "ready" | "missing" | null;
}

/**
 * What to show for a range, checked: the rasters published and opened, so the map can
 * show it straight away. Null if it can't be made; rejects if the bucket can't be reached.
 */
export async function checkedWaporPeriod(range: DayRange): Promise<CheckedWaporPeriod | null> {
  const period = await publishedWaporPeriod(range);
  if (!period) return null;
  const quality = period.qualityUrl && (await waporAvailable(period.qualityUrl).catch(() => false));
  const qualityUrl = quality ? period.qualityUrl : null;
  await Promise.all([...period.terms.map((t) => t.url), ...(qualityUrl ? [qualityUrl] : [])].map(openRaster));
  return { period: { ...period, qualityUrl }, quality: period.qualityUrl ? (quality ? "ready" : "missing") : null };
}

/**
 * Recent periods are published with a delay, so check a raster exists before opening
 * it. Rejects on a network error (not cached: tried again next time), so that isn't
 * taken for a raster that doesn't exist.
 */
const exists = new Map<string, Promise<boolean>>();

export function waporAvailable(url: string): Promise<boolean> {
  let check = exists.get(url);
  if (!check) {
    check = fetch(url, { method: "HEAD" }).then((res) => res.ok);
    exists.set(url, check);
    check.catch(() => exists.delete(url));
  }
  return check;
}

/**
 * Opened rasters, by URL: their headers are read once, by whichever needs them first
 * (the map layer or the playback buffer). The least recently used are dropped first.
 */
const MAX_OPEN_RASTERS = 64;
// The bucket speaks HTTP/2, so more than the browser's 6 per host for HTTP/1.1 (the
// library's default): playback loads several frames' tiles at once.
const LIMITER = new PerOriginSemaphore({ maxRequests: 16 });
const rasters = new Map<string, Promise<GeoTIFF>>();
const opened = new Map<string, GeoTIFF>();

function openRaster(url: string): Promise<GeoTIFF> {
  let raster = rasters.get(url);
  if (raster) {
    rasters.delete(url);
  } else {
    raster = GeoTIFF.fromUrl(url, { concurrencyLimiter: LIMITER });
    raster.then((geotiff) => rasters.get(url) === raster && opened.set(url, geotiff), () => rasters.delete(url));
  }
  rasters.set(url, raster);
  for (const old of rasters.keys()) {
    if (rasters.size <= MAX_OPEN_RASTERS) break;
    rasters.delete(old);
    opened.delete(old);
  }
  return raster;
}

/** One tile of one raster, decoded. */
interface RasterTile {
  values: RasterTypedArray;
  width: number;
  height: number;
  nodata: number | null;
}

/**
 * Decoded tiles, by raster and tile (x, y, z), so playback can load them ahead and
 * periods that share a raster share its tiles. The least recently used go first.
 */
const TILE_CACHE_BYTES = 384 * 2 ** 20;
const tiles = new Map<string, { tile: Promise<RasterTile>; bytes: number; done: boolean }>();
let tileBytes = 0;

function rasterTile(url: string, { x, y, z }: TileIndex, signal?: AbortSignal): Promise<RasterTile> {
  const key = `${z}/${x}/${y} ${url}`;
  const hit = tiles.get(key);
  if (hit) {
    tiles.delete(key);
    tiles.set(key, hit);
    // Another reader may have given up on it (its tile left the view): then fetch it again.
    return hit.tile.catch((err) => {
      if (signal?.aborted) throw err;
      return rasterTile(url, { x, y, z }, signal);
    });
  }
  const tile = openRaster(url).then(async (geotiff) => {
    const images = [geotiff, ...geotiff.overviews]; // full resolution first; z = 0 is the coarsest
    const pool = defaultDecoderPool();
    const { array } = await images[images.length - 1 - z].fetchTile(x, y, { boundless: false, pool, signal });
    return { values: samples(array), width: array.width, height: array.height, nodata: array.nodata };
  });
  const entry = { tile, bytes: 0, done: false };
  tiles.set(key, entry);
  tile.then(
    ({ values }) => {
      if (tiles.get(key) !== entry) return;
      Object.assign(entry, { bytes: values.byteLength, done: true });
      tileBytes += entry.bytes;
      for (const [old, { bytes, done }] of tiles) {
        if (tileBytes <= TILE_CACHE_BYTES) break;
        if (!done) continue;
        tiles.delete(old);
        tileBytes -= bytes;
      }
    },
    () => tiles.get(key) === entry && tiles.delete(key),
  );
  return tile;
}

type TileIndex = { x: number; y: number; z: number };

/** The tiles the map shows (the same for every period: they share one grid). */
let viewTiles: TileIndex[] = [];
let viewKey = "";
const viewListeners = new Set<() => void>();

/** Run `callback` whenever the map shows other tiles (the view moved). Returns a function that stops it. */
export function onWaporView(callback: () => void) {
  viewListeners.add(callback);
  return () => viewListeners.delete(callback);
}

const periodRasters = (period: WaporPeriod) => [...period.terms.map((t) => t.url), ...(period.qualityUrl ? [period.qualityUrl] : [])];

/** Whether every tile the map shows has been loaded for this period. */
export function waporBuffered(period: WaporPeriod) {
  return periodRasters(period).every((url) =>
    viewTiles.every(({ x, y, z }) => tiles.get(`${z}/${x}/${y} ${url}`)?.done),
  );
}

/**
 * Load the tiles the map shows for a period, ahead of showing it. A tile that fails
 * is left out (the map would fail on it too); rejects only when `signal` aborts.
 */
export async function bufferWapor(period: WaporPeriod, signal: AbortSignal) {
  const view = viewTiles;
  await Promise.all(
    periodRasters(period).flatMap((url) =>
      view.map((index) =>
        rasterTile(url, index, signal).catch((err) => {
          if (signal.aborted) throw err;
        }),
      ),
    ),
  );
  signal.throwIfAborted();
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

  /**
   * One tile: the period's rasters added up into one band, "aeti" (as float32), next
   * to the quality band if there is one. All WaPOR rasters share one grid, so tile
   * (x, y, z) covers the same pixels in each. A pixel without data in any of them has
   * none in the sum. Rounding can take a difference just below zero; that's 0.
   */
  async _getTileData(...[tile, options]: Parameters<MultiCOGLayer["_getTileData"]>) {
    const { x, y, z } = tile.index;
    const { multiDescriptor } = this.state;
    const { device, signal } = options;
    const config = this.props.sources as Record<string, WaporSource>;
    const read = (name: string) => rasterTile(config[name].href, { x, y, z }, signal);

    const names = Object.keys(config).filter((name) => name !== "quality");
    const [quality, ...rasters] = await Promise.all([config.quality ? read("quality") : null, ...names.map(read)]);
    const { width, height } = rasters[0];
    const sum = new Float32Array(width * height);
    rasters.forEach(({ values, nodata }, i) => {
      const factor = config[names[i]].factor;
      for (let p = 0; p < sum.length; p++) {
        const v = values[p];
        sum[p] = v === nodata ? Number.NaN : sum[p] + factor * v; // NaN stays NaN
      }
    });
    if (names.some((name) => config[name].factor < 0)) {
      for (let p = 0; p < sum.length; p++) if (sum[p] < 0) sum[p] = 0;
    }

    const bands = new Map([["aeti", band(device, sum, "r32float", width, height)]]);
    if (quality) bands.set("quality", band(device, quality.values, "r8unorm", quality.width, quality.height));
    const { forwardTransform, inverseTransform } = multiDescriptor!.primary.levels[z].tileTransform(x, y);
    const byteLength = sum.byteLength + (quality?.values.byteLength ?? 0);
    return { bands, forwardTransform, inverseTransform, width, height, byteLength };
  }

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
        const key = indices.map(({ x, y, z }) => `${z}/${x}/${y}`).join();
        if (key !== viewKey) {
          viewTiles = indices;
          viewKey = key;
          viewListeners.forEach((listener) => listener());
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
 * A MultiCOGLayer source: a raster in the sum (t0, t1, …), or the quality raster. Once
 * opened, the layer gets the raster itself as `url`, so it doesn't read the header again.
 */
type WaporSource = { url: string | GeoTIFF; href: string; factor: number };

/** The samples of a one-band tile, in either layout. */
const samples = (array: RasterArray) => (array.layout === "band-separate" ? array.bands[0] : array.data);

function band(device: Texture["device"], data: RasterTypedArray, format: "r32float" | "r8unorm", width: number, height: number) {
  const texture = device.createTexture({ data, format, width, height, sampler: { minFilter: "nearest", magFilter: "nearest" } });
  return { texture, uvTransform: [0, 0, 1, 1] as [number, number, number, number], width, height, byteLength: data.byteLength };
}

// MultiCOGLayer opens its rasters again whenever it gets a new `sources` object. While
// playing, the map has two periods' layers: the one shown and the next.
const sourcesByKey = new Map<string, Record<string, WaporSource>>();

/**
 * The period's raster (or sum of rasters), coloured with its colour map; nothing where
 * it has no data. With the period's quality raster, pixels with a gap longer than
 * `maxGap` dekads are left out too (null: none). No layer without a period: a hidden
 * MultiCOGLayer would still open its sources.
 */
export function waporLayer({
  period,
  maxGap = null,
  onLoad,
  id = "wapor-aeti",
  hidden = false,
  onViewportLoad,
}: {
  period: WaporPeriod | null;
  maxGap?: number | null;
  onLoad?: () => void;
  id?: string;
  /** Loads its tiles, but doesn't draw them (the next period while playing). */
  hidden?: boolean;
  /** Runs when every tile in view has loaded. */
  onViewportLoad?: () => void;
}) {
  if (!period) return null;
  const key = `${period.key} ${period.qualityUrl}`;
  let sources = sourcesByKey.get(key);
  if (!sources) {
    const source = (href: string, factor: number) => ({ url: opened.get(href) ?? href, href, factor });
    sources = {};
    period.terms.forEach(({ url, factor }, i) => (sources![`t${i}`] = source(url, factor)));
    if (period.qualityUrl) sources.quality = source(period.qualityUrl, 1);
    sourcesByKey.set(key, sources);
    for (const old of sourcesByKey.keys()) if (sourcesByKey.size > 4) sourcesByKey.delete(old);
  }
  return new GlobeMultiCOGLayer({
    id,
    visible: !hidden,
    sources: sources as Record<string, { url: string }>,
    concurrencyLimiter: LIMITER,
    composite: period.qualityUrl ? { r: "aeti", g: "quality" } : { r: "aeti" },
    // A new maxGap only re-renders the loaded tiles.
    renderPipeline: [{ module: AetiRamp, props: rampProps(period.ramp, maxGap) }],
    // Linear filtering would blend values with the -9999 nodata at coasts.
    resampling: "nearest",
    parameters: { depthCompare: "always" },
    onGeoTIFFLoad: onLoad,
    // (Passed on to the TileLayer, though MultiCOGLayer's typings leave it out.)
    ...({ onViewportLoad } as object),
  });
}
