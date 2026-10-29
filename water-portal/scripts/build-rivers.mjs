/*
 * The river network per major basin, for the Basin view's discharge network:
 *   public/data/rivers/<major basin id>.bin
 * and where each sub-basin's dot goes on the storage change and discharge maps:
 *   public/data/sub-basin-middles.json
 *
 * Cut from river-flow-poc's connected network (../river-flow-poc/public/data/rivers.bin,
 * built there by `npm run network` from FAO's rivers_world_47950: topology rebuilt from
 * the end points, artefacts dropped, simplified to ~500 m). The vector tiles can't be
 * used for this: they carry no upstream area and drop the topology. Each arc goes to the
 * major basin of its SDG 6 sub-basin; arcs in sub-basins that aren't in
 * public/data/sub-basins.json are dropped. Run with `npm run rivers` (after `npm run lists`).
 *
 * The middles come from river-flow-poc's public/data/nodes.json (its `npm run nodes`: a
 * point inside each sub-basin, near its centroid): { "<sub-basin id>": [lon, lat] }.
 *
 * <id>.bin (little-endian), arcs in the network's order:
 *   Uint32 nArcs, Uint32 nVerts
 *   Uint32[nArcs + 1] first vertex of each arc
 *   Float32[nArcs]    upstream area, km²
 *   Int32[nArcs]      sub-basin (SDG 6 SBM id)
 *   Int32[nArcs]      the arc it flows into (index in this file), -1 for none or another major basin
 *   Float32[nVerts*2] lon, lat
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const [input = path.join(ROOT, "../river-flow-poc/public/data/rivers.bin")] = process.argv.slice(2);
const OUT = path.join(ROOT, "public/data/rivers");

// --- rivers.bin (see river-flow-poc/scripts/build-network.mjs) ---------------------------
const buf = await fs.readFile(input);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const [nArcs, nVerts] = new Uint32Array(ab, 0, 2);
let offset = 8;
const take = (Type, length) => {
  const array = new Type(ab, offset, length);
  offset += array.byteLength;
  return array;
};
const starts = take(Uint32Array, nArcs + 1);
const next = take(Int32Array, nArcs);
const acc = take(Float32Array, nArcs); // km² × 100
const subBasin = take(Int32Array, nArcs);
const coords = take(Float32Array, nVerts * 2);

// Some short arcs (often where a river crosses into the next sub-basin) have an upstream
// area of 0 or 1 km²: give every arc at least the upstream area of any arc flowing into
// it. (The arcs come before those they flow into.)
let raised = 0;
for (let a = 0; a < nArcs; a++) {
  const b = next[a];
  if (b >= 0 && acc[b] < acc[a]) {
    acc[b] = acc[a];
    raised++;
  }
}

const subBasins = JSON.parse(await fs.readFile(path.join(ROOT, "public/data/sub-basins.json"), "utf8")); // (by column)
const majorOf = new Map(subBasins.id.map((id, i) => [id, subBasins.majorBasin[i]]));

// --- Split ------------------------------------------------------------------------------
const arcsOf = new Map(); // major basin -> arc indices, in the network's order
let dropped = 0;
for (let a = 0; a < nArcs; a++) {
  const major = majorOf.get(subBasin[a]);
  if (major === undefined) {
    dropped++;
    continue;
  }
  if (!arcsOf.has(major)) arcsOf.set(major, []);
  arcsOf.get(major).push(a);
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
let total = 0;
for (const [major, arcs] of arcsOf) {
  const n = arcs.length;
  const verts = arcs.reduce((s, a) => s + starts[a + 1] - starts[a], 0);
  const local = new Map(arcs.map((a, i) => [a, i]));
  const out = new ArrayBuffer(8 + 4 * (n + 1) + 12 * n + 8 * verts);
  let o = 0;
  const put = (Type, length) => {
    const array = new Type(out, o, length);
    o += array.byteLength;
    return array;
  };
  put(Uint32Array, 2).set([n, verts]);
  const s = put(Uint32Array, n + 1);
  const ac = put(Float32Array, n);
  const sb = put(Int32Array, n);
  const nx = put(Int32Array, n);
  const xy = put(Float32Array, verts * 2);
  let v = 0;
  arcs.forEach((a, i) => {
    s[i] = v;
    ac[i] = acc[a] / 100;
    sb[i] = subBasin[a];
    nx[i] = local.get(next[a]) ?? -1;
    xy.set(coords.subarray(starts[a] * 2, starts[a + 1] * 2), v * 2);
    v += starts[a + 1] - starts[a];
  });
  s[n] = v;
  await fs.writeFile(path.join(OUT, `${major}.bin`), new Uint8Array(out));
  total += out.byteLength;
}
console.log(
  `${arcsOf.size} major basins, ${nArcs - dropped} arcs (${dropped} in no listed sub-basin, ` +
    `${raised} given their upstream arc's area) → ` +
    `${path.relative(ROOT, OUT)}/ (${(total / 1e6).toFixed(1)} MB)`,
);

// --- Middles ----------------------------------------------------------------------------
const nodes = JSON.parse(await fs.readFile(path.join(ROOT, "../river-flow-poc/public/data/nodes.json"), "utf8"));
const middles = Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, n.slice(0, 2)]));
await fs.writeFile(path.join(ROOT, "public/data/sub-basin-middles.json"), JSON.stringify(middles));
console.log(`${Object.keys(middles).length} sub-basin middles → public/data/sub-basin-middles.json`);
