/*
 * The water balance model: discharge (Q) and storage change (ΔS) for a sub-basin and
 * everything upstream of it, from WaPOR L1 precipitation (PCP) and actual
 * evapotranspiration (AETI).
 *
 * The model runs in BigQuery: calc_runoff.sql is a copy of sql/calc_runoff.sql from
 * the fao-wapor-discharge project (a linear-reservoir model, routed downstream through
 * the sub-basins, retention factor 0.1). It is sent as text to FAO's BigQuery proxy,
 * with two changes made here rather than in the file:
 *
 * - The routes table it reads is swapped for an inline list of the network's
 *   sub-basins (the proxy is read-only, so no routes table can be staged), as
 *   examples/verify_sql_runoff.py does there.
 * - The final SELECT returns one row per sub-basin with the time series as arrays,
 *   instead of one row per sub-basin per dekad: the proxy returns at most 50,000
 *   rows, and big networks have more (the Mississippi: 766 sub-basins × 288 dekads).
 */
import { MIN_YEAR } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import type { SubBasin } from "../map/sub-basin-network";
import CALC_RUNOFF_SQL from "./calc_runoff.sql?raw";

const PROXY_URL = "https://data.apps.fao.org/api/v2/bigquery";
const SPINUP = 2; // model passes (calc_runoff's default)

export type Variable = "PCP" | "AETI" | "Q" | "dS";
export const VARIABLES: Variable[] = ["PCP", "AETI", "Q", "dS"];

/** Per sub-basin, one value per dekad of `dekads`: PCP, AETI in mm/day; Q, ΔS in m³/s. */
export type Series = Record<Variable, Float64Array>;

export interface NetworkResult {
  /** The sub-basin the network drains to (the one that was selected). */
  outlet: number;
  /** Dekad indices (see dekads.ts) with model output, ascending. */
  dekads: number[];
  series: Map<number, Series>;
}

/** Period means per sub-basin (PCP, AETI in mm/day; Q, ΔS in m³/s). */
export type Means = Map<number, Record<Variable, number>>;

interface Row {
  id: number;
  dk: number[];
  pcp: (number | null)[];
  aeti: (number | null)[];
  q: (number | null)[];
  ds: (number | null)[];
}

const results = new Map<number, Promise<NetworkResult>>();

/**
 * Run the model for `outlet` and the sub-basins upstream of it (`upstream`, not
 * including `outlet`). Results are kept, so selecting the same sub-basin again is
 * instant. A failed run is forgotten, so it can be retried.
 */
export function runNetwork(outlet: SubBasin, upstream: SubBasin[]): Promise<NetworkResult> {
  let result = results.get(outlet.id);
  if (!result) {
    result = query(renderSql(outlet, upstream)).then((rows) => toResult(outlet.id, rows));
    result.catch(() => results.delete(outlet.id));
    results.set(outlet.id, result);
  }
  return result;
}

