/*
 * WaPOR v3 level 1 (global) variables: actual evapotranspiration and interception
 * (AETI), its parts transpiration (T), evaporation (E) and interception (I), net
 * primary production (NPP), all at 300 m, precipitation (PCP, about 5 km) and reference
 * evapotranspiration (RET, about 30 km: 0.3125° × 0.25°, AgERA5's grid). They're
 * read straight from FAO's bucket (it sends CORS headers). WaPOR publishes one COG per
 * dekad, and for some variables per calendar month and calendar year too (see
 * WAPOR_VARIABLES; NPP's years are total biomass production's, converted). A range is
 * added up from one or more of them (see wapor-plan.ts for which), tile by tile as
 * they load, and always shown as the average per day over the
 * range, e.g. in mm/day. A range can start and end on any day: of a dekad it only
 * partly covers, it takes those days' share of the dekad's raster.
 *
 * A variable can also be made from others: PCP − AETI is PCP's sum minus AETI's, and
 * water productivity (WP) NPP's sum over AETI's (the ratio of the totals). PCP − AETI is on
 * AETI's 300 m grid, with PCP's 5 km pixels sampled onto it (see resampledTile).
 *
 * Catalogue: https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets/L1-AETI-D
 * (-M, -A; L1-T-D, …). AETI's colours are WaPOR's own style AETI-D-INT16, the others'
 * ColorBrewer ramps; the stops are stretched to the values in view (see waporViewRange).
 *
 * A dekad of a 300 m variable also comes with L1-QUAL-NDVI-D, on the same grid: for
 * each pixel, how many dekads it has been since the last valid satellite observation
 * behind the NDVI (0: observed this dekad). The variables are modelled from it, so a
 * long gap means a less reliable value; the quality slider hides those pixels. It's
 * published some dekads after them.
 *
 * For some countries (see wapor-l2.ts) WaPOR also publishes level 2: the same variables
 * (not PCP) for the same periods at 100 m, on a grid three times as fine that lines up
 * with L1's. It's only read where L1 runs out: when its full 100 m is due (see
 * L2_FROM), and the view reaches those countries. So a view loads one level or the
 * other, never both. Pixels L2 has no data for (other countries, in a view across a
 * border) are filled from L1, sampled onto L2's grid.
 *
 * The same layer draws GAEZ's maps (gaez.ts), which have no time: rasters added up
 * as a period's are (a RasterSum), without the period.
 *
 * In five modules: the variables (wapor-variables.ts: the catalogue, units, colours,
 * where the rasters are), the periods (wapor-period.ts: which rasters a range is added
 * up from, and whether they're published), the rasters and tiles (wapor-tiles.ts: read,
 * decoded, kept, added up), the layer that draws them (wapor-layer.ts, loaded with the
 * first raster), and here the view: which tiles are in view at which level, the values
 * in view (for the colours) and the value under the pointer. The panels and legends
 * need only the first two.
 */
import type { Viewport } from "@deck.gl/core";
import { isProjectedViewport } from "../flat/projected-viewport";
import { type DayRange } from "../../toolbar/range-rules";
import type { LngLat } from "../places";
import type { WaporLayerProps } from "./wapor-layer";
import { publishedWaporPeriod, waporAvailable, type RasterSum, type WaporPeriod } from "./wapor-period";
import { assemble, cachedAt, level, loadSources, loadedTile, openWapor, opened, waporOpened, type PeriodTile, type TileIndex } from "./wapor-tiles";
import { waporHasL2, type WaporLevel, type WaporStretch, type WaporVariable } from "./wapor-variables";

// The layer (wapor-layer.ts: deck.gl's COG layer, with the GeoTIFF reader behind it) is
// loaded along with the first raster, not with the page: the Country view needs neither.
let layerModule: typeof import("./wapor-layer") | null = null;
let layerLoading: Promise<void> | null = null;
const loadLayer = () =>
  (layerLoading ??= import("./wapor-layer").then((m) => {
    layerModule = m;
  }));

/** Open a period's rasters, and load the layer that draws them. */
export const prepareWapor = (period: RasterSum) => Promise.all([openWapor(period), loadLayer()]).then(() => {});

/** Whether a period can be drawn straight away: its rasters open, and the layer loaded. */
export const waporReady = (period: RasterSum) => layerModule !== null && waporOpened(period);

