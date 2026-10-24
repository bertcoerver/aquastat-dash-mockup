/*
 * Dates as dekad indices
 * ----------------------
 * Every date is stored as a DEKAD INDEX: dekad 0 = 1–10 Jan 2018, 1 = 11–20 Jan 2018,
 * 2 = 21–31 Jan 2018, ... 36 dekads per year, 3 per month.
 *   start date of a dekad -> day 1, 11 or 21
 *   end date of a dekad   -> day 10, 20 or the last day of the month
 * So 1 dekad = 1 index, 1 month = 3 indices, 1 year = 36 indices.
 */

export const MIN_YEAR = 2018;
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

/** Country view: only complete calendar years whose 31 Dec is not after the current dekad. */
export const COUNTRY_MAX_YEAR = dkM(MAX_DK) === 11 && dkD(MAX_DK) === 2 ? dkY(MAX_DK) : dkY(MAX_DK) - 1;
