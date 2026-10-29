/*
 * Build the dams for the Local view's Dams map:
 *   public/data/dams.json
 *     { source, count, columns: { name, country, river, basin, year, height, capacity,
 *       area, purposes, validated, lon, lat } }
 *
 * One list per column, a dam per index (so the browser reads all ~14,000 at once and
 * picks any column to draw). From the CSV FAO's Water Portal (review) loads for its
 * Infrastructure > Dams layer: AQUASTAT's geo-referenced dams, a newer edition than
 * the regional Excel files on AQUASTAT's website (more dams, and whether each location
 * was checked). Dams without coordinates (about 3,100) are left out.
 *
 * - year: completed / operational since; height: m; capacity: million m³; area: km².
 * - purposes: bits, in the order of PURPOSES below (0: none given).
 * - validated: 1 the location was checked, 0 not (often the nearest city's), null not said.
 * - name, country, river, basin: mended where the CSV lost their accented letters
 *   (dam-names.mjs), with AQUASTAT's regional Excel files.
 *
 * Run with `npm run dams`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { addWords, damNameMender, excelNames } from "./dam-names.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = "https://waterportal.review.fao.org/data/Dams/AQUASTAT_DAMS_corrected.csv";
const OUT = path.join(ROOT, "public/data/dams.json");

/** The purpose columns, in the order of their bits (src/local/vector-maps.ts names them). */
const PURPOSES = ["IRRIG", "WATERSUPPL", "FLOODCONTR", "Hydroelect", "NAVIGAT", "Recreation", "Pollution_", "Livestock"];

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
const rows = parseCsv(await res.text());
const header = rows[0];
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`The dams CSV has no column ${name}`);
  return i;
};
const at = Object.fromEntries(
  ["NAME", "Country", "ISO3", "River", "MAJOR_BAS", "OP_SINCE", "HEIGHT_m", "CAPACITY_M", "AREA_KM2", "Validated", "Latitude", "longitude", ...PURPOSES].map((c) => [c, col(c)]),
);

// The names spelled right (the Excel files', the CSV's own), to mend the others with.
const { names, words } = await excelNames();
for (const row of rows.slice(1)) for (const c of [at.NAME, at.Country, at.River, at.MAJOR_BAS]) addWords(words, row[c]);
const mend = damNameMender(names, words);
const mendings = { name: [0, 0], country: [0, 0], river: [0, 0], basin: [0, 0] }; // [mended, not quite]
const mended = (s, row, field) => {
  const raw = s.trim();
  const { name, mended: ok } = mend(raw, row[at.ISO3].trim(), field === "country" ? "name" : field);
  if (name !== raw || !ok) mendings[field][ok ? 0 : 1]++;
  return name;
};

const num = (s, digits) => {
  const v = Number(s);
  return s.trim() === "" || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
};
const columns = { name: [], country: [], river: [], basin: [], year: [], height: [], capacity: [], area: [], purposes: [], validated: [], lon: [], lat: [] };
for (const row of rows.slice(1)) {
  if (row.length < header.length) continue;
  const lat = num(row[at.Latitude], 4);
  const lon = num(row[at.longitude], 4);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
  columns.name.push(mended(row[at.NAME], row, "name"));
  columns.country.push(mended(row[at.Country], row, "country"));
  columns.river.push(mended(row[at.River], row, "river"));
  columns.basin.push(mended(row[at.MAJOR_BAS], row, "basin"));
  columns.year.push(num(row[at.OP_SINCE], 0));
  columns.height.push(num(row[at.HEIGHT_m], 1));
  columns.capacity.push(num(row[at.CAPACITY_M], 3));
  columns.area.push(num(row[at.AREA_KM2], 3));
  columns.purposes.push(PURPOSES.reduce((bits, p, i) => (row[at[p]] === "TRUE" ? bits | (1 << i) : bits), 0));
  const validated = row[at.Validated];
  columns.validated.push(validated === "TRUE" ? 1 : validated === "FALSE" ? 0 : null);
  columns.lon.push(lon);
  columns.lat.push(lat);
}

const count = columns.lat.length;
await fs.writeFile(OUT, JSON.stringify({ source: SOURCE, count, columns }));
console.log(`${count} of ${rows.length - 1} dams (with coordinates) → ${path.relative(ROOT, OUT)}`);
for (const [field, [ok, not]] of Object.entries(mendings)) console.log(`  ${field}: ${ok} mended, ${not} with letters still lost ("?")`);

/** RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes. */
function parseCsv(text) {
  const out = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') field += text[++i];
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) out.push([...row, field]);
  return out;
}
