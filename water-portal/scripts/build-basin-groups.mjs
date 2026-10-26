/*
 * Group the major basins two ways, for the Basin view's charts (the Country view's
 * regions, for basins):
 *   public/data/basin-groups.json  { majors: { <id>: { drain, drainShare, ai, climate, covered } } }
 *
 * - drain: where most of the basin's water ends up (by area): the Atlantic, Pacific,
 *   Indian or Arctic Ocean, the Mediterranean (with the Black Sea), or inland (a sink
 *   that never reaches the sea). Each sub-basin follows its downstream sub-basins
 *   (public/data/sub-basins.json) to the end; one that drains to the sea (-999) drains
 *   into the ocean nearest its coast, after Marine Regions' Global Oceans and Seas
 *   (each of its pixels closest to the sea votes), unless that's far (the Caspian, which
 *   the sub-basins count as a sea: inland). drainShare: the part of the basin's
 *   area that goes there.
 * - climate: the UNEP aridity class of the basin's aridity index (ai): precipitation
 *   over reference evapotranspiration, WaPOR v3 L1 (PCP-A, RET-A), every pixel weighted
 *   by its area, over the years in YEARS. WaPOR's precipitation stops at 60°N, so a
 *   basin less than half covered (covered: the part that is) has none (null).
 *
 * The sub-basins' polygons come from the vector tiles the map shows (as in
 * build-lists.mjs: FAO's WFS has them too, but under other ids). Needs GDAL
 * (gdal_rasterize, gdalwarp) on the PATH. The polygons are downloaded to data/ the first
 * time (~200 MB each). Run with `npm run groups` (after `npm run lists`).
 */
import { parse } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const OUT = path.join(ROOT, "public/data/basin-groups.json");
const SUB_POLYGONS = path.join(DATA, "sub-basin-polygons.geojson");
const OCEANS = path.join(DATA, "oceans.geojson");
const OCEANS_URL =
  "https://geo.vliz.be/geoserver/MarineRegions/wfs?service=WFS&version=1.0.0&request=GetFeature" +
  "&typeName=MarineRegions:goas&propertyName=name,the_geom&outputFormat=application/json";
const SUB_TILES = "https://storage.googleapis.com/fao-cog-data/basins/SDG6_SBM_v1_tiles";
const ZOOM = 5;
const WAPOR = "/vsicurl/https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";
const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];

// The grid everything is put on: 0.05°, WaPOR's precipitation's.
const RES = 0.05;
const W = 360 / RES;
const H = 180 / RES;
// WaPOR's precipitation covers 60°N–60°S: rows ROW0 to ROW0 + WH of the grid.
const ROW0 = 30 / RES;
const WH = 120 / RES;

// Marine Regions' oceans and seas, by where the charts put them (index + 1 on the grid).
const DRAINS = [
  { id: "atlantic", seas: ["North Atlantic Ocean", "South Atlantic Ocean", "Baltic Sea"] },
  { id: "pacific", seas: ["North Pacific Ocean", "South Pacific Ocean", "South China and Easter Archipelagic Seas"] },
  { id: "indian", seas: ["Indian Ocean"] },
  { id: "arctic", seas: ["Arctic Ocean"] },
  { id: "mediterranean", seas: ["Mediterranean Region"] },
  { id: "southern", seas: ["Southern Ocean"] },
];
// UNEP's aridity classes: the upper bound of each.
const CLIMATES = [
  { id: "hyper-arid", max: 0.05 },
  { id: "arid", max: 0.2 },
  { id: "semi-arid", max: 0.5 },
  { id: "dry-subhumid", max: 0.65 },
  { id: "humid", max: Infinity },
];
const MIN_COVERED = 0.5;
// An outlet "to the sea" further than this from the oceans (pixels) is on an inland sea:
// the Caspian.
const MAX_COAST = 10;

if (!existsSync(OCEANS)) {
  console.log("Downloading the oceans…");
  const response = await fetch(OCEANS_URL);
  if (!response.ok) throw new Error(`${OCEANS_URL}: ${response.status}`);
  await fs.writeFile(OCEANS, Buffer.from(await response.arrayBuffer()));
}
if (!existsSync(SUB_POLYGONS)) await downloadSubBasins();

