/*
 * The water balance scheme's nodes (scheme.html): each sub-basin's middle and outlet,
 * → public/data/nodes.json.
 *
 * The middle: FAO's sub-basin tiles (the ones the map draws) at zoom ZOOM, rasterised
 * into one global grid of sub-basin ids (TILE_PX cells a tile, in Web Mercator; only the
 * part of each polygon inside its tile, so pieces in several tiles fit together). Of a
 * sub-basin's cells, the one nearest its centroid among those at least half as far from
 * its edge as its innermost cell: in the middle, and inside the sub-basin even when it's
 * curved (the centroid of a crescent lies outside it).
 *
 * The outlet: the end of the sub-basin's biggest arc in the river network
 * (public/data/rivers.bin, the largest flow accumulation), where its main river leaves
 * it: into the next sub-basin down, the sea or a sink. The direction of that arc's last
 * stretch (about OUTFLOW_KM) says which way the water goes out, for the arrow at a
 * basin's mouth. Sub-basins without arcs (small coastal, island and desert ones) have
 * no outlet.
 *
 * nodes.json: { "<sub-basin id>": [middle lon, middle lat, outlet lon, outlet lat, dx, dy] }
 * (dx, dy a unit vector east and north), or [middle lon, middle lat] without an outlet.
 */
import { parse } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import { readFileSync, writeFileSync } from "node:fs";

const TILES = "https://storage.googleapis.com/fao-cog-data/basins/SDG6_SBM_v1_tiles";
const ZOOM = 5;
const TILE_PX = 256; // ~4 km cells at the equator
const OUTFLOW_KM = 20;

const [rivers = "public/data/rivers.bin", output = "public/data/nodes.json"] = process.argv.slice(2);

// --- Middles ---------------------------------------------------------------------------

const n = 2 ** ZOOM;
const size = n * TILE_PX;
/** Index into `ids` + 1 per cell; 0: no sub-basin. */
const grid = new Uint16Array(size * size);
const ids = [];
const index = new Map();

/** Fill a polygon's rings (tile coordinates 0–1) into the grid, even–odd, inside the tile. */
function fill(rings, label, tx, ty) {
  for (let row = 0; row < TILE_PX; row++) {
    const y = (row + 0.5) / TILE_PX;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x0, y0] = ring[j];
        const [x1, y1] = ring[i];
        if (y0 > y !== y1 > y) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    const base = (ty * TILE_PX + row) * size + tx * TILE_PX;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] * TILE_PX - 0.5));
      const to = Math.min(TILE_PX - 1, Math.floor(xs[k + 1] * TILE_PX - 0.5));
      for (let c = from; c <= to; c++) grid[base + c] = label;
    }
  }
}

const jobs = [];
for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) jobs.push([x, y]);
let tiles = 0;
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let job; (job = jobs.pop()); ) {
      const [x, y] = job;
      const response = await fetch(`${TILES}/${ZOOM}/${x}/${y}.pbf`);
      if (!response.ok) continue; // no file for empty tiles
      tiles++;
      const features = await parse(await response.arrayBuffer(), MVTLoader, { mvt: { coordinates: "local", shape: "geojson" } });
      for (const { geometry, properties } of features) {
        const id = properties.SDG6_SB_ID;
        if (!index.has(id)) {
          ids.push(id);
          index.set(id, ids.length);
        }
        const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
        for (const rings of polygons) fill(rings, index.get(id), x, y);
      }
    }
  }),
);

// Each sub-basin's cells: bounding box and centroid (in grid cells).
const boxes = ids.map(() => ({ x0: size, y0: size, x1: -1, y1: -1, sx: 0, sy: 0, count: 0 }));
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const label = grid[y * size + x];
    if (!label) continue;
    const b = boxes[label - 1];
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
    b.sx += x;
    b.sy += y;
    b.count++;
  }
}

