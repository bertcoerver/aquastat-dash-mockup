/*
 * Discharge along the rivers of a major basin, from the water balance model's outflow
 * per sub-basin (the Basin view's river discharge map).
 *
 * The network (public/data/rivers/<id>.bin, scripts/build-rivers.mjs) is FAO's river
 * arcs with their upstream area (from a flow accumulation raster) and their sub-basin.
 * The model only gives what leaves each sub-basin, so an arc gets the share of its
 * sub-basin's outflow that its upstream area is of the sub-basin's largest arc's (its
 * outlet):
 *
 *   Q(arc) = Q(sub-basin) × A(arc) / A(the sub-basin's largest arc)
 *
 * So each outlet shows the model's outflow (unless the network has only bits of the
 * sub-basin's river: see MIN_SHARE), and a river runs on from one sub-basin into
 * the next with no more of a step than the change in discharge per km² upstream, which
 * is small where the new sub-basin is small next to what lies upstream of it.
 *
 * Big rivers often run along sub-basin boundaries, zigzagging across them, so an arc
 * of the main stem can be filed under a small sub-basin beside it; and the network has
 * parallel channels with the main stem's full upstream area. An arc that drains more
 * than its sub-basin and everything the model routes into it therefore goes to the first
 * sub-basin downstream that drains as much: the one the main stem is really in. (The
 * listed sub-basin areas are only used for this and for MIN_SHARE. They don't match the
 * raster's: they are larger by about 1/cos²(latitude), as if measured on Web Mercator.)
 *
 * (Building the discharge up along the arcs instead, from each sub-basin's own runoff,
 * would follow the model more closely within a sub-basin, but those parallel channels
 * merge back into the main stem and count it twice: 4× too much at the Mississippi's
 * mouth, 16× at the Amazon's.)
 */
import type { SubBasin } from "../map/sub-basin-network";

export interface RiverNetwork {
  /** Number of arcs. */
  n: number;
  /** First vertex of each arc (n + 1: the last ends where the next starts). */
  starts: Uint32Array;
  /** Upstream area, km². */
  area: Float32Array;
  subBasin: Int32Array;
  /** lon, lat per vertex. */
  coords: Float32Array;
}

const FILES = `${import.meta.env.BASE_URL}data/rivers/`;
const loaded = new Map<number, Promise<RiverNetwork | null>>();

/** A major basin's rivers (null: it has none, e.g. small islands). Kept once loaded. */
export function loadRivers(major: number): Promise<RiverNetwork | null> {
  let network = loaded.get(major);
  if (!network) {
    network = fetch(`${FILES}${major}.bin`).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Couldn't load the rivers (HTTP ${r.status}).`);
      // (Vite's dev server answers a missing file with index.html.)
      if (r.headers.get("content-type")?.includes("text/html")) return null;
      return parse(await r.arrayBuffer());
    });
    network.catch(() => loaded.delete(major));
    loaded.set(major, network);
  }
  return network;
}

function parse(buffer: ArrayBuffer): RiverNetwork {
  const [n, nVerts] = new Uint32Array(buffer, 0, 2);
  let offset = 8;
  const take = <T>(Type: new (b: ArrayBuffer, o: number, l: number) => T & { byteLength: number }, length: number) => {
    const array = new Type(buffer, offset, length);
    offset += array.byteLength;
    return array;
  };
  return {
    n,
    starts: take(Uint32Array, n + 1),
    area: take(Float32Array, n),
    subBasin: take(Int32Array, n),
    coords: take(Float32Array, nVerts * 2),
  };
}

/**
 * The least a sub-basin's largest arc is taken to drain, as a share of its listed
 * upstream area × cos²(latitude) (about the area on the ground). Usually it drains 50–85%
 * of that; far less means the network has only bits of the sub-basin's river, which
 * would otherwise carry all of its outflow.
 */
const MIN_SHARE = 0.3;

/**
 * Discharge per arc, m³/s, from each sub-basin's outflow `q` (NaN for arcs in a
 * sub-basin without one). `subBasins`: the sub-basin list, for the model's routes and areas.
 */
export function riverDischarge(net: RiverNetwork, q: Map<number, number>, subBasins: SubBasin[]): Float32Array {
  const byId = new Map(subBasins.map((b) => [b.id, b]));
  const inflows = new Map<number, number[]>();
  for (const b of subBasins) {
    if (!inflows.has(b.downstream)) inflows.set(b.downstream, []);
    inflows.get(b.downstream)!.push(b.id);
  }
  // Listed upstream area, over all the sub-basins (the model's networks cross major basins).
  const upArea = new Map<number, number>();
  const up = (id: number): number => {
    let a = upArea.get(id);
    if (a !== undefined) return a;
    upArea.set(id, 0); // (a loop in the routes ends here)
    a = (byId.get(id)?.area ?? 0) + (inflows.get(id) ?? []).reduce((s, u) => s + up(u), 0);
    upArea.set(id, a);
    return a;
  };

  // The sub-basin each arc goes to, and each one's largest arc.
  const owner = new Int32Array(net.n);
  const largest = new Map<number, number>();
  for (let i = 0; i < net.n; i++) {
    const area = net.area[i];
    let s = net.subBasin[i];
    for (let steps = 0; area > up(s) && steps < 100; steps++) {
      const d = byId.get(s)?.downstream;
      if (d === undefined || !q.has(d)) break; // (to the sea, or out of the model file)
      s = d;
    }
    owner[i] = s;
    largest.set(s, Math.max(largest.get(s) ?? 0, area));
  }

  const out = new Float32Array(net.n);
  for (let i = 0; i < net.n; i++) {
    const s = owner[i];
    const qs = q.get(s) ?? NaN;
    const bbox = byId.get(s)?.bbox;
    const cos = bbox ? Math.cos((((bbox[1] + bbox[3]) / 2) * Math.PI) / 180) : 1;
    out[i] = (Math.max(0, qs) * net.area[i]) / Math.max(largest.get(s)!, MIN_SHARE * up(s) * cos * cos);
  }
  return out;
}

/** Widest river on the map, CSS pixels: the basin's largest discharge (or above). */
export const RIVER_MAX_WIDTH = 10;
const RIVER_MIN_WIDTH = 0.8;

/**
 * Line width for discharge `q`, pixels: grows with its square root up to `max` (the top
 * of the colour scale), so a tenth of the discharge is about a third as wide. Width
 * shows the big rivers apart; the colour (on a log scale) the small ones.
 */
export function riverWidth(q: number, max: number): number {
  const f = max > 0 ? Math.min(1, Math.max(0, q) / max) : 0;
  return RIVER_MIN_WIDTH + (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH) * Math.sqrt(f);
}
