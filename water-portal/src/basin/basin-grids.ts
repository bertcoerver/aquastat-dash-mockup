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
 */
import { parse } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import { GeoTIFF, defaultDecoderPool, type RasterArray } from "@developmentseed/geotiff";
import type { Feature } from "geojson";
import { WAPOR_VARIABLES, publishedWaporPeriod, type WaporVariableId } from "../map/layers/wapor";
import type { MajorBasinProperties } from "../map/layers/basins";
import { FAO_TILES } from "../map/layers/tile-urls";
import type { DayRange } from "../toolbar/range-rules";

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

const grids = new Map<string, Promise<BasinGrid>>();

/** A variable's mean mm/day over a range, on the basin's grid (kept; a failed one is forgotten). */
export function loadBasinGrid(variable: GridVariable, range: DayRange, major: number, box: Box): Promise<BasinGrid> {
  const key = `${variable}:${range.start}-${range.end}:${major}`;
  let grid = grids.get(key);
  if (!grid) {
    grid = readGrid(variable, range, major, box);
    grid.catch(() => grids.delete(key));
    grids.set(key, grid);
  }
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

// --- Rasters -------------------------------------------------------------------------

const rasters = new Map<string, Promise<GeoTIFF>>();
function openRaster(url: string) {
  let raster = rasters.get(url);
  if (!raster) {
    raster = GeoTIFF.fromUrl(url);
    raster.catch(() => rasters.delete(url));
    rasters.set(url, raster);
  }
  return raster;
}

/** The samples of a one-band tile, in either layout. */
const samples = (array: RasterArray) => (array.layout === "band-separate" ? array.bands[0] : array.data);

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
  const tiles = new Map((await image.fetchTiles(xy, { boundless: false, pool: defaultDecoderPool() })).map((t) => [`${t.x},${t.y}`, t.array]));
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

// --- The basin's outline -------------------------------------------------------------

/** 1 where a cell's centre lies in the major basin, else 0. */
async function basinMask(major: number, frame: Frame): Promise<Uint8Array> {
  const [west, south, east, north] = frame.bounds;
  // A zoom level with the basin about three tiles across.
  const z = Math.max(0, Math.min(8, Math.floor(Math.log2((3 * 360) / Math.max(east - west, north - south)))));
  const n = 2 ** z;
  const tileX = (lng: number) => Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
  const tileY = (lat: number) => {
    const rad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)));
  };
  const loads: Promise<Feature[]>[] = [];
  for (let x = tileX(west); x <= tileX(east); x++) {
    for (let y = tileY(north); y <= tileY(south); y++) loads.push(loadTile(x, y, z));
  }
  const features = (await Promise.all(loads)).flat().filter((f) => (f.properties as MajorBasinProperties).SDG6_MB_ID === major);

  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d")!;
  // Cell (i, j) is pixel (i, j).
  const px = (lng: number) => ((lng - west) / (east - west)) * frame.width;
  const py = (lat: number) => ((north - lat) / (north - south)) * frame.height;
  ctx.fillStyle = "#fff";
  for (const { geometry } of features) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
    for (const rings of polygons) {
      ctx.beginPath();
      for (const ring of rings) ring.forEach(([lng, lat], k) => (k ? ctx.lineTo(px(lng), py(lat)) : ctx.moveTo(px(lng), py(lat))));
      ctx.fill("evenodd");
    }
  }
  const { data } = ctx.getImageData(0, 0, frame.width, frame.height);
  return Uint8Array.from({ length: frame.width * frame.height }, (_, i) => (data[i * 4 + 3] >= 128 ? 1 : 0));
}

async function loadTile(x: number, y: number, z: number): Promise<Feature[]> {
  const url = FAO_TILES.majorBasins.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  const response = await fetch(url);
  if (!response.ok) return []; // (no tile: nothing there)
  return (await parse(await response.arrayBuffer(), MVTLoader, {
    mvt: { coordinates: "wgs84", tileIndex: { x, y, z }, shape: "geojson" },
  })) as Feature[];
}
