/*
 * Discharge per arc, and what the map makes of it: velocity, colour and width.
 *
 * Two sources:
 * - a proxy everywhere: a uniform runoff of RUNOFF over each arc's upstream area,
 *   i.e. what the river would carry if it rained the same everywhere;
 * - FAO's water balance model for one major basin, per dekad (basin-model.ts).
 *   The model gives the discharge out of each sub-basin; each arc in the sub-basin
 *   gets the share of it that its upstream area is of the sub-basin's largest arc's
 *   (area-proportional, as a sub-basin's runoff is spread evenly).
 */
import type { BasinDischarge } from "./basin-model";
import type { Network } from "./network";

/** Proxy runoff, m³/s per km² (0.01 ≈ 315 mm a year, about the world's land average). */
const RUNOFF = 0.01;

/** The proxy discharge per arc, m³/s. */
export function proxyDischarge(net: Network): Float32Array {
  const q = new Float32Array(net.nArcs);
  for (let a = 0; a < net.nArcs; a++) q[a] = (net.acc[a] / 100) * RUNOFF;
  return q;
}

/** A sub-basin's model discharge spread over its arcs: arc → [sub-basin, share]. */
export interface ModelShares {
  arcs: Int32Array;
  share: Float32Array;
}

/** Which arcs the model covers, and each one's share of its sub-basin's discharge. */
export function modelShares(net: Network, model: BasinDischarge): ModelShares {
  const maxAcc = new Map<number, number>();
  for (let a = 0; a < net.nArcs; a++) {
    const sb = net.subBasin[a];
    if (model.q.has(sb)) maxAcc.set(sb, Math.max(maxAcc.get(sb) ?? 0, net.acc[a]));
  }
  const arcs: number[] = [];
  const share: number[] = [];
  for (let a = 0; a < net.nArcs; a++) {
    const max = maxAcc.get(net.subBasin[a]);
    if (max) {
      arcs.push(a);
      share.push(net.acc[a] / max);
    }
  }
  return { arcs: Int32Array.from(arcs), share: Float32Array.from(share) };
}

/**
 * Discharge per arc for dekad `i` of the model (index into model.dekads): the proxy
 * where the model has no value. Returns which arcs got a model value.
 */
export function modelDischarge(
  net: Network,
  model: BasinDischarge,
  shares: ModelShares,
  i: number,
  proxy: Float32Array,
  out: Float32Array,
): Uint8Array {
  out.set(proxy);
  const modelled = new Uint8Array(net.nArcs);
  for (let k = 0; k < shares.arcs.length; k++) {
    const a = shares.arcs[k];
    const q = model.q.get(net.subBasin[a])![i];
    if (Number.isFinite(q)) {
      out[a] = Math.max(0, q) * shares.share[k];
      modelled[a] = 1;
    }
  }
  return modelled;
}

/**
 * Dot velocity, m/s: (Q / 1000 m³/s)^exponent, so 1 m/s at 1000 m³/s. The default
 * exponent is 0, the same speed everywhere: discharge is shown by the number of lanes,
 * and slowing small rivers down made mountain streams look sluggish.
 */
export function velocities(q: Float32Array, exponent: number): Float32Array {
  const v = new Float32Array(q.length);
  for (let a = 0; a < q.length; a++) v[a] = Math.min(8, Math.max(0.02, (Math.max(q[a], 1e-3) / 1000) ** exponent));
  return v;
}

export type RGBA = [number, number, number, number];

/** How strongly a river shows at a zoom, 0.1–1: small rivers fade as you zoom out. */
export function zoomFade(q: number, zoom: number): number {
  const log = Math.log10(Math.max(q, 1e-3));
  const cutoff = 4.2 - 0.8 * zoom; // log10(Q) shown at half strength
  return Math.min(1, Math.max(0.1, 0.5 + (log - cutoff) / 2));
}

export type Ramp = { log: number; rgb: [number, number, number] }[];

/** Colour stops at log10(Q in m³/s) = −1, 0, … 5. */
const stops = (...rgb: [number, number, number][]): Ramp => rgb.map((c, i) => ({ log: i - 1, rgb: c }));

/** The colour maps on offer (all run light-on-dark, so small rivers stay visible). */
export const RAMPS: Record<string, { label: string; ramp: Ramp }> = {
  spectral: {
    label: "Spectral",
    ramp: stops([70, 90, 170], [50, 130, 220], [30, 190, 220], [60, 210, 140], [225, 225, 80], [255, 140, 50], [235, 60, 120]),
  },
  viridis: {
    label: "Viridis",
    ramp: stops([68, 1, 84], [68, 57, 131], [49, 104, 142], [33, 145, 140], [53, 183, 121], [144, 215, 67], [253, 231, 37]),
  },
  turbo: {
    label: "Turbo",
    ramp: stops([48, 18, 59], [70, 117, 237], [27, 208, 213], [97, 252, 108], [210, 233, 53], [254, 155, 45], [200, 40, 10]),
  },
  blues: {
    label: "Blues",
    ramp: stops([8, 48, 107], [8, 81, 156], [33, 113, 181], [66, 146, 198], [107, 174, 214], [158, 202, 225], [222, 235, 247]),
  },
  grey: {
    label: "Grey (no colour map)",
    ramp: stops([110, 116, 124], [110, 116, 124], [110, 116, 124], [110, 116, 124], [110, 116, 124], [110, 116, 124], [110, 116, 124]),
  },
};

/** The default colour map. */
export const RAMP = RAMPS.spectral.ramp;

/**
 * The discharge colour; `zoom` fades small rivers out as you zoom out (like a map's
 * stream order cut-off), so the big rivers carry the picture at continental zooms.
 */
export function dischargeColor(q: number, zoom: number, ramp: Ramp = RAMP): RGBA {
  const rgb = rampColor(q, ramp);
  const alpha = zoomFade(q, zoom);
  // Opaque, faded towards black (FlowLayer draws rivers opaque, so overlapping segments
  // don't show as lighter bands).
  return [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, 255];
}

/** The colour map's colour for discharge `q` (m³/s), 0–255. */
export function rampColor(q: number, ramp: Ramp = RAMP): [number, number, number] {
  const log = Math.log10(Math.max(q, 1e-3));
  let i = 0;
  while (i < ramp.length - 2 && log > ramp[i + 1].log) i++;
  const lo = ramp[i];
  const hi = ramp[i + 1];
  const t = Math.min(1, Math.max(0, (log - lo.log) / (hi.log - lo.log)));
  return [0, 1, 2].map((k) => lo.rgb[k] + (hi.rgb[k] - lo.rgb[k]) * t) as [number, number, number];
}

/** Width of a lane of dots, in pixels at width scale 1 (FlowLayer's laneSpacing / widthScale). */
export const LANE_WIDTH = 3;

/**
 * Lanes of dots: the discharge is shown by how many streams of dots a river carries,
 * one more per ×5 or so: 1 lane up to ~5 m³/s, 4 at 100, 6 at 3000, 8 from ~50,000.
 */
export function dischargeLanes(q: number): number {
  return Math.min(8, Math.max(1, Math.floor(1 + 1.5 * Math.log10(Math.max(q, 1)))));
}

/**
 * Line width in pixels at width scale 1: room for the river's lanes (and half a lane
 * spare, so FlowLayer's floor(width / laneSpacing) comes out right).
 */
export function dischargeWidth(q: number): number {
  return (dischargeLanes(q) + 0.5) * LANE_WIDTH;
}
