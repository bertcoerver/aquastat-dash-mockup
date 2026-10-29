/*
 * WaPOR's rasters and their tiles: the rasters opened (their headers read once, kept
 * least recently used first), the tiles decoded (kept the same way), a period's tile
 * added up from its rasters' (with L1's sampled onto L2's grid where L2 has no data),
 * and the static maps' values. wapor.ts (the layer and the view) and the playback
 * buffer read through here.
 */
import { GeoTIFF, PerOriginSemaphore, defaultDecoderPool, type RasterArray, type RasterTypedArray } from "@developmentseed/geotiff";
import { cogImage, cogTile } from "../../local/cog-pixel";
import { type RasterSum } from "./wapor-period";
import { pixelArea, type WaporVariable } from "./wapor-variables";

/** A period's own rasters (not those sampled onto its grid), and its quality raster. */
export const ownUrls = (period: RasterSum) => [...period.terms.filter((t) => !t.grid).map((t) => t.url), ...(period.qualityUrl ? [period.qualityUrl] : [])];

/** Whether a period's rasters are open, so its layer doesn't open them again (an L2 period's, see map.ts). */
export const waporOpened = (period: RasterSum) => ownUrls(period).every((url) => opened.has(url));

/** Open a period's rasters. */
export const openWapor = (period: RasterSum) => Promise.all(ownUrls(period).map(openRaster)).then(() => {});

/**
 * Opened rasters, by URL: their headers are read once, by whichever needs them first
 * (the map layer or the playback buffer). The least recently used are dropped first.
 */
const MAX_OPEN_RASTERS = 64;
// The bucket speaks HTTP/2, so more than the browser's 6 per host for HTTP/1.1 (the
// library's default): playback loads several frames' tiles at once.
export const LIMITER = new PerOriginSemaphore({ maxRequests: 16 });
export const rasters = new Map<string, Promise<GeoTIFF>>();
/** The rasters of each layer's `sources` (by its key; see waporLayer): kept open while a layer draws them. */
export const sourceUrls = new Map<string, string[]>();
export const opened = new Map<string, GeoTIFF>();

function openRaster(url: string): Promise<GeoTIFF> {
  let raster = rasters.get(url);
  if (raster) {
    rasters.delete(url);
  } else {
    raster = GeoTIFF.fromUrl(url, { concurrencyLimiter: LIMITER });
    raster.then((geotiff) => rasters.get(url) === raster && opened.set(url, geotiff), () => rasters.delete(url));
  }
  rasters.set(url, raster);
  if (rasters.size > MAX_OPEN_RASTERS) {
    // (Not those a layer draws: playback opens many ahead, and the map would blank
    // until the one shown is read again.)
    const drawn = new Set([...sourceUrls.values()].flat());
    for (const old of rasters.keys()) {
      if (rasters.size <= MAX_OPEN_RASTERS) break;
      if (drawn.has(old)) continue;
      rasters.delete(old);
      opened.delete(old);
    }
  }
  return raster;
}

/** One tile of one raster, decoded. */
interface RasterTile {
  values: RasterTypedArray;
  width: number;
  height: number;
  nodata: number | null;
  /** Whether any pixel is nodata (looked for once: it's asked at every hover and stretch). */
  hasNodata: boolean;
  /** Pixel (col, row) to lon/lat: [a, b, c, d, e, f], lon = a·col + b·row + c, lat = d·col + e·row + f. */
  transform: RasterArray["transform"];
}

/**
 * Decoded tiles, by raster and tile (x, y, z), so playback can load them ahead and
 * periods that share a raster share its tiles. The least recently used go first.
 */
const TILE_CACHE_BYTES = 384 * 2 ** 20;
type TileEntry = { tile: Promise<RasterTile>; bytes: number; done: boolean; value?: RasterTile };
export const tiles = new Map<string, TileEntry>();
let tileBytes = 0;
const tileListeners = new Set<() => void>();

/** Run `callback` whenever a tile has loaded. Returns a function that stops it. */
export function onWaporTile(callback: () => void) {
  tileListeners.add(callback);
  return () => tileListeners.delete(callback);
}

/** A raster's tiles to read: its own, or sampled onto the grid of the raster `grid`. */
type TileSource = { url: string; grid?: string };

const tileKey = ({ url, grid }: TileSource, { x, y, z }: TileIndex) => `${z}/${x}/${y} ${url}${grid ? ` on ${grid}` : ""}`;