/** The period's layer (see wapor-layer.ts); null until prepareWapor has done. */
export const waporLayer = (props: WaporLayerProps) => layerModule?.waporLayer(props) ?? null;

/** A period that has been checked, ready to show, and its quality raster's state. */
export interface CheckedWaporPeriod {
  /** Without its quality raster if that isn't published. */
  period: WaporPeriod;
  /** A dekad: whether its quality raster is published (null: not a dekad). */
  quality: "ready" | "missing" | null;
}

/**
 * What to show for a range, checked: the rasters published, and those of the level the
 * view shows opened, so the map can show it straight away. Null if it can't be made;
 * rejects if the bucket can't be reached.
 */
export async function checkedWaporPeriod(variable: WaporVariable, range: DayRange): Promise<CheckedWaporPeriod | null> {
  const period = await publishedWaporPeriod(variable, range);
  if (!period) return null;
  // (The quality raster and L2, checked at once: each is a round trip to the bucket.)
  const [quality, l2Published] = await Promise.all([
    period.qualityUrl ? waporAvailable(period.qualityUrl).catch(() => false) : false,
    waporHasL2(variable) ? publishedWaporPeriod(variable, range, "L2").catch(() => null) : null,
  ]);
  const l1 = { ...period, qualityUrl: quality ? period.qualityUrl : null };
  const l2 = l2Published ? await checkedL2(l2Published, l1) : null;
  const checked = { ...l1, l2 };
  await prepareWapor(shownPeriod(checked));
  return { period: checked, quality: period.qualityUrl ? (quality ? "ready" : "missing") : null };
}

/** An L2 period as published, filled from its L1 one, with its quality raster if that's published. */
async function checkedL2(l2: WaporPeriod, l1: WaporPeriod): Promise<WaporPeriod> {
  // Its filled pixels have L1's quality: with both quality rasters, or neither.
  const quality = l1.qualityUrl && l2.qualityUrl && (await waporAvailable(l2.qualityUrl).catch(() => false));
  return { ...l2, qualityUrl: quality ? l2.qualityUrl : null, fill: l1 };
}

/**
 * The tiles the map shows at each level (the same for every period of a variable at
 * a level: they share one grid), the level the view asks for, and the part of the
 * globe in view.
 */
const viewTiles: Record<WaporLevel, TileIndex[]> = { L1: [], L2: [] };
let viewLevel: WaporLevel = "L1";
let viewBox: Box | null = null;
let viewKey = "";
const viewListeners = new Set<() => void>();
const levelListeners = new Set<(level: WaporLevel) => void>();

/** Run `callback` whenever the map shows other tiles (the view moved). Returns a function that stops it. */
export function onWaporView(callback: () => void) {
  viewListeners.add(callback);
  return () => viewListeners.delete(callback);
}

/**
 * Run `callback` whenever the view asks for the other level (see CSS_PX_PER_RASTER_PX).
 * It runs while deck.gl picks tiles: don't update layers from it straight away.
 */
export function onWaporLevel(callback: (level: WaporLevel) => void) {
  levelListeners.add(callback);
  return () => levelListeners.delete(callback);
}


/** The level a period is shown at in the current view (L1 if it has no L2). */
export const waporShownLevel = (period: WaporPeriod): WaporLevel => (viewLevel === "L2" && period.l2 ? "L2" : "L1");

const shownPeriod = (period: WaporPeriod) => (waporShownLevel(period) === "L2" ? period.l2! : period);

/** The level the view asks for. */
export const waporViewLevel = () => viewLevel;

/** The layer's tileset (wapor-layer.ts) tells the view what it shows: the part of the globe, and the tiles at a level. */
export function setView(level: WaporLevel, indices: TileIndex[], wanted: WaporLevel, box: Box | null) {
  viewBox = box;
  viewTiles[level] = indices;
  if (wanted === "L1") viewTiles.L2 = []; // (no L2 layer to pick them)
  const levelChanged = wanted !== viewLevel;
  viewLevel = wanted;
  const key = (["L1", "L2"] as const).map((l) => viewTiles[l].map(({ x, y, z }) => `${z}/${x}/${y}`).join()).join(" ");
  if (levelChanged) levelListeners.forEach((listener) => listener(wanted));
  if (`${viewLevel} ${key}` === viewKey) return;
  viewKey = `${viewLevel} ${key}`;
  viewListeners.forEach((listener) => listener());
}

