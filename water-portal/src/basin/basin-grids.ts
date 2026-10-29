/*
 * WaPOR rasters over a major basin, for the rain and vapour (effects-map.ts): a
 * variable's mean per day over a range (PCP, AETI or T, in mm/day), on a grid over the
 * basin's box, NaN outside the basin.
 *
 * The range is the sum of published rasters the map would add up (wapor.ts,
 * waporPeriod: a year, months, dekads), each read at the coarsest overview that's still
 * as fine as the grid, only the tiles over the basin, sampled onto the grid (nearest
 * pixel). The basin's outline comes from the major basins' vector tiles, drawn onto the
 * grid at a zoom level a few tiles across it.
 *
 * A grid can be cut down to some of the basin's sub-basins (withinSubBasins: a selected
 * sub-basin and those upstream of it), drawn onto the grid from the sub-basins' tiles.
 *
 * Also transpiration and evapotranspiration per sub-basin (loadTranspiration): there are
 * no zonal statistics of T, so its grid and AETI's are averaged over the cells of each
 * sub-basin, drawn onto the grid from the sub-basins' vector tiles the same way.
 */
import { parse } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import type { GeoTIFF } from "@developmentseed/geotiff";
import { geotiffLib } from "../map/layers/geotiff-lib";
import type { Feature } from "geojson";
import { publishedWaporPeriod } from "../map/layers/wapor-period";
import { samples } from "../map/layers/wapor-tiles";
import { WAPOR_VARIABLES, type WaporVariableId } from "../map/layers/wapor-variables";
import type { MajorBasinProperties, SubBasinProperties } from "../map/layers/basins";
import { FAO_TILES } from "../map/layers/tile-urls";
import type { DayRange } from "../toolbar/range-rules";
import { keepLast, memoized } from "../lib/memo";

export type GridVariable = Extract<WaporVariableId, "PCP" | "AETI" | "T">;

/** A grid over a basin's box: row 0 north. */
export interface BasinGrid {
  width: number;
  height: number;
  /** [west, south, east, north], degrees (an equirectangular grid). */
  bounds: [number, number, number, number];
  /** mm/day per cell, NaN outside the basin and where there's no data (beyond 60° for PCP). */
  values: Float32Array;
}

type Box = [number, number, number, number];
type Frame = Omit<BasinGrid, "values">;

/** Cells along the box's longer side. */
const CELLS = 480;

/** The grid over a basin's box (a cell wider on every side). */
function frameOf([w, s, e, n]: Box): Frame {
  const cell = Math.max(e - w, n - s) / CELLS;
  const width = Math.ceil((e - w) / cell) + 2;
  const height = Math.ceil((n - s) / cell) + 2;
  return { width, height, bounds: [w - cell, n + cell - height * cell, w - cell + width * cell, n + cell] };
}

/** How many grids (a megabyte or so each) are kept: a range played adds one per step. */
const KEPT_GRIDS = 16;
const grids = new Map<string, Promise<BasinGrid>>();

/** A variable's mean mm/day over a range, on the basin's grid (kept; a failed one is forgotten). */
export function loadBasinGrid(variable: GridVariable, range: DayRange, major: number, box: Box): Promise<BasinGrid> {
  const key = `${variable}:${range.start}-${range.end}:${major}`;
  const grid = memoized(grids, key, () => readGrid(variable, range, major, box));
  keepLast(grids, KEPT_GRIDS);
  return grid;
}

async function readGrid(id: GridVariable, range: DayRange, major: number, box: Box): Promise<BasinGrid> {
  const variable = WAPOR_VARIABLES.find((v) => v.id === id)!;
  const frame = frameOf(box);
  const [period, mask] = await Promise.all([publishedWaporPeriod(variable, range), basinMask(major, frame)]);
  if (!period) throw new Error(`WaPOR has no ${variable.short} for this period yet.`);
  const terms = await Promise.all(period.terms.map((t) => sampled(t.url, frame)));
  const values = new Float32Array(frame.width * frame.height);
  for (let i = 0; i < values.length; i++) {
    let v = mask[i] ? 0 : NaN;
    for (let k = 0; k < terms.length && v === v; k++) v += period.terms[k].factor * terms[k][i];
    values[i] = v;
  }
  return { ...frame, values };
}

const masked = new Map<string, Promise<BasinGrid>>();

/** A variable's grid (as loadBasinGrid) with the cells outside some sub-basins (`key` names them) NaN (kept). */
export function withinSubBasins(variable: GridVariable, range: DayRange, major: number, box: Box, subs: { key: string; ids: Set<number> }): Promise<BasinGrid> {
  const key = `${variable}:${range.start}-${range.end}:${major}:${subs.key}`;
  const grid = memoized(masked, key, () =>
    Promise.all([loadBasinGrid(variable, range, major, box), subBasinMask(major, box, subs)]).then(([g, mask]) => ({
      ...g,
      values: g.values.map((v, i) => (mask[i] ? v : NaN)),
    })),
  );
  keepLast(masked, KEPT_GRIDS);
  return grid;
}