/** Tile (x, y, z) of a raster, or of a term (sampled onto the period's grid if need be). */
function sourceTile(source: TileSource, index: TileIndex, signal?: AbortSignal) {
  return source.grid ? resampledTile(source.url, source.grid, index, signal) : rasterTile(source.url, index, signal);
}

/** A raster's level: z = 0 is its coarsest overview, the last its full resolution. */
export function level(geotiff: GeoTIFF, z: number) {
  const images = [geotiff, ...geotiff.overviews]; // full resolution first
  return images[images.length - 1 - z];
}

function rasterTile(url: string, { x, y, z }: TileIndex, signal?: AbortSignal): Promise<RasterTile> {
  return cachedTile(tileKey({ url }, { x, y, z }), signal, async () => {
    const geotiff = await openRaster(url);
    const pool = defaultDecoderPool();
    const { array } = await level(geotiff, z).fetchTile(x, y, { boundless: false, pool, signal });
    const values = samples(array);
    const { nodata } = array;
    return { values, width: array.width, height: array.height, nodata, hasNodata: nodata !== null && values.includes(nodata), transform: array.transform };
  });
}

/** A level of a raster to sample from: its grid, and its tiles. */
interface SampleSource {
  transform: RasterArray["transform"];
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tile(x: number, y: number): Promise<RasterTile>;
}

/** The coarsest level of a raster that's still at least as fine as `pixel` (degrees). */
async function levelSource(url: string, pixel: number, signal?: AbortSignal): Promise<SampleSource> {
  const from = await openRaster(url);
  let sz = from.overviews.length; // full resolution
  while (sz > 0 && Math.abs(level(from, sz - 1).transform[0]) <= pixel) sz--;
  const { transform, width, height, tileWidth, tileHeight } = level(from, sz);
  return { transform, width, height, tileWidth, tileHeight, tile: (x, y) => rasterTile(url, { x, y, z: sz }, signal) };
}

/**
 * A raster's full resolution, read with the Local panel's lean reader (cog-pixel.ts):
 * its first IFD and a tile, instead of every overview's tags as well, which are most
 * of the bytes of a few tiles' worth of sampling.
 */
async function fullSource(url: string, signal?: AbortSignal): Promise<SampleSource> {
  const image = await cogImage(url);
  if (!image) throw new Error(`No such raster: ${url}`);
  const { transform, width, height, tileWidth, tileHeight, nodata } = image;
  const tile = (x: number, y: number) =>
    cachedTile(`full/${x}/${y} ${url}`, signal, async () => {
      const values = await cogTile(url, x, y, signal);
      return {
        values,
        width: tileWidth,
        height: tileHeight,
        nodata,
        hasNodata: nodata !== null && values.includes(nodata),
        transform: [transform[0], 0, transform[2] + transform[0] * x * tileWidth, 0, transform[4], transform[5] + transform[4] * y * tileHeight],
      };
    });
  return { transform, width, height, tileWidth, tileHeight, tile };
}

/**
 * Tile (x, y, z) of the raster `grid`, with the raster `url` sampled onto its pixels:
 * the value of the pixel each one's centre falls in (both are lon/lat grids). It's read
 * from the coarsest level of `url` that's still at least as fine as the tile: at the
 * grid's full resolution that's `url`'s own (nothing is sampled onto a coarser grid),
 * read leanly. The values stay raw; NaN where `url` has none (e.g. PCP beyond 60° N and S).
 */
