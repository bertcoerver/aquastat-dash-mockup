/*
 * WaPOR v3 L1 dekadal evapotranspiration, read straight from FAO's bucket: actual
 * evapotranspiration and interception (AETI, mm/day) and its transpiration (T), so the
 * vapour can be split into what plants give off and what evaporates from soil, water and
 * leaves. The COGs are global 300 m (122880 × 61440) with overviews; the seventh, 1920 ×
 * 960 (0.1875°, about 20 km), is read whole: about a second per layer, both at once.
 */
import { fromUrl } from "geotiff";
import { dkD, dkM, dkY } from "@portal/toolbar/dekads";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";
/** The overview read (0: full resolution). */
const OVERVIEW = 6;
/** The rasters' values are mm/day × 10. */
const SCALE = 0.1;
/** mm/day at grid value 255. */
export const GRID_MAX = 10;

/** A dekad's evapotranspiration: row 0 north. */
export interface Evapotranspiration {
  dekad: number;
  width: number;
  height: number;
  /** [west, south, east, north], degrees (an equirectangular grid). */
  bounds: [number, number, number, number];
  /** mm/day per cell, NaN where there's no data (the sea). */
  aeti: Float32Array;
  transpiration: Float32Array;
  /** For the layers, two bytes a cell: AETI (0–255 for 0–GRID_MAX) and T's share of it (0–255). */
  data: Uint8Array;
}

const url = (layer: string, dk: number) =>
  `${BUCKET}/L1-${layer}-D/WAPOR-3.L1-${layer}-D.${dkY(dk)}-${String(dkM(dk) + 1).padStart(2, "0")}-D${dkD(dk) + 1}.tif`;

const loaded = new Map<number, Promise<Evapotranspiration>>();

/** A dekad's evapotranspiration (kept, so each is read once; a failed read is forgotten). */
export function loadEvapotranspiration(dk: number): Promise<Evapotranspiration> {
  let p = loaded.get(dk);
  if (!p) {
    p = read(dk);
    p.catch(() => loaded.delete(dk));
    loaded.set(dk, p);
  }
  return p;
}

/** A layer's overview as mm/day (NaN for nodata), and the raster's bounds. */
async function readLayer(layer: string, dk: number) {
  const tiff = await fromUrl(url(layer, dk));
  const image = await tiff.getImage(OVERVIEW);
  const nodata = image.getGDALNoData();
  const [raw] = (await image.readRasters()) as unknown as [Int16Array | Uint8Array];
  const values = Float32Array.from(raw, (v) => (v === nodata ? NaN : v * SCALE));
  const bounds = (await tiff.getImage(0)).getBoundingBox() as [number, number, number, number];
  return { values, width: image.getWidth(), height: image.getHeight(), bounds };
}

async function read(dk: number): Promise<Evapotranspiration> {
  const [aeti, t] = await Promise.all([readLayer("AETI", dk), readLayer("T", dk)]);
  const data = new Uint8Array(aeti.values.length * 2);
  for (let i = 0; i < aeti.values.length; i++) {
    const v = aeti.values[i];
    if (!(v > 0)) continue;
    data[i * 2] = Math.min(255, Math.round((v / GRID_MAX) * 255));
    data[i * 2 + 1] = Math.round(Math.min(1, (t.values[i] || 0) / v) * 255);
  }
  return { dekad: dk, width: aeti.width, height: aeti.height, bounds: aeti.bounds, aeti: aeti.values, transpiration: t.values, data };
}

/** The cell's index at a point, or -1. */
export function cellAt(e: Evapotranspiration, lng: number, lat: number): number {
  const [w, s, east, n] = e.bounds;
  const x = Math.floor(((lng - w) / (east - w)) * e.width);
  const y = Math.floor(((n - lat) / (n - s)) * e.height);
  return x < 0 || y < 0 || x >= e.width || y >= e.height ? -1 : y * e.width + x;
}

/** Colour ramp of the ground (mm/day → RGBA): clear when dry, a deeper green as more water goes up. */
export const RAMP_STOPS: [number, [number, number, number, number]][] = [
  [0, [0, 0, 0, 0]],
  [0.3, [70, 90, 60, 0]],
  [1, [80, 120, 70, 45]],
  [2.5, [80, 155, 95, 80]],
  [4, [95, 190, 130, 105]],
  [6, [170, 230, 190, 130]],
];

export function rampColor(mm: number): [number, number, number, number] {
  if (!(mm > RAMP_STOPS[0][0])) return RAMP_STOPS[0][1];
  for (let i = 1; i < RAMP_STOPS.length; i++) {
    const [m1, c1] = RAMP_STOPS[i];
    if (mm <= m1) {
      const [m0, c0] = RAMP_STOPS[i - 1];
      const t = (mm - m0) / (m1 - m0);
      return c0.map((c, k) => c + (c1[k] - c) * t) as [number, number, number, number];
    }
  }
  return RAMP_STOPS.at(-1)![1];
}

/** The AETI grid as an image for the ground (BitmapLayer). */
export function groundImage(e: Evapotranspiration): ImageData {
  const image = new ImageData(e.width, e.height);
  for (let i = 0; i < e.aeti.length; i++) image.data.set(rampColor(e.aeti[i]), i * 4);
  return image;
}
