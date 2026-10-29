/*
 * AQUASTAT country statistics for the Country view, read straight from FAO's
 * dissemination table (fao-maps.fao_aquastat_dissemination.mvw_aquastat) through the
 * same read-only BigQuery proxy the Basin view's model uses.
 *
 * Each topic (tab of the panel) loads its own variables once, for every country and
 * every aggregate (World, regions), from 2010. One row per area and variable, with the
 * years and values as arrays, keeps the response small (~300 KB per topic).
 *
 * Areas are M49 codes: countries, and the aggregates 1 (World) and the regions in
 * public/data/country-info.json. Some variables have no aggregates (renewable water
 * resources by origin and source, wastewater reuse, irrigation by source); charts that
 * need them per region sum or weight the region's countries themselves (see regionValue).
 */
import { memoized } from "../lib/memo";

const PROXY_URL = "https://data.apps.fao.org/api/v2/bigquery";
const TABLE = "`fao-maps.fao_aquastat_dissemination.mvw_aquastat`";
export const FIRST_YEAR = 2010;
export const BASE_YEAR = 2015; // the SDG 6.4 baseline
export const WORLD = 1;

/** The AQUASTAT variables used, by short key: their name in the table and unit. */
export const VARS = {
  pop: { name: "Total population", unit: "1000 inhab" },
  // Water resources
  trwr: { name: "Total renewable water resources", unit: "10⁹ m³/yr" },
  trwrpc: { name: "Total renewable water resources per capita", unit: "m³/inhab/yr" },
  irwr: { name: "Total internal renewable water resources (IRWR)", unit: "10⁹ m³/yr" },
  ext: { name: "Water resources: total external renewable", unit: "10⁹ m³/yr" },
  rsw: { name: "Total renewable surface water", unit: "10⁹ m³/yr" },
  rgw: { name: "Total renewable groundwater", unit: "10⁹ m³/yr" },
  overlap: { name: "Overlap between surface water and groundwater", unit: "10⁹ m³/yr" },
  dep: { name: "Dependency ratio", unit: "%" },
  dam: { name: "Total dam capacity", unit: "km³" },
  // Water use
  tww: { name: "Total water withdrawal", unit: "10⁹ m³/yr" },
  tfw: { name: "Total freshwater withdrawal", unit: "10⁹ m³/yr" },
  twpc: { name: "Total water withdrawal per capita", unit: "m³/inhab/yr" },
  aw: { name: "Agricultural water withdrawal", unit: "10⁹ m³/yr" },
  iw: { name: "Industrial water withdrawal", unit: "10⁹ m³/yr" },
  mw: { name: "Municipal water withdrawal", unit: "10⁹ m³/yr" },
  awpc: { name: "Agricultural water withdrawal per capita", unit: "m³/inhab/yr" },
  iwpc: { name: "Industrial water withdrawal per capita", unit: "m³/inhab/yr" },
  mwpc: { name: "Municipal water withdrawal per capita (total population)", unit: "m³/inhab/yr" },
  fsw: { name: "Fresh surface water withdrawal", unit: "10⁹ m³/yr" },
  fgw: { name: "Fresh groundwater withdrawal", unit: "10⁹ m³/yr" },
  desal: { name: "Desalinated water produced", unit: "10⁹ m³/yr" },
  reuse: { name: "Direct use of treated municipal wastewater", unit: "10⁹ m³/yr" },
  // Irrigation
  aei: { name: "Area equipped for irrigation: total", unit: "1000 ha" },
  fci: { name: "Area equipped for full control irrigation: total", unit: "1000 ha" },
  fcSurface: { name: "Area equipped for full control irrigation: surface irrigation", unit: "1000 ha" },
  fcSprinkler: { name: "Area equipped for full control irrigation: sprinkler irrigation", unit: "1000 ha" },
  fcLocalized: { name: "Area equipped for full control irrigation: localized irrigation", unit: "1000 ha" },
  pctci: { name: "% of the cultivated area equipped for irrigation", unit: "%" },
  srcSurface: { name: "% of area equipped for irrigation by surface water", unit: "%" },
  // (sic: AQUASTAT's name ends in a space)
  srcGround: { name: "% of area equipped for irrigation by groundwater ", unit: "%" },
  srcMixed: { name: "% of area equipped for irrigation by mixed surface water and groundwater", unit: "%" },
  aai: { name: "Area equipped for irrigation: actually irrigated", unit: "1000 ha" },
  pctaai: { name: "% of the area equipped for irrigation actually irrigated", unit: "%" },
  crop: { name: "Cropland area (arable land + permanent crops)", unit: "1000 ha" },
  // SDG 6.4
  ws: { name: "SDG 6.4.2. Water Stress", unit: "%" },
  ascws: { name: "SDG 6.4.2. Agricultural Sector Contribution to Water Stress", unit: "%" },
  iscws: { name: "SDG 6.4.2. Industrial Sector Contribution to Water Stress", unit: "%" },
  mscws: { name: "SDG 6.4.2. Municipal Sector Contribution to Water Stress", unit: "%" },
  wue: { name: "SDG 6.4.1. Water Use Efficiency", unit: "US$/m³" },
  iwue: { name: "SDG 6.4.1. Industrial Water Use Efficiency", unit: "US$/m³" },
  iawue: { name: "SDG 6.4.1. Irrigated Agriculture Water Use Efficiency", unit: "US$/m³" },
  swue: { name: "SDG 6.4.1. Services Water Use Efficiency", unit: "US$/m³" },
} as const;