export function resampledTile(url: string, grid: string, { x, y, z }: TileIndex, signal?: AbortSignal): Promise<RasterTile> {
  return cachedTile(tileKey({ url, grid }, { x, y, z }), signal, async () => {
    const onto = await openRaster(grid);
    const target = level(onto, z);
    const [a, , c, , e, f] = target.transform;
    const [col0, row0] = [x * target.tileWidth, y * target.tileHeight];
    const width = Math.min(target.tileWidth, target.width - col0);
    const height = Math.min(target.tileHeight, target.height - row0);

    const source = z === onto.overviews.length ? await fullSource(url, signal) : await levelSource(url, Math.abs(a), signal);
    const [sa, , sc, , se, sf] = source.transform;
    const { tileWidth: tw, tileHeight: th } = source;
    // The source's column of each column of the tile, and row of each row (-1: outside it).
    const inside = (n: number, size: number, at: (i: number) => number) =>
      Int32Array.from({ length: n }, (_, i) => {
        const k = Math.floor(at(i));
        return k >= 0 && k < size ? k : -1;
      });
    const cols = inside(width, source.width, (i) => (c + a * (col0 + i + 0.5) - sc) / sa);
    const rows = inside(height, source.height, (j) => (f + e * (row0 + j + 0.5) - sf) / se);
    // The source's tiles under it: they run the same way as the tile's pixels.
    const span = (ks: Int32Array, size: number) => {
      const valid = ks.filter((k) => k >= 0);
      return valid.length ? [Math.floor(valid[0] / size), Math.floor(valid[valid.length - 1] / size)] : null;
    };
    const [xs, ys] = [span(cols, tw), span(rows, th)];

    const values = new Float32Array(width * height).fill(Number.NaN);
    if (xs && ys) {
      const under: RasterTile[][] = await Promise.all(
        Array.from({ length: ys[1] - ys[0] + 1 }, (_, j) =>
          Promise.all(Array.from({ length: xs[1] - xs[0] + 1 }, (_, i) => source.tile(xs[0] + i, ys[0] + j))),
        ),
      );
      for (let j = 0; j < height; j++) {
        const r = rows[j];
        if (r < 0) continue;
        const row = under[Math.floor(r / th) - ys[0]];
        for (let i = 0; i < width; i++) {
          const k = cols[i];
          if (k < 0) continue;
          const tile = row[Math.floor(k / tw) - xs[0]];
          const v = tile.values[(r % th) * tile.width + (k % tw)];
          if (v !== tile.nodata) values[j * width + i] = v;
        }
      }
    }
    const transform: RasterArray["transform"] = [a, 0, c + a * col0, 0, e, f + e * row0];
    return { values, width, height, nodata: null, hasNodata: false, transform };
  });
}

/**
 * A tile from the cache, or loaded into it. If it failed because another reader gave
 * up on it (its tile left the view), it's loaded again.
 */