/** Distance (cells, chamfer 3-4 / 3) from each of the sub-basin's cells to its edge. */
function clearance(label, { x0, y0, x1, y1 }) {
  const w = x1 - x0 + 3;
  const h = y1 - y0 + 3;
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x0 + x - 1;
      const gy = y0 + y - 1;
      const inside = gx >= 0 && gy >= 0 && gx < size && gy < size && grid[gy * size + gx] === label;
      d[y * w + x] = inside ? Infinity : 0;
    }
  }
  const pass = (ys, xs, s) => {
    for (const y of ys) {
      for (const x of xs) {
        const i = y * w + x;
        if (!d[i]) continue;
        const ny = y - s;
        const nx = x - s;
        let v = d[i];
        if (nx >= 0 && nx < w) v = Math.min(v, d[i - s] + 3);
        if (ny >= 0 && ny < h) {
          v = Math.min(v, d[i - s * w] + 3);
          if (nx >= 0 && nx < w) v = Math.min(v, d[i - s * w - s] + 4);
          if (x + s >= 0 && x + s < w) v = Math.min(v, d[i - s * w + s] + 4);
        }
        d[i] = v;
      }
    }
  };
  const range = (k) => Array.from({ length: k }, (_, i) => i);
  pass(range(h), range(w), 1);
  pass(range(h).reverse(), range(w).reverse(), -1);
  return { d, w };
}

const lon = (x) => (x / size) * 360 - 180;
const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI;

const middles = new Map();
ids.forEach((id, i) => {
  const b = boxes[i];
  if (!b.count) return; // too small for a cell at this zoom
  const { d, w } = clearance(i + 1, b);
  let best = 0;
  for (const v of d) if (v > best) best = v;
  const cx = b.sx / b.count;
  const cy = b.sy / b.count;
  let pick = null;
  let nearest = Infinity;
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      if (d[(y - b.y0 + 1) * w + (x - b.x0 + 1)] < best / 2) continue;
      const dist = (x - cx) ** 2 + (y - cy) ** 2;
      if (dist < nearest) {
        nearest = dist;
        pick = [x + 0.5, y + 0.5];
      }
    }
  }
  middles.set(id, [lon(pick[0]), lat(pick[1])]);
});
const unplaced = ids.filter((id) => !middles.has(id)).length;
console.log(`${tiles} tiles, ${middles.size} middles${unplaced ? ` (${unplaced} sub-basins too small for a cell)` : ""}`);

// --- Outlets ---------------------------------------------------------------------------

const file = readFileSync(rivers);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
let offset = 0;
const take = (Type, count) => {
  const array = new Type(buffer, offset, count);
  offset += array.byteLength;
  return array;
};
const [nArcs, nVerts] = take(Uint32Array, 2);
const starts = take(Uint32Array, nArcs + 1);
take(Int32Array, nArcs); // next
const acc = take(Float32Array, nArcs);
const subBasin = take(Int32Array, nArcs);
const coords = take(Float32Array, nVerts * 2);

const km = (v, w) => {
  const k = Math.cos((coords[2 * v + 1] * Math.PI) / 180);
  return 111.2 * Math.hypot((coords[2 * v] - coords[2 * w]) * k, coords[2 * v + 1] - coords[2 * w + 1]);
};

const biggest = new Map();
for (let a = 0; a < nArcs; a++) {
  const b = biggest.get(subBasin[a]);
  if (b === undefined || acc[a] > acc[b]) biggest.set(subBasin[a], a);
}

const round = (x) => Math.round(x * 1000) / 1000;
const nodes = {};
let withOutlet = 0;
for (const [id, middle] of middles) {
  const a = biggest.get(id);
  if (a === undefined) {
    nodes[id] = middle.map(round);
    continue;
  }
  const last = starts[a + 1] - 1;
  const [x, y] = [coords[2 * last], coords[2 * last + 1]];
  // Walk back up the arc until OUTFLOW_KM, for the outflow direction.
  let v = last - 1;
  while (v > starts[a] && km(v, last) < OUTFLOW_KM) v--;
  const dx = (x - coords[2 * v]) * Math.cos((y * Math.PI) / 180);
  const dy = y - coords[2 * v + 1];
  const length = Math.hypot(dx, dy) || 1;
  nodes[id] = [...middle, x, y, dx / length, dy / length].map(round);
  withOutlet++;
}

writeFileSync(output, JSON.stringify(nodes));
console.log(`${Object.keys(nodes).length} nodes (${withOutlet} with an outlet) → ${output}`);