export type VarKey = keyof typeof VARS;

export type Topic = "sdg" | "resources" | "use" | "irrigation";

/**
 * Each topic's variables: its own, then those of other topics its maps and charts
 * combine them with (water stress under withdrawal, say), so a topic loads in one query.
 */
const TOPIC_VARS: Record<Topic, VarKey[]> = {
  sdg: ["pop", "tww", "ws", "ascws", "iscws", "mscws", "wue", "iwue", "iawue", "swue", "aw", "iw", "mw", "trwrpc"],
  resources: ["pop", "trwr", "trwrpc", "irwr", "ext", "rsw", "rgw", "overlap", "dep", "dam", "fgw", "desal", "reuse"],
  use: ["pop", "tww", "tfw", "twpc", "aw", "iw", "mw", "awpc", "iwpc", "mwpc", "fsw", "fgw", "desal", "reuse", "ws", "trwrpc"],
  irrigation: ["pop", "aei", "fci", "fcSurface", "fcSprinkler", "fcLocalized", "pctci", "srcSurface", "srcGround", "srcMixed", "aai", "pctaai", "crop", "aw", "iawue", "ascws"],
};

/** area -> variable -> year -> value */
const store = new Map<number, Map<VarKey, Map<number, number>>>();
const loads = new Map<Topic, Promise<void>>();
let latest = 0;

/** Load a topic's variables (once; a failed load is forgotten, so it can be retried). */
export function loadTopic(topic: Topic): Promise<void> {
  return memoized(loads, topic, () => query(TOPIC_VARS[topic]));
}

async function query(keys: VarKey[]) {
  const names = keys.map((k) => `'${VARS[k].name}'`).join(", ");
  const sql = `SELECT
  SAFE_CAST(area_code AS INT64) AS a,
  variable AS v,
  ARRAY_AGG(year ORDER BY year) AS y,
  ARRAY_AGG(ROUND(value, 4) ORDER BY year) AS x
FROM ${TABLE}
WHERE year >= ${FIRST_YEAR} AND value IS NOT NULL AND variable IN (${names})
GROUP BY a, v`;
  const response = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, output_format: "json", download: "false" }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`The AQUASTAT query failed (${response.status}): ${text.slice(0, 300)}`);
  const rows = JSON.parse(text) as { a: number | null; v: string; y: number[]; x: number[] }[];
  if (!Array.isArray(rows)) throw new Error(`The AQUASTAT query failed: ${text.slice(0, 300)}`);

  const keyOf = new Map(keys.map((k) => [VARS[k].name as string, k]));
  for (const row of rows) {
    const key = keyOf.get(row.v);
    if (row.a === null || !key) continue;
    if (!store.has(row.a)) store.set(row.a, new Map());
    store.get(row.a)!.set(key, new Map(row.y.map((y, i) => [y, row.x[i]])));
    latest = Math.max(latest, row.y[row.y.length - 1]);
  }
}

/** The latest year with any data loaded (0: nothing loaded yet). */
export const latestYear = () => latest;

/** All years of a variable for an area (empty: none). */
export function series(area: number, key: VarKey): Map<number, number> {
  return store.get(area)?.get(key) ?? new Map();
}

/** The value in `year`, or else the latest one before it (AQUASTAT fills most years). */
function valueAt(area: number, key: VarKey, year: number): number {
  const s = store.get(area)?.get(key);
  if (!s) return NaN;
  for (let y = year; y >= FIRST_YEAR; y--) {
    const v = s.get(y);
    if (v !== undefined) return v;
  }
  return NaN;
}

/** Calendar years `from` to `to`, both included: the top bar's range in the Country view. */
export interface Period {
  from: number;
  to: number;
}

export const yearPeriod = (y: number): Period => ({ from: y, to: y });

/** "2023", or "2019–2023". */
export const periodLabel = ({ from, to }: Period) => (from === to ? String(from) : `${from}–${to}`);

/** The mean of `value` over a period's years, leaving out years without one. */
export function meanOver(p: Period, value: (year: number) => number): number {
  let sum = 0;
  let n = 0;
  for (let y = p.from; y <= p.to; y++) {
    const v = value(y);
    if (!Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  return n ? sum / n : NaN;
}

/** A variable's yearly mean over a period (each year as in valueAt). */
export const meanAt = (area: number, key: VarKey, p: Period) => meanOver(p, (y) => valueAt(area, key, y));

/**
 * A region's (or the World's) value: AQUASTAT's own aggregate where there is one,
 * else the sum over its countries, or with `weight`, their mean weighted by that
 * variable (for percentages of an area).
 */
export function regionValue(code: number, key: VarKey, year: number, members: number[], weight?: VarKey): number {
  if (!weight) {
    const own = valueAt(code, key, year);
    if (Number.isFinite(own)) return own;
  }
  let sum = 0;
  let total = 0;
  let n = 0;
  for (const m of members) {
    const v = valueAt(m, key, year);
    if (!Number.isFinite(v)) continue;
    const w = weight ? valueAt(m, weight, year) : 1;
    if (!Number.isFinite(w)) continue;
    sum += v * w;
    total += w;
    n++;
  }
  if (!n) return NaN;
  return weight ? (total ? sum / total : NaN) : sum;
}
