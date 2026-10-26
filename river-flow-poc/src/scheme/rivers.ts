/*
 * The scheme's discharge lines along the real rivers (public/data/rivers.bin), simplified.
 *
 * Within each sub-basin S, the line is the river network between where water comes in
 * and where it leaves:
 *
 * - from each upstream sub-basin U's outlet, downstream along the network until the river
 *   leaves S: that's S's outlet. Sub-basins are split at confluences, so most of these
 *   start at the same point, but not all: a tributary can join part way down. Sub-basins
 *   are worked through from upstream down, so U's outlet is known by then. (Not simply
 *   the end of S's biggest arc: the network has parallel duplicate arcs, so that's often
 *   the twin of the arc the river is traced along, and the two never meet.)
 *   Without anything flowing in, S's outlet is where the river leaves S below its biggest
 *   arc;
 * - S's dot sits on that river, at the point nearest the sub-basin's middle (on its own
 *   main river when nothing flows in: a headwater's line starts at its dot).
 *
 * Each piece of river carries the outflow of the upstream sub-basins that pass through
 * it, and below the dot also S's own gain (or, where S loses water, all of it scaled
 * down), so the width at S's outlet is S's outflow and the lines join up. Where the
 * network doesn't connect (a sub-basin without rivers, or a gap in the network), the
 * water goes straight from U's outlet, or dot, to S's dot.
 *
 * Pieces between junctions are simplified (Douglas–Peucker) at a tolerance the page
 * picks, so the lines can run anywhere from the river's every bend to nearly straight.
 */
import type { Network } from "../network";
import type { Balance, Node } from "./balance";

type LonLat = [number, number];

export interface RiverLine {
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

export interface RiverScheme {
  lines: RiverLine[];
  /** Each sub-basin's dot. */
  dots: Map<number, LonLat>;
  /** Per sub-basin, the upstream sub-basins whose water reaches it straight at its dot. */
  atDot: Map<number, number[]>;
}

/** A run of an arc's vertices, [from, to] inclusive. */
interface Seg {
  arc: number;
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

export function riverScheme(net: Network, nodes: Map<number, Node>, middles: Map<number, LonLat>, reach: number): RiverScheme {
  const { starts, next, acc, subBasin, coords } = net;
  const pt = (v: number): LonLat => [coords[2 * v], coords[2 * v + 1]];

  // Each sub-basin's biggest arc, and its main river upstream within it.
  const biggest = new Map<number, number>();
  for (let a = 0; a < net.nArcs; a++) {
    const sb = subBasin[a];
    if (!nodes.has(sb)) continue;
    const b = biggest.get(sb);
    if (b === undefined || acc[a] > acc[b]) biggest.set(sb, a);
  }
  /** Each sub-basin's outlet arc: the arc its river leaves it by (set upstream first). */
  const outletArc = new Map<number, number>();
  /** The arcs from `a` down to where the river leaves sub-basin `s` (empty if it never gets there). */
  const downTo = (a: number, s: number) => {
    const path: number[] = [];
    for (let i = 0; a >= 0 && subBasin[a] !== s && i < MAX_OUTSIDE; i++) path.push((a = next[a]));
    if (a < 0 || subBasin[a] !== s) return [];
    path.length = 0;
    for (let i = 0; a >= 0 && i < MAX_STEPS; i++) {
      path.push(a);
      if (next[a] < 0 || subBasin[next[a]] !== s) break;
      a = next[a];
    }
    return path;
  };

  // Upstream first.
  const order: Node[] = [];
  const done = new Set<number>();
  const visit = (node: Node) => {
    if (done.has(node.id)) return;
    done.add(node.id);
    for (const u of node.upstream) visit(nodes.get(u)!);
    order.push(node);
  };
  for (const node of nodes.values()) visit(node);
  const mainUp = new Map<number, number>();
  for (let a = 0; a < net.nArcs; a++) {
    const b = next[a];
    if (b < 0 || !nodes.has(subBasin[a]) || subBasin[a] !== subBasin[b]) continue;
    const m = mainUp.get(b);
    if (m === undefined || acc[a] > acc[m]) mainUp.set(b, a);
  }

  const lines: RiverLine[] = [];
  const dots = new Map<number, LonLat>();
  const atDot = new Map<number, number[]>();
  const straightFrom = new Map<number, number>(); // U → S: U's water goes straight to S's dot

  for (const node of order) {
    const s = node.id;
    const middle = middles.get(s) ?? node.position;
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
      const area = nodes.get(u)!.area;
      if (out === undefined || area > outFrom) [out, outFrom] = [path.at(-1)!, area];
    }
    out ??= downTo(biggest.get(s)!, s).at(-1) ?? biggest.get(s)!;
    outletArc.set(s, out);

    // The dot: the vertex nearest the middle, on the tree (or the main river of a headwater).
    let candidates = [...through.keys()];
    if (!candidates.length) for (let a: number | undefined = out; a !== undefined; a = mainUp.get(a)) candidates.push(a);
    const k = Math.cos((middle[1] * Math.PI) / 180);
    let dotArc = out;
    let dotV = starts[out + 1] - 1;
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
      return { arc, from, to, through: ups, below: isBelow, key: `${ups.join(",")}|${isBelow}`, next: null, preds: 0 };
    };
    for (const a of new Set([...through.keys(), ...below])) {
      const first = starts[a];
      const last = starts[a + 1] - 1;
      if (a !== dotArc) segs.set(a, [make(a, first, last, below.has(a))]);
      else if (dotV > first && through.has(a)) segs.set(a, [make(a, first, dotV, false), make(a, dotV, last, true)]);
      else segs.set(a, [make(a, dotV, last, true)]);
    }
    for (const [a, list] of segs) {
      for (let i = 0; i + 1 < list.length; i++) list[i].next = list[i + 1];
      const after = segs.get(next[a]);
      list.at(-1)!.next = after?.[0] ?? null;
    }
    const all = [...segs.values()].flat();
    for (const seg of all) if (seg.next) seg.next.preds++;

