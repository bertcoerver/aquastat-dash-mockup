/*
 * Build what the Country view needs to know about each country besides its name:
 *   public/data/country-info.json
 *     { regions: [{ code, name }], countries: { [m49]: { region, center } } }
 *
 * - region: the M49 code of the AQUASTAT region it is reported in. These are the
 *   regions of FAO's Water Portal charts: SDG regions, with Northern Africa and
 *   Western Asia, Central and Southern Asia, and Eastern and South-Eastern Asia
 *   split into their sub-regions. From UNSD's M49 table.
 * - center: [lon, lat], the centroid of the country's largest polygon (where the
 *   map draws a country's proportional circle). From data/m49_geom.geojson.
 *
 * Only countries in one of these regions are listed.
 *
 * Run with `npm run country-info` (after `npm run tiles` has downloaded the polygons).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ROOT, fetchOk, round3 as round, writeJson } from "./lib.mjs";
const UNSD = "https://unstats.un.org/unsd/methodology/m49/overview/";

export const REGIONS = [
  { code: 202, name: "Sub-Saharan Africa" },
  { code: 15, name: "Northern Africa" },
  { code: 145, name: "Western Asia" },
  { code: 143, name: "Central Asia" },
  { code: 34, name: "Southern Asia" },
  { code: 30, name: "Eastern Asia" },
  { code: 35, name: "South-eastern Asia" },
  { code: 419, name: "Latin America and the Caribbean" },
  { code: 9, name: "Oceania" },
  { code: 513, name: "Europe and Northern America" },
];
const SUB_REGIONS = new Set([202, 15, 145, 143, 34, 30, 35, 419]);

// --- Regions: UNSD's table (HTML), one row per country ---------------------------
const html = await (await fetchOk(UNSD)).text();
const table = html.slice(html.indexOf('id = "downloadTableEN"'), html.indexOf("</table>", html.indexOf('id = "downloadTableEN"')));
const text = (cell) => cell.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
  [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1])),
);
const header = rows[0];
const col = (name) => header.indexOf(name);
const [iRegion, iSub, iM49] = [col("Region Code"), col("Sub-region Code"), col("M49 Code")];
if (iRegion < 0 || iSub < 0 || iM49 < 0) throw new Error("UNSD's M49 table has changed");

const regionOf = new Map();
for (const row of rows.slice(1)) {
  const region = Number(row[iRegion]);
  const sub = Number(row[iSub]);
  const m49 = Number(row[iM49]);
  // Sub-Saharan Africa and Latin America are UNSD "intermediate" groupings of sub-regions.
  const code = SUB_REGIONS.has(sub) ? sub : region === 150 || sub === 21 ? 513 : region === 9 ? 9 : null;
  if (code !== null) regionOf.set(m49, code);
}

// --- Centres: the centroid of each country's largest polygon ------------------------
const geojson = JSON.parse(await fs.readFile(path.join(ROOT, "data/m49_geom.geojson"), "utf8"));
const centerOf = new Map();
for (const { properties, geometry } of geojson.features) {
  if (!geometry) continue;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  for (const [outer] of polygons) {
    const c = ringCentroid(outer);
    if (!best || Math.abs(c.area) > Math.abs(best.area)) best = c;
  }
  if (best) centerOf.set(properties.m49, [round(best.x), round(best.y)]);
}

// Only countries in a region: m49_geom also holds the regions themselves, historical
// units and territories AQUASTAT doesn't report on.
const countries = {};
for (const [m49, center] of centerOf) {
  if (regionOf.has(m49)) countries[m49] = { region: regionOf.get(m49), center };
}
const out = path.join(ROOT, "public/data/country-info.json");
await writeJson(out, { regions: REGIONS, countries });
console.log(`${Object.keys(countries).length} countries → ${path.relative(ROOT, out)}`);

/** Planar centroid and signed area of a ring (lon/lat: good enough for one country). */
function ringCentroid(ring) {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const f = x0 * y1 - x1 * y0;
    area += f;
    x += (x0 + x1) * f;
    y += (y0 + y1) * f;
  }
  if (!area) return { area: 0, x: ring[0][0], y: ring[0][1] };
  return { area: area / 2, x: x / (3 * area), y: y / (3 * area) };
}