function renderSql(outlet: SubBasin, upstream: SubBasin[]): string {
  // The outlet drains out of the network: -999 (terminal), as far as the model knows.
  const routes = [outlet, ...upstream]
    .sort((a, b) => a.id - b.id)
    .map((b) => `(${b.id}, ${b.id === outlet.id ? -999 : b.downstream}, ${b.area ?? "NULL"}, NULL)`)
    .join(",\n    ");
  const routesSource =
    "SELECT * FROM UNNEST(\n" +
    "  ARRAY<STRUCT<basin FLOAT64, downstream FLOAT64, area_km2 FLOAT64, f FLOAT64>>[\n" +
    `    ${routes}\n  ])`;

  let sql = CALC_RUNOFF_SQL;
  const begin = sql.indexOf("-- ROUTES_SOURCE_BEGIN");
  const end = sql.indexOf("-- ROUTES_SOURCE_END") + "-- ROUTES_SOURCE_END".length;
  sql = sql.slice(0, begin) + routesSource + sql.slice(end);

  // Replace the final SELECT (one row per basin per dekad) with one row per basin.
  // Dates become dekad indices; values are rounded to keep the response small.
  const dekad = `(EXTRACT(YEAR FROM res.dt) - ${MIN_YEAR}) * 36 + (EXTRACT(MONTH FROM res.dt) - 1) * 3 + DIV(EXTRACT(DAY FROM res.dt) - 1, 10)`;
  sql = sql.slice(0, sql.lastIndexOf("\nSELECT\n")) + `
SELECT
  CAST(res.basin AS INT64) AS id,
  ARRAY_AGG(${dekad} ORDER BY res.dt) AS dk,
  ARRAY_AGG(ROUND(res.pcp, 3) ORDER BY res.dt) AS pcp,
  ARRAY_AGG(ROUND(res.aeti, 3) ORDER BY res.dt) AS aeti,
  ARRAY_AGG(ROUND(res.q, 3) ORDER BY res.dt) AS q,
  ARRAY_AGG(ROUND(res.delta_s, 3) ORDER BY res.dt) AS ds
FROM UNNEST(solve_network(
  (SELECT ARRAY_AGG(STRUCT(basin, dt, pcp, aeti) ORDER BY basin, dt) FROM ts),
  (SELECT ARRAY_AGG(STRUCT(basin, downstream, area_km2, f) ORDER BY basin) FROM net_routes),
  {{SPINUP}}
)) AS res
GROUP BY id`;
  return sql.replaceAll("{{OUTLET_SB_ID}}", String(outlet.id)).replaceAll("{{SPINUP}}", String(SPINUP));
}

async function query(sql: string): Promise<Row[]> {
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, output_format: "json", download: "false" }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`The model query failed (${response.status}): ${text.slice(0, 300)}`);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error(`The model query failed: ${text.slice(0, 300)}`);
  return rows;
}

/** Rows to series on one shared dekad axis (missing values are NaN). */
function toResult(outlet: number, rows: Row[]): NetworkResult {
  const dekads = [...new Set(rows.flatMap((r) => r.dk))].sort((a, b) => a - b);
  const index = new Map(dekads.map((dk, i) => [dk, i]));
  const series = new Map<number, Series>();
  for (const row of rows) {
    const s: Series = {
      PCP: new Float64Array(dekads.length).fill(NaN),
      AETI: new Float64Array(dekads.length).fill(NaN),
      Q: new Float64Array(dekads.length).fill(NaN),
      dS: new Float64Array(dekads.length).fill(NaN),
    };
    row.dk.forEach((dk, j) => {
      const i = index.get(dk)!;
      s.PCP[i] = row.pcp[j] ?? NaN;
      s.AETI[i] = row.aeti[j] ?? NaN;
      s.Q[i] = row.q[j] ?? NaN;
      s.dS[i] = row.ds[j] ?? NaN;
    });
    series.set(row.id, s);
  }
  return { outlet, dekads, series };
}

/** The part of `range` that has model output, or null if none of it has. */
export function coveredRange({ dekads }: NetworkResult, range: DekadRange): DekadRange | null {
  if (!dekads.length) return null;
  const start = Math.max(range.start, dekads[0]);
  const end = Math.min(range.end, dekads[dekads.length - 1]);
  return start <= end ? { start, end } : null;
}

/** Mean of each variable per sub-basin over the dekads in `range` (inclusive). */
export function periodMeans({ dekads, series }: NetworkResult, range: DekadRange): Means {
  const from = dekads.findIndex((dk) => dk >= range.start);
  let to = dekads.findIndex((dk) => dk > range.end);
  if (to < 0) to = dekads.length;
  const means: Means = new Map();
  for (const [id, s] of series) {
    means.set(id, { PCP: mean(s.PCP, from, to), AETI: mean(s.AETI, from, to), Q: mean(s.Q, from, to), dS: mean(s.dS, from, to) });
  }
  return means;
}

/** Mean of the finite values in values[from..to). */
export function mean(values: Float64Array, from = 0, to = values.length): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    if (Number.isFinite(values[i])) {
      sum += values[i];
      n++;
    }
  }
  return n ? sum / n : NaN;
}
