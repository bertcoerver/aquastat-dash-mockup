/*
 * The river network (public/data/rivers.bin, see scripts/build-network.mjs) and the
 * "flow time" that drives the animation.
 *
 * Flow time is the time water takes to get to a vertex, in hours, measured along a
 * stream: from the stream's head, at each arc's velocity. A stream continues through a
 * confluence along its bigger branch (the main stem); a tributary's stream ends there,
 * and the arcs below get the main stem's flow times. So flow time is continuous along
 * every line that's drawn, however the velocity changes from arc to arc, and particles
 * placed at equal steps of it travel down the river at the local velocity without
 * jumping at arc ends. Each stream head starts at a random flow time, so particles
 * aren't lined up across the network.
 *
 * The bend lead c, in hours, is how far the right-bank lane runs ahead of the middle,
 * and the left-bank lane behind it (FlowLayer adds u × c to each lane's flow time, u = 1
 * on the left bank). Every corner of the line adds to it in proportion to how sharply it
 * turns (left turns up, right turns down), so the lanes on the outside of a bend get ahead (water runs faster on the outside of a bend), and it
 * dies away downstream of the bend. It's spread over the segment before the corner, so
 * it changes smoothly, and capped so no lane ever runs backwards.
 */

/** A corner's lead per radian of turn ÷ segment length, as a share of the segment's flow time. */
const BEND_GAIN = 2; // km
/** At most this share of a segment's flow time is gained or lost in one corner. */
const BEND_MAX = 0.4;
/** The lead halves every BEND_RELAX × ln 2 km downstream. */
const BEND_RELAX = 15; // km

export interface Network {
  nArcs: number;
  nVerts: number;
  /** First vertex of each arc (nArcs + 1 entries). */
  starts: Uint32Array;
  /** The arc each arc flows into, -1 for none. Arcs come before the arc they flow into. */
  next: Int32Array;
  /** The biggest arc flowing into each arc (its main stem upstream), -1 for none. */
  mainUp: Int32Array;
  /** Flow accumulation: upstream area in km² × 100. */
  acc: Float32Array;
  subBasin: Int32Array;
  strahler: Uint8Array;
  perennial: Uint8Array;
  /** lon, lat per vertex. */
  coords: Float32Array;
  /** Distance from the start of its arc, km, per vertex. */
  along: Float32Array;
  /** Turn at each vertex, radians, left (anticlockwise) positive; 0 at arc ends. */
  turn: Float32Array;
  /** Each stream head's starting flow time, as a fraction of the time wrap. */
  headOffset: Float32Array;
}

export async function loadNetwork(url: string): Promise<Network> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load the river network (${response.status}); run npm run network`);
  const buffer = await response.arrayBuffer();
  let offset = 0;
  const take = <T>(Type: new (b: ArrayBuffer, o: number, n: number) => T & { byteLength: number }, n: number) => {
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
  const strahler = take(Uint8Array, nArcs);
  const perennial = take(Uint8Array, nArcs);

  const mainUp = new Int32Array(nArcs).fill(-1);
  for (let a = 0; a < nArcs; a++) {
    const b = next[a];
    if (b >= 0 && (mainUp[b] < 0 || acc[a] > acc[mainUp[b]])) mainUp[b] = a;
  }

  const along = new Float32Array(nVerts);
  for (let a = 0; a < nArcs; a++) {
    let km = 0;
    for (let v = starts[a] + 1; v < starts[a + 1]; v++) {
      km += distanceKm(coords[2 * v - 2], coords[2 * v - 1], coords[2 * v], coords[2 * v + 1]);
      along[v] = km;
    }
  }

  const turn = new Float32Array(nVerts);
  for (let a = 0; a < nArcs; a++) {
    for (let v = starts[a] + 1; v < starts[a + 1] - 1; v++) {
      const k = Math.cos(coords[2 * v + 1] * (Math.PI / 180));
      const ax = (coords[2 * v] - coords[2 * v - 2]) * k;
      const ay = coords[2 * v + 1] - coords[2 * v - 1];
      const bx = (coords[2 * v + 2] - coords[2 * v]) * k;
      const by = coords[2 * v + 3] - coords[2 * v + 1];
      turn[v] = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    }
  }

  // A fixed pseudo-random offset per arc, so heads keep their phase when velocities change.
  const headOffset = new Float32Array(nArcs);
  let seed = 12345;
  for (let a = 0; a < nArcs; a++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    headOffset[a] = seed / 2 ** 32;
  }

  return { nArcs, nVerts, starts, next, mainUp, acc, subBasin, strahler, perennial, coords, along, turn, headOffset };
}

/**
 * Flow time and bend lead per vertex (hours) for a velocity per arc (m/s), into `out`
 * at 4 × vertex + `channel` and 4 × vertex + 2 + `channel` (FlowLayer's A/B layout).
 * Stream heads start at headOffset × `wrap`.
 */
export function flowTimes(net: Network, velocity: Float32Array, wrap: number, out: Float32Array, channel: 0 | 1) {
  const endTime = new Float32Array(net.nArcs);
  const endLead = new Float32Array(net.nArcs);
  const { starts, along, turn } = net;
  for (let a = 0; a < net.nArcs; a++) {
    const up = net.mainUp[a];
    const hoursPerKm = 1 / (3.6 * velocity[a]);
    const first = starts[a];
    const last = starts[a + 1] - 1;
    const t0 = up >= 0 ? endTime[up] : net.headOffset[a] * wrap;
    let lead = up >= 0 ? endLead[up] : 0;
    out[4 * first + channel] = t0;
    out[4 * first + 2 + channel] = lead;
    for (let v = first + 1; v <= last; v++) {
      const km = along[v] - along[v - 1];
      const share = Math.max(-BEND_MAX, Math.min(BEND_MAX, (BEND_GAIN * turn[v]) / Math.max(km, 0.1)));
      lead = lead * Math.exp(-km / BEND_RELAX) + share * km * hoursPerKm;
      out[4 * v + channel] = t0 + along[v] * hoursPerKm;
      out[4 * v + 2 + channel] = lead;
    }
    endTime[a] = out[4 * last + channel];
    endLead[a] = lead;
  }
}

function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number) {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return 6371 * Math.hypot(x, y);
}
