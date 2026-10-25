/*
 * The river network for the browser: data/rivers.geojson (from build-network.sh) →
 * public/data/rivers.bin.
 *
 * The shapefile's FROM_NODE / TO_NODE ids don't connect the arcs (they repeat across
 * regions), so the topology is rebuilt from the arcs' end points: arcs are digitised
 * downstream, so an arc flows into the arc that starts where it ends. The network is
 * traced from a flow-direction raster, which leaves two kinds of artefacts, dropped here:
 * "starbursts" (eight one-cell arcs fanning out of a sink) and arcs that loop back onto
 * their own start.
 *
 * rivers.bin (little-endian), arcs sorted so every arc comes before the arc it flows into:
 *   Uint32 nArcs, Uint32 nVerts
 *   Uint32[nArcs + 1] first vertex of each arc
 *   Int32[nArcs]      the arc it flows into, -1 for none (sea or sink)
 *   Float32[nArcs]    flow accumulation (upstream area, km² × 100)
 *   Int32[nArcs]      sub-basin (SDG 6 SBM id)
 *   Float32[nVerts*2] lon, lat
 *   Uint8[nArcs]      Strahler order
 *   Uint8[nArcs]      1: perennial, 0: intermittent
 */
import { readFileSync, writeFileSync } from "node:fs";

const SNAP = 3e-4; // degrees: end points this close are one node (the grid is 1/480°)
// Degrees: Douglas–Peucker tolerance (~500 m, 2 px at zoom 8). The source only has
// vertices where the line turns, so anything finer keeps nearly all of them.
const SIMPLIFY = 5e-3;

const [input = "data/rivers.geojson", output = "public/data/rivers.bin"] = process.argv.slice(2);
const { features } = JSON.parse(readFileSync(input, "utf8"));

const arcs = features
  .filter((f) => f.geometry?.type === "LineString" && f.geometry.coordinates.length >= 2)
  .map((f) => ({
    coords: f.geometry.coordinates,
    acc: f.properties.RASTERVA_1,
    subBasin: f.properties.SUBBAS_ID,
    strahler: f.properties.Strahler,
    perennial: f.properties.Regime === "P" ? 1 : 0,
  }));

// Nodes: end points snapped together on a grid of SNAP-sized cells.
const grid = new Map();
const nodes = [];
function nodeAt([x, y]) {
  const gx = Math.floor(x / SNAP);
  const gy = Math.floor(y / SNAP);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const n of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
        if (Math.abs(nodes[n][0] - x) <= SNAP && Math.abs(nodes[n][1] - y) <= SNAP) return n;
      }
    }
  }
  nodes.push([x, y]);
  const key = `${gx},${gy}`;
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(nodes.length - 1);
  return nodes.length - 1;
}
for (const a of arcs) {
  a.from = nodeAt(a.coords[0]);
  a.to = nodeAt(a.coords[a.coords.length - 1]);
}

const outOf = (list) => {
  const map = new Map();
  for (const a of list) {
    if (!map.has(a.from)) map.set(a.from, []);
    map.get(a.from).push(a);
  }
  return map;
};
let out = outOf(arcs);
const kept = arcs.filter((a) => {
  if (a.from === a.to) return false;
  const starburst = out.get(a.from).length >= 3 && !out.has(a.to);
  return !starburst;
});
const dropped = arcs.length - kept.length;
out = outOf(kept);

// Each arc flows into the arc leaving its end node; at a bifurcation, the larger one.
for (const a of kept) {
  const next = out.get(a.to);
  a.next = next ? next.reduce((m, b) => (b.acc > m.acc ? b : m)) : null;
}

// Upstream first (Kahn); arcs on a loop are cut loose from what they flow into.
const inDegree = new Map(kept.map((a) => [a, 0]));
for (const a of kept) if (a.next) inDegree.set(a.next, inDegree.get(a.next) + 1);
const order = kept.filter((a) => inDegree.get(a) === 0);
for (let i = 0; i < order.length; i++) {
  const next = order[i].next;
  if (next && inDegree.set(next, inDegree.get(next) - 1).get(next) === 0) order.push(next);
}
const loops = kept.filter((a) => inDegree.get(a) > 0);
for (const a of loops) a.next = null;
order.push(...loops);
order.forEach((a, i) => (a.index = i));

/** Douglas–Peucker; keeps both ends, so arcs still meet. */
function simplify(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = points[i];
    const [bx, by] = points[j];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstDist = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * (points[k][0] - ax) - dx * (points[k][1] - ay)) / len;
      if (d > worstDist) {
        worst = k;
        worstDist = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

const paths = order.map((a) => simplify(a.coords, SIMPLIFY));
const nArcs = order.length;
const nVerts = paths.reduce((n, p) => n + p.length, 0);

const size = 8 + 4 * (nArcs + 1) + 12 * nArcs + 8 * nVerts + 2 * nArcs;
const buffer = new ArrayBuffer(size);
let offset = 0;
const take = (Type, length) => {
  const array = new Type(buffer, offset, length);
  offset += array.byteLength;
  return array;
};
take(Uint32Array, 2).set([nArcs, nVerts]);
const starts = take(Uint32Array, nArcs + 1);
const next = take(Int32Array, nArcs);
const acc = take(Float32Array, nArcs);
const subBasin = take(Int32Array, nArcs);
const coords = take(Float32Array, nVerts * 2);
const strahler = take(Uint8Array, nArcs);
const perennial = take(Uint8Array, nArcs);

let v = 0;
order.forEach((a, i) => {
  starts[i] = v;
  next[i] = a.next ? a.next.index : -1;
  acc[i] = a.acc;
  subBasin[i] = a.subBasin;
  strahler[i] = a.strahler;
  perennial[i] = a.perennial;
  for (const [x, y] of paths[i]) {
    coords[v * 2] = x;
    coords[v * 2 + 1] = y;
    v++;
  }
});
starts[nArcs] = v;

writeFileSync(output, new Uint8Array(buffer));
const sourceVerts = arcs.reduce((n, a) => n + a.coords.length, 0);
console.log(
  `${nArcs} arcs (${dropped} artefacts dropped, ${loops.length} on loops), ` +
    `${nVerts} vertices (from ${sourceVerts}), ${order.filter((a) => !a.next).length} outlets → ` +
    `${output} (${(size / 1e6).toFixed(1)} MB)`,
);
