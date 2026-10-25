/*
 * The water balance model: discharge (Q) and storage change (ΔS) from WaPOR L1
 * precipitation (PCP) and actual evapotranspiration (AETI).
 *
 * The maps read them precomputed: fao_wapor_discharge.portal runs the model for every
 * outlet network and writes, under MODEL_FILES (see the README),
 *
 *   latest.json        the dekads covered, and a version for the other files' URLs;
 *   majors.json        per major basin, Q at its outlets and ΔS summed, per dekad;
 *   major/<id>.json    per sub-basin of a major basin, Q and ΔS per dekad.
 *
 * The rest of this module runs the model itself, for a sub-basin and everything upstream
 * of it (the water balance panel, switched off for now: MODEL_SHOWN in water-balance.ts).
 *
 * The model runs here, in the browser: calc_runoff.js is a copy of js/calc_runoff.js
 * from the fao-wapor-discharge project, a port of its calc_runoff (a linear-reservoir
 * model, routed downstream through the sub-basins, retention factor 0.1) that gives
 * the same numbers as the Python function, bit for bit. Its inputs, the network's
 * dekadal PCP and AETI, come from FAO's BigQuery proxy, joined as the Python pipeline
 * joins them, with one row per sub-basin and the time series as arrays: the proxy
 * returns at most 50,000 rows, and big networks have more (the Mississippi: 766
 * sub-basins × 288 dekads).
 */
import { MIN_YEAR, mk } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import type { SubBasin } from "../map/sub-basin-network";
import { calcRunoff } from "./calc_runoff.js";

const PROXY_URL = "https://data.apps.fao.org/api/v2/bigquery";
/** Where the precomputed model output is (a directory URL, ending in /). */
const MODEL_FILES: string = import.meta.env.VITE_MODEL_FILES ?? `${import.meta.env.BASE_URL}data/model/`;
const FORMAT_VERSION = 1; // of the files
const PCP = "`fao-maps-review.zonal_stats_openEO.L1-PCP-D_HYDRO_SUB_BASIN_V2`";
const AETI = "`fao-maps-review.zonal_stats_openEO.L1-AETI-D_HYDRO_SUB_BASIN_V2`";
const SPINUP = 2; // model passes (calc_runoff's default)
// BigQuery arrays can't hold NULL; PCP and AETI are never negative.
const NONE = -9999;

export type Variable = "PCP" | "AETI" | "Q" | "dS";
export const VARIABLES: Variable[] = ["PCP", "AETI", "Q", "dS"];

/** Per sub-basin, one value per dekad of `dekads`: PCP, AETI in mm/day; Q, ΔS in m³/s. */
export type Series = Record<Variable, Float64Array>;

export interface ModelSeries {
  /** Dekad indices (see dekads.ts) with model output, ascending. */
  dekads: number[];
  series: Map<number, Series>;
}

export interface NetworkResult extends ModelSeries {
  /** The sub-basin the network drains to (the one that was selected). */
  outlet: number;
}

/** Q and ΔS (m³/s) per dekad, of the precomputed files. */
export type Flux = "Q" | "dS";
export interface FluxSeries {
  /** Dekad indices, ascending and consecutive. */
  dekads: number[];
  series: Map<number, Record<Flux, Float64Array>>;
}

/** What latest.json says: the dekads the files cover. */
export interface ModelFiles {
  first: number;
  last: number;
  updated: string;
}

/** Period means per sub-basin (PCP, AETI in mm/day; Q, ΔS in m³/s). */
export type Means = Map<number, Record<Variable, number>>;

/** A sub-basin's inputs: start times (Unix seconds), PCP and AETI in mm/day. */
interface Row {
  id: number;
  t: number[];
  pcp: number[];
  aeti: number[];
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
    const network = [outlet, ...upstream];
    result = query(inputsSql(network.map((b) => b.id))).then((rows) => {
      // The outlet drains out of the network: -999 (terminal), as far as the model knows.
      const routes = Object.fromEntries(network.map((b) => [b.id, [b.id === outlet.id ? -999 : b.downstream, b.area]]));
      return { outlet: outlet.id, ...toSeries([runModel(rows, routes)]) };
    });
    result.catch(() => results.delete(outlet.id));
    results.set(outlet.id, result);
  }
  return result;
}

// --- Precomputed output -----------------------------------------------------------------
// Loaded once (a failed load is forgotten, so it can be retried).

let latest: Promise<ModelFiles> | null = null;
const files = new Map<string, Promise<FluxSeries>>();

/** latest.json: the dekads with output. Always asked for afresh, not from the cache. */
export function loadModelFiles(): Promise<ModelFiles> {
  if (!latest) {
    latest = fetchJson(`${MODEL_FILES}latest.json`, { cache: "no-cache" }).then((f) => {
      if (f.version !== FORMAT_VERSION) throw new Error(`The model output is in an unknown format (version ${f.version}).`);
      return { first: isoDekad(f.first), last: isoDekad(f.last), updated: f.updated };
    });
    latest.catch(() => (latest = null));
  }
  return latest;
}

/** Q and ΔS per major basin (Q: at its outlets, ΔS: summed over its sub-basins). */
export const loadMajorFluxes = () => loadFile("majors.json", "majors");

