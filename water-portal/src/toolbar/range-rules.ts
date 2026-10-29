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
 * start no earlier than WaPOR's data (1 Jan 2018); Basin ranges end no later than the
 * latest dekad with water balance model output (see limitBasinDekads). Country years
 * run from the start of the timeline to the latest year with AQUASTAT data (see
 * limitCountryYears).
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
} from "./dekads";
import { clamp } from "../lib/math";

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

// Basin: the latest dekad that can be selected, the last with model output (the
// Basin view's data all come from the same WaPOR tables). Until that is known, the
// current dekad.
let basinLast = MAX_DK;

/** Basin view: the latest dekad with data, `last` (at most the current dekad). */
export function limitBasinDekads(last: number) {
  basinLast = clamp(last, dayDk(WAPOR_FIRST_DAY), MAX_DK);
}

/** Basin view: the latest dekad that can be selected. */
export const basinLastDekad = () => basinLast;

/** The first day a view's range may start on. */
export const firstDay = (view: View) => (view === "country" ? 0 : WAPOR_FIRST_DAY);

/** The last day a view's range may end on. */
export const lastDay = (view: View) =>
  view === "country" ? dayOf(countryLast + 1, 0, 1) - 1 : view === "basin" ? dkLastDay(basinLast) : MAX_DAY;

/** The parts of the track a view can't select, as boundaries [from, to): before its first day, after its last. */
export function unavailable(view: View): { from: number; to: number }[] {
  return [
    { from: 0, to: firstDay(view) },
    { from: lastDay(view) + 1, to: MAX_DAY + 1 },
  ].filter((gap) => gap.from < gap.to);
}

// --- Boundaries -----------------------------------------------------------------
// A boundary is the start of a day: a range runs from boundary `start` to `end + 1`.

/** The nearest boundary to `p` (a position in days) where a range may start or end. */
function snap(view: View, p: number) {
  const b = clamp(Math.round(p), firstDay(view), lastDay(view) + 1);
  if (view === "local") return b;
  // Basin: the nearer of the boundaries around the dekad it's in.
  const dk = dayDk(Math.min(b, lastDay(view)));
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
    // The dekads it lies in. One ending after the model output moves back by whole
    // years, or if that's too far back for it, ends at the output's last dekad.
    let { start, end } = coveringDekads(days);
    start += 36 * years;
    end += 36 * years;
    const back = 36 * Math.max(0, Math.ceil((end - basinLast) / 36));
    const first = dayDk(WAPOR_FIRST_DAY);
    if (start - back >= first) return daysOfDekads({ start: start - back, end: end - back });
    return daysOfDekads({ start: Math.min(start, basinLast), end: Math.min(end, basinLast) });
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

/** The range's length: in years in Country (whole years), else in days. */
export const rangeLength = (view: View, { start, end }: DayRange) =>
  view === "country" ? yearOfDay(end) - yearOfDay(start) + 1 : end - start + 1;

/** The shortest range from a start: a day in Local, a dekad in Basin. */
const minEnd = (view: View, start: number) => (view === "local" ? start : dkLastDay(dayDk(start)));

/** The range after the user moves the start to position `p` (in days). */
export function changeStart(view: View, prev: DayRange, p: number): DayRange {
  // Country: the year whose 1 Jan is nearest, at most the end's year.
  if (view === "country") {
    const to = yearOfDay(prev.end);
    return countryYears(Math.min(MIN_YEAR + Math.round(dayDk(clamp(Math.round(p), 0, MAX_DAY)) / 36), to), to);
  }
  const start = Math.min(snap(view, p), stepBoundary(view, lastDay(view) + 1, -1));
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
  return { ...prev, end: clamp(snap(view, p) - 1, minEnd(view, prev.start), lastDay(view)) };
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
  const last = dayDk(lastDay(view)) + 1 - len;
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
  const d = clamp(day, firstDay(view), lastDay(view));
  const [first, last] = view === "local" ? [d, d] : [dkFirstDay(dayDk(d)), dkLastDay(dayDk(d))];
  return end === "start"
    ? { start: first, end: Math.max(prev.end, last) }
    : { start: Math.min(prev.start, first), end: last };
}

/**
 * The range after the user types its length, `n`: in days, or years in Country. The
 * start stays and the end follows (in Basin, to the nearest dekad boundary). If the
 * range wouldn't fit after the start, it ends at the latest day and starts earlier.
 */
export function setLength(view: View, prev: DayRange, n: number): DayRange {
  const len = Math.max(1, Math.round(n));
  if (view === "country") {
    const from = yearOfDay(prev.start);
    const shift = Math.max(0, from + len - 1 - countryLast);
    return countryYears(from - shift, from + len - 1 - shift);
  }
  if (prev.start + len <= lastDay(view) + 1) return changeEnd(view, prev, prev.start + len);
  return { start: snap(view, lastDay(view) + 1 - len), end: lastDay(view) };
}

/**
 * The range moved `n` whole years on (or back), keeping its dates: the same days in
 * Local, the same dekads in Basin, the same years in Country. Null if that doesn't fit.
 */
export function shiftYears(view: View, prev: DayRange, n: number): DayRange | null {
  const next =
    view === "local"
      ? { start: addYears(prev.start, n), end: addYears(prev.end, n) }
      : daysOfDekads({ start: dayDk(prev.start) + 36 * n, end: dayDk(prev.end) + 36 * n });
  return next.start >= firstDay(view) && next.end <= lastDay(view) ? next : null;
}

/**
 * Playback in Country and Basin (range-player.ts): the range a step on, keeping its
 * length (a year in Country, a dekad in Basin). Null past the view's last day.
 */
export function stepRange(view: Exclude<View, "local">, prev: DayRange): DayRange | null {
  if (view === "country") {
    const [a, b] = [yearOfDay(prev.start) + 1, yearOfDay(prev.end) + 1];
    return b <= countryLast ? countryYears(a, b) : null;
  }
  const { start, end } = coveringDekads(prev);
  return end + 1 <= basinLast ? daysOfDekads({ start: start + 1, end: end + 1 }) : null;
}

/** Playback: the first range of the same length the view can show (where it starts over). */
export function firstRange(view: Exclude<View, "local">, prev: DayRange): DayRange {
  if (view === "country") return countryYears(MIN_YEAR, MIN_YEAR + yearOfDay(prev.end) - yearOfDay(prev.start));
  const { start, end } = coveringDekads(prev);
  const first = dayDk(WAPOR_FIRST_DAY);
  return daysOfDekads({ start: first, end: first + end - start });
}

export type Period = "dekad" | "month" | "year";
const PERIOD_DEKADS: Record<Period, number> = { dekad: 1, month: 3, year: 36 };

/**
 * The calendar dekad, month or year nearest the range: the one its middle day lies in,
 * or the nearest one the view can show in full. Country only has years.
 */
export function snapToPeriod(view: View, prev: DayRange, period: Period): DayRange {
  const size = PERIOD_DEKADS[view === "country" ? "year" : period];
  const mid = dayDk(Math.floor((prev.start + prev.end) / 2));
  const first = dayDk(firstDay(view)); // 1 Jan, so the start of every period
  const last = dayDk(lastDay(view)) + 1 - size; // the latest start that fits
  const start = clamp(Math.floor(mid / size) * size, first, Math.floor(last / size) * size);
  return daysOfDekads({ start, end: start + size - 1 });
}

/** Range shown on first load: the latest year the Country view can show. */
export const initialRange = (): DayRange => countryYears(countryLast, countryLast);