function cachedTile(key: string, signal: AbortSignal | undefined, load: () => Promise<RasterTile>): Promise<RasterTile> {
  const hit = tiles.get(key);
  if (hit) {
    tiles.delete(key);
    tiles.set(key, hit);
    return hit.tile.catch((err) => {
      if (signal?.aborted) throw err;
      return cachedTile(key, signal, load);
    });
  }
  const tile = load();
  const entry: TileEntry = { tile, bytes: 0, done: false };
  tiles.set(key, entry);
  tile.then(
    (value) => {
      if (tiles.get(key) !== entry) return;
      Object.assign(entry, { bytes: value.values.byteLength, done: true, value });
      tileListeners.forEach((listener) => listener());
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

export type TileIndex = { x: number; y: number; z: number };

/** A period's value in one tile (see combineTiles), and its quality band if it has one. */
export interface PeriodTile {
  values: Float32Array;
  quality: RasterTypedArray | null;
  width: number;
  height: number;
  transform: RasterArray["transform"];
}

/** A raster's tile, if it's loaded. */
type GetTile = (source: TileSource) => RasterTile | undefined;

/** An L2 period's term on its own grid (not sampled onto it): where it has no data, L2 has none. */
const gridTerm = (period: RasterSum) => period.terms.find((t) => !t.grid)!;

/**
 * The rasters' tiles a period's tile is made from (with its quality raster's, if
 * `quality`), as far as they can be known from those loaded: an L2 period's L1 tiles,
 * sampled onto its grid, only once its own show pixels without data.
 */
function tileSources(period: RasterSum, quality: boolean, get: GetTile): TileSource[] {
  const sources: TileSource[] = [...period.terms, ...(quality && period.qualityUrl ? [{ url: period.qualityUrl }] : [])];
  const { fill } = period;
  if (!fill) return sources;
  const grid = get(gridTerm(period));
  if (!grid?.hasNodata) return sources;
  const onGrid = (url: string) => ({ url, grid: gridTerm(period).url });
  return [...sources, ...fill.terms.map((t) => onGrid(t.url)), ...(quality && fill.qualityUrl ? [onGrid(fill.qualityUrl)] : [])];
}

/** Whether every tile a period's tile is made from is loaded. */
export const loadedTile = (period: RasterSum, quality: boolean, get: GetTile) => tileSources(period, quality, get).every((source) => get(source));

/**
 * A period's tile, from its rasters' tiles (every one in tileSources loaded). At L2,
 * the pixels without data are L1's, quality too (none: 255, as no quality value).
 */
export function assemble(period: RasterSum, quality: boolean, get: GetTile): PeriodTile {
  const rasters = period.terms.map((t) => get(t)!);
  const values = combineTiles(period, rasters);
  const { width, height, transform } = rasters[0];
  let qualities = quality && period.qualityUrl ? get({ url: period.qualityUrl })!.values : null;
  const { fill } = period;
  const grid = fill && get(gridTerm(period))!;
  if (fill && grid?.hasNodata) {
    const onGrid = (url: string) => get({ url, grid: gridTerm(period).url })!;
    const filled = combineTiles(fill, fill.terms.map((t) => onGrid(t.url)));
    const filledQuality = qualities && fill.qualityUrl ? onGrid(fill.qualityUrl).values : null;
    if (filledQuality) qualities = Uint8Array.from(qualities!); // (not the cached tile's)
    for (let p = 0; p < values.length; p++) {
      if (grid.values[p] !== grid.nodata) continue;
      values[p] = filled[p];
      if (filledQuality) qualities![p] = filledQuality[p] === filledQuality[p] ? filledQuality[p] : 255;
    }
  }
  return { values, quality: qualities, width, height, transform };
}

/** Load the rasters' tiles a period's tile (x, y, z) is made from. Resolves to them. */
export async function loadSources(period: RasterSum, index: TileIndex, quality: boolean, signal?: AbortSignal): Promise<GetTile> {
  // (Kept here too: the cache may let go of one before the last is in.)
  const loaded = new Map<string, RasterTile>();
  const get: GetTile = (source) => loaded.get(tileKey(source, index)) ?? tiles.get(tileKey(source, index))?.value;
  for (;;) {
    const missing = tileSources(period, quality, get).filter((source) => !get(source));
    if (!missing.length) return get;
    const values = await Promise.all(missing.map((source) => sourceTile(source, index, signal)));
    missing.forEach((source, i) => loaded.set(tileKey(source, index), values[i]));
  }
}

/** A raster's tile from the cache, if it's loaded. */
export const cachedAt = (index: TileIndex): GetTile => (source) => tiles.get(tileKey(source, index))?.value;

/**
 * A period's value in a tile, from its terms' tiles: their sum, or for a ratio the sum
 * of the first part's over the sum of the second's (none where that's below `ratioMin`,
 * or not above 0). The parts' sums are averages per day.
 */
function combineTiles(period: RasterSum, rasters: RasterTile[]) {
  const { terms, variable } = period;
  if (!variable.ratio) {
    const sum = sumTiles(rasters, terms.map((t) => t.factor), variable.signed);
    return variable.zeroEmpty || variable.perArea ? staticValues(variable, sum, rasters[0]) : sum;
  }
  const sumOf = (part: number) => {
    const i = terms.flatMap((t, k) => (t.part === part ? [k] : []));
    return sumTiles(i.map((k) => rasters[k]), i.map((k) => terms[k].factor));
  };
  const [num, den] = [sumOf(0), sumOf(1)];
  const least = variable.ratioMin ?? 0;
  for (let p = 0; p < num.length; p++) num[p] = den[p] > 0 && den[p] >= least ? (variable.scale * num[p]) / den[p] : Number.NaN;
  return num;
}

/**
 * Rasters' tiles added up, each times its factor. A pixel without data in any of them
 * has none in the sum (NaN). Rounding can take a difference just below zero; that's 0,
 * unless the variable is `signed`.
 */
export function sumTiles(rasters: RasterTile[], factors: number[], signed = false) {
  const { width, height } = rasters[0];
  const sum = new Float32Array(width * height);
  rasters.forEach(({ values, nodata }, i) => {
    const factor = factors[i];
    for (let p = 0; p < sum.length; p++) {
      const v = values[p];
      sum[p] = v === nodata ? Number.NaN : sum[p] + factor * v; // NaN stays NaN
    }
  });
  if (!signed && factors.some((f) => f < 0)) {
    for (let p = 0; p < sum.length; p++) if (sum[p] < 0) sum[p] = 0;
  }
  return sum;
}

/**
 * A static map's values (gaez.ts), in place: areas per pixel as % of a full-resolution
 * pixel's area at the row's latitude (`perArea`), and 0 as no data (`zeroEmpty`).
 */
function staticValues({ zeroEmpty, perArea }: WaporVariable, values: Float32Array, { width, transform: [, , , , e, f] }: RasterTile) {
  for (let row = 0, p = 0; p < values.length; row++) {
    // (ha → m², over the pixel's m², in %.)
    const k = perArea ? 1e6 / pixelArea([perArea, perArea], e * (row + 0.5) + f) : 1;
    for (let col = 0; col < width; col++, p++) {
      const v = values[p] * k;
      values[p] = zeroEmpty && !(v > 0) ? Number.NaN : v;
    }
  }
  return values;
}

/** The samples of a one-band tile, in either layout. */
export const samples = (array: RasterArray) => (array.layout === "band-separate" ? array.bands[0] : array.data);