const masks = new Map<string, Promise<Uint8Array>>();

/** 1 where a cell's centre lies in one of the sub-basins, else 0 (kept). */
function subBasinMask(major: number, box: Box, subs: { key: string; ids: Set<number> }): Promise<Uint8Array> {
  const frame = frameOf(box);
  return memoized(masks, `${major}:${subs.key}`, () =>
    tilesOver(frame, FAO_TILES.subBasins).then((all) => maskOf(frame, all.filter((f) => subs.ids.has((f.properties as SubBasinProperties).SDG6_SB_ID)))),
  );
}

// --- Rasters -------------------------------------------------------------------------

const rasters = new Map<string, Promise<GeoTIFF>>();
const openRaster = (url: string) => memoized(rasters, url, () => geotiffLib().then(({ GeoTIFF }) => GeoTIFF.fromUrl(url)));


/** A raster's raw values at the grid's cells (nearest pixel; NaN for nodata and off the raster). */
async function sampled(url: string, frame: Frame): Promise<Float32Array> {
  const tiff = await openRaster(url);
  const [west, south, east, north] = frame.bounds;
  const cell = (east - west) / frame.width;
  // The coarsest image whose pixels are no bigger than the grid's cells (else the finest).
  const images = [tiff, ...tiff.overviews];
  const image = images.filter((im) => Math.abs(im.transform[0]) <= cell).at(-1) ?? tiff;
  const [a, , c, , e, f] = image.transform;
  const { width, height, tileWidth: tw, tileHeight: th } = image;
  const col = (lng: number) => Math.floor((lng - c) / a);
  const row = (lat: number) => Math.floor((lat - f) / e);
  const out = new Float32Array(frame.width * frame.height).fill(NaN);
  const [c0, c1] = [Math.max(0, col(west)), Math.min(width - 1, col(east))];
  const [r0, r1] = [Math.max(0, row(north)), Math.min(height - 1, row(south))];
  if (c0 > c1 || r0 > r1) return out;

  const xy: [number, number][] = [];
  for (let ty = Math.floor(r0 / th); ty <= Math.floor(r1 / th); ty++) {
    for (let tx = Math.floor(c0 / tw); tx <= Math.floor(c1 / tw); tx++) xy.push([tx, ty]);
  }
  const pool = (await geotiffLib()).decoderPool();
  const tiles = new Map((await image.fetchTiles(xy, { boundless: false, pool })).map((t) => [`${t.x},${t.y}`, t.array]));
  for (let j = 0; j < frame.height; j++) {
    const r = row(north - (j + 0.5) * cell);
    if (r < 0 || r >= height) continue;
    for (let i = 0; i < frame.width; i++) {
      const cc = col(west + (i + 0.5) * cell);
      const tile = cc >= 0 && cc < width ? tiles.get(`${Math.floor(cc / tw)},${Math.floor(r / th)}`) : undefined;
      if (!tile) continue;
      const v = samples(tile)[(r % th) * tile.width + (cc % tw)];
      if (v !== tile.nodata) out[j * frame.width + i] = v;
    }
  }
  return out;
}

// --- Transpiration per sub-basin --------------------------------------------------------

const transpirations = new Map<string, Promise<Map<number, { t: number; aeti: number }>>>();

/**
 * Per sub-basin of a major basin, the mean mm/day of T and AETI over a range, over the
 * cells of the basin's grid inside it (kept; a failed one is forgotten).
 */
export function loadTranspiration(range: DayRange, major: number, box: Box): Promise<Map<number, { t: number; aeti: number }>> {
  const key = `${range.start}-${range.end}:${major}`;
  let out = transpirations.get(key);
  if (!out) {
    out = Promise.all([loadBasinGrid("T", range, major, box), loadBasinGrid("AETI", range, major, box), subBasinZones(major, frameOf(box))]).then(([t, aeti, zones]) => {
      const sums = new Map<number, { t: number; aeti: number; n: number }>();
      for (let i = 0; i < zones.length; i++) {
        const [tv, ev] = [t.values[i], aeti.values[i]];
        if (!zones[i] || tv !== tv || ev !== ev) continue;
        const s = sums.get(zones[i]) ?? { t: 0, aeti: 0, n: 0 };
        s.t += tv;
        s.aeti += ev;
        s.n++;
        sums.set(zones[i], s);
      }
      return new Map([...sums].map(([id, s]) => [id, { t: s.t / s.n, aeti: s.aeti / s.n }]));
    });
    out.catch(() => transpirations.delete(key));
    transpirations.set(key, out);
  }
  return out;
}

