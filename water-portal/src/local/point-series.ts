/*
 * A WaPOR variable's whole record at a point: its value in every dekad, from its
 * dekadal rasters (one pixel of each, see cog-pixel.ts). A variable made from others
 * (PCP − AETI) is made the same way at the point, each part read on its own grid; a
 * ratio (WP: NPP over AETI) keeps its parts too, so totals can be made of each.
 *
 * Always from L1 (300 m), even where the map shows L2 (100 m): a series from L2's
 * 512-pixel tiles is 70 MB, from L1's about 20 MB, for about the same time.
 *
 * The dekads in the selected period are read first, then outwards from it: the period
 * is asked for again at each dekad, so a period chosen while it loads goes first too.
 */
import type { LngLat } from "../map/places";
import { pixelArea, waporAvailable, waporDekadUrl, waporVariable, type WaporLevel, type WaporVariable } from "../map/layers/wapor";
import { MAX_DK, WAPOR_MIN_YEAR, mk } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import { cogPixel, cogPixelSize } from "./cog-pixel";

export interface PointSeries {
  variable: WaporVariable;
  lngLat: LngLat;
  /** Every dekad from WaPOR's first to its latest published one. */
  dekads: number[];
  /** Per day, in the variable's unit; NaN: no data there, or not read yet. */
  values: Float64Array;
  /** How many dekads have been read. */
  loaded: number;
  /** A ratio's parts (e.g. NPP and AETI per day): `values` is the first over the second. */
  ratio?: { num: Float64Array; den: Float64Array };
}

/**
 * The area of a variable's pixel at latitude `lat` at a level, in m² (of `grid`'s for
 * a variable made from others), from its first raster's header. Null if that can't be read.
 */
export async function waporPixelArea(variable: WaporVariable, lat: number, level: WaporLevel = "L1"): Promise<number | null> {
  const grid = waporVariable(variable.grid ?? variable.id);
  const size = await cogPixelSize(waporDekadUrl(grid, mk(WAPOR_MIN_YEAR, 0, 0), level)).catch(() => null);
  return size && pixelArea(size, lat);
}

/** Dekads read at the same time (the bucket speaks HTTP/2; each is a few requests in turn). */
const LOADERS = 12;
/** While the map plays a range: its frames load from the same bucket, and go first. */
const PLAYING_LOADERS = 2;

let loaders = LOADERS;
const wakeLoaders: (() => void)[] = [];

/** Whether the map is playing a range: the series then reads fewer dekads at a time. */
export function setPointSeriesYield(playing: boolean) {
  loaders = playing ? PLAYING_LOADERS : LOADERS;
  if (!playing) wakeLoaders.splice(0).forEach((wake) => wake());
}

/**
 * Read the series, `onUpdate` running as values come in (the same object, filled in).
 * Rejects if a raster can't be read, or when `signal` aborts.
 */
export async function loadPointSeries(
  variable: WaporVariable,
  lngLat: LngLat,
  signal: AbortSignal,
  onUpdate: (series: PointSeries) => void,
  /** The selected period, to read first (null: none). */
  getPeriod: () => DekadRange | null = () => null,
): Promise<PointSeries> {
  const parts = (variable.parts ?? [{ id: variable.id, sign: 1 }]).map(({ id, sign }) => ({ variable: waporVariable(id), sign }));
  const first = mk(WAPOR_MIN_YEAR, 0, 0);
  // The latest dekads are published some time after: up to the last of every part.
  let last = MAX_DK;
  while (last > first && !(await Promise.all(parts.map((p) => waporAvailable(waporDekadUrl(p.variable, last))))).every(Boolean)) last--;
  signal.throwIfAborted();

  const dekads = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const none = () => new Float64Array(dekads.length).fill(Number.NaN);
  const series: PointSeries = { variable, lngLat, dekads, values: none(), loaded: 0, ...(variable.ratio ? { ratio: { num: none(), den: none() } } : {}) };
  onUpdate(series);

  // The next dekad to read: the unread one nearest the period (the earliest on a tie).
  const claimed = new Uint8Array(dekads.length);
  let left = dekads.length;
  function next() {
    const period = getPeriod();
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < dekads.length; i++) {
      if (claimed[i]) continue;
      const dk = dekads[i];
      const distance = period ? Math.max(0, period.start - dk, dk - period.end) : 0;
      if (distance < bestDistance) [best, bestDistance] = [i, distance];
      if (distance === 0) break;
    }
    claimed[best] = 1;
    left--;
    return best;
  }

  async function loader(n: number) {
    while (left > 0) {
      // (Loaders past the number allowed wait, between dekads.)
      while (n >= loaders) await new Promise<void>((wake) => wakeLoaders.push(wake));
      signal.throwIfAborted();
      if (left === 0) return;
      const i = next();
      const raw = await Promise.all(parts.map((p) => cogPixel(waporDekadUrl(p.variable, dekads[i]), lngLat, signal)));
      signal.throwIfAborted();
      const value = (k: number) => (raw[k] === null ? Number.NaN : parts[k].sign * parts[k].variable.scale * raw[k]!);
      if (series.ratio) {
        const [num, den] = [value(0), value(1)];
        series.ratio.num[i] = num;
        series.ratio.den[i] = den;
        series.values[i] = den > 0 && den >= (variable.ratioMin ?? 0) ? (variable.scale * num) / den : Number.NaN;
      } else {
        series.values[i] = raw.every((v) => v !== null) ? parts.reduce((sum, _, k) => sum + value(k), 0) : Number.NaN;
      }
      series.loaded++;
      onUpdate(series);
    }
  }
  await Promise.all(Array.from({ length: LOADERS }, (_, n) => loader(n)));
  return series;
}
