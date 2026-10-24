/*
 * Which date ranges each view allows, and how a range is adjusted to fit. The toolbar
 * keeps the range in days (see dekads.ts); each view's rules decide where its ends may sit.
 *
 * - Country: national statistics are annual, so the range is whole calendar years (the
 *   panel shows their mean). Each end snaps to the nearest 1 Jan or 31 Dec.
 * - Basin: data is dekadal, and any range can be aggregated in the query, so both ends
 *   sit on dekad boundaries and any length is allowed.
 * - Local: any day. WaPOR only publishes rasters per dekad, calendar month and year,
 *   but any range can be added up from those, with part of a dekad's raster for a
 *   dekad the range only partly covers (see src/map/layers/wapor-plan.ts).
 *
 * No range may end after the current dekad (MAX_DK, MAX_DAY). Basin and Local ranges
 * start no earlier than WaPOR's data (1 Jan 2018); Country years run from the start of
 * the timeline to the latest year with AQUASTAT data (see limitCountryYears).
 */
import {
  COUNTRY_MAX_YEAR,
  MAX_DAY,
  MAX_DK,
  MIN_YEAR,
  WAPOR_FIRST_DAY,
  WAPOR_MIN_YEAR,
  addYears,
  dayDk,
  dayOf,
  dkFirstDay,
  dkLastDay,
  dkY,
  mk,
} from "./dekads";

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

// --- Limits ---------------------------------------------------------------------

// Country: the latest year that can be selected. Until AQUASTAT's data are loaded, the
// latest complete calendar year.
let countryLast = COUNTRY_MAX_YEAR;

/** Country view: the latest year with data, `last` (never the current, incomplete year). */
export function limitCountryYears(last: number) {
  countryLast = Math.min(last, COUNTRY_MAX_YEAR);
}

/** Whether the Country view can show year `y`. */
export const isCountryYear = (y: number) => y >= MIN_YEAR && y <= countryLast;

/** The first day a view's range may start on. */
export const firstDay = (view: View) => (view === "country" ? 0 : WAPOR_FIRST_DAY);

/** The part of the track a view can't select, as boundaries [from, to) (null: none). */
export function unavailable(view: View): { from: number; to: number } | null {
  const [from, to] = view === "country" ? [dayOf(countryLast + 1, 0, 1), MAX_DAY + 1] : [0, WAPOR_FIRST_DAY];
  return from < to ? { from, to } : null;
}

// --- Boundaries -----------------------------------------------------------------
// A boundary is the start of a day: a range runs from boundary `start` to `end + 1`.

/** The nearest boundary to `p` (a position in days) where a range may start or end. */
function snap(view: View, p: number) {
  const b = clamp(Math.round(p), firstDay(view), MAX_DAY + 1);
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
  // Country: the years it lies in.
  if (view === "country") return countryYears(dkY(dayDk(days.start)), dkY(dayDk(days.end)));
  // Basin and Local: a range starting before WaPOR's data moves on by whole years.
  const years = Math.max(0, WAPOR_MIN_YEAR - dkY(dayDk(days.start)));
  if (view === "basin") {
    // The dekads it lies in.
    const { start, end } = coveringDekads(days);
    return daysOfDekads({ start: start + 36 * years, end: Math.min(end + 36 * years, MAX_DK) });
  }
  return { start: addYears(days.start, years), end: Math.min(addYears(days.end, years), MAX_DAY) };
}

/** Country view: calendar years `a` to `b`, kept within the years that have data. */
const countryYears = (a: number, b: number): DayRange => {
  const from = clamp(a, MIN_YEAR, countryLast);
  const to = clamp(b, from, countryLast);
  return { start: dayOf(from, 0, 1), end: dayOf(to + 1, 0, 1) - 1 };
};
const yearOfDay = (day: number) => dkY(dayDk(day));

/** The shortest range from a start: a day in Local, a dekad in Basin. */
const minEnd = (view: View, start: number) => (view === "local" ? start : dkLastDay(dayDk(start)));

/** The range after the user moves the start to position `p` (in days). */
export function changeStart(view: View, prev: DayRange, p: number): DayRange {
  // Country: the year whose 1 Jan is nearest, at most the end's year.
  if (view === "country") {
    const to = yearOfDay(prev.end);
    return countryYears(Math.min(MIN_YEAR + Math.round(dayDk(clamp(Math.round(p), 0, MAX_DAY)) / 36), to), to);
  }
  const start = Math.min(snap(view, p), stepBoundary(view, MAX_DAY + 1, -1));
  return { start, end: Math.max(prev.end, minEnd(view, start)) };
}

/** The range after the user moves the end to position `p` (in days: the boundary after the last day). */
export function changeEnd(view: View, prev: DayRange, p: number): DayRange {
  // Country: the year whose 31 Dec is nearest, at least the start's year.
  if (view === "country") {
    const dk = dayDk(clamp(Math.round(p), 1, MAX_DAY + 1) - 1);
    const from = yearOfDay(prev.start);
    return countryYears(from, Math.max(MIN_YEAR + Math.round((dk + 1) / 36) - 1, from));
  }
  return { ...prev, end: clamp(snap(view, p) - 1, minEnd(view, prev.start), MAX_DAY) };
}

/**
 * The range after the user drags the whole range so it starts near position `p` (in
 * days). The length is kept: in days in Local, in dekads in Basin, in years in Country
 * (whose start snaps to 1 Jan).
 */
export function moveRange(view: View, prev: DayRange, p: number): DayRange {
  if (view === "local") {
    const len = prev.end - prev.start + 1;
    const start = clamp(Math.round(p), WAPOR_FIRST_DAY, MAX_DAY - len + 1);
    return { start, end: start + len - 1 };
  }
  const dekads = coveringDekads(prev);
  const len = dekads.end - dekads.start + 1;
  const wanted = dayDk(clamp(Math.round(p), 0, MAX_DAY));
  const step = view === "country" ? 36 : 1;
  const first = dayDk(firstDay(view));
  const last = (view === "country" ? mk(countryLast + 1, 0, 0) : MAX_DK + 1) - len;
  const start = clamp(Math.round(wanted / step) * step, first, Math.floor(last / step) * step);
  return daysOfDekads({ start, end: start + len - 1 });
}

/**
 * The range after the user picks `day` for one end in the calendar (date-picker.ts):
 * that day in Local, its dekad in Basin, its year in Country. If the pick passes the
 * other end, that end moves along.
 */
export function pickDay(view: View, prev: DayRange, end: "start" | "end", day: number): DayRange {
  if (view === "country") {
    const y = yearOfDay(day);
    return end === "start"
      ? countryYears(y, Math.max(y, yearOfDay(prev.end)))
      : countryYears(Math.min(yearOfDay(prev.start), y), y);
  }
  const d = clamp(day, firstDay(view), MAX_DAY);
  const [first, last] = view === "local" ? [d, d] : [dkFirstDay(dayDk(d)), dkLastDay(dayDk(d))];
  return end === "start"
    ? { start: first, end: Math.max(prev.end, last) }
    : { start: Math.min(prev.start, first), end: last };
}

/** Range shown on first load: the latest year the Country view can show. */
export const initialRange = (): DayRange => countryYears(countryLast, countryLast);
