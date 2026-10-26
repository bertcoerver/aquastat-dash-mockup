/*
 * Basin statistics for the Basin view's charts (after the Basin tab of FAO's Water
 * Portal): precipitation (PCP) and actual evapotranspiration (AETI) per sub-basin over
 * the selected date range, from the same WaPOR v3 L1 dekadal zonal statistics the
 * water balance model reads.
 *
 * Every sub-basin's dekadal series are loaded once, from a static file
 * (public/data/wapor-series.bin, scripts/build-wapor-series.mjs: ~9 MB), and summed
 * here, so a new date range needs no query and shows at once:
 *
 * - periodStats: every sub-basin's PCP and AETI over the range (~7,600 sub-basins).
 *   Totals over the range are the mean rate × days, so a sub-basin missing a dekad
 *   isn't counted short.
 * - monthlyStats: PCP and AETI per calendar month of the range, area-weighted over all
 *   sub-basins or those of one major basin.
 * - windowRates: every sub-basin's mean daily PCP and AETI over each of several ranges
 *   (the same days in other years: see sameDays), for comparing the period with them.
 *
 * A failed load is forgotten, so it can be retried.
 */
import { MIN_YEAR, dkM, dkY, endDay, startDay } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";

const FILE = `${import.meta.env.BASE_URL}data/wapor-series.bin`;
const FORMAT_VERSION = 1; // of the file

export interface SubBasinStat {
  majorBasin: number;
  /** km² */
  area: number;
  /** Totals over the covered range, in mm. */
  pcp: number;
  aeti: number;
}

export interface PeriodStats {
  /** The part of the requested range with data (null: none of it). */
  covered: DekadRange | null;
  /** Days in the covered range. */
  days: number;
  sub: Map<number, SubBasinStat>;
}

export interface Monthly {
  /** Months as (year - MIN_YEAR) * 12 + month (0–11). */
  months: number[];
  /** mm per month (of the part of the month in the range). */
  pcp: number[];
  aeti: number[];
}

export interface WindowRates {
  /** Per sub-basin, mean mm/day in each of the ranges asked for, in their order (NaN: no data). */
  sub: Map<number, { pcp: Float64Array; aeti: Float64Array }>;
}

/** The dekadal series, sub-basin after sub-basin (mm/day, NaN: no value). */
export interface WaporSeries {
  /** The first dekad (as in toolbar/dekads.ts) and how many follow on. */
  first: number;
  dekads: number;
  ids: Int32Array;
  majorBasins: Int32Array;
  /** km² */
  areas: Float32Array;
  pcp: Float32Array;
  aeti: Float32Array;
  /** Days in each dekad. */
  days: Uint8Array;
}

let series: Promise<WaporSeries> | null = null;

export function loadSeries(): Promise<WaporSeries> {
  if (!series) {
    series = fetch(FILE).then(async (response) => {
      if (!response.ok) throw new Error(`The basin statistics failed to load (${response.status}).`);
      return parseSeries(await response.arrayBuffer());
    });
    series.catch(() => (series = null));
  }
  return series;
}

function parseSeries(buf: ArrayBuffer): WaporSeries {
  const length = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, length)));
  if (header.version !== FORMAT_VERSION) throw new Error(`The basin statistics are in an unknown format (version ${header.version}).`);
  const { n, dekads, scale, none } = header;
  let offset = 4 + length;
  const take = <T extends Int32Array | Float32Array | Uint16Array>(Type: { new (b: ArrayBuffer, o: number, l: number): T }, count: number) => {
    const array = new Type(buf, offset, count);
    offset += array.byteLength;
    return array;
  };
  const ids = take(Int32Array, n);
  const majorBasins = take(Int32Array, n);
  const areas = take(Float32Array, n);
  const values = (raw: Uint16Array, k: number) => Float32Array.from(raw, (x) => (x === none ? NaN : x / k));
  const pcp = values(take(Uint16Array, n * dekads), scale.pcp);
  const aeti = values(take(Uint16Array, n * dekads), scale.aeti);
  const [y, m, d] = (header.first as string).split("-").map(Number);
  const first = (y - MIN_YEAR) * 36 + (m - 1) * 3 + Math.floor((d - 1) / 10);
  const days = Uint8Array.from({ length: dekads }, (_, i) => endDay(first + i) - startDay(first + i) + 1);
  return { first, dekads, ids, majorBasins, areas, pcp, aeti, days };
}

