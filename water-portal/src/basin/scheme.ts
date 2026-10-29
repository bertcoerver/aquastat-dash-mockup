/*
 * The Basin view's water balance scheme for a major basin (from river-flow-poc's
 * scheme.html): its sub-basins' discharge as lines along the rivers, simplified, and a
 * dot for each sub-basin (its storage change) on its river near its middle.
 *
 * Within each sub-basin S, the line is the river network between where water comes in
 * and where it leaves:
 *
 * - from each upstream sub-basin U's outlet, downstream along the network until the river
 *   leaves S: that's S's outlet. Sub-basins are split at confluences, so most of these
 *   start at the same point, but not all: a tributary can join part way down. Sub-basins
 *   are worked through from upstream down, so U's outlet is known by then. (Not simply
 *   the end of S's biggest arc: the network has parallel duplicate arcs, so that's often
 *   the twin of the arc the river is traced along, and the two never meet.) Without
 *   anything flowing in, S's outlet is where the river leaves S below its biggest arc;
 * - S's dot sits on that river, at the point nearest the sub-basin's middle (on its own
 *   main river when nothing flows in: a headwater's line starts at its dot).
 *
 * Each piece of river carries the outflow of the upstream sub-basins that pass through
 * it, and below the dot also S's own gain (or, where S loses water, all of it scaled
 * down), so the width at S's outlet is S's outflow and the lines join up (lineQ). Where
 * the network doesn't connect (a sub-basin without rivers, or a gap in the network), the
 * water goes straight from U's outlet, or dot, to S's dot. Water from sub-basins in other
 * major basins counts as S's own gain. Where the basin leaves the scheme (the sea, a
 * sink, another major basin) the line goes on a little past the outlet, to an arrow.
 *
 * Pieces between junctions are simplified (Douglas–Peucker, simplify()) at a tolerance
 * the legend's slider picks, from the network's every bend to nearly straight.
 */
import type { SubBasin } from "../map/sub-basin-network";
import type { RiverNetwork } from "./rivers";

export type LonLat = [number, number];

export interface SchemeNode {
  id: number;
  /** The sub-basins of the scheme draining straight into it. */
  upstream: number[];
  /** Whether it drains out of the scheme. */
  mouth: boolean;
}

export interface SchemeLine {
  /** "river": along the network; "straight": where it doesn't connect; "mouth": out of the scheme. */
  kind: "river" | "straight" | "mouth";
  /** The sub-basin it lies in (hovering shows it). */
  in: number;
  /** The upstream sub-basins whose outflow passes through it. */
  through: number[];
  /** Below the dot of `in`: also carries its own gain. */
  below: boolean;
  /** Full detail. */
  raw: LonLat[];
  /** Simplified (simplify()). */
  path: LonLat[];
}

export interface Scheme {
  nodes: Map<number, SchemeNode>;
  lines: SchemeLine[];
  /** Each sub-basin's dot. */
  dots: Map<number, LonLat>;
  /** Per sub-basin, the upstream sub-basins whose water reaches it straight at its dot. */
  atDot: Map<number, number[]>;
  /** The basin's size (degrees of latitude), which the simplification is a share of. */
  extent: number;
  /** The tolerance the lines' paths are simplified to (none yet: full detail). */
  simplifiedAt?: number;
}

/** A run of an arc's vertices, [from, to] inclusive. */
interface Seg {
  from: number;
  to: number;
  key: string;
  through: number[];
  below: boolean;
  next: Seg | null;
  preds: number;
}

/** Arcs to follow at most within a sub-basin (loops in the data). */
const MAX_STEPS = 20000;
/** Arcs an upstream outlet's river may run outside the sub-basin it drains into before entering it. */
const MAX_OUTSIDE = 5;
/** How far back up the outlet arc the direction of a mouth's arrow is taken, km. */
const OUTFLOW_KM = 20;
/** How far a mouth's line reaches out, as a share of the basin's size. */
const MOUTH_REACH = 0.04;

