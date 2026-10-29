/*
 * The Basin view's data: WaPOR L1 precipitation (PCP) and actual evapotranspiration
 * (AETI), and the water balance model's discharge (Q) and storage change (ΔS) from them.
 *
 * All precomputed by scripts/build-model.py, which downloads the WaPOR zonal
 * statistics, runs the model for every outlet network and writes, under MODEL_FILES
 * (see the README),
 *
 *   latest.json        the dekads covered, and a version for the other files' URLs;
 *   subbasins.bin      per sub-basin, its major basin, area, and PCP and AETI per dekad;
 *   majors.bin         per major basin, Q at its outlets and ΔS summed, per dekad;
 *   major/<id>.bin     per sub-basin of a major basin, Q and ΔS per dekad.
 *
 * Every series runs over the same dekads, those in latest.json. The .bin format: see
 * parseFile (and scripts/build-model.py). Nothing is queried here: the files are all there is.
 *
 * The water balance panel (switched off for now: MODEL_SHOWN in water-balance.ts) shows a
 * sub-basin and everything upstream of it: networkSeries, from the same files.
 */
import { MIN_YEAR } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import type { SubBasin } from "../map/sub-basin-network";
import { memoized } from "../lib/memo";

/** Where the precomputed files are (a directory URL, ending in /). */
const MODEL_FILES: string = import.meta.env.VITE_MODEL_FILES ?? `${import.meta.env.BASE_URL}data/model/`;
const FORMAT_VERSION = 2; // of the files

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

/** A .bin file: per id (a sub-basin or major basin), some values and some series. */
export interface DataFile {
  /** The first dekad (as in dekads.ts), and how many follow on. */
  first: number;
  dekads: number;
  ids: Int32Array;
  /** One value per id. */
  columns: Record<string, Int32Array | Float32Array>;
  /** One value per id per dekad, id after id (NaN: missing). */
  series: Record<string, Float32Array>;
}

// Loaded once (a failed load is forgotten, so it can be retried).

let latest: Promise<ModelFiles> | null = null;
const files = new Map<string, Promise<DataFile>>();
const fluxes = new Map<string, Promise<FluxSeries>>();
const networks = new Map<number, Promise<NetworkResult>>();

/** latest.json: the dekads with output. Always asked for afresh, not from the cache. */
export function loadModelFiles(): Promise<ModelFiles> {
  if (!latest) {
    latest = fetch(`${MODEL_FILES}latest.json`, { cache: "no-cache" })
      .then((r) => checked(r, "latest.json").json())
      .then((f) => {
        if (f.version !== FORMAT_VERSION) throw new Error(`The model output is in an unknown format (version ${f.version}).`);
        return { first: isoDekad(f.first), last: isoDekad(f.last), updated: f.updated };
      });
    latest.catch(() => (latest = null));
  }
  return latest;
}

/** One of the .bin files, by its path under MODEL_FILES. */
export function loadFile(path: string): Promise<DataFile> {
  // Versioned, so a browser doesn't keep a copy from before an update.
  return memoized(files, path, () =>
    loadModelFiles()
      .then(({ updated }) => fetch(`${MODEL_FILES}${path}?v=${encodeURIComponent(updated)}`))
      .then((r) => checked(r, path).arrayBuffer())
      .then(parseFile),
  );
}

function checked(response: Response, path: string) {
  if (!response.ok) throw new Error(`The model output couldn't be loaded (${response.status} for ${path}).`);
  // (Vite's dev server answers a missing file with index.html, as if it were there.)
  if (response.headers.get("content-type")?.includes("text/html")) throw new Error(`The model output isn't there (${path}): not built yet; see scripts/build-model.py.`);
  return response;
}

/**
 * Little-endian: Uint32 header length; the header, JSON ({ first, dekads, n, columns:
 * [{ name, type }], series: [{ name, type, scale?, none? }] }); Int32[n] ids; each column,
 * n values; each series, n × dekads values, id after id: float32 (NaN: missing), or
 * uint16 (value × scale; `none`: missing).
 */