/** Every tile's sub-basin polygons, as they are (a polygon's pieces in each tile it's in). */
async function downloadSubBasins() {
  console.log("Downloading the sub-basins' tiles…");
  const n = 2 ** ZOOM;
  const jobs = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) jobs.push([x, y]);
  const out = await fs.open(SUB_POLYGONS, "w");
  await out.write('{"type":"FeatureCollection","features":[\n');
  let first = true;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let job; (job = jobs.pop()); ) {
        const [x, y] = job;
        const response = await fetch(`${SUB_TILES}/${ZOOM}/${x}/${y}.pbf`);
        if (!response.ok) continue;
        const features = await parse(await response.arrayBuffer(), MVTLoader, {
          mvt: { coordinates: "wgs84", tileIndex: { x, y, z: ZOOM }, shape: "geojson" },
        });
        const lines = features
          .filter((f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
          .map((f) => JSON.stringify({ type: "Feature", properties: { id: f.properties.SDG6_SB_ID }, geometry: f.geometry }));
        if (!lines.length) continue;
        const text = (first ? "" : ",\n") + lines.join(",\n");
        first = false;
        await out.write(text);
      }
    }),
  );
  await out.write("\n]}\n");
  await out.close();
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basin-groups-"));
// (The oceans are single features of ~80 MB each: more than GDAL reads by default.)
const env = { ...process.env, OGR_GEOJSON_MAX_OBJ_SIZE: "0" };
const gdal = (cmd, args) => execFileSync(cmd, ["-q", ...args], { stdio: ["ignore", "ignore", "inherit"], env });
const grid = (top, rows) => ["-te", "-180", String(top - rows * RES), "180", String(top), "-tr", String(RES), String(RES)];
async function read(file, Type) {
  const buf = await fs.readFile(file);
  return new Type(buf.buffer, buf.byteOffset, buf.byteLength / Type.BYTES_PER_ELEMENT);
}

// --- Rasterize the sub-basins and the oceans ----------------------------------------------
console.log("Rasterizing sub-basins and oceans…");
const subFile = path.join(tmp, "sub.bin");
gdal("gdal_rasterize", ["-a", "id", "-ot", "Int32", "-init", "0", ...grid(90, H), "-of", "ENVI", SUB_POLYGONS, subFile]);
const oceanFile = path.join(tmp, "ocean.bin");
gdal("gdal_rasterize", ["-burn", "0", "-ot", "Byte", "-init", "0", ...grid(90, H), "-of", "ENVI", "-where", "1=0", OCEANS, oceanFile]);
DRAINS.forEach((d, i) => {
  const where = `name IN (${d.seas.map((s) => `'${s}'`).join(",")})`;
  gdal("gdal_rasterize", ["-burn", String(i + 1), "-where", where, OCEANS, oceanFile]);
});
const sub = await read(subFile, Int32Array);
const ocean = await read(oceanFile, Uint8Array);

// A pixel's area, relative: by latitude.
const weight = new Float64Array(H).map((_, r) => Math.cos(((90 - (r + 0.5) * RES) * Math.PI) / 180));

// --- The nearest ocean to every pixel (breadth-first from the sea) -----------------------
console.log("Finding the nearest ocean…");
const dist = new Uint16Array(W * H).fill(65535);
const nearest = new Uint8Array(W * H);
let queue = new Int32Array(W * H);
let head = 0;
let tail = 0;
for (let i = 0; i < W * H; i++) {
  if (ocean[i]) {
    dist[i] = 0;
    nearest[i] = ocean[i];
    queue[tail++] = i;
  }
}
while (head < tail) {
  const i = queue[head++];
  const r = Math.floor(i / W);
  const c = i % W;
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const rr = r + dr;
    if (rr < 0 || rr >= H) continue;
    const j = rr * W + ((c + dc + W) % W);
    if (dist[j] !== 65535) continue;
    dist[j] = dist[i] + 1;
    nearest[j] = nearest[i];
    queue[tail++] = j;
  }
}
queue = null;

// Per sub-basin: its pixels' area, and votes for an ocean by the pixels nearest the sea.
const subs = new Map(); // id -> { area, minDist, votes: Float64Array }
for (let i = 0; i < W * H; i++) {
  const id = sub[i];
  if (!id) continue;
  let s = subs.get(id);
  if (!s) subs.set(id, (s = { area: 0, minDist: 65535, votes: new Float64Array(DRAINS.length + 1) }));
  const w = weight[Math.floor(i / W)];
  s.area += w;
  if (dist[i] < s.minDist) {
    s.minDist = dist[i];
    s.votes.fill(0);
  }
  if (dist[i] <= s.minDist + 1) s.votes[nearest[i]] += w;
}

