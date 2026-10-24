/*
 * Which date ranges each view allows, and how a range is adjusted to fit.
 *
 * - Country: national statistics are annual, so the range is one full calendar year.
 *   Moving either end moves the whole year.
 * - Basin: data is dekadal, and any range can be aggregated in the query, so both ends
 *   sit on dekad boundaries and any length is allowed.
 * - Local: data are pre-computed COGs, which only exist per dekad, calendar month and
 *   calendar year. The range must be exactly one of those.
 *
 * No range may end after the current dekad (MAX_DK).
 */
import { COUNTRY_MAX_YEAR, MAX_DK, MIN_YEAR, dkD, dkY, mk } from "./dekads";

export type View = "country" | "basin" | "local";

/** First and last dekad of a range, both inclusive. */
export interface DekadRange {
  start: number;
  end: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- Local view: pre-computed lengths -----------------------------------------
// From a given start:
//   1 dekad  -> always
//   1 month  -> only if start is the 1st of a month
//   1 year   -> only if start is 1 Jan
// and never ending after the current dekad.

export const localLengths = (start: number) =>
  [1, ...(dkD(start) === 0 ? [3] : []), ...(start % 36 === 0 ? [36] : [])].filter(
    (len) => start + len - 1 <= MAX_DK,
  );

export const localEnds = (start: number) => localLengths(start).map((len) => start + len - 1);

const nearestLocalLength = (start: number, current: number) =>
  localLengths(start).reduce((best, len) =>
    Math.abs(len - current) < Math.abs(best - current) ? len : best,
  );

// --- Adjustments ----------------------------------------------------------------

/** The range after switching to `view`, adjusted to fit that view's rules. */
export function enterView(view: View, { start, end }: DekadRange): DekadRange {
  switch (view) {
    case "country": {
      const year = Math.min(dkY(start), COUNTRY_MAX_YEAR);
      const s = mk(year, 0, 0);
      return { start: s, end: s + 35 };
    }
    case "basin":
      // Other views always produce dekad-aligned ranges; only the upper bound can be off.
      return { start, end: Math.min(end, MAX_DK) };
    case "local":
      return { start, end: start + nearestLocalLength(start, end - start + 1) - 1 };
  }
}

/** Country view: the full calendar year `y`, kept within the years that have data. */
const countryYear = (y: number): DekadRange => {
  const start = mk(clamp(y, MIN_YEAR, COUNTRY_MAX_YEAR), 0, 0);
  return { start, end: start + 35 };
};

/** The range after the user moves the start to dekad `wanted`. */
export function changeStart(view: View, prev: DekadRange, wanted: number): DekadRange {
  // Country: the year whose 1 Jan is nearest.
  if (view === "country") return countryYear(MIN_YEAR + Math.round(wanted / 36));
  const start = clamp(wanted, 0, MAX_DK);
  if (view === "basin") return { start, end: Math.max(prev.end, start) };
  // Local: keep the length if it's available from the new start, else the closest one.
  const len = nearestLocalLength(start, prev.end - prev.start + 1);
  return { start, end: start + len - 1 };
}

/** The range after the user moves the end to dekad `wanted`. */
export function changeEnd(view: View, prev: DekadRange, wanted: number): DekadRange {
  // Country: the year whose 31 Dec is nearest.
  if (view === "country") return countryYear(MIN_YEAR + Math.round((wanted + 1) / 36) - 1);

  if (view === "local") {
    // The allowed end closest to the wanted one.
    const end = localEnds(prev.start).reduce((best, dk) =>
      Math.abs(dk - wanted) < Math.abs(best - wanted) ? dk : best,
    );
    return { ...prev, end };
  }

  return { ...prev, end: clamp(wanted, prev.start, MAX_DK) };
}

/**
 * The range after the user drags the whole range so it starts near dekad `wanted`.
 * The length is kept. Country and local lengths (a dekad, month or year) only exist
 * from starts that are a multiple of that length, so the start snaps to those.
 */
export function moveRange(view: View, prev: DekadRange, wanted: number): DekadRange {
  const len = prev.end - prev.start + 1;
  const step = view === "basin" ? 1 : len;
  const last = view === "country" ? mk(COUNTRY_MAX_YEAR, 0, 0) : MAX_DK - len + 1;
  const start = clamp(Math.round(wanted / step) * step, 0, Math.floor(last / step) * step);
  return { start, end: start + len - 1 };
}

/** Range shown on first load: the latest complete year. */
export const initialRange = (): DekadRange => {
  const start = mk(COUNTRY_MAX_YEAR, 0, 0);
  return { start, end: start + 35 };
};
