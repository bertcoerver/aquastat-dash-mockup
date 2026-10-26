/*
 * The water balance scheme's data: the sub-basins as a graph (a node in the middle of
 * each, lines through each one's outlet to the next one down), the periods to step
 * through, and each sub-basin's balance over a period.
 *
 * The model (basin-model.ts, basinBalance) gives per sub-basin and dekad PCP and AETI
 * (mm/day over the sub-basin) and Q and ΔS (m³/s), with
 *
 *   ΔS = Qin + P·A − ET·A − Q
 *
 * (Qin: the Q of the sub-basins draining into it; calc_runoff.js). Period values are
 * means of the dekads', so the balance closes for any period too.
 */
import { mean, type ModelSeries, type Variable } from "@portal/basin/model";
import type { SubBasin } from "@portal/map/sub-basin-network";
import { MONTHS, dkM, dkY, fmtEnd, fmtStart } from "@portal/toolbar/dekads";

type LonLat = [number, number];

/**
 * Per sub-basin (nodes.json, scripts/build-nodes.mjs): its middle (lon, lat), and where it
 * has a river, its outlet (lon, lat) and the direction the water leaves in (east, north).
 */
export type NodeFile = Record<string, [number, number] | [number, number, number, number, number, number]>;

export interface Node {
  id: number;
  name: string;
  /** km² */
  area: number;
  /** The middle of the sub-basin (lon, lat): where its dot is. */
  position: LonLat;
  /** Where it drains out (lon, lat); null without a river. */
  outlet: LonLat | null;
  /** Unit vector (east, north) the water leaves in. */
  direction: LonLat;
  /** The node it drains into; null when it leaves the scheme. */
  downstream: number | null;
  /** Where it goes when it leaves the scheme. */
  mouth: "sea" | "sink" | "outside" | null;
  /** The nodes draining straight into it. */
  upstream: number[];
}

/**
 * A stretch of the scheme's lines, carrying the outflow of `from` (summed):
 * - "out": from a node's middle to its outlet;
 * - "in": from an outlet to the middle of the node it drains into (`to`). Sub-basins
 *   meeting at a confluence share their outlet, so they share this stretch: the lines
 *   from their middles join there, as a Y;
 * - "mouth": out of the scheme, from a node's outlet on in its direction (an arrow).
 */
export interface Line {
  kind: "out" | "in" | "mouth";
  from: number[];
  /** The sub-basin the stretch lies in (hovering shows it). */
  in: number;
  path: LonLat[];
}

export interface Scheme {
  nodes: Map<number, Node>;
  lines: Line[];
  /** Bounding box of the nodes: west, south, east, north. */
  bbox: [number, number, number, number];
}

/** The scheme for the sub-basins the model ran for. */
export function buildScheme(model: ModelSeries, subBasins: SubBasin[], file: NodeFile): Scheme {
  const byId = new Map(subBasins.map((b) => [b.id, b]));
  const nodes = new Map<number, Node>();
  for (const id of model.series.keys()) {
    const b = byId.get(id);
    if (!b) continue;
    const f = file[id];
    const [w, s, e, n] = b.bbox;
    nodes.set(id, {
      id,
      name: b.name,
      area: b.area ?? NaN,
      position: f ? [f[0], f[1]] : [(w + e) / 2, (s + n) / 2],
      outlet: f?.length === 6 ? [f[2], f[3]] : null,
      direction: f?.length === 6 ? [f[4], f[5]] : [0, -1],
      downstream: null,
      mouth: null,
      upstream: [],
    });
  }
  for (const node of nodes.values()) {
    const down = byId.get(node.id)!.downstream;
    if (nodes.has(down) && down !== node.id) {
      node.downstream = down;
      nodes.get(down)!.upstream.push(node.id);
    } else {
      node.mouth = down === -999 ? "sea" : down === -888 ? "sink" : "outside";
    }
  }

  const xs = [...nodes.values()].flatMap((n) => [n.position[0], ...(n.outlet ? [n.outlet[0]] : [])]);
  const ys = [...nodes.values()].flatMap((n) => [n.position[1], ...(n.outlet ? [n.outlet[1]] : [])]);
  const bbox: Scheme["bbox"] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  // How far a mouth's arrow reaches out, in degrees of latitude.
  const reach = Math.max(0.15, 0.04 * Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]));

  const lines: Line[] = [];
  const ins = new Map<string, Line>();
  for (const node of nodes.values()) {
    // Without a river, the line goes straight from the middle (as if that were the outlet).
    const outlet = node.outlet ?? node.position;
    if (node.outlet) lines.push({ kind: "out", from: [node.id], in: node.id, path: [node.position, node.outlet] });
    if (node.downstream !== null) {
      const key = `${node.downstream}:${outlet[0].toFixed(3)},${outlet[1].toFixed(3)}`;
      const line = ins.get(key);
      if (line) line.from.push(node.id);
      else ins.set(key, { kind: "in", from: [node.id], in: node.downstream, path: [outlet, nodes.get(node.downstream)!.position] });
    } else if (node.outlet) {
      const k = Math.cos((outlet[1] * Math.PI) / 180);
      const end: LonLat = [outlet[0] + (node.direction[0] * reach) / k, outlet[1] + node.direction[1] * reach];
      lines.push({ kind: "mouth", from: [node.id], in: node.id, path: [outlet, end] });
    }
  }
  lines.push(...ins.values());
  return { nodes, lines, bbox };
}

