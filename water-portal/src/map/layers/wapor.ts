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
 * In four modules: the variables (wapor-variables.ts: the catalogue, units, colours,
 * where the rasters are), the periods (wapor-period.ts: which rasters a range is added
 * up from, and whether they're published), the rasters and tiles (wapor-tiles.ts: read,
 * decoded, kept, added up), and here the view and its layer: which tiles are in view at
 * which level, the layer that draws them, the values in view (for the colours) and the
 * value under the pointer. The panels and legends need only the first two.
 */
import type { Viewport } from "@deck.gl/core";
import type { TileLayer } from "@deck.gl/geo-layers";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import { GeoTIFF, type RasterTypedArray } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import { type DayRange } from "../../toolbar/range-rules";
import type { LngLat } from "../places";
import { boxInL2 } from "./wapor-l2";
import { AetiRamp, rampProps, type WaporRamp } from "./wapor-shader";
import { publishedWaporPeriod, waporAvailable, type RasterSum, type WaporPeriod } from "./wapor-period";
import { LIMITER, assemble, cachedAt, level, loadSources, loadedTile, openWapor, opened, ownUrls, sourceUrls, type PeriodTile, type TileIndex } from "./wapor-tiles";
import { waporHasL2, type WaporLevel, type WaporStretch, type WaporVariable } from "./wapor-variables";

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
  await openWapor(shownPeriod(checked));
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

function setView(level: WaporLevel, indices: TileIndex[], wanted: WaporLevel) {
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

/**
 * Which overview to show: the coarsest whose pixels are at most this many CSS pixels on
 * screen, at the centre of the view. At 2, the raster is magnified up to 2× (4× in
 * device pixels on a retina screen), and the full 300 m only loads from about zoom 8.
 */
const CSS_PX_PER_RASTER_PX = 2;

/** An L1 pixel is this many L2 pixels across. */
const L1_PER_L2 = 3;

/**
 * L2 is shown once its full 100 m would be picked, i.e. its first overview (200 m) is
 * magnified more than CSS_PX_PER_RASTER_PX. That overview isn't worth reading: it's
 * 2.25 times L1's pixels for 1.5 times the detail. Until then L1's 300 m is magnified
 * up to 1.5 times more than usual.
 */
const L2_FROM = 2 / L1_PER_L2; // L1's pixel size, times this, is L2's first overview's

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
let visibleBoxOf: { viewport: Viewport; box: Box | null } | null = null;
function visibleBox(viewport: Viewport): Box | null {
  // (Asked by each of the periods' layers for the same view.)
  if (visibleBoxOf && (visibleBoxOf.viewport === viewport || viewport.equals(visibleBoxOf.viewport))) return visibleBoxOf.box;
  const box = visibleBoxOnce(viewport);
  visibleBoxOf = { viewport, box };
  return box;
}
function visibleBoxOnce(viewport: Viewport): Box | null {
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

type Level = {
  metersPerPixel: number;
  matrixWidth: number;
  matrixHeight: number;
  projectedTileCorners(col: number, row: number): { topLeft: [number, number]; bottomRight: [number, number] };
};

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
   * to the quality band if there is one. A variable's rasters (and the quality raster
   * of a 300 m one) share one grid, so tile (x, y, z) covers the same pixels in each;
   * a part on another grid is sampled onto it (see sumTiles and resampledTile), and so
   * is L1 where L2 has no data (see assemble).
   */
  async _getTileData(...[tile, options]: Parameters<MultiCOGLayer["_getTileData"]>) {
    const { x, y, z } = tile.index;
    const { multiDescriptor } = this.state;
    const { device, signal } = options;
    const { period } = this.props as unknown as { period: RasterSum };

    const get = await loadSources(period, { x, y, z }, true, signal);
    const { values, quality, width, height } = assemble(period, true, get);
    const bands = new Map([["aeti", band(device, values, "r32float", width, height)]]);
    if (quality) bands.set("quality", band(device, quality, "r8unorm", width, height));
    const { forwardTransform, inverseTransform } = multiDescriptor!.primary.levels[z].tileTransform(x, y);
    const byteLength = values.byteLength + (quality?.byteLength ?? 0);
    return { bands, forwardTransform, inverseTransform, width, height, byteLength };
  }

  renderLayers() {
    // The inner TileLayer's tileset picks the tiles. deck.gl builds it once, from the
    // first class it's given, so the subclass holds no per-render state; the period
    // stays the same for a layer's id (see map.ts).
    const layer = super.renderLayers() as TileLayer | null;
    if (!layer) return null;
    const Tileset = layer.props.TilesetClass;
    const { period } = this.props as unknown as { period: RasterSum };
    class GlobeTileset extends Tileset {
      getTileIndices({ viewport }: { viewport: Viewport }) {
        // Levels run from the coarsest (z = 0) to full resolution (the last); the
        // descriptor is private in the typings.
        const { levels } = (this as unknown as { descriptor: { levels: Level[] } }).descriptor;
        const last = levels.length - 1;
        const box = visibleBox(viewport);
        viewBox = box;
        const { width, height } = viewport;
        const a = viewport.unproject([width / 2 - 5, height / 2]);
        const b = viewport.unproject([width / 2 + 5, height / 2]);
        if (!box) {
          setView(period.level, [], viewLevel);
          return [];
        }

        const metersPerCssPixel = metersBetween(a, b) / 10;
        let z = 0;
        while (z < last && levels[z].metersPerPixel > CSS_PX_PER_RASTER_PX * metersPerCssPixel) z++;
        // L2 once its full resolution is due (see L2_FROM), if the view reaches its countries.
        const l1Meters = levels[last].metersPerPixel * (period.level === "L2" ? L1_PER_L2 : 1);
        const due = l1Meters * L2_FROM > CSS_PX_PER_RASTER_PX * metersPerCssPixel;
        const wanted = due && boxInL2(box.west, box.south, box.east, box.north) ? "L2" : "L1";

        // A lon/lat grid: every tile spans the same degrees, from the top left one's
        // corner (not every variable's grid reaches the poles).
        const level = levels[z];
        const { matrixWidth, matrixHeight } = level;
        const { topLeft: [west, north], bottomRight: [east, south] } = level.projectedTileCorners(0, 0);
        const [degX, degY] = [east - west, north - south];
        const around = Math.round(360 / degX); // tiles around the globe, if the grid went all the way
        const x0 = Math.floor((box.west - west) / degX);
        const x1 = Math.min(Math.floor((box.east - west) / degX), x0 + around - 1);
        const y0 = Math.max(0, Math.floor((north - box.north) / degY));
        const y1 = Math.min(matrixHeight - 1, Math.floor((north - box.south) / degY));
        const indices = [];
        for (let x = x0; x <= x1; x++) {
          const col = ((x % around) + around) % around;
          if (col < matrixWidth) for (let y = y0; y <= y1; y++) indices.push({ x: col, y, z });
        }
        setView(period.level, indices, wanted);

        // At the other level than the one shown: none, but an L1 layer keeps those it
        // has loaded, to show until L2's are in (see map.ts).
        const shown = period.level === "L2" ? wanted === "L2" : wanted === "L1" || !period.l2;
        if (!shown) return period.level === "L1" ? indices.filter((index) => loadedTile(period, true, cachedAt(index))) : [];
        return indices;
      }
    }
    return layer.clone({ TilesetClass: GlobeTileset });
  }
}