/**
 * The sub-basin each cell's centre lies in (its id; 0: none), of a major basin's: each
 * drawn in a colour of its own. Cells on an edge are left out: those not fully covered,
 * and those whose colour no neighbour across shares (two sub-basins' colours blended
 * can look like a third's).
 */
const zones = new Map<number, Promise<Int32Array>>();
function subBasinZones(major: number, frame: Frame): Promise<Int32Array> {
  return memoized(zones, major, () => subBasinZonesOnce(major, frame));
}
async function subBasinZonesOnce(major: number, frame: Frame): Promise<Int32Array> {
  const features = (await tilesOver(frame, FAO_TILES.subBasins)).filter((f) => (f.properties as SubBasinProperties).SDG6_MB_ID === major);
  const ids = [...new Set(features.map((f) => (f.properties as SubBasinProperties).SDG6_SB_ID))];
  const index = new Map(ids.map((id, i) => [id, i + 1]));
  const ctx = drawn(frame, features, (f) => {
    const k = index.get((f.properties as SubBasinProperties).SDG6_SB_ID)!;
    return `rgb(${k & 255} ${(k >> 8) & 255} ${(k >> 16) & 255})`;
  });
  const { data } = ctx.getImageData(0, 0, frame.width, frame.height);
  const w = frame.width;
  const colorAt = (i: number) => (data[i * 4 + 3] === 255 ? data[i * 4] | (data[i * 4 + 1] << 8) | (data[i * 4 + 2] << 16) : -1);
  return Int32Array.from({ length: w * frame.height }, (_, i) => {
    const k = colorAt(i);
    if (k <= 0) return 0;
    const x = i % w;
    const shared = (x > 0 && colorAt(i - 1) === k) || (x < w - 1 && colorAt(i + 1) === k);
    return shared ? ids[k - 1] ?? 0 : 0;
  });
}

/** Polygons drawn onto a canvas the size of the grid (cell (i, j) is pixel (i, j)), each in `color`, without smoothing. */
function drawn(frame: Frame, features: Feature[], color: (f: Feature) => string) {
  const [west, south, east, north] = frame.bounds;
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const px = (lng: number) => ((lng - west) / (east - west)) * frame.width;
  const py = (lat: number) => ((north - lat) / (north - south)) * frame.height;
  for (const f of features) {
    const { geometry } = f;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
    ctx.fillStyle = color(f);
    for (const rings of polygons) {
      ctx.beginPath();
      for (const ring of rings) ring.forEach(([lng, lat], k) => (k ? ctx.lineTo(px(lng), py(lat)) : ctx.moveTo(px(lng), py(lat))));
      ctx.fill("evenodd");
    }
  }
  return ctx;
}

/** The features of a tile set over a grid, at a zoom level with the grid about three tiles across. */
async function tilesOver(frame: Frame, tiles: string): Promise<Feature[]> {
  const [west, south, east, north] = frame.bounds;
  const z = Math.max(0, Math.min(8, Math.floor(Math.log2((3 * 360) / Math.max(east - west, north - south)))));
  const n = 2 ** z;
  const tileX = (lng: number) => Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
  const tileY = (lat: number) => {
    const rad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)));
  };
  const loads: Promise<Feature[]>[] = [];
  for (let x = tileX(west); x <= tileX(east); x++) {
    for (let y = tileY(north); y <= tileY(south); y++) loads.push(loadTile(tiles, x, y, z));
  }
  return (await Promise.all(loads)).flat();
}

// --- The basin's outline -------------------------------------------------------------

/** 1 where a cell's centre lies in one of the features, else 0. */
function maskOf(frame: Frame, features: Feature[]): Uint8Array {
  const { data } = drawn(frame, features, () => "#fff").getImageData(0, 0, frame.width, frame.height);
  return Uint8Array.from({ length: frame.width * frame.height }, (_, i) => (data[i * 4 + 3] >= 128 ? 1 : 0));
}

const basinMasks = new Map<number, Promise<Uint8Array>>();

/** 1 where a cell's centre lies in the major basin, else 0 (kept: every variable and range over the basin needs it; a failed one is forgotten). */
function basinMask(major: number, frame: Frame): Promise<Uint8Array> {
  return memoized(basinMasks, major, () =>
    tilesOver(frame, FAO_TILES.majorBasins).then((all) => maskOf(frame, all.filter((f) => (f.properties as MajorBasinProperties).SDG6_MB_ID === major))),
  );
}

async function loadTile(tiles: string, x: number, y: number, z: number): Promise<Feature[]> {
  const url = tiles.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const response = await fetch(url);
  if (!response.ok) return []; // (no tile: nothing there)
  return (await parse(await response.arrayBuffer(), MVTLoader, {
    mvt: { coordinates: "wgs84", tileIndex: { x, y, z }, shape: "geojson" },
  })) as Feature[];
}
