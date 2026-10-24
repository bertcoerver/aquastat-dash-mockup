/*
 * Which WaPOR rasters to add up for a date range. WaPOR publishes AETI per dekad (D),
 * calendar month (M) and calendar year (A), and they add up: a month is the sum of its
 * dekads (as mm/day × days), a year the sum of its months. So any range of dekads is a
 * sum of rasters with signs, e.g. Feb–Nov 2025 = A[2025] − M[2025-01] − M[2025-12].
 *
 * A range can also start or end within a dekad. A dekadal raster is the dekad's
 * average mm/day, so k of its days count as k × that raster: this assumes ET is spread
 * evenly over the dekad (WaPOR v3 has nothing daily), e.g. 5 Jan – 31 Dec 2025 =
 * A[2025] − 4·D[2025-01-D1].
 *
 * Of the many ways to write a range, planRange picks the one that's cheapest to load.
 * Years hold months and months hold dekads, so it can search them as a tree: for each
 * year, then each month in it, add the raster, subtract it or leave it out, and at the
 * dekads fix whatever is still off. That's exact, and only a few thousand steps.
 */
import { MAX_DK, dayDk, dkFirstDay, dkLastDay, endDay, startDay } from "../../toolbar/dekads";
import type { DayRange } from "../../toolbar/range-rules";

export type BlockKind = "D" | "M" | "A";

/** One published raster: a dekad, calendar month or calendar year. */
export interface Block {
  kind: BlockKind;
  start: number; // first dekad
  len: number; // 1, 3 or 36 dekads
  /** As in WaPOR's raster names: 2025, 2025-03 or 2025-03-D2. */
  code: string;
}

/**
 * A raster in a plan: its total over its own period (mm), times `coef`. A dekadal
 * raster counts per day instead: `days` of it (coef = days / days in the dekad).
 */
export interface Term {
  block: Block;
  coef: number;
  days?: number;
}

export interface Plan {
  terms: Term[];
  /** In units of one dekadal raster; see COST. */
  cost: number;
}

/**
 * The cost of loading a raster, in units of the bytes of a dekadal one. Rasters get
 * bigger with longer periods: in 2024 the average D was 0.87 GB, M 1.77 GB (Int16, but
 * larger values compress worse) and A 5.09 GB (Int32). Each raster also costs a fixed
 * amount, about one dekadal raster's worth at a typical view: a check that it exists,
 * its header (~0.3 MB) and one more request for every tile on screen.
 */
const PER_RASTER = 1;
export const COST: Record<BlockKind, number> = { D: PER_RASTER + 1, M: PER_RASTER + 2, A: PER_RASTER + 5.8 };

const pad = (n: number) => String(n).padStart(2, "0");
const yearOf = (dk: number) => 2018 + Math.floor(dk / 36);

export function block(kind: BlockKind, start: number): Block {
  const y = yearOf(start);
  const m = Math.floor((start % 36) / 3);
  const len = { D: 1, M: 3, A: 36 }[kind];
  const code = kind === "A" ? String(y) : kind === "M" ? `${y}-${pad(m + 1)}` : `${y}-${pad(m + 1)}-D${(start % 3) + 1}`;
  return { kind, start, len, code };
}

/** Days in a dekad: 10, or 8 to 11 for the last of the month. */
export const dekadDays = (dk: number) => endDay(dk) - startDay(dk) + 1;

/** "A[2025]", "M[2025-01]" or "D[2025-03-D2]". */
export const blockName = (b: Block) => `${b.kind}[${b.code}]`;

const NONE: Plan = { terms: [], cost: Infinity };
const better = (a: Plan, b: Plan) => a.cost < b.cost || (a.cost === b.cost && a.terms.length < b.terms.length);
const add = (a: Plan, b: Plan): Plan => ({ terms: [...a.terms, ...b.terms], cost: a.cost + b.cost });

/**
 * The cheapest sum of rasters for a range of days, or null if there is none, e.g. when
 * a dekad in it isn't published. `unpublished(block)` tells which rasters can't be
 * used; those ending after the current dekad never can.
 */
export function planRange(days: DayRange, unpublished: (b: Block) => boolean = () => false): Plan | null {
  const usable = (b: Block) => b.start + b.len - 1 <= MAX_DK && !unpublished(b);
  // The dekads the range lies in.
  const start = dayDk(days.start);
  const end = dayDk(days.end);

  // `c`: how many times the rasters chosen above already count each dekad here.
  function dekad(dk: number, c: number): Plan {
    const all = dekadDays(dk);
    const covered = Math.max(0, Math.min(days.end, dkLastDay(dk)) - Math.max(days.start, dkFirstDay(dk)) + 1);
    const need = covered - c * all; // in days
    if (need === 0) return { terms: [], cost: 0 };
    const b = block("D", dk);
    return usable(b) ? { terms: [{ block: b, coef: need / all, days: need }], cost: COST.D } : NONE;
  }

  // A year or month: leave its raster out, add it or subtract it (in that order of
  // preference on a tie), then do the same for what's in it.
  function node(kind: "A" | "M", first: number, c: number): Plan {
    // Nothing selected in it, and nothing to take away: nothing to load.
    const last = first + (kind === "A" ? 35 : 2);
    if (c === 0 && (last < start || first > end)) return { terms: [], cost: 0 };
    const b = block(kind, first);
    let best = NONE;
    for (const k of [0, 1, -1]) {
      if (k !== 0 && !usable(b)) continue;
      // (Stops early once over the best so far; on a tie it must finish to compare.)
      let plan: Plan = k === 0 ? { terms: [], cost: 0 } : { terms: [{ block: b, coef: k }], cost: COST[kind] };
      if (kind === "A") for (let m = 0; m < 12 && plan.cost <= best.cost; m++) plan = add(plan, node("M", first + m * 3, c + k));
      else for (let d = 0; d < 3 && plan.cost <= best.cost; d++) plan = add(plan, dekad(first + d, c + k));
      if (better(plan, best)) best = plan;
    }
    return best;
  }

  let plan: Plan = { terms: [], cost: 0 };
  for (let y = Math.floor(start / 36); y <= Math.floor(end / 36); y++) plan = add(plan, node("A", y * 36, 0));
  if (!Number.isFinite(plan.cost)) return null;
  plan.terms.sort((a, b) => a.block.start - b.block.start || b.block.len - a.block.len);
  return plan;
}

/**
 * The plan as an equation of totals in mm, e.g. "A[2025] − M[2025-01] − M[2025-12]".
 * A dekadal raster is in mm/day, so it's multiplied by its days: "11·D[2025-03-D3]".
 */
export function formatPlan({ terms }: Plan) {
  return terms
    .map(({ block: b, coef, days }, i) => {
      const factor = Math.abs(days ?? coef);
      const sign = coef < 0 ? (i ? " − " : "−") : i ? " + " : "";
      return `${sign}${factor === 1 && days === undefined ? "" : `${factor}·`}${blockName(b)}`;
    })
    .join("");
}