/**
 * A MultiCOGLayer source: a raster in the sum (t0, t1, …) on the period's grid, or the
 * quality raster; the layer builds its tile grid from them. Once opened, the layer gets
 * the raster itself as `url`, so it doesn't read the header again.
 */
type WaporSource = { url: string | GeoTIFF };

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

export function band(device: Texture["device"], data: RasterTypedArray, format: "r32float" | "r8unorm", width: number, height: number) {
  const texture = device.createTexture({ data, format, width, height, sampler: { minFilter: "nearest", magFilter: "nearest" } });
  return { texture, uvTransform: [0, 0, 1, 1] as [number, number, number, number], width, height, byteLength: data.byteLength };
}

// MultiCOGLayer opens its rasters again whenever it gets a new `sources` object. While
// playing, the map has two periods' layers: the one shown and the next.
const sourcesByKey = new Map<string, Record<string, WaporSource>>();

/**
 * The period's raster (or sum of rasters), coloured with `ramp`; nothing where
 * it has no data. With the period's quality raster, pixels with a gap longer than
 * `maxGap` dekads are left out too (null: none). No layer without a period: a hidden
 * MultiCOGLayer would still open its sources.
 */
export function waporLayer({
  period,
  ramp,
  maxGap = null,
  onLoad,
  id = "wapor-aeti",
  hidden = false,
  opacity = 1,
  onViewportLoad,
}: {
  period: RasterSum | null;
  ramp: WaporRamp;
  maxGap?: number | null;
  onLoad?: () => void;
  id?: string;
  /** Loads its tiles, but doesn't draw them (the next period while playing). */
  hidden?: boolean;
  /** How opaque it's drawn (fading in over the period before, see map.ts). */
  opacity?: number;
  /** Runs when every tile in view has loaded. */
  onViewportLoad?: () => void;
}) {
  if (!period) return null;
  const key = `${period.key} ${period.qualityUrl}`;
  let sources = sourcesByKey.get(key);
  if (!sources) {
    const source = (url: string) => ({ url: opened.get(url) ?? url });
    sources = {};
    period.terms.forEach(({ url, grid }, i) => grid || (sources![`t${i}`] = source(url)));
    if (period.qualityUrl) sources.quality = source(period.qualityUrl);
    sourcesByKey.set(key, sources);
    sourceUrls.set(key, ownUrls(period));
    for (const old of sourcesByKey.keys()) {
      if (sourcesByKey.size <= 4) break;
      sourcesByKey.delete(old);
      sourceUrls.delete(old);
    }
  }
  return new GlobeMultiCOGLayer({
    id,
    visible: !hidden,
    opacity,
    sources: sources as Record<string, { url: string }>,
    concurrencyLimiter: LIMITER,
    composite: period.qualityUrl ? { r: "aeti", g: "quality" } : { r: "aeti" },
    // A new ramp or maxGap only re-renders the loaded tiles.
    renderPipeline: [{ module: AetiRamp, props: rampProps(ramp, maxGap, period.variable.signed) }],
    // Linear filtering would blend values with the -9999 nodata at coasts.
    resampling: "nearest",
    parameters: { depthCompare: "always" },
    onGeoTIFFLoad: onLoad,
    // (Passed on to the TileLayer, though MultiCOGLayer's typings leave it out; `period`
    // for _getTileData.)
    ...({ onViewportLoad, period } as object),
  });
}