function parseFile(buf: ArrayBuffer): DataFile {
  const length = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, length)));
  const { n, dekads } = header;
  let offset = 4 + length;
  const types = { int32: Int32Array, float32: Float32Array, uint16: Uint16Array };
  const take = (type: keyof typeof types, count: number) => {
    const array = new types[type](buf, offset, count);
    offset += array.byteLength;
    return array;
  };
  const ids = take("int32", n) as Int32Array;
  const columns: DataFile["columns"] = {};
  for (const c of header.columns) columns[c.name] = take(c.type, n) as Int32Array | Float32Array;
  const series: DataFile["series"] = {};
  for (const s of header.series) {
    const raw = take(s.type, n * dekads);
    series[s.name] = s.type === "uint16" ? Float32Array.from(raw, (x) => (x === s.none ? NaN : x / s.scale)) : (raw as Float32Array);
  }
  return { first: isoDekad(header.first), dekads, ids, columns, series };
}

/** Row `row` of series `name`, as numbers. */
const rowOf = (file: DataFile, name: string, row: number) =>
  Float64Array.from(file.series[name].subarray(row * file.dekads, (row + 1) * file.dekads));

/** Q and ΔS per major basin (Q: at its outlets, ΔS: summed over its sub-basins). */
export const loadMajorFluxes = () => loadFluxes("majors.bin");

/** Q and ΔS per sub-basin of major basin `major`. */
export const loadSubBasinFluxes = (major: number) => loadFluxes(`major/${major}.bin`);

function loadFluxes(path: string): Promise<FluxSeries> {
  return memoized(fluxes, path, () =>
    loadFile(path).then((file) => ({
      dekads: Array.from({ length: file.dekads }, (_, i) => file.first + i),
      series: new Map([...file.ids].map((id, row) => [id, { Q: rowOf(file, "Q", row), dS: rowOf(file, "dS", row) }])),
    })),
  );
}

/**
 * All four variables for `outlet` and the sub-basins upstream of it (`upstream`, not
 * including `outlet`), over the dekads with the outlet's Q. The network can reach into
 * other major basins: their files are loaded too.
 */
export function networkSeries(outlet: SubBasin, upstream: SubBasin[]): Promise<NetworkResult> {
  let result = networks.get(outlet.id);
  if (!result) {
    const network = [outlet, ...upstream];
    const majors = [...new Set(network.map((b) => b.majorBasin))];
    result = Promise.all([loadFile("subbasins.bin"), ...majors.map((m) => loadFile(`major/${m}.bin`))]).then(([wapor, ...flux]) => {
      const rows = (file: DataFile) => new Map([...file.ids].map((id, row) => [id, row]));
      const waporRows = rows(wapor);
      const fluxRows = flux.map(rows);
      const empty = () => new Float64Array(wapor.dekads).fill(NaN);
      const all = new Map<number, Series>();
      for (const b of network) {
        const w = waporRows.get(b.id);
        const f = fluxRows.findIndex((r) => r.has(b.id));
        const fr = f < 0 ? null : fluxRows[f].get(b.id)!;
        all.set(b.id, {
          PCP: w === undefined ? empty() : rowOf(wapor, "PCP", w),
          AETI: w === undefined ? empty() : rowOf(wapor, "AETI", w),
          Q: fr === null ? empty() : rowOf(flux[f], "Q", fr),
          dS: fr === null ? empty() : rowOf(flux[f], "dS", fr),
        });
      }
      // The dekads the model has output for (its network's common date range).
      const q = all.get(outlet.id)!.Q;
      const from = q.findIndex(Number.isFinite);
      const to = from < 0 ? 0 : q.findLastIndex(Number.isFinite) + 1;
      const dekads = Array.from({ length: Math.max(0, to - from) }, (_, i) => wapor.first + from + i);
      const series = new Map<number, Series>();
      for (const [id, s] of all) {
        series.set(id, { PCP: s.PCP.slice(from, to), AETI: s.AETI.slice(from, to), Q: s.Q.slice(from, to), dS: s.dS.slice(from, to) });
      }
      return { outlet: outlet.id, dekads, series };
    });
    result.catch(() => networks.delete(outlet.id));
    networks.set(outlet.id, result);
  }
  return result;
}

/** The dekad of an ISO date (yyyy-mm-dd). */
function isoDekad(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return (y - MIN_YEAR) * 36 + (m - 1) * 3 + (d <= 10 ? 0 : d <= 20 ? 1 : 2);
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
