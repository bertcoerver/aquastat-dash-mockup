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
 */
import { MIN_YEAR } from "../toolbar/dekads";
import { memoized } from "../lib/memo";

/** Where the precomputed files are (a directory URL, ending in /). */
const MODEL_FILES: string = import.meta.env.VITE_MODEL_FILES ?? `${import.meta.env.BASE_URL}data/model/`;
const FORMAT_VERSION = 2; // of the files

export type Variable = "PCP" | "AETI" | "Q" | "dS";

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

/** The dekad of an ISO date (yyyy-mm-dd). */
function isoDekad(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return (y - MIN_YEAR) * 36 + (m - 1) * 3 + (d <= 10 ? 0 : d <= 20 ? 1 : 2);
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
