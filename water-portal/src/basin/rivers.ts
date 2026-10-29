/*
 * The river network of a major basin, for the Basin view's discharge network and where
 * storage change's circles stand (scheme.ts).
 *
 * The network (public/data/rivers/<id>.bin, scripts/build-rivers.mjs) is FAO's river arcs
 * with their upstream area (from a flow accumulation raster), their sub-basin and the arc
 * each flows into, simplified to ~500 m.
 */
import { memoized } from "../lib/memo";


export interface RiverNetwork {
  /** Number of arcs. */
  n: number;
  /** First vertex of each arc (n + 1: the last ends where the next starts). */
  starts: Uint32Array;
  /** Upstream area, km². */
  area: Float32Array;
  subBasin: Int32Array;
  /** The arc each arc flows into, -1 for none (the sea, a sink, or another major basin). */
  next: Int32Array;
  /** lon, lat per vertex. */
  coords: Float32Array;
}

const FILES = `${import.meta.env.BASE_URL}data/rivers/`;
const loaded = new Map<number, Promise<RiverNetwork | null>>();

/** A major basin's rivers (null: it has none, e.g. small islands). Kept once loaded. */
export function loadRivers(major: number): Promise<RiverNetwork | null> {
  return memoized(loaded, major, () =>
    fetch(`${FILES}${major}.bin`).then(async (r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Couldn't load the rivers (HTTP ${r.status}).`);
      // (Vite's dev server answers a missing file with index.html.)
      if (r.headers.get("content-type")?.includes("text/html")) return null;
      return parse(await r.arrayBuffer());
    }),
  );
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
    next: take(Int32Array, n),
    coords: take(Float32Array, nVerts * 2),
  };
}

let middles: Promise<Map<number, [number, number]>> | null = null;

/** A point inside each sub-basin, near its centroid (public/data/sub-basin-middles.json). */
export function loadMiddles(): Promise<Map<number, [number, number]>> {
  if (!middles) {
    middles = fetch(`${import.meta.env.BASE_URL}data/sub-basin-middles.json`).then(async (r) => {
      if (!r.ok) throw new Error(`Couldn't load the sub-basins' middles (HTTP ${r.status}).`);
      const file: Record<string, [number, number]> = await r.json();
      return new Map(Object.entries(file).map(([id, p]) => [Number(id), p]));
    });
    middles.catch(() => (middles = null));
  }
  return middles;
}
