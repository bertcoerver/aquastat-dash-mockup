/*
 * Build the name lists for the country and basin pickers in the top bar:
 *   public/data/countries.json     [{ m49, name, bbox }]
 *   public/data/major-basins.json  [{ id, name, bbox }]
 *   public/data/sub-basins.json    [{ id, name, majorBasin, downstream, area, bbox }]
 * bbox is [west, south, east, north] in degrees (west > east when it crosses 180°).
 *
 * Read from the same vector tiles the map shows, so the lists match the map:
 * countries from public/tiles/m49, basins from FAO's tile bucket. Run with
 * `npm run lists` after rebuilding the tiles.
 */
import { parse } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "public/data");
// Zoom 5: detailed enough that tippecanoe keeps even small basins, few enough tiles.
const ZOOM = Number(process.env.ZOOM ?? 5);
// Sub-basin routes from the wapor_discharge project: { id: [downstream, area_km2, name] }.
const ROUTES = JSON.parse(await fs.readFile(path.join(ROOT, "data/fao_sb_ids.json"), "utf8"));

const SETS = [
  {
    out: "countries.json",
    source: (z, x, y) => fs.readFile(path.join(ROOT, `public/tiles/m49/${z}/${x}/${y}.pbf`)).catch(() => null),
    key: (p) => p.m49,
    entry: (p) => ({ m49: p.m49, name: p.name }),
  },
  {
    out: "major-basins.json",
    source: async (z, x, y) => {
      const r = await fetch(`https://storage.googleapis.com/fao-cog-data/basins/SDG6_MBM_v1_tiles/${z}/${x}/${y}.pbf`);
      return r.ok ? r.arrayBuffer() : null;
    },
    key: (p) => p.SDG6_MB_ID,
    entry: (p) => ({ id: p.SDG6_MB_ID, name: p.S6_MB_NAME }),
  },
  {
    out: "sub-basins.json",
    source: async (z, x, y) => {
      const r = await fetch(`https://storage.googleapis.com/fao-cog-data/basins/SDG6_SBM_v1_tiles/${z}/${x}/${y}.pbf`);
      return r.ok ? r.arrayBuffer() : null;
    },
    key: (p) => p.SDG6_SB_ID,
    // downstream: the sub-basin it drains into; -999 the sea, -888 an inland sink.
    // area (km²) isn't in the tiles: it comes from the discharge model's routes file.
    entry: (p) => ({
      id: p.SDG6_SB_ID,
      name: p.S6_SB_NAME,
      majorBasin: p.SDG6_MB_ID,
      downstream: p.TO_SB_ID,
      area: ROUTES[p.SDG6_SB_ID]?.[1] ?? null,
    }),
  },
];

for (const set of SETS) {
  const found = new Map(); // key -> { entry, lngs: [], lats: [] extremes }
  const n = 2 ** ZOOM;
  const jobs = [];
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) jobs.push([x, y]);

  // A few requests at a time.
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let job; (job = jobs.pop()); ) {
        const [x, y] = job;
        const data = await set.source(ZOOM, x, y);
        if (!data) continue;
        const features = await parse(data, MVTLoader, {
          mvt: { coordinates: "wgs84", tileIndex: { x, y, z: ZOOM }, shape: "geojson" },
        });
        // Only the part inside the tile: the buffer would stretch boxes past the shape.
        const west = (x / n) * 360 - 180;
        const east = ((x + 1) / n) * 360 - 180;
        for (const f of features) {
          const k = set.key(f.properties);
          if (!found.has(k)) found.set(k, { entry: set.entry(f.properties), points: [] });
          const item = found.get(k);
          for (const [lng, lat] of coordinates(f.geometry)) {
            if (lng >= west && lng <= east) item.points.push(lng, lat);
          }
        }
      }
    }),
  );

  const list = [...found.values()]
    .filter((item) => item.points.length > 0)
    .map(({ entry, points }) => ({ ...entry, bbox: bbox(points) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, set.out), JSON.stringify(list));
  console.log(`${set.out}: ${list.length} entries`);
}

function* coordinates(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  for (const rings of polygons) yield* rings[0]; // the outer ring is enough for a box
}

/** Bounding box; across 180° if that gives a narrower box (e.g. Fiji, Russia). */
function bbox(points) {
  let south = 90, north = -90, w = 180, e = -180, w360 = 360, e360 = 0;
  for (let i = 0; i < points.length; i += 2) {
    const lng = points[i], lat = points[i + 1];
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    w = Math.min(w, lng);
    e = Math.max(e, lng);
    const l360 = lng < 0 ? lng + 360 : lng;
    w360 = Math.min(w360, l360);
    e360 = Math.max(e360, l360);
  }
  const r = (v) => Math.round(v * 1000) / 1000;
  const wrap = (v) => (v > 180 ? v - 360 : v);
  return e360 - w360 < e - w ? [r(wrap(w360)), r(south), r(wrap(e360)), r(north)] : [r(w), r(south), r(e), r(north)];
}