    // Chains of segments with the same load, between junctions.
    const merged = new Set<Seg>();
    for (const seg of all) {
      if (merged.has(seg)) continue;
      const isStart = seg.preds !== 1 || !all.some((p) => p.next === seg && p.key === seg.key);
      if (!isStart) continue;
      const raw: LonLat[] = [];
      for (let c: Seg | null = seg; c && c.key === seg.key && (c === seg || c.preds === 1); c = c.next) {
        merged.add(c);
        for (let v = c.from; v <= c.to; v++) {
          const p = pt(v);
          const prev = raw.at(-1);
          if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) raw.push(p);
        }
      }
      if (raw.length > 1) lines.push({ kind: "river", in: s, through: seg.through, below: seg.below, raw, path: raw });
    }

    if (node.downstream === null) {
      const end = pt(starts[out + 1] - 1);
      const [dx, dy] = node.direction;
      const tip: LonLat = [end[0] + (dx * reach) / Math.cos((end[1] * Math.PI) / 180), end[1] + dy * reach];
      lines.push({ kind: "mouth", in: s, through: [], below: true, raw: [end, tip], path: [end, tip] });
    }
  }

  // Where the network doesn't connect: straight from U's outlet (or dot) to S's dot.
  for (const [u, s] of straightFrom) {
    const uOut = outletArc.get(u);
    const from = uOut === undefined ? dots.get(u)! : pt(starts[uOut + 1] - 1);
    if (!atDot.has(s)) atDot.set(s, []);
    atDot.get(s)!.push(u);
    const raw: LonLat[] = [from, dots.get(s)!];
    lines.push({ kind: "straight", in: u, through: [u], below: false, raw, path: raw });
  }
  return { lines, dots, atDot };
}

/** A line's discharge (m³/s) in a period. */
export function lineQ(line: RiverLine, balance: (id: number) => Balance | undefined, atDot: Map<number, number[]>): number {
  const q = (id: number) => {
    const v = balance(id)?.Q;
    return Number.isFinite(v) ? v! : 0;
  };
  if (line.kind === "mouth") return q(line.in);
  const passing = line.through.reduce((sum, id) => sum + q(id), 0);
  if (!line.below) return passing;
  const b = balance(line.in);
  if (!b) return passing;
  const joined = passing + (atDot.get(line.in) ?? []).reduce((sum, id) => sum + q(id), 0);
  // Where the sub-basin loses water, what comes in shrinks to what goes out.
  const keep = b.Qin > 0 ? Math.min(1, Math.max(0, b.Q) / b.Qin) : 1;
  return joined * keep + Math.max(0, b.Q - b.Qin);
}

/** Simplify every river line to `tolerance` degrees (of latitude). */
export function simplify(lines: RiverLine[], tolerance: number) {
  for (const line of lines) line.path = line.kind === "river" && tolerance > 0 ? douglasPeucker(line.raw, tolerance) : line.raw;
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
