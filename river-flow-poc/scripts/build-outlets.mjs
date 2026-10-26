/*
 * Where each sub-basin drains out, for the water balance scheme (scheme.html):
 * public/data/rivers.bin → public/data/outlets.json.
 *
 * A sub-basin's outlet is the end of its biggest arc (the largest flow accumulation),
 * which is where its main river leaves it: into the next sub-basin down, the sea or a
 * sink. The direction of that arc's last stretch (about OUTFLOW_KM) says which way the
 * water goes out, for the arrow at a basin's mouth.
 *
 * Sub-basins are split at confluences, so a tributary's sub-basin and the main river's
 * sub-basin above the confluence drain out at the same point. The scheme's node for a
 * sub-basin is therefore moved up its main river (the biggest arc into each arc, within
 * the sub-basin) by NODE_SHARE of that river's length: the two then sit apart, on their
 * own rivers, and their lines meet at the next node down as a Y.
 *
 * Sub-basins without arcs (small coastal or desert ones) aren't listed; the scheme puts
 * them at their bounding box's centre.
 *
 * outlets.json: { "<sub-basin id>": [node lon, node lat, outlet lon, outlet lat, dx, dy] },
 * dx, dy a unit vector east and north.
 */
import { readFileSync, writeFileSync } from "node:fs";

const OUTFLOW_KM = 20;
const NODE_SHARE = 0.3;

const [input = "public/data/rivers.bin", output = "public/data/outlets.json"] = process.argv.slice(2);
const file = readFileSync(input);
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
let offset = 0;
const take = (Type, n) => {
  const array = new Type(buffer, offset, n);
  offset += array.byteLength;
  return array;
};
const [nArcs, nVerts] = take(Uint32Array, 2);
const starts = take(Uint32Array, nArcs + 1);
const next = take(Int32Array, nArcs);
const acc = take(Float32Array, nArcs);
const subBasin = take(Int32Array, nArcs);
const coords = take(Float32Array, nVerts * 2);

// The biggest arc flowing into each arc, in the same sub-basin.
const mainUp = new Int32Array(nArcs).fill(-1);
for (let a = 0; a < nArcs; a++) {
  const b = next[a];
  if (b >= 0 && subBasin[a] === subBasin[b] && (mainUp[b] < 0 || acc[a] > acc[mainUp[b]])) mainUp[b] = a;
}

const km = (v, w) => {
  const k = Math.cos((coords[2 * v + 1] * Math.PI) / 180);
  return 111.2 * Math.hypot((coords[2 * v] - coords[2 * w]) * k, coords[2 * v + 1] - coords[2 * w + 1]);
};

/** The main river's vertices from the outlet arc `a` upstream, outlet first. */
function mainRiver(a) {
  const vertices = [];
  for (const seen = new Set(); a >= 0 && !seen.has(a); a = mainUp[a]) {
    seen.add(a);
    for (let v = starts[a + 1] - 1; v >= starts[a]; v--) if (vertices.at(-1) !== v) vertices.push(v);
  }
  return vertices;
}

/** The point `share` of the way up a line of vertices (by length). */
function along(vertices, share) {
  let total = 0;
  for (let i = 1; i < vertices.length; i++) total += km(vertices[i - 1], vertices[i]);
  let left = share * total;
  for (let i = 1; i < vertices.length; i++) {
    const d = km(vertices[i - 1], vertices[i]);
    if (d >= left && d > 0) {
      const t = left / d;
      const [p, q] = [vertices[i - 1], vertices[i]];
      return [coords[2 * p] + (coords[2 * q] - coords[2 * p]) * t, coords[2 * p + 1] + (coords[2 * q + 1] - coords[2 * p + 1]) * t];
    }
    left -= d;
  }
  const v = vertices.at(-1);
  return [coords[2 * v], coords[2 * v + 1]];
}

const biggest = new Map();
for (let a = 0; a < nArcs; a++) {
  const sb = subBasin[a];
  const b = biggest.get(sb);
  if (b === undefined || acc[a] > acc[b]) biggest.set(sb, a);
}

const round = (x) => Math.round(x * 1000) / 1000;
const outlets = {};
for (const [sb, a] of biggest) {
  if (sb <= 0) continue;
  const last = starts[a + 1] - 1;
  const [lon, lat] = [coords[2 * last], coords[2 * last + 1]];
  const k = Math.cos((lat * Math.PI) / 180);
  // Walk back up the arc until OUTFLOW_KM, for the outflow direction.
  let v = last - 1;
  while (v > starts[a] && km(v, last) < OUTFLOW_KM) v--;
  const dx = (lon - coords[2 * v]) * k;
  const dy = lat - coords[2 * v + 1];
  const length = Math.hypot(dx, dy) || 1;
  const [nodeLon, nodeLat] = along(mainRiver(a), NODE_SHARE);
  outlets[sb] = [nodeLon, nodeLat, lon, lat, dx / length, dy / length].map(round);
}

writeFileSync(output, JSON.stringify(outlets));
console.log(`${Object.keys(outlets).length} outlets → ${output}`);
