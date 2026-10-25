/*
 * WaPOR v3 L1 dekadal precipitation (PCP, mm/day, the dekad's mean), read straight from
 * FAO's bucket as the portal's map does. The COGs are 0.05° (7200 × 2400, 60° N to 60° S)
 * with overviews; the rain only needs the third, 0.2° (1800 × 600, about 22 km), read
 * whole: about 0.4 s and a few hundred KB per dekad.
 */
import { fromUrl } from "geotiff";
import { dkD, dkM, dkY } from "@portal/toolbar/dekads";
import type { RainGrid } from "./rain-layer";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L1-PCP-D";
/** The overview read (0: full resolution, 7200 × 2400). */
const OVERVIEW = 2;
/** The raster's values are mm/day × 10. */
const SCALE = 0.1;
const NODATA = -9999;
/** mm/day at grid value 255. */
export const GRID_MAX = 40;

export interface Precipitation extends RainGrid {
  dekad: number;
  /** mm/day per cell, NaN where there's no data (the sea). */
  values: Float32Array;
}

export const pcpUrl = (dk: number) =>
  `${BUCKET}/WAPOR-3.L1-PCP-D.${dkY(dk)}-${String(dkM(dk) + 1).padStart(2, "0")}-D${dkD(dk) + 1}.tif`;

const loaded = new Map<number, Promise<Precipitation>>();

/** A dekad's precipitation (kept, so each is read once; a failed read is forgotten). */
export function loadPrecipitation(dk: number): Promise<Precipitation> {
  let p = loaded.get(dk);
  if (!p) {
    p = read(dk);
    p.catch(() => loaded.delete(dk));
    loaded.set(dk, p);
  }
  return p;
}

async function read(dk: number): Promise<Precipitation> {
  const tiff = await fromUrl(pcpUrl(dk));
  const image = await tiff.getImage(OVERVIEW);
  const [raw] = (await image.readRasters()) as unknown as [Int16Array];
  const [west, south, east, north] = (await tiff.getImage(0)).getBoundingBox() as [number, number, number, number];
  const values = new Float32Array(raw.length);
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i] === NODATA ? NaN : raw[i] * SCALE;
    values[i] = v;
    data[i] = v > 0 ? Math.min(255, Math.round((v / GRID_MAX) * 255)) : 0;
  }
  return { dekad: dk, values, data, width: image.getWidth(), height: image.getHeight(), bounds: [west, south, east, north] };
}

/** mm/day at a point, or NaN. */
export function precipitationAt(p: Precipitation, lng: number, lat: number): number {
  const [w, s, e, n] = p.bounds;
  const x = Math.floor(((lng - w) / (e - w)) * p.width);
  const y = Math.floor(((n - lat) / (n - s)) * p.height);
  return x < 0 || y < 0 || x >= p.width || y >= p.height ? NaN : p.values[y * p.width + x];
}

/** Colour ramp of the ground (mm/day → RGBA): clear when dry, deeper blue as it rains more. */
const STOPS: [number, [number, number, number, number]][] = [
  [0, [0, 0, 0, 0]],
  [0.5, [40, 70, 110, 0]],
  [2, [45, 100, 160, 50]],
  [6, [50, 130, 200, 85]],
  [15, [90, 170, 235, 115]],
  [30, [170, 215, 255, 140]],
];
export const RAMP_STOPS = STOPS;

export function rampColor(mm: number): [number, number, number, number] {
  if (!(mm > STOPS[0][0])) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [m1, c1] = STOPS[i];
    if (mm <= m1) {
      const [m0, c0] = STOPS[i - 1];
      const t = (mm - m0) / (m1 - m0);
      return c0.map((c, k) => c + (c1[k] - c) * t) as [number, number, number, number];
    }
  }
  return STOPS.at(-1)![1];
}

/** The grid as an image for the ground (BitmapLayer). */
export function groundImage(p: Precipitation): ImageData {
  const image = new ImageData(p.width, p.height);
  for (let i = 0; i < p.values.length; i++) image.data.set(rampColor(p.values[i]), i * 4);
  return image;
}