/** Whether every tile the map shows has been loaded for this period. */
export function waporBuffered(period: WaporPeriod) {
  const shown = shownPeriod(period);
  return viewTiles[shown.level].every((index) => loadedTile(shown, true, cachedAt(index)));
}

/**
 * Load the tiles the map shows for a period, ahead of showing it. A tile that fails
 * is left out (the map would fail on it too); rejects only when `signal` aborts.
 */
export async function bufferWapor(period: WaporPeriod, signal: AbortSignal) {
  const shown = shownPeriod(period);
  await Promise.all(
    viewTiles[shown.level].map((index) =>
      loadSources(shown, index, true, signal).catch((err) => {
        if (signal.aborted) throw err;
      }),
    ),
  );
  signal.throwIfAborted();
}

export interface Box {
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
let visibleBoxOf: { viewport: Viewport; box: Box | null } | null = null;
export function visibleBox(viewport: Viewport): Box | null {
  // (Asked by each of the periods' layers for the same view.)
  if (visibleBoxOf && (visibleBoxOf.viewport === viewport || viewport.equals(visibleBoxOf.viewport))) return visibleBoxOf.box;
  const box = visibleBoxOnce(viewport);
  visibleBoxOf = { viewport, box };
  return box;
}
function visibleBoxOnce(viewport: Viewport): Box | null {
  // The flat map: its viewport knows its bounds (the plane goes on past its edges, so
  // the globe's test below would find no edge).
  if (isProjectedViewport(viewport)) {
    const [west, south, east, north] = viewport.getBounds();
    return west < east && south < north ? { west, south, east, north } : null;
  }
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

/** At most this many of the values in view are sorted for the percentiles (evenly spread). */
const SAMPLE = 2 ** 18;

/**
 * The tiles in view as waporViewRange last made them (by "z/x/y"), for one period and
 * quality filter: it runs whenever a tile comes in, and a period can be many rasters
 * (WP: 12 months of NPP and a year of AETI), so it doesn't add them up again.
 */
let assembled = { key: "", tiles: new Map<string, PeriodTile>() };

/**
 * The range of a period's values on screen, without `cut`% of the pixels at either
 * end: the pixels with data in the part of the globe in view, of the tiles in view
 * that have loaded, without those the quality filter hides (`maxGap`, as in
 * waporLayer). Null if there are none (yet). Percentiles come from a sorted sample of
 * the values (every so many), so a few extreme ones (a ratio over almost nothing) don't
 * skew them, as they would bins of the range.
 */
export function waporViewRange(period: WaporPeriod, maxGap: number | null, cut: WaporStretch): [number, number] | null {
  const box = viewBox;
  if (!box) return null;
  const centre = (box.west + box.east) / 2;
  const unwrap = (lon: number) => centre + ((((lon - centre) % 360) + 540) % 360) - 180;
  const drawn = shownPeriod(period);
  const { signed } = period.variable;
  const filter = maxGap !== null;

  // The tiles in view, each with the columns inside the box (the values are read in
  // place: no copy of a tile per pass).
  const inView: { tile: PeriodTile; cols: boolean[] }[] = [];
  const key = `${drawn.variable.id} ${drawn.key} ${drawn.qualityUrl} ${filter}`;
  const made = assembled.key === key ? assembled.tiles : new Map<string, PeriodTile>();
  assembled = { key, tiles: new Map() }; // (only those still in view)
  for (const index of viewTiles[drawn.level]) {
    const at = `${index.z}/${index.x}/${index.y}`;
    let tile = made.get(at);
    if (!tile) {
      const get = cachedAt(index);
      if (!loadedTile(drawn, filter, get)) continue;
      tile = assemble(drawn, filter, get);
    }
    assembled.tiles.set(at, tile);
    const { width, transform: [a, , c] } = tile;
    // Columns inside the box, by their pixel centres (the grid is lon/lat).
    const cols = Array.from({ length: width }, (_, i) => {
      const lon = unwrap(a * (i + 0.5) + c);
      return lon >= box.west && lon <= box.east;
    });
    inView.push({ tile, cols });
  }
  /** Each shown value in view (as in the shader: no negative values unless signed, none hidden by the quality filter). */
  const each = (fn: (v: number) => void) => {
    for (const { tile, cols } of inView) {
      const { values, quality, width, height, transform: [, , , , e, f] } = tile;
      for (let row = 0; row < height; row++) {
        const lat = e * (row + 0.5) + f;
        if (lat < box.south || lat > box.north) continue;
        for (let col = 0; col < width; col++) {
          if (!cols[col]) continue;
          const p = row * width + col;
          const v = values[p];
          if (!(signed ? v === v : v >= 0) || (quality && quality[p] > maxGap!)) continue;
          fn(v);
        }
      }
    }
  };
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  each((v) => {
    total++;
    if (v < min) min = v;
    if (v > max) max = v;
  });
  if (!(max >= min)) return null;
  if (cut === 0 || max === min) return [min, max];

  const every = Math.max(1, Math.ceil(total / SAMPLE));
  const sample = new Float32Array(Math.ceil(total / every));
  let n = 0;
  let k = 0;
  each((v) => {
    if (k++ % every === 0) sample[n++] = v;
  });
  const sorted = sample.subarray(0, n).sort();
  /** The value below which `share` of the pixels lie. */
  const quantile = (share: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(share * (n - 1))))];
  return [quantile(cut / 100), quantile(1 - cut / 100)];
}

