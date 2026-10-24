/*
 * Which date ranges each view allows, and how a range is adjusted to fit. The toolbar
 * keeps the range in days (see dekads.ts); each view's rules decide where its ends may sit.
 *
 * - Country: national statistics are annual, so the range is one full calendar year.
 *   Moving either end moves the whole year.
 * - Basin: data is dekadal, and any range can be aggregated in the query, so both ends
 *   sit on dekad boundaries and any length is allowed.
 * - Local: any day. WaPOR only publishes rasters per dekad, calendar month and year,
 *   but any range can be added up from those, with part of a dekad's raster for a
 *   dekad the range only partly covers (see src/map/layers/wapor-plan.ts).
 *
 * No range may end after the current dekad (MAX_DK, MAX_DAY).
 */
import { COUNTRY_MAX_YEAR, MAX_DAY, MAX_DK, MIN_YEAR, addYears, dayDk, dkFirstDay, dkLastDay, dkY, mk } from "./dekads";

export type View = "country" | "basin" | "local";

/** First and last dekad of a range, both inclusive. */
export interface DekadRange {
  start: number;
  end: number;
}

/** First and last day of a range, both inclusive (day indices, see dekads.ts). */
export interface DayRange {
  start: number;
  end: number;
}

/** The days of a range of dekads. */
export const daysOfDekads = ({ start, end }: DekadRange): DayRange => ({ start: dkFirstDay(start), end: dkLastDay(end) });
/** The dekads a range of days lies in. */
export const coveringDekads = ({ start, end }: DayRange): DekadRange => ({ start: dayDk(start), end: dayDk(end) });
/** Whether a range of days is whole dekads. */
export const isDekads = (days: DayRange) => {
  const dekads = daysOfDekads(coveringDekads(days));
  return dekads.start === days.start && dekads.end === days.end;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- Boundaries -----------------------------------------------------------------
// A boundary is the start of a day: a range runs from boundary `start` to `end + 1`.

/** The nearest boundary to `p` (a position in days) where a range may start or end. */
function snap(view: View, p: number) {
  const b = clamp(Math.round(p), 0, MAX_DAY + 1);
  if (view === "local") return b;
  // Basin: the nearer of the boundaries around the dekad it's in.
  const dk = dayDk(Math.min(b, MAX_DAY));
  const [lo, hi] = [dkFirstDay(dk), dkLastDay(dk) + 1];
  return p - lo <= hi - p ? lo : hi;
}

/**
 * The boundary `n` steps on from `b`: days in Local, dekads in Basin. With `years`,
 * whole years (the same date).
 */
export function stepBoundary(view: View, b: number, n: number, years = false) {
  if (years) return view === "local" ? addYears(b, n) : dkFirstDay(dayDk(b) + 36 * n);
  return view === "local" ? b + n : dkFirstDay(dayDk(b) + n);
}

// --- Adjustments ----------------------------------------------------------------

/** The range after switching to `view`, adjusted to fit that view's rules. */
export function enterView(view: View, days: DayRange): DayRange {
  switch (view) {
    case "country":
      return countryYear(Math.min(dkY(dayDk(days.start)), COUNTRY_MAX_YEAR));
    case "basin":
      // The dekads it lies in.
      return daysOfDekads(coveringDekads(days));
    case "local":
      return { start: days.start, end: Math.min(days.end, MAX_DAY) };
  }
}

/** Country view: the full calendar year `y`, kept within the years that have data. */
const countryYear = (y: number): DayRange => {
  const start = mk(clamp(y, MIN_YEAR, COUNTRY_MAX_YEAR), 0, 0);
  return daysOfDekads({ start, end: start + 35 });
};

/** The shortest range from a start: a day in Local, a dekad in Basin. */
const minEnd = (view: View, start: number) => (view === "local" ? start : dkLastDay(dayDk(start)));

/** The range after the user moves the start to position `p` (in days). */
export function changeStart(view: View, prev: DayRange, p: number): DayRange {
  // Country: the year whose 1 Jan is nearest.
  if (view === "country") return countryYear(MIN_YEAR + Math.round(dayDk(clamp(Math.round(p), 0, MAX_DAY)) / 36));
  const start = Math.min(snap(view, p), stepBoundary(view, MAX_DAY + 1, -1));
  return { start, end: Math.max(prev.end, minEnd(view, start)) };
}

/** The range after the user moves the end to position `p` (in days: the boundary after the last day). */
export function changeEnd(view: View, prev: DayRange, p: number): DayRange {
  // Country: the year whose 31 Dec is nearest.
  if (view === "country") {
    const dk = dayDk(clamp(Math.round(p), 1, MAX_DAY + 1) - 1);
    return countryYear(MIN_YEAR + Math.round((dk + 1) / 36) - 1);
  }
  return { ...prev, end: clamp(snap(view, p) - 1, minEnd(view, prev.start), MAX_DAY) };
}

/**
 * The range after the user drags the whole range so it starts near position `p` (in
 * days). The length is kept: in days in Local, in dekads in Basin. In Country, the
 * start snaps to 1 Jan.
 */
export function moveRange(view: View, prev: DayRange, p: number): DayRange {
  if (view === "local") {
    const len = prev.end - prev.start + 1;
    const start = clamp(Math.round(p), 0, MAX_DAY - len + 1);
    return { start, end: start + len - 1 };
  }
  const dekads = coveringDekads(prev);
  const len = dekads.end - dekads.start + 1;
  const wanted = dayDk(clamp(Math.round(p), 0, MAX_DAY));
  const step = view === "country" ? len : 1;
  const last = view === "country" ? mk(COUNTRY_MAX_YEAR, 0, 0) : MAX_DK - len + 1;
  const start = clamp(Math.round(wanted / step) * step, 0, Math.floor(last / step) * step);
  return daysOfDekads({ start, end: start + len - 1 });
}

/** Range shown on first load: the latest complete year. */
export const initialRange = (): DayRange => countryYear(COUNTRY_MAX_YEAR);
