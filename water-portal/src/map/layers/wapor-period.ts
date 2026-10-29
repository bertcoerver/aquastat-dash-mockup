/*
 * A period of a WaPOR variable: the rasters a range of days is added up from (planned
 * by wapor-plan.ts), each with its share, and whether they're published yet. No raster
 * is read here; wapor-tiles.ts reads them and wapor.ts shows them.
 */
import { MONTHS, dkD, dkFirstDay, dkLastDay, dkM, dkY, fmtDay } from "../../toolbar/dekads";
import { type DayRange } from "../../toolbar/range-rules";
import { formatPlan, planRange, type Block, type BlockKind } from "./wapor-plan";
import { type WaporRamp } from "./wapor-shader";
import { memoized } from "../../lib/memo";
import { PER_DAYS, RESOLUTIONS, levelOf, mapsetOf, qualityOf, rasterUrl, scaleOf, termName, waporVariable, type WaporLevel, type WaporPer, type WaporResolution, type WaporVariable, type WaporVariableId } from "./wapor-variables";

/** One raster in a period's sum: shown value (mm/day) += factor * raw value. */
export interface WaporTerm {
  url: string;
  name: string; // "M[2025-01]"
  factor: number;
  /** On another grid than the period's: a raster on the period's, to sample it onto. */
  grid?: string;
  /** Of a variable made from others: which part (index in its `parts`) it adds to. */
  part?: number;
}

/** What the map shows for a date range: one WaPOR raster, or a sum of them. */
export interface WaporPeriod {
  variable: WaporVariable;
  resolution: WaporResolution;
  label: string;
  /** The range, and its days. */
  range: DayRange;
  days: number;
  terms: WaporTerm[];
  /** How the value is made, e.g. "AETI (mm/day) = (A[2025] − M[2025-01] − M[2025-12]) / 304". */
  equation: string;
  /** Of loading the rasters, in dekadal rasters (see wapor-plan.ts). */
  cost: number;
  /** Rasters a cheaper sum would have used, but which aren't published yet (file names). */
  unpublished: string[];
  /** A single dekad: its NDVI quality raster (null: none). */
  qualityUrl: string | null;
  /** About how the value is made, if there's something to know (partial dekads). */
  note: string | null;
  /** Identifies the variable's rasters and how they're added up (not the quality raster). */
  key: string;
  /** The level it's shown at: from L2's rasters where a variable has them (PCP stays L1's). */
  level: WaporLevel;
  /** At L1: the same range at L2, if the variable has it and it's published (null: none). */
  l2: WaporPeriod | null;
  /** At L2: the L1 period, for the pixels L2 has no data for. */
  fill: WaporPeriod | null;
}

/** What the raster layer draws: a period's rasters added up, or a static map's (gaez.ts), which has no period. */
export type RasterSum = Pick<WaporPeriod, "variable" | "terms" | "qualityUrl" | "key" | "level" | "l2" | "fill">;

const fileName = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const termsKey = (terms: WaporTerm[]) => terms.map((t) => `${t.factor}*${t.url}${t.grid ? ` on ${t.grid}` : ""}`).join(" + ");

function rangeLabel(range: DayRange) {
  const [first, last] = [fmtDay(range.start), fmtDay(range.end)];
  return `${first.slice(-4) === last.slice(-4) ? first.slice(0, -5) : first} – ${last}`;
}

/**
 * What to show of a variable for a Local view range, assuming every raster is published
 * except those in `unpublished` (by URL). Null if no sum can make the range. Periods
 * WaPOR doesn't publish the variable for (e.g. months of T) are left out.
 */