/** The scheme for major basin `major`'s sub-basins (net: null for a basin without rivers). */
export function buildScheme(
  net: RiverNetwork | null,
  major: number,
  subBasins: SubBasin[],
  middles: Map<number, LonLat>,
): Scheme {
  const own = subBasins.filter((b) => b.majorBasin === major);
  const nodes = new Map<number, SchemeNode>(own.map((b) => [b.id, { id: b.id, upstream: [], mouth: false }]));
  for (const b of own) {
    const down = nodes.get(b.downstream);
    if (down && b.downstream !== b.id) down.upstream.push(b.id);
    else nodes.get(b.id)!.mouth = true;
  }
  const centre = (b: SubBasin): LonLat => [(b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2];
  const middleOf = new Map(own.map((b) => [b.id, middles.get(b.id) ?? centre(b)]));
  const extent = Math.max(
    0.1,
    Math.max(...own.map((b) => b.bbox[2])) - Math.min(...own.map((b) => b.bbox[0])),
    Math.max(...own.map((b) => b.bbox[3])) - Math.min(...own.map((b) => b.bbox[1])),
  );

  const lines: SchemeLine[] = [];
  const dots = new Map<number, LonLat>();
  const atDot = new Map<number, number[]>();
  const straightFrom = new Map<number, number>(); // U → S: U's water goes straight to S's dot
  const outletArc = new Map<number, number>(); // the arc a sub-basin's river leaves it by
  const n = net?.n ?? 0;
  const starts = net?.starts ?? new Uint32Array(1);
  const next = net?.next ?? new Int32Array(0);
  const coords = net?.coords ?? new Float32Array(0);
  const subBasin = net?.subBasin ?? new Int32Array(0);
  const pt = (v: number): LonLat => [coords[2 * v], coords[2 * v + 1]];
  const last = (a: number) => starts[a + 1] - 1;

  // Each sub-basin's biggest arc, and its main river upstream within it.
  const biggest = new Map<number, number>();
  const mainUp = new Map<number, number>();
  for (let a = 0; a < n; a++) {
    const b = biggest.get(subBasin[a]);
    if (b === undefined || net!.area[a] > net!.area[b]) biggest.set(subBasin[a], a);
    const d = next[a];
    if (d < 0 || subBasin[a] !== subBasin[d]) continue;
    const m = mainUp.get(d);
    if (m === undefined || net!.area[a] > net!.area[m]) mainUp.set(d, a);
  }

  /** The arcs from `a` down to where the river leaves sub-basin `s` (empty if it never gets there). */
  const downTo = (a: number, s: number) => {
    for (let i = 0; a >= 0 && subBasin[a] !== s && i < MAX_OUTSIDE; i++) a = next[a];
    if (a < 0 || subBasin[a] !== s) return [];
    const path: number[] = [];
    for (let i = 0; a >= 0 && i < MAX_STEPS; i++) {
      path.push(a);
      if (next[a] < 0 || subBasin[next[a]] !== s) break;
      a = next[a];
    }
    return path;
  };

  // Upstream first.
  const order: SchemeNode[] = [];
  const done = new Set<number>();
  const visit = (node: SchemeNode) => {
    if (done.has(node.id)) return;
    done.add(node.id);
    for (const u of node.upstream) visit(nodes.get(u)!);
    order.push(node);
  };
  for (const node of nodes.values()) visit(node);

  for (const node of order) {
    const s = node.id;
    const middle = middleOf.get(s)!;
    if (!biggest.has(s)) {
      dots.set(s, middle);
      for (const u of node.upstream) straightFrom.set(u, s);
      continue;
    }

    // Which upstream sub-basins pass through each arc of S's tree, and where it leaves S:
    // the outlet of the river from the biggest upstream sub-basin (parallel channels can
    // leave by different arcs; the others' lines end where theirs do).
    const through = new Map<number, number[]>();
    let out: number | undefined;
    let outFrom = -1;
    for (const u of node.upstream) {
      const uOut = outletArc.get(u);
      const path = uOut === undefined ? [] : downTo(next[uOut], s);
      if (!path.length) {
        straightFrom.set(u, s);
        continue;
      }
      for (const arc of path) {
        if (!through.has(arc)) through.set(arc, []);
        through.get(arc)!.push(u);
      }
      const area = net!.area[uOut!];
      if (out === undefined || area > outFrom) [out, outFrom] = [path.at(-1)!, area];
    }
    out ??= downTo(biggest.get(s)!, s).at(-1) ?? biggest.get(s)!;
    outletArc.set(s, out);

    // The dot: the vertex nearest the middle, on the tree (or the main river of a headwater).
    const candidates = [...through.keys()];
    if (!candidates.length) for (let a: number | undefined = out; a !== undefined; a = mainUp.get(a)) candidates.push(a);
    const k = Math.cos((middle[1] * Math.PI) / 180);
    let dotArc = out;
    let dotV = last(out);
    let best = Infinity;
    for (const a of candidates) {
      for (let v = starts[a]; v < starts[a + 1]; v++) {
        const d = ((coords[2 * v] - middle[0]) * k) ** 2 + (coords[2 * v + 1] - middle[1]) ** 2;
        if (d < best) [best, dotArc, dotV] = [d, a, v];
      }
    }
    dots.set(s, pt(dotV));

    // The arcs from the dot down to the outlet.
    const below = new Set<number>();
    for (let a = dotArc, i = 0; a >= 0 && subBasin[a] === s && i < MAX_STEPS; a = next[a], i++) {
      below.add(a);
      if (a === out) break;
    }

    // Segments: whole arcs, with the dot's arc split at the dot.
    const segs = new Map<number, Seg[]>(); // arc → its segments, upstream first
    const make = (arc: number, from: number, to: number, isBelow: boolean): Seg => {
      const ups = (through.get(arc) ?? []).slice().sort((x, y) => x - y);
      return { from, to, through: ups, below: isBelow, key: `${ups.join(",")}|${isBelow}`, next: null, preds: 0 };
    };
    for (const a of new Set([...through.keys(), ...below])) {
      const first = starts[a];
      if (a !== dotArc) segs.set(a, [make(a, first, last(a), below.has(a))]);
      else if (dotV > first && through.has(a)) segs.set(a, [make(a, first, dotV, false), make(a, dotV, last(a), true)]);
      else segs.set(a, [make(a, dotV, last(a), true)]);
    }
    for (const [a, list] of segs) {
      for (let i = 0; i + 1 < list.length; i++) list[i].next = list[i + 1];
      list.at(-1)!.next = segs.get(next[a])?.[0] ?? null;
    }
    const all = [...segs.values()].flat();
    for (const seg of all) if (seg.next) seg.next.preds++;
    const samePred = new Set(all.filter((p) => p.next && p.next.key === p.key).map((p) => p.next!));

    // Chains of segments with the same load, between junctions.
    for (const seg of all) {
      if (seg.preds === 1 && samePred.has(seg)) continue; // inside a chain
      const raw: LonLat[] = [];
      for (let c: Seg | null = seg; c && c.key === seg.key && (c === seg || c.preds === 1); c = c.next) {
        for (let v = c.from; v <= c.to; v++) {
          const p = pt(v);
          const prev = raw.at(-1);
          if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) raw.push(p);
        }
      }
      if (raw.length > 1) lines.push({ kind: "river", in: s, through: seg.through, below: seg.below, raw, path: raw });
    }

    if (node.mouth) {
      const end = last(out);
      let v = end - 1;
      const km = (w: number) =>
        111.2 * Math.hypot((coords[2 * w] - coords[2 * end]) * Math.cos((coords[2 * end + 1] * Math.PI) / 180), coords[2 * w + 1] - coords[2 * end + 1]);
      while (v > starts[out] && km(v) < OUTFLOW_KM) v--;
      const [x, y] = pt(end);
      const dx = (x - coords[2 * v]) * Math.cos((y * Math.PI) / 180);
      const dy = y - coords[2 * v + 1];
      const length = Math.hypot(dx, dy) || 1;
      const reach = MOUTH_REACH * extent;
      const tip: LonLat = [x + (dx / length) * reach / Math.cos((y * Math.PI) / 180), y + (dy / length) * reach];
      lines.push({ kind: "mouth", in: s, through: [], below: true, raw: [[x, y], tip], path: [[x, y], tip] });
    }
  }

  // Where the network doesn't connect: straight from U's outlet (or dot) to S's dot.
  for (const [u, s] of straightFrom) {
    const uOut = outletArc.get(u);
    const from = uOut === undefined ? dots.get(u)! : pt(last(uOut));
    if (!atDot.has(s)) atDot.set(s, []);
    atDot.get(s)!.push(u);
    const raw: LonLat[] = [from, dots.get(s)!];
    lines.push({ kind: "straight", in: u, through: [u], below: false, raw, path: raw });
  }
  return { nodes, lines, dots, atDot, extent };
}