/** Q and ΔS per sub-basin of major basin `major`. */
export const loadSubBasinFluxes = (major: number) => loadFile(`major/${major}.json`, "subBasins");

function loadFile(path: string, key: string): Promise<FluxSeries> {
  let file = files.get(path);
  if (!file) {
    // Versioned, so a browser doesn't keep a copy from before an update.
    file = loadModelFiles()
      .then(({ updated }) => fetchJson(`${MODEL_FILES}${path}?v=${encodeURIComponent(updated)}`))
      .then((f) => {
        const first = isoDekad(f.first);
        const dekads = Array.from({ length: isoDekad(f.last) - first + 1 }, (_, i) => first + i);
        const values = (xs: (number | null)[]) => Float64Array.from(xs, (x) => x ?? NaN);
        const series = new Map<number, Record<Flux, Float64Array>>();
        for (const [id, s] of Object.entries(f[key] as Record<string, Record<Flux, (number | null)[]>>)) {
          series.set(Number(id), { Q: values(s.Q), dS: values(s.dS) });
        }
        return { dekads, series };
      });
    file.catch(() => files.delete(path));
    files.set(path, file);
  }
  return file;
}

/** Mean of `flux` per basin over the dekads in `range` (inclusive). */
export function fluxMeans({ dekads, series }: FluxSeries, range: DekadRange, flux: Flux): Map<number, number> {
  const from = Math.max(0, range.start - dekads[0]);
  const to = Math.min(dekads.length, range.end - dekads[0] + 1);
  return new Map([...series].map(([id, s]) => [id, mean(s[flux], from, to)]));
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`The model output couldn't be loaded (${response.status} for ${url}).`);
  return response.json();
}

/** The dekad of an ISO date (yyyy-mm-dd). */
function isoDekad(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return (y - MIN_YEAR) * 36 + (m - 1) * 3 + (d <= 10 ? 0 : d <= 20 ? 1 : 2);
}

// --- Running the model -------------------------------------------------------------------

/** The inner join of the PCP and AETI zonal statistics, as pipeline._combine does it. */
function inputsSql(ids: number[]): string {
  return `SELECT p.FAO_SB_ID AS id,
  ARRAY_AGG(UNIX_SECONDS(p.start_datetime) ORDER BY p.start_datetime) AS t,
  ARRAY_AGG(IFNULL(p.mean, ${NONE}) ORDER BY p.start_datetime) AS pcp,
  ARRAY_AGG(IFNULL(a.mean, ${NONE}) ORDER BY p.start_datetime) AS aeti
FROM ${PCP} AS p
JOIN ${AETI} AS a ON a.FAO_SB_ID = p.FAO_SB_ID AND a.start_datetime = p.start_datetime
WHERE p.FAO_SB_ID IN (${ids.join(", ")})
GROUP BY id`;
}

function runModel(rows: Row[], routes: Record<string, unknown[]>) {
  const basin: number[] = [];
  const start: number[] = [];
  const pcp: number[] = [];
  const aeti: number[] = [];
  const value = (v: number) => (v === NONE ? NaN : v);
  for (const row of rows) {
    row.t.forEach((t, i) => {
      basin.push(row.id);
      start.push(t * 1000);
      pcp.push(value(row.pcp[i]));
      aeti.push(value(row.aeti[i]));
    });
  }
  return calcRunoff({ basin, start, pcp, aeti }, routes, { spinup: SPINUP });
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

/** Model output (of one or more networks) to series on one shared dekad axis (missing values are NaN). */
function toSeries(outs: ReturnType<typeof calcRunoff>[]): ModelSeries {
  const dekadOf = (ms: number) => {
    const d = new Date(ms);
    return mk(d.getUTCFullYear(), d.getUTCMonth(), Math.floor((d.getUTCDate() - 1) / 10));
  };
  const rowDekads = outs.map((out) => out.start.map(dekadOf));
  const dekads = [...new Set(rowDekads.flat())].sort((a, b) => a - b);
  const index = new Map(dekads.map((dk, i) => [dk, i]));
  const series = new Map<number, Series>();
  outs.forEach((out, o) => out.basin.forEach((id, r) => {
    let s = series.get(id);
    if (!s) {
      const empty = () => new Float64Array(dekads.length).fill(NaN);
      series.set(id, (s = { PCP: empty(), AETI: empty(), Q: empty(), dS: empty() }));
    }
    const i = index.get(rowDekads[o][r])!;
    s.PCP[i] = out.pcp[r];
    s.AETI[i] = out.aeti[r];
    s.Q[i] = out.q[r];
    s.dS[i] = out.dS[r];
  }));
  return { dekads, series };
}

/** The part of `range` that has model output, or null if none of it has. */
export function coveredRange({ dekads }: { dekads: number[] }, range: DekadRange): DekadRange | null {
  if (!dekads.length) return null;
  const start = Math.max(range.start, dekads[0]);
  const end = Math.min(range.end, dekads[dekads.length - 1]);
  return start <= end ? { start, end } : null;
}

/** Mean of each variable per sub-basin over the dekads in `range` (inclusive). */
export function periodMeans({ dekads, series }: ModelSeries, range: DekadRange): Means {
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
