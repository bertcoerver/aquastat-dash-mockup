/*
 * Basin statistics for the Basin view's charts (after the Basin tab of FAO's Water
 * Portal): precipitation (PCP) and actual evapotranspiration (AETI) per sub-basin over
 * the selected date range, from the same WaPOR v3 L1 dekadal zonal statistics the
 * water balance model reads.
 *
 * Every sub-basin's dekadal series are loaded once, from the precomputed files
 * (subbasins.bin, ~9 MB: see model.ts), and summed here, so a new date range needs no
 * query and shows at once:
 *
 * - periodStats: every sub-basin's PCP and AETI over the range (~7,600 sub-basins).
 *   Totals over the range are the mean rate × days, so a sub-basin missing a dekad
 *   isn't counted short.
 * - monthlyStats: PCP and AETI per calendar month of the range, area-weighted over all
 *   sub-basins, those of one major basin, or one sub-basin.
 * - windowRates: every sub-basin's mean daily PCP and AETI over each of several ranges
 *   (the same days in other years: see sameDays), for comparing the period with them.
 * - dekadRates: PCP and AETI dekad by dekad, area-weighted over all sub-basins, those
 *   of one major basin, or one sub-basin (rain against discharge).
 *
 * A failed load is forgotten, so it can be retried.
 */
import { MIN_YEAR, dkM, dkY, endDay, startDay } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import { loadFile } from "./model";

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

export function loadSeries(): Promise<WaporSeries> {
  return loadFile("subbasins.bin").then(({ first, dekads, ids, columns, series }) => ({
    first,
    dekads,
    ids,
    majorBasins: columns.majorBasin as Int32Array,
    areas: columns.area as Float32Array,
    pcp: series.PCP,
    aeti: series.AETI,
    days: Uint8Array.from({ length: dekads }, (_, i) => endDay(first + i) - startDay(first + i) + 1),
  }));
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

/** What to average over: a major basin's sub-basins, or one sub-basin (null: all of them). */
export type Within = { kind: "major" | "sub"; id: number } | null;

/** Whether sub-basin `row` is in `within`. */
const inside = (s: WaporSeries, row: number, within: Within) =>
  !within || (within.kind === "major" ? s.majorBasins[row] : s.ids[row]) === within.id;

/** Monthly PCP and AETI over `range` for all sub-basins, or those `within`. */
export function monthlyStats(s: WaporSeries, range: DekadRange, within: Within): Monthly {
  const { from, to } = span(s, range);
  const out: Monthly = { months: [], pcp: [], aeti: [] };
  for (let i = from; i < to; ) {
    const dk = s.first + i;
    const end = Math.min(to, i + 3 - (dk % 3)); // the rest of the month in the range
    let area = 0;
    let p = 0;
    let e = 0;
    for (let row = 0; row < s.ids.length; row++) {
      if (!inside(s, row, within)) continue;
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

/** Per dekad of `range` (by dekad number), mean mm/day of PCP and AETI, area-weighted over all sub-basins or those `within`. */
export function dekadRates(s: WaporSeries, range: DekadRange, within: Within): { pcp: Map<number, number>; aeti: Map<number, number> } {
  const { from, to } = span(s, range);
  const pcp = new Map<number, number>();
  const aeti = new Map<number, number>();
  for (let i = from; i < to; i++) {
    let area = 0;
    let p = 0;
    let e = 0;
    for (let row = 0, j = i; row < s.ids.length; row++, j += s.dekads) {
      if (!inside(s, row, within)) continue;
      const [pv, ev] = [s.pcp[j], s.aeti[j]];
      if (pv !== pv || ev !== ev) continue;
      area += s.areas[row];
      p += pv * s.areas[row];
      e += ev * s.areas[row];
    }
    if (area) {
      pcp.set(s.first + i, p / area);
      aeti.set(s.first + i, e / area);
    }
  }
  return { pcp, aeti };
}