export function waporPeriod(
  variable: WaporVariable,
  range: DayRange,
  unpublished: ReadonlySet<string> = new Set(),
  level: WaporLevel = "L1",
): WaporPeriod | null {
  if (variable.parts) return combinedPeriod(variable, range, unpublished, level);
  const url = (b: Block) => rasterUrl(mapsetOf(variable, b.kind, level), b.code);
  const plan = planRange(range, (b) => !variable.kinds.includes(b.kind) || unpublished.has(url(b)));
  if (!plan) return null;
  const skipped = [...unpublished].map(fileName);
  const [only] = plan.terms;
  const days = range.end - range.start + 1;
  const equation = `${variable.short} (${variable.unit}) =`;
  // The total (a dekadal raster is per day, so times its days), over the days.
  const terms = plan.terms.map(({ block: b, coef, days: n }) => ({
    url: url(b),
    name: termName(variable, b),
    factor: (scaleOf(variable, b.kind) * (n ?? coef)) / days,
  }));
  const key = termsKey(terms);

  // Exactly one raster: named after its period.
  if (
    plan.terms.length === 1 &&
    only.coef === 1 &&
    dkFirstDay(only.block.start) === range.start &&
    dkLastDay(only.block.start + only.block.len - 1) === range.end
  ) {
    const b = only.block;
    const start = b.start;
    const y = dkY(start);
    const m = dkM(start);
    const label =
      b.kind === "D" ? `${["1st", "2nd", "3rd"][dkD(start)]} dekad of ${MONTHS[m]} ${y}` : b.kind === "M" ? `${MONTHS[m]} ${y}` : String(y);
    return {
      variable,
      resolution: RESOLUTIONS[b.kind],
      label,
      range,
      days,
      terms,
      equation: `${equation} ${termName(variable, b)}${b.kind === "D" ? "" : ` / ${days}`}`,
      cost: plan.cost,
      unpublished: skipped,
      qualityUrl: b.kind === "D" && variable.quality ? rasterUrl(qualityOf(levelOf(variable, level)), b.code) : null,
      note: null,
      key,
      level,
      l2: null,
      fill: null,
    };
  }

  return {
    variable,
    resolution: "custom",
    label: rangeLabel(range),
    range,
    days,
    terms,
    equation: `${equation} (${formatPlan(plan, (b) => termName(variable, b))}) / ${days}`,
    cost: plan.cost,
    unpublished: skipped,
    qualityUrl: null,
    note: null,
    key,
    level,
    l2: null,
    fill: null,
  };
}

/**
 * A variable made from others (see WaporVariable.parts): each part's period, its terms
 * times the part's sign. Those of parts on another grid are sampled onto `grid`'s.
 */
function combinedPeriod(variable: WaporVariable, range: DayRange, unpublished: ReadonlySet<string>, level: WaporLevel): WaporPeriod | null {
  const parts = [];
  for (const { id, sign } of variable.parts!) {
    const period = waporPeriod(waporVariable(id), range, unpublished, level);
    if (!period) return null;
    parts.push({ id, sign, period });
  }
  const onGrid = parts.find((p) => p.id === variable.grid)!.period;
  // A part on the same grid (same level and pixel size: WaPOR's grids line up) needs no sampling.
  const sameGrid = (id: WaporVariableId) => {
    const [part, grid] = [waporVariable(id), waporVariable(variable.grid!)];
    return levelOf(part, level) === levelOf(grid, level) && part.pixel === grid.pixel;
  };
  const terms = parts.flatMap(({ id, sign, period }, part) =>
    period.terms.map((t) => ({ ...t, part, factor: sign * t.factor, ...(sameGrid(id) ? {} : { grid: onGrid.terms[0].url }) })),
  );
  const periods = parts.map((p) => p.period);
  const same = (get: (p: WaporPeriod) => string) => periods.every((p) => get(p) === get(periods[0]));
  // Each part's own equation, without its left-hand side: "PCP(M[2025-01] / 31) − AETI(…)".
  const equation = parts
    .map(({ sign, period }, i) => {
      const op = variable.ratio ? (i ? " / " : "") : sign < 0 ? (i ? " − " : "−") : i ? " + " : "";
      return `${op}${period.variable.short}(${period.equation.slice(period.equation.indexOf(" = ") + 3)})`;
    })
    .join("");
  return {
    variable,
    resolution: same((p) => p.resolution) ? periods[0].resolution : "custom",
    label: same((p) => p.label) ? periods[0].label : rangeLabel(range),
    range,
    days: range.end - range.start + 1,
    terms,
    equation: `${variable.short} (${variable.unit}) = ${equation}`,
    cost: periods.reduce((sum, p) => sum + p.cost, 0),
    unpublished: [...unpublished].map(fileName),
    qualityUrl: onGrid.qualityUrl,
    note: periods.find((p) => p.note)?.note ?? null,
    key: termsKey(terms),
    level,
    l2: null,
    fill: null,
  };
}