/** A line's discharge (m³/s), from each sub-basin's outflow `q` (NaN: none). */
export function lineQ(line: SchemeLine, q: (id: number) => number, scheme: Scheme): number {
  const flow = (id: number) => {
    const v = q(id);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  };
  if (line.kind === "mouth") return flow(line.in);
  const passing = line.through.reduce((sum, id) => sum + flow(id), 0);
  if (!line.below) return passing;
  const out = flow(line.in);
  const qin = (scheme.nodes.get(line.in)?.upstream ?? []).reduce((sum, id) => sum + flow(id), 0);
  const joined = passing + (scheme.atDot.get(line.in) ?? []).reduce((sum, id) => sum + flow(id), 0);
  // Where the sub-basin loses water, what comes in shrinks to what goes out.
  const keep = qin > 0 ? Math.min(1, out / qin) : 1;
  return joined * keep + Math.max(0, out - qin);
}

/** Simplify every river line to `tolerance` degrees (of latitude); nothing to do if they are already. */
export function simplify(scheme: Scheme, tolerance: number) {
  if (scheme.simplifiedAt === tolerance) return;
  scheme.simplifiedAt = tolerance;
  for (const line of scheme.lines) line.path = line.kind === "river" && tolerance > 0 ? douglasPeucker(line.raw, tolerance) : line.raw;
}

function douglasPeucker(points: LonLat[], tolerance: number): LonLat[] {
  if (points.length < 3) return points;
  const k = Math.cos((points[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = [points[i][0] * k, points[i][1]];
    const [bx, by] = [points[j][0] * k, points[j][1]];
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let m = i + 1; m < j; m++) {
      const [px, py] = [points[m][0] * k, points[m][1]];
      const t = length2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > worst) [worst, at] = [d, m];
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
