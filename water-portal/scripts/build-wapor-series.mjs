/*
 * Every sub-basin's dekadal WaPOR v3 L1 precipitation (PCP) and actual
 * evapotranspiration (AETI), for the Basin view's statistics (src/basin/stats-data.ts),
 * which sum them over any date range in the browser, without a query per range:
 *   public/data/wapor-series.bin
 *
 * From the zonal statistics the water balance model reads, through FAO's BigQuery proxy,
 * in chunks of sub-basins (the proxy returns at most 50,000 rows, and big responses
 * fail). Run with `npm run wapor-series`; again when WaPOR has new dekads.
 *
 * wapor-series.bin (little-endian):
 *   Uint32 header length, then the header, JSON, padded with spaces to 4 bytes:
 *     { version, first: "yyyy-mm-dd", dekads, n, scale: { pcp, aeti }, none }
 *     (first: the first dekad's start; dekads: how many follow on from it)
 *   Int32[n]          sub-basin (SDG 6 SBM id)
 *   Int32[n]          its major basin (SDG 6 MBM id)
 *   Float32[n]        area, km²
 *   Uint16[n*dekads]  PCP per sub-basin, then per dekad: mean mm/day × scale.pcp
 *   Uint16[n*dekads]  AETI, the same with scale.aeti
 *   (none: no value for that dekad)
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public/data/wapor-series.bin");
const PROXY_URL = "https://data.apps.fao.org/api/v2/bigquery";
const TABLES = {
  pcp: "`fao-maps-review.zonal_stats_openEO.L1-PCP-D_HYDRO_SUB_BASIN_V2`",
  aeti: "`fao-maps-review.zonal_stats_openEO.L1-AETI-D_HYDRO_SUB_BASIN_V2`",
};
const FIRST_YEAR = 2018;
// mm/day: PCP to 163 at 0.0025, AETI to 13 at 0.0002 (the highest dekads: 135 and 7.4).
const SCALE = { pcp: 400, aeti: 5000 };
const NONE = 65535;
const CHUNKS = 16;

async function query(sql) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql, output_format: "json", download: "false" }),
    });
    const text = await response.text();
    const rows = response.ok ? JSON.parse(text) : null;
    if (Array.isArray(rows)) return rows;
    if (attempt === 3) throw new Error(`Query failed (${response.status}): ${text.slice(0, 300)}`);
    console.warn(`  retrying (${response.status})`);
  }
}

// --- Download --------------------------------------------------------------------------
/** Per sub-basin: { mb, area (m²), pcp: Map<dekad, mm/day>, aeti: … }. */
const subs = new Map();
let last = 0;
for (const [v, table] of Object.entries(TABLES)) {
  for (let chunk = 0; chunk < CHUNKS; chunk++) {
    const rows = await query(`SELECT FAO_SB_ID AS id, ANY_VALUE(FAO_MB_ID) AS mb, ANY_VALUE(area) AS area,
  ARRAY_AGG((EXTRACT(YEAR FROM start_datetime) - ${FIRST_YEAR}) * 36 + (EXTRACT(MONTH FROM start_datetime) - 1) * 3
    + DIV(EXTRACT(DAY FROM start_datetime) - 1, 10) ORDER BY start_datetime) AS k,
  ARRAY_AGG(IFNULL(ROUND(mean, 5), -1) ORDER BY start_datetime) AS x
FROM ${table} WHERE MOD(FAO_SB_ID, ${CHUNKS}) = ${chunk} GROUP BY id`);
    for (const row of rows) {
      let s = subs.get(row.id);
      if (!s) subs.set(row.id, (s = { mb: row.mb, area: row.area, pcp: new Map(), aeti: new Map() }));
      row.k.forEach((k, i) => {
        if (row.x[i] >= 0) s[v].set(k, row.x[i]);
        last = Math.max(last, k);
      });
    }
    console.log(`${v} ${chunk + 1}/${CHUNKS}: ${rows.length} sub-basins`);
  }
}

// --- Write -----------------------------------------------------------------------------
const ids = [...subs.keys()].sort((a, b) => a - b);
const n = ids.length;
const dekads = last + 1;
const header = { version: 1, first: `${FIRST_YEAR}-01-01`, dekads, n, scale: SCALE, none: NONE };
let json = JSON.stringify(header);
json += " ".repeat((4 - (json.length % 4)) % 4);
const id = new Int32Array(ids);
const mb = new Int32Array(ids.map((i) => subs.get(i).mb));
const area = new Float32Array(ids.map((i) => subs.get(i).area / 1e6));
const series = { pcp: new Uint16Array(n * dekads).fill(NONE), aeti: new Uint16Array(n * dekads).fill(NONE) };
let clipped = 0;
ids.forEach((i, row) => {
  for (const v of ["pcp", "aeti"]) {
    for (const [k, x] of subs.get(i)[v]) {
      const q = Math.round(x * SCALE[v]);
      if (q >= NONE) clipped++;
      series[v][row * dekads + k] = Math.min(q, NONE - 1);
    }
  }
});
if (clipped) console.warn(`${clipped} values above the scale's range, clipped`);

const length = new Uint32Array([json.length]);
const bytes = (x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);
await fs.writeFile(OUT, Buffer.concat([bytes(length), Buffer.from(json), ...[id, mb, area, series.pcp, series.aeti].map(bytes)]));
const size = (await fs.stat(OUT)).size;
console.log(`${path.relative(ROOT, OUT)}: ${n} sub-basins × ${dekads} dekads, ${(size / 1e6).toFixed(1)} MB`);