/**
 * What to show for a range, using only published rasters: a cheaper sum may need one
 * that isn't out yet (the latest year or month), so plan again without it. Null if the
 * range can't be made from published rasters. Rejects if the bucket can't be reached.
 */
export async function publishedWaporPeriod(variable: WaporVariable, range: DayRange, level: WaporLevel = "L1"): Promise<WaporPeriod | null> {
  const unpublished = new Set<string>();
  for (;;) {
    const period = waporPeriod(variable, range, unpublished, level);
    if (!period) return null;
    const published = await Promise.all(period.terms.map((t) => waporAvailable(t.url)));
    if (published.every(Boolean)) return period;
    period.terms.forEach((t, i) => published[i] || unpublished.add(t.url));
  }
}

/**
 * Recent periods are published with a delay, so check a raster exists before opening
 * it. Rejects on a network error (not cached: tried again next time), so that isn't
 * taken for a raster that doesn't exist.
 */
const exists = new Map<string, Promise<boolean>>();

export function waporAvailable(url: string): Promise<boolean> {
  return memoized(exists, url, () => fetch(url, { method: "HEAD" }).then((res) => res.ok));
}

/** A raster of each kind's days, nominally (a dekad's is per day). */
const KIND_DAYS: Record<BlockKind, number> = { D: 1, M: 365 / 12, A: 365 };
/** How long a raster of each kind is, in days. */
const KIND_LENGTH: Record<BlockKind, number> = { D: 10, M: 365 / 12, A: 365 };
/** The kind of raster that's in these units. */
const KIND_OF: Partial<Record<WaporPer, BlockKind>> = { day: "D", month: "M", year: "A" };

/**
 * WaPOR's own colour map for a period, shown `per` day, month, year or in total, per day
 * (as the map): its default style for rasters in that unit (a dekad's per day, a month's
 * per month, …; in total, for those nearest the period in length). If WaPOR has no such
 * style for the variable (no M for T), the nearest in length that it has, scaled. Null
 * for a variable WaPOR doesn't publish (made from others).
 */
export function waporStyleRamp({ variable, days, resolution }: WaporPeriod, per: WaporPer): WaporRamp | null {
  const styles = variable.styles;
  if (!styles) return null;
  const nearest = (length: number, kinds: BlockKind[]) =>
    kinds.reduce((a, b) => (Math.abs(Math.log(length / KIND_LENGTH[a])) <= Math.abs(Math.log(length / KIND_LENGTH[b])) ? a : b));
  const wanted = KIND_OF[per] ?? nearest(days, ["D", "M", "A"]);
  const kind = nearest(KIND_LENGTH[wanted], Object.keys(styles) as BlockKind[]);
  // So the legend's numbers are the style's own: what it multiplies a value per day by.
  const perDay =
    kind === "D" ? 1 : per === "total" ? (RESOLUTIONS[kind] === resolution ? days : KIND_DAYS[kind]) : kind === wanted ? PER_DAYS[per] : KIND_DAYS[kind];
  const { quantities, colors } = styles[kind]!;
  return { quantities: quantities.map((q) => q / perDay), colors };
}