/** Range `r` as indices into the series (to exclusive), clipped to them. */
function span(s: WaporSeries, r: DekadRange) {
  return { from: Math.max(0, r.start - s.first), to: Math.min(s.dekads, r.end - s.first + 1) };
}

/** Mean mm/day of sub-basin `row`'s `x` over [from, to): weighted by days, skipping gaps. */
function rate(s: WaporSeries, x: Float32Array, row: number, from: number, to: number) {
  let sum = 0;
  let days = 0;
  for (let i = from, j = row * s.dekads + from; i < to; i++, j++) {
    const v = x[j];
    if (v === v) {
      sum += v * s.days[i];
      days += s.days[i];
    }
  }
  return days ? sum / days : NaN;
}

const daysIn = (s: WaporSeries, from: number, to: number) => {
  let days = 0;
  for (let i = from; i < to; i++) days += s.days[i];
  return days;
};

export function periodStats(s: WaporSeries, range: DekadRange): PeriodStats {
  const { from, to } = span(s, range);
  if (from >= to) return { covered: null, days: 0, sub: new Map() };
  const covered = { start: s.first + from, end: s.first + to - 1 };
  const days = daysIn(s, from, to);
  const sub = new Map<number, SubBasinStat>();
  for (let row = 0; row < s.ids.length; row++) {
    sub.set(s.ids[row], {
      majorBasin: s.majorBasins[row],
      area: s.areas[row],
      pcp: rate(s, s.pcp, row, from, to) * days,
      aeti: rate(s, s.aeti, row, from, to) * days,
    });
  }
  return { covered, days, sub };
}

/** Monthly PCP and AETI over `range` for all sub-basins, or those of `majorBasin`. */
export function monthlyStats(s: WaporSeries, range: DekadRange, majorBasin: number | null): Monthly {
  const { from, to } = span(s, range);
  const out: Monthly = { months: [], pcp: [], aeti: [] };
  for (let i = from; i < to; ) {
    const dk = s.first + i;
    const end = Math.min(to, i + 3 - (dk % 3)); // the rest of the month in the range
    let area = 0;
    let p = 0;
    let e = 0;
    for (let row = 0; row < s.ids.length; row++) {
      if (majorBasin !== null && s.majorBasins[row] !== majorBasin) continue;
      const pr = rate(s, s.pcp, row, i, end);
      const er = rate(s, s.aeti, row, i, end);
      if (pr !== pr || er !== er) continue;
      const days = daysIn(s, i, end);
      area += s.areas[row];
      p += pr * days * s.areas[row];
      e += er * days * s.areas[row];
    }
    if (area) {
      out.months.push((dkY(dk) - MIN_YEAR) * 12 + dkM(dk));
      out.pcp.push(p / area);
      out.aeti.push(e / area);
    }
    i = end;
  }
  return out;
}

/** Mean daily PCP and AETI per sub-basin over each of `ranges`. */
export function windowRates(s: WaporSeries, ranges: DekadRange[]): WindowRates {
  const spans = ranges.map((r) => span(s, r));
  const sub = new Map<number, { pcp: Float64Array; aeti: Float64Array }>();
  for (let row = 0; row < s.ids.length; row++) {
    const pcp = new Float64Array(ranges.length);
    const aeti = new Float64Array(ranges.length);
    spans.forEach(({ from, to }, k) => {
      pcp[k] = rate(s, s.pcp, row, from, to);
      aeti[k] = rate(s, s.aeti, row, from, to);
    });
    sub.set(s.ids[row], { pcp, aeti });
  }
  return { sub };
}