// --- Periods ---------------------------------------------------------------------------

export type Aggregation = "dekad" | "month" | "year" | "all";

export interface Period {
  label: string;
  /** Indices into the model's dekads, [from, to). */
  from: number;
  to: number;
  /** Not all of the period has model output (the record starts or ends within it). */
  partial: boolean;
}

/** The model's dekads grouped into periods. */
export function periods(dekads: number[], aggregation: Aggregation): Period[] {
  const key = (dk: number) =>
    aggregation === "dekad" ? dk : aggregation === "month" ? dkY(dk) * 12 + dkM(dk) : aggregation === "year" ? dkY(dk) : 0;
  const size = { dekad: 1, month: 3, year: 36, all: 0 }[aggregation];
  const out: Period[] = [];
  let from = 0;
  for (let i = 1; i <= dekads.length; i++) {
    if (i < dekads.length && key(dekads[i]) === key(dekads[from])) continue;
    const first = dekads[from];
    const last = dekads[i - 1];
    const partial = size > 0 && i - from < size;
    const label =
      aggregation === "dekad" || aggregation === "all"
        ? `${fmtStart(first)} – ${fmtEnd(last)}`
        : aggregation === "month"
          ? `${MONTHS[dkM(first)]} ${dkY(first)}`
          : partial
            ? `${dkY(first)} (${fmtStart(first)} – ${fmtEnd(last)})`
            : `${dkY(first)}`;
    out.push({ label, from, to: i, partial });
    from = i;
  }
  return out;
}

// --- Balance ---------------------------------------------------------------------------

export interface Balance {
  /** mm/day over the sub-basin. */
  PCP: number;
  AETI: number;
  /** m³/s */
  Q: number;
  dS: number;
  Qin: number;
}

/** mm/day over `area` km² → m³/s. */
export const toFlow = (mmPerDay: number, area: number) => (mmPerDay * area) / 86.4;

/** Each node's balance over a period. */
export function periodBalance(model: ModelSeries, scheme: Scheme, { from, to }: Period): Map<number, Balance> {
  const out = new Map<number, Balance>();
  for (const id of scheme.nodes.keys()) {
    const s = model.series.get(id)!;
    const m = (v: Variable) => mean(s[v], from, to);
    out.set(id, { PCP: m("PCP"), AETI: m("AETI"), Q: m("Q"), dS: m("dS"), Qin: 0 });
  }
  for (const node of scheme.nodes.values()) {
    for (const up of node.upstream) {
      const q = out.get(up)!.Q;
      if (Number.isFinite(q)) out.get(node.id)!.Qin += q;
    }
  }
  return out;
}

/** The p-th quantile (0–1) of the finite values. */
export function quantile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}