// --- Aridity: PCP and RET summed over the years, per sub-basin ----------------------------
const pcpSum = new Map(); // id -> area-weighted mm summed over the years
const retSum = new Map();
const covered = new Map(); // id -> area-weighted pixels with both, summed over the years
for (const year of YEARS) {
  console.log(`WaPOR ${year}…`);
  const files = {};
  for (const v of ["PCP", "RET"]) {
    files[v] = path.join(tmp, `${v}-${year}.bin`);
    const src = `${WAPOR}/L1-${v}-A/WAPOR-3.L1-${v}-A.${year}.tif`;
    gdal("gdalwarp", ["-overwrite", "-r", v === "RET" ? "bilinear" : "near", "-ot", "Float32", "-dstnodata", "-9999", ...grid(60, WH), "-of", "ENVI", src, files[v]]);
  }
  const pcp = await read(files.PCP, Float32Array);
  const ret = await read(files.RET, Float32Array);
  for (let k = 0; k < W * WH; k++) {
    const i = k + ROW0 * W;
    const id = sub[i];
    const p = pcp[k];
    const e = ret[k];
    if (!id || p < 0 || !(e > 0)) continue;
    const w = weight[Math.floor(i / W)];
    pcpSum.set(id, (pcpSum.get(id) ?? 0) + p * w);
    retSum.set(id, (retSum.get(id) ?? 0) + e * w);
    covered.set(id, (covered.get(id) ?? 0) + w);
  }
  await Promise.all(Object.values(files).map((f) => fs.rm(f)));
}
await fs.rm(tmp, { recursive: true });

// --- Per major basin ---------------------------------------------------------------------
const list = JSON.parse(await fs.readFile(path.join(ROOT, "public/data/sub-basins.json"), "utf8"));
const byId = new Map(list.map((b) => [b.id, b]));
const centre = (b) => {
  const [w, s, e, n] = b.bbox;
  return [((w + (e < w ? e + 360 : e)) / 2 + 540) % 360 - 180, (s + n) / 2];
};

/** Where a sub-basin's water ends up: an index into DRAINS, or -1 inland. */
function drainOf(id) {
  const seen = new Set();
  let b = byId.get(id);
  while (b && b.downstream > 0 && !seen.has(b.id)) {
    seen.add(b.id);
    b = byId.get(b.downstream) ?? b;
    if (seen.has(b.id)) break;
  }
  if (!b || b.downstream === -888) return -1;
  const s = subs.get(b.id);
  if (s && s.minDist > MAX_COAST) return -1;
  if (s && s.votes.some((v) => v > 0)) return s.votes.indexOf(Math.max(...s.votes)) - 1;
  // Too small to have a pixel: the ocean nearest its centre.
  const [lng, lat] = centre(b);
  const r = Math.min(H - 1, Math.floor((90 - lat) / RES));
  const c = Math.min(W - 1, Math.floor((lng + 180) / RES));
  return dist[r * W + c] > MAX_COAST ? -1 : nearest[r * W + c] - 1;
}

const majors = {};
const tally = new Map(); // major -> { drains: Map, area, pcp, ret, covered }
for (const b of list) {
  let t = tally.get(b.majorBasin);
  if (!t) tally.set(b.majorBasin, (t = { drains: new Map(), area: 0, pcp: 0, ret: 0, covered: 0, pixels: 0 }));
  const area = b.area ?? 0;
  const d = drainOf(b.id);
  t.drains.set(d, (t.drains.get(d) ?? 0) + area);
  t.area += area;
  t.pcp += pcpSum.get(b.id) ?? 0;
  t.ret += retSum.get(b.id) ?? 0;
  t.covered += (covered.get(b.id) ?? 0) / YEARS.length;
  t.pixels += subs.get(b.id)?.area ?? 0;
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
for (const [id, t] of [...tally].sort((a, b) => a[0] - b[0])) {
  const [drain, area] = [...t.drains].sort((a, b) => b[1] - a[1])[0];
  const share = t.covered / (t.pixels || 1);
  const ai = t.ret > 0 && share >= MIN_COVERED ? t.pcp / t.ret : null;
  majors[id] = {
    drain: drain < 0 ? "inland" : DRAINS[drain].id,
    drainShare: round(t.area ? area / t.area : 1, 2),
    ai: ai === null ? null : round(ai, 3),
    climate: ai === null ? null : CLIMATES.find((k) => ai < k.max).id,
    covered: round(share, 2),
  };
}

await fs.writeFile(OUT, JSON.stringify({ years: [YEARS[0], YEARS[YEARS.length - 1]], majors }) + "\n");
const count = (key) => Object.values(majors).reduce((m, b) => m.set(b[key], (m.get(b[key]) ?? 0) + 1), new Map());
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${Object.keys(majors).length} major basins`);
console.log("drain:", Object.fromEntries(count("drain")));
console.log("climate:", Object.fromEntries(count("climate")));
