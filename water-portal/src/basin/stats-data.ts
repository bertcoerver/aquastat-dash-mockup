/*
 * Basin statistics for the Basin view's charts (after the Basin tab of FAO's Water
 * Portal): precipitation (PCP) and actual evapotranspiration (AETI) per sub-basin over
 * the selected date range, from the same WaPOR v3 L1 dekadal zonal statistics the
 * water balance model reads, through the same BigQuery proxy.
 *
 * - loadPeriod: every sub-basin's mean daily PCP and AETI over the range (one row
 *   with arrays: ~7,600 sub-basins). Totals over the range are rate × days, so a
 *   sub-basin missing a dekad isn't counted short.
 * - loadMonthly: PCP and AETI per calendar month of the range, area-weighted over all
 *   sub-basins or those of one major basin.
 *
 * Results are kept for the session; a failed query is forgotten, so it can be retried.
 */
import { MIN_YEAR, dkM, dkY, endDay, startDay } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";

const PROXY_URL = "https://data.apps.fao.org/api/v2/bigquery";
const PCP = "`fao-maps-review.zonal_stats_openEO.L1-PCP-D_HYDRO_SUB_BASIN_V2`";
const AETI = "`fao-maps-review.zonal_stats_openEO.L1-AETI-D_HYDRO_SUB_BASIN_V2`";
const DAYS = "(DATE_DIFF(DATE(end_datetime), DATE(start_datetime), DAY) + 1)";
const NONE = -9999; // BigQuery arrays can't hold NULL

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

const pad = (n: number) => String(n).padStart(2, "0");
const isoStart = (dk: number) => `${dkY(dk)}-${pad(dkM(dk) + 1)}-${pad(startDay(dk))}`;
const isoEnd = (dk: number) => `${dkY(dk)}-${pad(dkM(dk) + 1)}-${pad(endDay(dk))}`;
/** The dekad an ISO date (yyyy-mm-dd) falls in. */
const dekadOf = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return (y - MIN_YEAR) * 36 + (m - 1) * 3 + (d <= 10 ? 0 : d <= 20 ? 1 : 2);
};
const daysIn = ({ start, end }: DekadRange) =>
  Math.round((Date.parse(isoEnd(end)) - Date.parse(isoStart(start))) / 86400000) + 1;

const periods = new Map<string, Promise<PeriodStats>>();
const monthlies = new Map<string, Promise<Monthly>>();

export function loadPeriod(range: DekadRange): Promise<PeriodStats> {
  const key = `${range.start}-${range.end}`;
  let load = periods.get(key);
  if (!load) {
    load = queryPeriod(range);
    load.catch(() => periods.delete(key));
    periods.set(key, load);
  }
  return load;
}

async function queryPeriod(range: DekadRange): Promise<PeriodStats> {
  const where = `DATE(start_datetime) BETWEEN '${isoStart(range.start)}' AND '${isoStart(range.end)}'`;
  const [row] = await query<{
    id: number[];
    mb: number[];
    area: number[];
    p: number[];
    e: number[];
    d0: string | null;
    d1: string | null;
  }>(`WITH p AS (
  SELECT FAO_SB_ID AS id, ANY_VALUE(FAO_MB_ID) AS mb, ANY_VALUE(area) AS area,
    SAFE_DIVIDE(SUM(mean * ${DAYS}), SUM(${DAYS})) AS rate,
    MIN(DATE(start_datetime)) AS d0, MAX(DATE(start_datetime)) AS d1
  FROM ${PCP} WHERE ${where} GROUP BY id
), e AS (
  SELECT FAO_SB_ID AS id, SAFE_DIVIDE(SUM(mean * ${DAYS}), SUM(${DAYS})) AS rate
  FROM ${AETI} WHERE ${where} GROUP BY id
)
SELECT
  ARRAY_AGG(p.id) AS id,
  ARRAY_AGG(p.mb) AS mb,
  ARRAY_AGG(ROUND(p.area / 1e6, 1)) AS area,
  ARRAY_AGG(IFNULL(ROUND(p.rate, 4), ${NONE})) AS p,
  ARRAY_AGG(IFNULL(ROUND(e.rate, 4), ${NONE})) AS e,
  CAST(MIN(p.d0) AS STRING) AS d0,
  CAST(MAX(p.d1) AS STRING) AS d1
FROM p LEFT JOIN e USING (id)`);

  if (!row?.d0 || !row.d1) return { covered: null, days: 0, sub: new Map() };
  const covered = { start: Math.max(range.start, dekadOf(row.d0)), end: Math.min(range.end, dekadOf(row.d1)) };
  const days = daysIn(covered);
  const total = (rate: number) => (rate === NONE ? NaN : rate * days);
  const sub = new Map<number, SubBasinStat>();
  row.id.forEach((id, i) => sub.set(id, { majorBasin: row.mb[i], area: row.area[i], pcp: total(row.p[i]), aeti: total(row.e[i]) }));
  return { covered, days, sub };
}

/** Monthly PCP and AETI over `range` for all sub-basins, or those of `majorBasin`. */
export function loadMonthly(range: DekadRange, majorBasin: number | null): Promise<Monthly> {
  const key = `${range.start}-${range.end}:${majorBasin ?? "all"}`;
  let load = monthlies.get(key);
  if (!load) {
    load = queryMonthly(range, majorBasin);
    load.catch(() => monthlies.delete(key));
    monthlies.set(key, load);
  }
  return load;
}

async function queryMonthly(range: DekadRange, majorBasin: number | null): Promise<Monthly> {
  const where =
    `DATE(start_datetime) BETWEEN '${isoStart(range.start)}' AND '${isoStart(range.end)}'` +
    (majorBasin === null ? "" : ` AND FAO_MB_ID = ${Number(majorBasin)}`);
  const perMonth = (table: string) => `SELECT FAO_SB_ID AS id, ANY_VALUE(area) AS area,
    DATE_TRUNC(DATE(start_datetime), MONTH) AS m, SUM(mean * ${DAYS}) AS v
  FROM ${table} WHERE ${where} GROUP BY id, m`;
  const rows = await query<{ m: string; p: number; e: number }>(`WITH p AS (${perMonth(PCP)}), e AS (${perMonth(AETI)})
SELECT FORMAT_DATE('%Y-%m', m) AS m,
  ROUND(SAFE_DIVIDE(SUM(p.v * p.area), SUM(p.area)), 2) AS p,
  ROUND(SAFE_DIVIDE(SUM(e.v * e.area), SUM(e.area)), 2) AS e
FROM p JOIN e USING (id, m)
GROUP BY m ORDER BY m`);
  return {
    months: rows.map((r) => {
      const [y, m] = r.m.split("-").map(Number);
      return (y - MIN_YEAR) * 12 + m - 1;
    }),
    pcp: rows.map((r) => r.p ?? NaN),
    aeti: rows.map((r) => r.e ?? NaN),
  };
}

async function query<T>(sql: string): Promise<T[]> {
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, output_format: "json", download: "false" }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`The basin statistics query failed (${response.status}): ${text.slice(0, 300)}`);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(`The basin statistics query failed: ${text.slice(0, 300)}`);
  return rows;
}
