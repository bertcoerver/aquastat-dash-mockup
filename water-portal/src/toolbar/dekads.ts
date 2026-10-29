/*
 * Dates as dekad indices
 * ----------------------
 * Every date is stored as a DEKAD INDEX: dekad 0 = 1–10 Jan 2016, 1 = 11–20 Jan 2016,
 * 2 = 21–31 Jan 2016, ... 36 dekads per year, 3 per month.
 *   start date of a dekad -> day 1, 11 or 21
 *   end date of a dekad   -> day 10, 20 or the last day of the month
 * So 1 dekad = 1 index, 1 month = 3 indices, 1 year = 36 indices.
 */

/** The first year of the timeline. */
export const MIN_YEAR = 2016;
/** The first year with WaPOR data (Basin and Local views). */
export const WAPOR_MIN_YEAR = 2018;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Dekad index from a year, month (0–11) and dekad of the month (0–2). */
export const mk = (y: number, m: number, d: number) => (y - MIN_YEAR) * 36 + m * 3 + d;
export const dkY = (dk: number) => MIN_YEAR + Math.floor(dk / 36);
export const dkM = (dk: number) => Math.floor((dk % 36) / 3);
export const dkD = (dk: number) => dk % 3;

/** Days in a month (month 0–11). */
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const startDay = (dk: number) => [1, 11, 21][dkD(dk)];
export const endDay = (dk: number) => (dkD(dk) < 2 ? [10, 20][dkD(dk)] : daysInMonth(dkY(dk), dkM(dk)));
export const fmtStart = (dk: number) => `${startDay(dk)} ${MONTHS[dkM(dk)]} ${dkY(dk)}`;
export const fmtEnd = (dk: number) => `${endDay(dk)} ${MONTHS[dkM(dk)]} ${dkY(dk)}`;

// The latest selectable dekad is the one containing today. No range may end after it.
const now = new Date();
export const MAX_DK = mk(
  now.getFullYear(),
  now.getMonth(),
  now.getDate() <= 10 ? 0 : now.getDate() <= 20 ? 1 : 2,
);

/** Country view: only complete calendar years whose 31 Dec is not after the current dekad (see also range-rules.ts). */
export const COUNTRY_MAX_YEAR = dkM(MAX_DK) === 11 && dkD(MAX_DK) === 2 ? dkY(MAX_DK) : dkY(MAX_DK) - 1;

/*
 * Days, for the Local view, which can start and end on any day: DAY INDEX 0 = 1 Jan 2016.
 */
const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(MIN_YEAR, 0, 1);
/** Day index of a date (month 0–11, day of the month 1–31). */
export const dayOf = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m, d) - EPOCH) / DAY_MS);
const dateOf = (day: number) => new Date(EPOCH + day * DAY_MS);
/** Year, month (0–11) and day of the month of a day index. */
export const ymd = (day: number) => {
  const date = dateOf(day);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
};
/** First and last day of a dekad. */
export const dkFirstDay = (dk: number) => dayOf(dkY(dk), dkM(dk), startDay(dk));
export const dkLastDay = (dk: number) => dayOf(dkY(dk), dkM(dk), endDay(dk));
/** The dekad a day is in. */
export const dayDk = (day: number) => {
  const date = dateOf(day);
  const d = date.getUTCDate();
  return mk(date.getUTCFullYear(), date.getUTCMonth(), d <= 10 ? 0 : d <= 20 ? 1 : 2);
};
/** The same date `years` later (or earlier), e.g. for Page Up on a handle. */
export const addYears = (day: number, years: number) => {
  const date = dateOf(day);
  return dayOf(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate());
};
export const fmtDay = (day: number) => {
  const date = dateOf(day);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};
/** The last day that can be selected: the end of the current dekad. */
export const MAX_DAY = dkLastDay(MAX_DK);
/** The first day with WaPOR data. */
export const WAPOR_FIRST_DAY = dayOf(WAPOR_MIN_YEAR, 0, 1);