/** A raster's pixel under the pointer, as the map draws it (see waporValueAt). */
export interface WaporPixelValue {
  /** Its value, per day as the rasters (null: no data there, or hidden by the quality slider). */
  value: number | null;
  /** The level it's read from (L1 where L2 has no tile loaded yet, as the map shows). */
  level: WaporLevel;
  /** The size of a full-resolution pixel, in degrees (lon, lat). */
  fullPixel: [number, number];
}

/** The last tile looked up by waporValueAt (the pointer stays on one for a while). */
let hoverTile: { key: string; tile: PeriodTile } | null = null;

/**
 * A period's (or static map's) pixel at a point, from the tiles the map shows: none
 * read, so null where none is loaded there. At L2, from L1's tiles where L2's aren't in
 * yet (the map shows L1's until they are).
 */
export function waporValueAt(period: RasterSum, [lng, lat]: LngLat, maxGap: number | null): WaporPixelValue | null {
  const levels = period.level === "L1" && period.l2 && viewLevel === "L2" ? [period.l2, period] : [period];
  for (const drawn of levels) {
    for (const index of viewTiles[drawn.level]) {
      const get = cachedAt(index);
      const grid = get(drawn.terms[0]);
      if (!grid) continue;
      const { width, height, transform: [a, , c, , e, f] } = grid;
      // (Longitudes wrap: from the tile's west edge, eastwards.)
      const col = Math.floor(((((lng - c) % 360) + 360) % 360) / a);
      const row = Math.floor((lat - f) / e);
      if (col >= width || row < 0 || row >= height || !loadedTile(drawn, true, get)) continue;
      const at = `${index.z}/${index.x}/${index.y}`;
      const key = `${drawn.key} ${drawn.qualityUrl} ${at}`;
      if (hoverTile?.key !== key) {
        // (As the stretch pass made it, if it did, with the quality band too.)
        const made = assembled.key === `${drawn.variable.id} ${drawn.key} ${drawn.qualityUrl} true` ? assembled.tiles.get(at) : undefined;
        hoverTile = { key, tile: made ?? assemble(drawn, true, get) };
      }
      const { values, quality } = hoverTile.tile;
      const p = row * width + col;
      const v = values[p];
      // As in the shader: no negative values (unless signed), and no quality value (255) is hidden too.
      const hidden = maxGap !== null && !!quality && quality[p] > maxGap;
      const shown = (drawn.variable.signed ? v === v : v >= 0) && !hidden;
      const geotiff = opened.get(drawn.terms[0].url);
      const full = geotiff ? level(geotiff, geotiff.overviews.length).transform : [a, 0, 0, 0, e];
      return { value: shown ? v : null, level: drawn.level, fullPixel: [Math.abs(full[0]), Math.abs(full[4])] };
    }
  }
  return null;
}
