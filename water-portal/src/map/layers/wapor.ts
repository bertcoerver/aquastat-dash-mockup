/*
 * WaPOR v3 level 1 (global) variables: actual evapotranspiration and interception
 * (AETI), its parts transpiration (T), evaporation (E) and interception (I), net
 * primary production (NPP), all at 300 m, precipitation (PCP, about 5 km) and reference
 * evapotranspiration (RET, about 30 km: 0.3125° × 0.25°, AgERA5's grid). They're
 * read straight from FAO's bucket (it sends CORS headers). WaPOR publishes one COG per
 * dekad, and for some variables per calendar month and calendar year too (see
 * WAPOR_VARIABLES). A range is added up from one or more of them (see wapor-plan.ts for
 * which), tile by tile as they load, and always shown as the average per day over the
 * range, e.g. in mm/day. A range can start and end on any day: of a dekad it only
 * partly covers, it takes those days' share of the dekad's raster.
 *
 * A variable can also be made from others: PCP − AETI is PCP's sum minus AETI's, and
 * water productivity (WP) NPP's sum over AETI's (the ratio of the totals). PCP − AETI is on
 * AETI's 300 m grid, with PCP's 5 km pixels sampled onto it (see resampledTile).
 *
 * Catalogue: https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets/L1-AETI-D
 * (-M, -A; L1-T-D, …). AETI's colours are WaPOR's own style AETI-D-INT16, the others'
 * ColorBrewer ramps; the stops are stretched to the values in view (see waporViewRange).
 *
 * A dekad of a 300 m variable also comes with L1-QUAL-NDVI-D, on the same grid: for
 * each pixel, how many dekads it has been since the last valid satellite observation
 * behind the NDVI (0: observed this dekad). The variables are modelled from it, so a
 * long gap means a less reliable value; the quality slider hides those pixels. It's
 * published some dekads after them.
 *
 * For some countries (see wapor-l2.ts) WaPOR also publishes level 2: the same variables
 * (not PCP) for the same periods at 100 m, on a grid three times as fine that lines up
 * with L1's. It's only read where L1 runs out: when its full 100 m is due (see
 * L2_FROM), and the view reaches those countries. So a view loads one level or the
 * other, never both. Pixels L2 has no data for (other countries, in a view across a
 * border) are filled from L1, sampled onto L2's grid.
 */
import type { Viewport } from "@deck.gl/core";
import type { TileLayer } from "@deck.gl/geo-layers";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import { GeoTIFF, PerOriginSemaphore, defaultDecoderPool, type RasterArray, type RasterTypedArray } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import { MONTHS, dkD, dkFirstDay, dkLastDay, dkM, dkY, fmtDay } from "../../toolbar/dekads";
import { type DayRange } from "../../toolbar/range-rules";
import { cogImage, cogTile } from "../../local/cog-pixel";
import { boxInL2 } from "./wapor-l2";
import { block, blockName, formatPlan, planRange, type Block, type BlockKind } from "./wapor-plan";
import { AetiRamp, rampProps, type WaporRamp } from "./wapor-shader";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";

/** WaPOR's level 1 (global, 300 m) or 2 (some countries, 100 m). */
export type WaporLevel = "L1" | "L2";

const qualityOf = (level: WaporLevel) => `${level}-QUAL-NDVI-D`;

export type WaporResolution = "dekadal" | "monthly" | "annual" | "custom";

const RESOLUTIONS: Record<BlockKind, WaporResolution> = { D: "dekadal", M: "monthly", A: "annual" };

export type WaporVariableId = "AETI" | "RET" | "T" | "E" | "I" | "PCP" | "NPP" | "PCP-AETI" | "WP" | "T-AETI";

export interface WaporVariable {
  id: WaporVariableId;
  label: string;
  /** In the legend and the equation, e.g. "AETI". */
  short: string;
  /** Per day: a dekadal raster's own unit (the others are per month and per year). */
  unit: string;
  /** Over a whole pixel, per day: a value per m² times the pixel's area, over 1000 (mm → m³, gC/m² → kgC). */
  perPixel: string;
  pixel: string;
  /** Physical value = raw * scale; of a ratio, the first part over the second times it (100: in %). */
  scale: number;
  /** The periods WaPOR publishes it for (mapset L1-<id>-<kind>); none if made from `parts`. */
  kinds: BlockKind[];
  /** Published at level 2 too, for the same periods (see waporHasL2 for one made from `parts`). */
  l2?: boolean;
  /** Whether L1-QUAL-NDVI-D goes with its dekads (same grid, modelled from NDVI). */
  quality: boolean;
  /** What the map shows until the view's own range is known, per day. */
  ramp: WaporRamp;
  /**
   * WaPOR's own default style for its rasters of each kind (see waporStyleRamp). None
   * if made from `parts`.
   */
  styles?: Partial<Record<BlockKind, WaporRamp>>;
  /**
   * Made from other variables instead of rasters of its own: their values, each times
   * its sign, on `grid`'s grid (the others' are sampled onto it, so it should be the
   * finest). Its quality raster is `grid`'s.
   */
  parts?: { id: WaporVariableId; sign: 1 | -1 }[];
  grid?: WaporVariableId;
  /** Its values can be below zero: they're kept, and its colours are centred on 0. */
  signed?: boolean;
  /**
   * Made from two `parts`: the first's total over the second's (both over the same
   * days), not a sum. Then it has no time in its unit, so no per month, year or pixel,
   * and no total.
   */
  ratio?: boolean;
  /**
   * A ratio: the least the second part may be, per day on average over the days, for the
   * ratio to mean something; below it there's no value (e.g. WP in a desert).
   */
  ratioMin?: number;
}

/**
 * WaPOR's default styles, by code (the catalogue's mapset gives its defaultStyleCode:
 * https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/styles/AETI-M),
 * in their rasters' units (per day, the month's total, the year's) instead of raw
 * values. Without their flag stops (AETI-D's 254, RET-E's 255).
 */
const YlGnBu5 = ["#f0f9e8", "#bae4bc", "#7bccc4", "#43a2ca", "#0868ac"];
const RET7 = ["#fffaf0", "#fef0d9", "#fdcc8a", "#fc8d59", "#e34a33", "#b30000", "#680d10"];
const PCP11 = ["#f0f9e8", "#d8f0d5", "#c0e7c1", "#a5dcbf", "#89d2c2", "#6ec3c6", "#56b0c8", "#3c9cc7", "#2282ba", "#0868ac", "#0745a2"];
const NPP5 = ["#d9d9d9", "#ebefc6", "#ccd990", "#99b632", "#68763d"];
const STYLES = {
  AETI_D: { quantities: [0.1, 2.5, 5, 7.5, 10], colors: ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"] },
  AETI_M: { quantities: [10, 40, 80, 120, 160], colors: YlGnBu5 },
  AETI_A: { quantities: [100, 400, 800, 1200, 1600], colors: YlGnBu5 },
  RET_E: { quantities: [1, 2.5, 5, 7.5, 10], colors: ["#fef0d9", "#fdcc8a", "#fc8d59", "#e34a33", "#b30000"] },
  RET_M: { quantities: [0, 100, 150, 200, 250, 300, 350], colors: RET7 },
  RET_A: { quantities: [0, 1000, 1500, 2000, 2500, 3000, 3500], colors: RET7 },
  PCP_E: { quantities: [0, 1, 5, 10, 15], colors: ["#e6e6e6", "#bae4bc", "#7bccc4", "#43a2ca", "#0868ac"] },
  PCP_M: { quantities: [0, 10, 25, 50, 75, 100, 125, 150, 200, 250, 300], colors: PCP11 },
  PCP_A: { quantities: [0, 100, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000], colors: PCP11 },
  NPP: { quantities: [0, 0.5, 1.5, 3, 6], colors: NPP5 },
  NPP_M: { quantities: [0, 15, 45, 90, 180], colors: NPP5 },
} satisfies Record<string, WaporRamp>;

/** In the order of the legend's menu. Published periods as in WaPOR's catalogue. */
export const WAPOR_VARIABLES: WaporVariable[] = [
  {
    id: "AETI",
    label: "Actual evapotranspiration",
    short: "AETI",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "300 m",
    scale: 0.1,
    kinds: ["D", "M", "A"],
    l2: true,
    quality: true,
    ramp: { quantities: [0.1, 2.5, 5, 7.5, 10], colors: ["#ffffcc", "#a1dab4", "#41b6c4", "#2c7fb8", "#253494"] },
    styles: { D: STYLES.AETI_D, M: STYLES.AETI_M, A: STYLES.AETI_A },
  },
  {
    id: "RET",
    label: "Reference evapotranspiration",
    short: "RET",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "30 km",
    scale: 0.1,
    kinds: ["D", "M", "A"],
    quality: false, // (another grid)
    ramp: { quantities: [0, 2, 4, 6, 8], colors: ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"] },
    styles: { D: STYLES.RET_E, M: STYLES.RET_M, A: STYLES.RET_A },
  },
  {
    id: "T",
    label: "Transpiration",
    short: "T",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "300 m",
    scale: 0.1,
    kinds: ["D", "A"],
    l2: true,
    quality: true,
    ramp: { quantities: [0, 1.5, 3, 4.5, 6], colors: ["#f7fcf5", "#c7e9c0", "#74c476", "#238b45", "#00441b"] },
    styles: { D: STYLES.AETI_D, A: STYLES.AETI_A }, // (WaPOR's are AETI's)
  },
  {
    id: "E",
    label: "Evaporation",
    short: "E",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "300 m",
    scale: 0.1,
    kinds: ["D", "A"],
    l2: true,
    quality: true,
    ramp: { quantities: [0, 1, 2, 3, 4], colors: ["#ffffe5", "#fee391", "#fe9929", "#cc4c02", "#662506"] },
    styles: { D: STYLES.AETI_D, A: STYLES.AETI_A }, // (WaPOR's are AETI's)
  },
  {
    id: "I",
    label: "Interception",
    short: "I",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "300 m",
    scale: 0.1,
    kinds: ["D", "A"],
    l2: true,
    quality: true,
    ramp: { quantities: [0, 0.25, 0.5, 0.75, 1], colors: ["#fcfbfd", "#dadaeb", "#9e9ac8", "#6a51a3", "#3f007d"] },
    styles: { D: STYLES.AETI_D, A: STYLES.AETI_A }, // (WaPOR's are AETI's)
  },
  {
    id: "PCP",
    label: "Precipitation",
    short: "PCP",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "5 km",
    scale: 0.1,
    kinds: ["D", "M", "A"],
    quality: false, // (another grid)
    ramp: { quantities: [0, 2.5, 5, 10, 20], colors: ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"] },
    styles: { D: STYLES.PCP_E, M: STYLES.PCP_M, A: STYLES.PCP_A },
  },
  {
    id: "NPP",
    label: "Net primary production",
    short: "NPP",
    unit: "gC/m²/day",
    perPixel: "kgC/day",
    pixel: "300 m",
    scale: 0.001,
    kinds: ["D", "M"],
    l2: true,
    quality: true,
    ramp: { quantities: [0, 1, 2, 3, 4], colors: ["#ffffcc", "#d9f0a3", "#78c679", "#238443", "#004529"] },
    styles: { D: STYLES.NPP, M: STYLES.NPP_M },
  },
  {
    id: "PCP-AETI",
    label: "Net runoff",
    short: "PCP − AETI",
    unit: "mm/day",
    perPixel: "m³/day",
    pixel: "300 m (PCP 5 km)",
    scale: 1,
    kinds: [],
    quality: true,
    // Brown where more evaporates than rains, blue-green where more rains.
    ramp: { quantities: [-4, -2, 0, 2, 4], colors: ["#a6611a", "#dfc27d", "#f5f5f5", "#80cdc1", "#018571"] },
    parts: [
      { id: "PCP", sign: 1 },
      { id: "AETI", sign: -1 },
    ],
    grid: "AETI",
    signed: true,
  },
  {
    id: "WP",
    label: "Water productivity",
    short: "WP",
    // NPP (gC/m²) per AETI (mm, i.e. L/m²): gC/L = kgC/m³.
    unit: "kgC/m³",
    perPixel: "kgC/m³",
    pixel: "300 m",
    scale: 1,
    kinds: [],
    quality: true,
    ramp: { quantities: [0, 0.5, 1, 1.5, 2], colors: ["#ffffd9", "#c7e9b4", "#41b6c4", "#225ea8", "#081d58"] },
    parts: [
      { id: "NPP", sign: 1 },
      { id: "AETI", sign: 1 },
    ],
    grid: "AETI",
    ratio: true,
    // AETI of 0.1 mm/day (37 mm a year): less, and NPP over it is mostly noise.
    ratioMin: 0.1,
  },
  {
    id: "T-AETI",
    label: "Beneficial AETI",
    short: "T / AETI",
    // The share of AETI that's transpired, in %.
    unit: "%",
    perPixel: "%",
    pixel: "300 m",
    scale: 100,
    kinds: [],
    quality: true,
    // Brown where little of it is transpired, green where most is.
    ramp: { quantities: [0, 25, 50, 75, 100], colors: ["#a6611a", "#dfc27d", "#f5f5f5", "#a6dba0", "#1b7837"] },
    parts: [
      { id: "T", sign: 1 },
      { id: "AETI", sign: 1 },
    ],
    grid: "AETI",
    ratio: true,
    // As WP's: over less AETI the share is mostly noise.
    ratioMin: 0.1,
  },
];

export const waporVariable = (id: string) => WAPOR_VARIABLES.find((v) => v.id === id) ?? WAPOR_VARIABLES[0];

/** Whether a variable can be shown from L2: one made from others if its `grid`'s is (PCP stays on its own). */
export const waporHasL2 = (variable: WaporVariable) => !!waporVariable(variable.grid ?? variable.id).l2;

/** The level a variable's rasters are read from, for a level shown (L1 if it has no L2 rasters). */
const levelOf = (variable: WaporVariable, level: WaporLevel): WaporLevel => (variable.l2 ? level : "L1");

/** Its pixel size at a level, e.g. "100 m (PCP 5 km)". */
export const waporPixel = (variable: WaporVariable, level: WaporLevel) =>
  level === "L2" && waporHasL2(variable) ? variable.pixel.replace("300 m", "100 m") : variable.pixel;

/**
 * The units values are shown in. Per: the rasters are per day, a month counts as 30
 * days and a year as 365; "total" is the sum over the selected period. Over a pixel
 * (`pixel`): times the pixel's area, e.g. m³ instead of mm.
 */
export type WaporPer = "day" | "month" | "year" | "total";
export interface WaporUnits {
  per: WaporPer;
  pixel: boolean;
}
const PERS: WaporPer[] = ["day", "month", "year", "total"];
/** In the order the unit button goes through them. */
export const WAPOR_UNITS: WaporUnits[] = [false, true].flatMap((pixel) => PERS.map((per) => ({ per, pixel })));
export const PER_DAYS: Record<Exclude<WaporPer, "total">, number> = { day: 1, month: 30, year: 365 };
/** A value per day times this is per `per`; `days`: the period's, for "total". */
export const perDays = (per: WaporPer, days: number) => (per === "total" ? days : PER_DAYS[per]);
/**
 * The units a variable can be shown in. A ratio has just its own: it has no time in its
 * unit, and on the map it's already the ratio of the period's totals.
 */
export const waporUnitsFor = (variable: WaporVariable): WaporUnits[] => (variable.ratio ? [WAPOR_UNITS[0]] : WAPOR_UNITS);
/** The nearest units a variable can be shown in (after another variable is picked). */
export function fitUnits(variable: WaporVariable, units: WaporUnits): WaporUnits {
  const all = waporUnitsFor(variable);
  return all.find((u) => u.per === units.per && u.pixel === units.pixel) ?? all.find((u) => u.per === (units.per === "total" ? "total" : "day"))!;
}
/**
 * What a value per day (in `variable.unit`) is multiplied by in these units: `days`, the
 * period's, for "total"; `pixelArea` (m²) for a value over a pixel. A ratio stays as it is.
 */
export const unitFactor = (variable: WaporVariable, { per, pixel }: WaporUnits, days: number, pixelArea: number) =>
  variable.ratio ? 1 : perDays(per, days) * (pixel ? pixelArea / 1000 : 1);
/** A variable's unit, e.g. "mm/month", "mm" in total, "m³/month" over a pixel. */
export const waporUnit = (variable: WaporVariable, { per, pixel }: WaporUnits) =>
  variable.ratio ? variable.unit : (pixel ? variable.perPixel : variable.unit).replace(/\/day$/, per === "total" ? "" : `/${per}`);


/** The area of a lon/lat grid's pixel of `size` degrees, centred at latitude `lat`, in m². */
export function pixelArea([dx, dy]: [number, number], lat: number) {
  const rad = Math.PI / 180;
  const R = 6371008.8;
  return R * R * dx * rad * Math.abs(Math.sin((lat + dy / 2) * rad) - Math.sin((lat - dy / 2) * rad));
}
/** "9.2 ha" or "30.9 km²". */
export const fmtArea = (m2: number) => (m2 < 1e6 ? `${+(m2 / 1e4).toFixed(1)} ha` : `${+(m2 / 1e6).toFixed(1)} km²`);

/** AETI's: the map's colours before any variable is picked. */
export const DEFAULT_RAMP: WaporRamp = WAPOR_VARIABLES[0].ramp;

const mapsetOf = (variable: WaporVariable, kind: BlockKind, level: WaporLevel = "L1") => `${levelOf(variable, level)}-${variable.id}-${kind}`;
const rasterUrl = (mapset: string, code: string) => `${BUCKET}/${mapset}/WAPOR-3.${mapset}.${code}.tif`;

/** A variable's raster for one dekad (of a variable with rasters of its own), at a level (L1 if it has no L2). */
export const waporDekadUrl = (variable: WaporVariable, dk: number, level: WaporLevel = "L1") =>
  rasterUrl(mapsetOf(variable, "D", level), block("D", dk).code);

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
    name: blockName(b),
    factor: (variable.scale * (n ?? coef)) / days,
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
      equation: `${equation} ${blockName(b)}${b.kind === "D" ? "" : ` / ${days}`}`,
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
    equation: `${equation} (${formatPlan(plan)}) / ${days}`,
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

/** A period that has been checked, ready to show, and its quality raster's state. */
export interface CheckedWaporPeriod {
  /** Without its quality raster if that isn't published. */
  period: WaporPeriod;
  /** A dekad: whether its quality raster is published (null: not a dekad). */
  quality: "ready" | "missing" | null;
}

/**
 * What to show for a range, checked: the rasters published, and those of the level the
 * view shows opened, so the map can show it straight away. Null if it can't be made;
 * rejects if the bucket can't be reached.
 */
export async function checkedWaporPeriod(variable: WaporVariable, range: DayRange): Promise<CheckedWaporPeriod | null> {
  const period = await publishedWaporPeriod(variable, range);
  if (!period) return null;
  const quality = period.qualityUrl && (await waporAvailable(period.qualityUrl).catch(() => false));
  const qualityUrl = quality ? period.qualityUrl : null;
  const l1 = { ...period, qualityUrl };
  const l2 = waporHasL2(variable) ? await checkedL2(l1) : null;
  const checked = { ...l1, l2 };
  await openWapor(shownPeriod(checked));
  return { period: checked, quality: period.qualityUrl ? (quality ? "ready" : "missing") : null };
}

/** A period's own rasters (not those sampled onto its grid), and its quality raster. */
const ownUrls = (period: WaporPeriod) => [...period.terms.filter((t) => !t.grid).map((t) => t.url), ...(period.qualityUrl ? [period.qualityUrl] : [])];

/** Whether a period's rasters are open, so its layer doesn't open them again (an L2 period's, see map.ts). */
export const waporOpened = (period: WaporPeriod) => ownUrls(period).every((url) => opened.has(url));

/** Open a period's rasters. */
export const openWapor = (period: WaporPeriod) => Promise.all(ownUrls(period).map(openRaster)).then(() => {});

/** An L1 period's L2 one, if it's published (null if not, or the bucket can't be reached: L1 is shown). */
async function checkedL2(l1: WaporPeriod): Promise<WaporPeriod | null> {
  const l2 = await publishedWaporPeriod(l1.variable, l1.range, "L2").catch(() => null);
  if (!l2) return null;
  // Its filled pixels have L1's quality: with both quality rasters, or neither.
  const quality = l1.qualityUrl && l2.qualityUrl && (await waporAvailable(l2.qualityUrl).catch(() => false));
  return { ...l2, qualityUrl: quality ? l2.qualityUrl : null, fill: l1 };
}

/**
 * Recent periods are published with a delay, so check a raster exists before opening
 * it. Rejects on a network error (not cached: tried again next time), so that isn't
 * taken for a raster that doesn't exist.
 */
const exists = new Map<string, Promise<boolean>>();

export function waporAvailable(url: string): Promise<boolean> {
  let check = exists.get(url);
  if (!check) {
    check = fetch(url, { method: "HEAD" }).then((res) => res.ok);
    exists.set(url, check);
    check.catch(() => exists.delete(url));
  }
  return check;
}

/**
 * Opened rasters, by URL: their headers are read once, by whichever needs them first
 * (the map layer or the playback buffer). The least recently used are dropped first.
 */
const MAX_OPEN_RASTERS = 64;
// The bucket speaks HTTP/2, so more than the browser's 6 per host for HTTP/1.1 (the
// library's default): playback loads several frames' tiles at once.
const LIMITER = new PerOriginSemaphore({ maxRequests: 16 });
const rasters = new Map<string, Promise<GeoTIFF>>();
const opened = new Map<string, GeoTIFF>();

function openRaster(url: string): Promise<GeoTIFF> {
  let raster = rasters.get(url);
  if (raster) {
    rasters.delete(url);
  } else {
    raster = GeoTIFF.fromUrl(url, { concurrencyLimiter: LIMITER });
    raster.then((geotiff) => rasters.get(url) === raster && opened.set(url, geotiff), () => rasters.delete(url));
  }
  rasters.set(url, raster);
  for (const old of rasters.keys()) {
    if (rasters.size <= MAX_OPEN_RASTERS) break;
    rasters.delete(old);
    opened.delete(old);
  }
  return raster;
}

/** One tile of one raster, decoded. */
interface RasterTile {
  values: RasterTypedArray;
  width: number;
  height: number;
  nodata: number | null;
  /** Pixel (col, row) to lon/lat: [a, b, c, d, e, f], lon = a·col + b·row + c, lat = d·col + e·row + f. */
  transform: RasterArray["transform"];
}

/**
 * Decoded tiles, by raster and tile (x, y, z), so playback can load them ahead and
 * periods that share a raster share its tiles. The least recently used go first.
 */
const TILE_CACHE_BYTES = 384 * 2 ** 20;
type TileEntry = { tile: Promise<RasterTile>; bytes: number; done: boolean; value?: RasterTile };
const tiles = new Map<string, TileEntry>();
let tileBytes = 0;
const tileListeners = new Set<() => void>();

/** Run `callback` whenever a tile has loaded. Returns a function that stops it. */
export function onWaporTile(callback: () => void) {
  tileListeners.add(callback);
  return () => tileListeners.delete(callback);
}

/** A raster's tiles to read: its own, or sampled onto the grid of the raster `grid`. */
type TileSource = { url: string; grid?: string };

const tileKey = ({ url, grid }: TileSource, { x, y, z }: TileIndex) => `${z}/${x}/${y} ${url}${grid ? ` on ${grid}` : ""}`;

/** Tile (x, y, z) of a raster, or of a term (sampled onto the period's grid if need be). */
function sourceTile(source: TileSource, index: TileIndex, signal?: AbortSignal) {
  return source.grid ? resampledTile(source.url, source.grid, index, signal) : rasterTile(source.url, index, signal);
}

/** A raster's level: z = 0 is its coarsest overview, the last its full resolution. */
function level(geotiff: GeoTIFF, z: number) {
  const images = [geotiff, ...geotiff.overviews]; // full resolution first
  return images[images.length - 1 - z];
}

function rasterTile(url: string, { x, y, z }: TileIndex, signal?: AbortSignal): Promise<RasterTile> {
  return cachedTile(tileKey({ url }, { x, y, z }), signal, async () => {
    const geotiff = await openRaster(url);
    const pool = defaultDecoderPool();
    const { array } = await level(geotiff, z).fetchTile(x, y, { boundless: false, pool, signal });
    return { values: samples(array), width: array.width, height: array.height, nodata: array.nodata, transform: array.transform };
  });
}

/** A level of a raster to sample from: its grid, and its tiles. */
interface SampleSource {
  transform: RasterArray["transform"];
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  tile(x: number, y: number): Promise<RasterTile>;
}

/** The coarsest level of a raster that's still at least as fine as `pixel` (degrees). */
async function levelSource(url: string, pixel: number, signal?: AbortSignal): Promise<SampleSource> {
  const from = await openRaster(url);
  let sz = from.overviews.length; // full resolution
  while (sz > 0 && Math.abs(level(from, sz - 1).transform[0]) <= pixel) sz--;
  const { transform, width, height, tileWidth, tileHeight } = level(from, sz);
  return { transform, width, height, tileWidth, tileHeight, tile: (x, y) => rasterTile(url, { x, y, z: sz }, signal) };
}

/**
 * A raster's full resolution, read with the Local panel's lean reader (cog-pixel.ts):
 * its first IFD and a tile, instead of every overview's tags as well, which are most
 * of the bytes of a few tiles' worth of sampling.
 */
async function fullSource(url: string, signal?: AbortSignal): Promise<SampleSource> {
  const image = await cogImage(url, signal);
  if (!image) throw new Error(`No such raster: ${url}`);
  const { transform, width, height, tileWidth, tileHeight, nodata } = image;
  const tile = (x: number, y: number) =>
    cachedTile(`full/${x}/${y} ${url}`, signal, async () => ({
      values: await cogTile(url, x, y, signal),
      width: tileWidth,
      height: tileHeight,
      nodata,
      transform: [transform[0], 0, transform[2] + transform[0] * x * tileWidth, 0, transform[4], transform[5] + transform[4] * y * tileHeight],
    }));
  return { transform, width, height, tileWidth, tileHeight, tile };
}

/**
 * Tile (x, y, z) of the raster `grid`, with the raster `url` sampled onto its pixels:
 * the value of the pixel each one's centre falls in (both are lon/lat grids). It's read
 * from the coarsest level of `url` that's still at least as fine as the tile: at the
 * grid's full resolution that's `url`'s own (nothing is sampled onto a coarser grid),
 * read leanly. The values stay raw; NaN where `url` has none (e.g. PCP beyond 60° N and S).
 */
function resampledTile(url: string, grid: string, { x, y, z }: TileIndex, signal?: AbortSignal): Promise<RasterTile> {
  return cachedTile(tileKey({ url, grid }, { x, y, z }), signal, async () => {
    const onto = await openRaster(grid);
    const target = level(onto, z);
    const [a, , c, , e, f] = target.transform;
    const [col0, row0] = [x * target.tileWidth, y * target.tileHeight];
    const width = Math.min(target.tileWidth, target.width - col0);
    const height = Math.min(target.tileHeight, target.height - row0);

    const source = z === onto.overviews.length ? await fullSource(url, signal) : await levelSource(url, Math.abs(a), signal);
    const [sa, , sc, , se, sf] = source.transform;
    const { tileWidth: tw, tileHeight: th } = source;
    // The source's column of each column of the tile, and row of each row (-1: outside it).
    const inside = (n: number, size: number, at: (i: number) => number) =>
      Int32Array.from({ length: n }, (_, i) => {
        const k = Math.floor(at(i));
        return k >= 0 && k < size ? k : -1;
      });
    const cols = inside(width, source.width, (i) => (c + a * (col0 + i + 0.5) - sc) / sa);
    const rows = inside(height, source.height, (j) => (f + e * (row0 + j + 0.5) - sf) / se);
    // The source's tiles under it: they run the same way as the tile's pixels.
    const span = (ks: Int32Array, size: number) => {
      const valid = ks.filter((k) => k >= 0);
      return valid.length ? [Math.floor(valid[0] / size), Math.floor(valid[valid.length - 1] / size)] : null;
    };
    const [xs, ys] = [span(cols, tw), span(rows, th)];

    const values = new Float32Array(width * height).fill(Number.NaN);
    if (xs && ys) {
      const under: RasterTile[][] = await Promise.all(
        Array.from({ length: ys[1] - ys[0] + 1 }, (_, j) =>
          Promise.all(Array.from({ length: xs[1] - xs[0] + 1 }, (_, i) => source.tile(xs[0] + i, ys[0] + j))),
        ),
      );
      for (let j = 0; j < height; j++) {
        const r = rows[j];
        if (r < 0) continue;
        const row = under[Math.floor(r / th) - ys[0]];
        for (let i = 0; i < width; i++) {
          const k = cols[i];
          if (k < 0) continue;
          const tile = row[Math.floor(k / tw) - xs[0]];
          const v = tile.values[(r % th) * tile.width + (k % tw)];
          if (v !== tile.nodata) values[j * width + i] = v;
        }
      }
    }
    const transform: RasterArray["transform"] = [a, 0, c + a * col0, 0, e, f + e * row0];
    return { values, width, height, nodata: null, transform };
  });
}

/**
 * A tile from the cache, or loaded into it. If it failed because another reader gave
 * up on it (its tile left the view), it's loaded again.
 */
function cachedTile(key: string, signal: AbortSignal | undefined, load: () => Promise<RasterTile>): Promise<RasterTile> {
  const hit = tiles.get(key);
  if (hit) {
    tiles.delete(key);
    tiles.set(key, hit);
    return hit.tile.catch((err) => {
      if (signal?.aborted) throw err;
      return cachedTile(key, signal, load);
    });
  }
  const tile = load();
  const entry: TileEntry = { tile, bytes: 0, done: false };
  tiles.set(key, entry);
  tile.then(
    (value) => {
      if (tiles.get(key) !== entry) return;
      Object.assign(entry, { bytes: value.values.byteLength, done: true, value });
      tileListeners.forEach((listener) => listener());
      tileBytes += entry.bytes;
      for (const [old, { bytes, done }] of tiles) {
        if (tileBytes <= TILE_CACHE_BYTES) break;
        if (!done) continue;
        tiles.delete(old);
        tileBytes -= bytes;
      }
    },
    () => tiles.get(key) === entry && tiles.delete(key),
  );
  return tile;
}

type TileIndex = { x: number; y: number; z: number };

/** A period's value in one tile (see combineTiles), and its quality band if it has one. */
interface PeriodTile {
  values: Float32Array;
  quality: RasterTypedArray | null;
  width: number;
  height: number;
  transform: RasterArray["transform"];
}

/** A raster's tile, if it's loaded. */
type GetTile = (source: TileSource) => RasterTile | undefined;

/** An L2 period's term on its own grid (not sampled onto it): where it has no data, L2 has none. */
const gridTerm = (period: WaporPeriod) => period.terms.find((t) => !t.grid)!;

/**
 * The rasters' tiles a period's tile is made from (with its quality raster's, if
 * `quality`), as far as they can be known from those loaded: an L2 period's L1 tiles,
 * sampled onto its grid, only once its own show pixels without data.
 */
function tileSources(period: WaporPeriod, quality: boolean, get: GetTile): TileSource[] {
  const sources: TileSource[] = [...period.terms, ...(quality && period.qualityUrl ? [{ url: period.qualityUrl }] : [])];
  const { fill } = period;
  if (!fill) return sources;
  const grid = get(gridTerm(period));
  if (!grid || grid.nodata === null || !grid.values.includes(grid.nodata)) return sources;
  const onGrid = (url: string) => ({ url, grid: gridTerm(period).url });
  return [...sources, ...fill.terms.map((t) => onGrid(t.url)), ...(quality && fill.qualityUrl ? [onGrid(fill.qualityUrl)] : [])];
}

/** Whether every tile a period's tile is made from is loaded. */
const loadedTile = (period: WaporPeriod, quality: boolean, get: GetTile) => tileSources(period, quality, get).every((source) => get(source));

/**
 * A period's tile, from its rasters' tiles (every one in tileSources loaded). At L2,
 * the pixels without data are L1's, quality too (none: 255, as no quality value).
 */
function assemble(period: WaporPeriod, quality: boolean, get: GetTile): PeriodTile {
  const rasters = period.terms.map((t) => get(t)!);
  const values = combineTiles(period, rasters);
  const { width, height, transform } = rasters[0];
  let qualities = quality && period.qualityUrl ? get({ url: period.qualityUrl })!.values : null;
  const { fill } = period;
  const grid = fill && get(gridTerm(period))!;
  if (fill && grid && grid.nodata !== null && grid.values.includes(grid.nodata)) {
    const onGrid = (url: string) => get({ url, grid: gridTerm(period).url })!;
    const filled = combineTiles(fill, fill.terms.map((t) => onGrid(t.url)));
    const filledQuality = qualities && fill.qualityUrl ? onGrid(fill.qualityUrl).values : null;
    if (filledQuality) qualities = Uint8Array.from(qualities!); // (not the cached tile's)
    for (let p = 0; p < values.length; p++) {
      if (grid.values[p] !== grid.nodata) continue;
      values[p] = filled[p];
      if (filledQuality) qualities![p] = filledQuality[p] === filledQuality[p] ? filledQuality[p] : 255;
    }
  }
  return { values, quality: qualities, width, height, transform };
}

/** Load the rasters' tiles a period's tile (x, y, z) is made from. Resolves to them. */
async function loadSources(period: WaporPeriod, index: TileIndex, quality: boolean, signal?: AbortSignal): Promise<GetTile> {
  // (Kept here too: the cache may let go of one before the last is in.)
  const loaded = new Map<string, RasterTile>();
  const get: GetTile = (source) => loaded.get(tileKey(source, index)) ?? tiles.get(tileKey(source, index))?.value;
  for (;;) {
    const missing = tileSources(period, quality, get).filter((source) => !get(source));
    if (!missing.length) return get;
    const values = await Promise.all(missing.map((source) => sourceTile(source, index, signal)));
    missing.forEach((source, i) => loaded.set(tileKey(source, index), values[i]));
  }
}

/** A raster's tile from the cache, if it's loaded. */
const cachedAt = (index: TileIndex): GetTile => (source) => tiles.get(tileKey(source, index))?.value;

/**
 * The tiles the map shows at each level (the same for every period of a variable at
 * a level: they share one grid), the level the view asks for, and the part of the
 * globe in view.
 */
const viewTiles: Record<WaporLevel, TileIndex[]> = { L1: [], L2: [] };
let viewLevel: WaporLevel = "L1";
let viewBox: Box | null = null;
let viewKey = "";
const viewListeners = new Set<() => void>();
const levelListeners = new Set<(level: WaporLevel) => void>();

/** Run `callback` whenever the map shows other tiles (the view moved). Returns a function that stops it. */
export function onWaporView(callback: () => void) {
  viewListeners.add(callback);
  return () => viewListeners.delete(callback);
}

/**
 * Run `callback` whenever the view asks for the other level (see CSS_PX_PER_RASTER_PX).
 * It runs while deck.gl picks tiles: don't update layers from it straight away.
 */
export function onWaporLevel(callback: (level: WaporLevel) => void) {
  levelListeners.add(callback);
  return () => levelListeners.delete(callback);
}

/** The level the view asks for: L2 where L1 is too coarse, if the view reaches L2's countries. */
export const waporViewLevel = () => viewLevel;

/** The level a period is shown at in the current view (L1 if it has no L2). */
export const waporShownLevel = (period: WaporPeriod): WaporLevel => (viewLevel === "L2" && period.l2 ? "L2" : "L1");

const shownPeriod = (period: WaporPeriod) => (waporShownLevel(period) === "L2" ? period.l2! : period);

function setView(level: WaporLevel, indices: TileIndex[], wanted: WaporLevel) {
  viewTiles[level] = indices;
  if (wanted === "L1") viewTiles.L2 = []; // (no L2 layer to pick them)
  const levelChanged = wanted !== viewLevel;
  viewLevel = wanted;
  const key = (["L1", "L2"] as const).map((l) => viewTiles[l].map(({ x, y, z }) => `${z}/${x}/${y}`).join()).join(" ");
  if (levelChanged) levelListeners.forEach((listener) => listener(wanted));
  if (`${viewLevel} ${key}` === viewKey) return;
  viewKey = `${viewLevel} ${key}`;
  viewListeners.forEach((listener) => listener());
}

/** Whether every tile the map shows has been loaded for this period. */
export function waporBuffered(period: WaporPeriod) {
  const shown = shownPeriod(period);
  return viewTiles[shown.level].every((index) => loadedTile(shown, true, cachedAt(index)));
}

/**
 * Load the tiles the map shows for a period, ahead of showing it. A tile that fails
 * is left out (the map would fail on it too); rejects only when `signal` aborts.
 */
export async function bufferWapor(period: WaporPeriod, signal: AbortSignal) {
  const shown = shownPeriod(period);
  await Promise.all(
    viewTiles[shown.level].map((index) =>
      loadSources(shown, index, true, signal).catch((err) => {
        if (signal.aborted) throw err;
      }),
    ),
  );
  signal.throwIfAborted();
}

/**
 * Which overview to show: the coarsest whose pixels are at most this many CSS pixels on
 * screen, at the centre of the view. At 2, the raster is magnified up to 2× (4× in
 * device pixels on a retina screen), and the full 300 m only loads from about zoom 8.
 */
const CSS_PX_PER_RASTER_PX = 2;

/** An L1 pixel is this many L2 pixels across. */
const L1_PER_L2 = 3;

/**
 * L2 is shown once its full 100 m would be picked, i.e. its first overview (200 m) is
 * magnified more than CSS_PX_PER_RASTER_PX. That overview isn't worth reading: it's
 * 2.25 times L1's pixels for 1.5 times the detail. Until then L1's 300 m is magnified
 * up to 1.5 times more than usual.
 */
const L2_FROM = 2 / L1_PER_L2; // L1's pixel size, times this, is L2's first overview's

/** Great-circle distance in metres. */
function metersBetween([lon1, lat1]: number[], [lon2, lat2]: number[]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

interface Box {
  west: number; // may be below -180 or east above 180: longitudes run on around the view
  east: number;
  south: number;
  north: number;
}

/**
 * The part of the globe in view, as a lon/lat box, from a grid of screen points. Where
 * a row or column of the grid crosses the globe's edge, the edge is found by bisection,
 * as the parts near it span many degrees on very few pixels.
 */
function visibleBox(viewport: Viewport): Box | null {
  const { width, height } = viewport;
  const longitude = viewport.unproject([width / 2, height / 2])[0];
  // Off the globe, unproject gives the nearest point on the horizon instead; that
  // point doesn't project back onto the same pixel.
  const onGlobe = (x: number, y: number) => {
    const lngLat = viewport.unproject([x, y]);
    const [px, py] = viewport.project(lngLat);
    return Math.hypot(px - x, py - y) < 1 ? lngLat : null;
  };
  const box: Box = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  const add = ([lon, lat]: number[]) => {
    const l = longitude + ((((lon - longitude) % 360) + 540) % 360) - 180; // unwrapped around the view
    box.west = Math.min(box.west, l);
    box.east = Math.max(box.east, l);
    box.south = Math.min(box.south, lat);
    box.north = Math.max(box.north, lat);
  };
  const N = 16;
  const line = (at: (t: number) => [number, number]) => {
    let prev: { t: number; hit: boolean } | null = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const hit = onGlobe(...at(t));
      if (hit) add(hit);
      if (prev && prev.hit !== !!hit) {
        // Bisect for the edge between the two samples.
        let [a, b] = prev.hit ? [prev.t, t] : [t, prev.t]; // a on the globe, b off it
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2;
          if (onGlobe(...at(m))) a = m;
          else b = m;
        }
        add(onGlobe(...at(a))!);
      }
      prev = { t, hit: !!hit };
    }
  };
  for (let i = 0; i <= N; i++) {
    line((t) => [t * width, (i / N) * height]);
    line((t) => [(i / N) * width, t * height]);
  }
  if (box.west > box.east) return null;
  // A pole in view: every longitude is.
  for (const lat of [90, -90]) {
    const [x, y] = viewport.project([longitude, lat]);
    const near = x >= 0 && x <= width && y >= 0 && y <= height && onGlobe(x, y);
    if (near && Math.abs(near[1]) > 89) {
      Object.assign(box, { west: longitude - 180, east: longitude + 180 });
      if (lat > 0) box.north = 90;
      else box.south = -90;
    }
  }
  return box;
}

type Level = {
  metersPerPixel: number;
  matrixWidth: number;
  matrixHeight: number;
  projectedTileCorners(col: number, row: number): { topLeft: [number, number]; bottomRight: [number, number] };
};

/**
 * MultiCOGLayer with its own choice of tiles: one overview for the whole view (see
 * CSS_PX_PER_RASTER_PX), and only the tiles on the visible part of the globe.
 *
 * deck.gl-raster picks a level per tile, from the Web Mercator scale at the tile's
 * latitude. On a globe that asks for ever finer tiles towards the poles, and it doesn't
 * leave out the far side of the globe: at zoom 9 it picked over 16,000 tiles.
 */
class GlobeMultiCOGLayer extends MultiCOGLayer {
  static layerName = "GlobeMultiCOGLayer";

  /**
   * One tile: the period's rasters added up into one band, "aeti" (as float32), next
   * to the quality band if there is one. A variable's rasters (and the quality raster
   * of a 300 m one) share one grid, so tile (x, y, z) covers the same pixels in each;
   * a part on another grid is sampled onto it (see sumTiles and resampledTile), and so
   * is L1 where L2 has no data (see assemble).
   */
  async _getTileData(...[tile, options]: Parameters<MultiCOGLayer["_getTileData"]>) {
    const { x, y, z } = tile.index;
    const { multiDescriptor } = this.state;
    const { device, signal } = options;
    const { period } = this.props as unknown as { period: WaporPeriod };

    const get = await loadSources(period, { x, y, z }, true, signal);
    const { values, quality, width, height } = assemble(period, true, get);
    const bands = new Map([["aeti", band(device, values, "r32float", width, height)]]);
    if (quality) bands.set("quality", band(device, quality, "r8unorm", width, height));
    const { forwardTransform, inverseTransform } = multiDescriptor!.primary.levels[z].tileTransform(x, y);
    const byteLength = values.byteLength + (quality?.byteLength ?? 0);
    return { bands, forwardTransform, inverseTransform, width, height, byteLength };
  }

  renderLayers() {
    // The inner TileLayer's tileset picks the tiles. deck.gl builds it once, from the
    // first class it's given, so the subclass holds no per-render state; the period
    // stays the same for a layer's id (see map.ts).
    const layer = super.renderLayers() as TileLayer | null;
    if (!layer) return null;
    const Tileset = layer.props.TilesetClass;
    const { period } = this.props as unknown as { period: WaporPeriod };
    class GlobeTileset extends Tileset {
      getTileIndices({ viewport }: { viewport: Viewport }) {
        // Levels run from the coarsest (z = 0) to full resolution (the last); the
        // descriptor is private in the typings.
        const { levels } = (this as unknown as { descriptor: { levels: Level[] } }).descriptor;
        const last = levels.length - 1;
        const box = visibleBox(viewport);
        viewBox = box;
        const { width, height } = viewport;
        const a = viewport.unproject([width / 2 - 5, height / 2]);
        const b = viewport.unproject([width / 2 + 5, height / 2]);
        if (!box) {
          setView(period.level, [], viewLevel);
          return [];
        }

        const metersPerCssPixel = metersBetween(a, b) / 10;
        let z = 0;
        while (z < last && levels[z].metersPerPixel > CSS_PX_PER_RASTER_PX * metersPerCssPixel) z++;
        // L2 once its full resolution is due (see L2_FROM), if the view reaches its countries.
        const l1Meters = levels[last].metersPerPixel * (period.level === "L2" ? L1_PER_L2 : 1);
        const due = l1Meters * L2_FROM > CSS_PX_PER_RASTER_PX * metersPerCssPixel;
        const wanted = due && boxInL2(box.west, box.south, box.east, box.north) ? "L2" : "L1";

        // A lon/lat grid: every tile spans the same degrees, from the top left one's
        // corner (not every variable's grid reaches the poles).
        const level = levels[z];
        const { matrixWidth, matrixHeight } = level;
        const { topLeft: [west, north], bottomRight: [east, south] } = level.projectedTileCorners(0, 0);
        const [degX, degY] = [east - west, north - south];
        const around = Math.round(360 / degX); // tiles around the globe, if the grid went all the way
        const x0 = Math.floor((box.west - west) / degX);
        const x1 = Math.min(Math.floor((box.east - west) / degX), x0 + around - 1);
        const y0 = Math.max(0, Math.floor((north - box.north) / degY));
        const y1 = Math.min(matrixHeight - 1, Math.floor((north - box.south) / degY));
        const indices = [];
        for (let x = x0; x <= x1; x++) {
          const col = ((x % around) + around) % around;
          if (col < matrixWidth) for (let y = y0; y <= y1; y++) indices.push({ x: col, y, z });
        }
        setView(period.level, indices, wanted);

        // At the other level than the one shown: none, but an L1 layer keeps those it
        // has loaded, to show until L2's are in (see map.ts).
        const shown = period.level === "L2" ? wanted === "L2" : wanted === "L1" || !period.l2;
        if (!shown) return period.level === "L1" ? indices.filter((index) => loadedTile(period, true, cachedAt(index))) : [];
        return indices;
      }
    }
    return layer.clone({ TilesetClass: GlobeTileset });
  }
}

/**
 * A MultiCOGLayer source: a raster in the sum (t0, t1, …) on the period's grid, or the
 * quality raster; the layer builds its tile grid from them. Once opened, the layer gets
 * the raster itself as `url`, so it doesn't read the header again.
 */
type WaporSource = { url: string | GeoTIFF };

/**
 * A period's value in a tile, from its terms' tiles: their sum, or for a ratio the sum
 * of the first part's over the sum of the second's (none where that's below `ratioMin`,
 * or not above 0). The parts' sums are averages per day.
 */
function combineTiles(period: WaporPeriod, rasters: RasterTile[]) {
  const { terms, variable } = period;
  if (!variable.ratio) return sumTiles(rasters, terms.map((t) => t.factor), variable.signed);
  const sumOf = (part: number) => {
    const i = terms.flatMap((t, k) => (t.part === part ? [k] : []));
    return sumTiles(i.map((k) => rasters[k]), i.map((k) => terms[k].factor));
  };
  const [num, den] = [sumOf(0), sumOf(1)];
  const least = variable.ratioMin ?? 0;
  for (let p = 0; p < num.length; p++) num[p] = den[p] > 0 && den[p] >= least ? (variable.scale * num[p]) / den[p] : Number.NaN;
  return num;
}

/**
 * Rasters' tiles added up, each times its factor. A pixel without data in any of them
 * has none in the sum (NaN). Rounding can take a difference just below zero; that's 0,
 * unless the variable is `signed`.
 */
function sumTiles(rasters: RasterTile[], factors: number[], signed = false) {
  const { width, height } = rasters[0];
  const sum = new Float32Array(width * height);
  rasters.forEach(({ values, nodata }, i) => {
    const factor = factors[i];
    for (let p = 0; p < sum.length; p++) {
      const v = values[p];
      sum[p] = v === nodata ? Number.NaN : sum[p] + factor * v; // NaN stays NaN
    }
  });
  if (!signed && factors.some((f) => f < 0)) {
    for (let p = 0; p < sum.length; p++) if (sum[p] < 0) sum[p] = 0;
  }
  return sum;
}

/** How much of the values in view the colour map spans: all, or without this % at either end. */
export type WaporStretch = 0 | 1 | 5;

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

/** At most this many of the values in view are sorted for the percentiles (evenly spread). */
const SAMPLE = 2 ** 18;

/**
 * The range of a period's values on screen, without `cut`% of the pixels at either
 * end: the pixels with data in the part of the globe in view, of the tiles in view
 * that have loaded, without those the quality filter hides (`maxGap`, as in
 * waporLayer). Null if there are none (yet). Percentiles come from a sorted sample of
 * the values (every so many), so a few extreme ones (a ratio over almost nothing) don't
 * skew them, as they would bins of the range.
 */
export function waporViewRange(period: WaporPeriod, maxGap: number | null, cut: WaporStretch): [number, number] | null {
  const box = viewBox;
  if (!box) return null;
  const centre = (box.west + box.east) / 2;
  const unwrap = (lon: number) => centre + ((((lon - centre) % 360) + 540) % 360) - 180;
  const drawn = shownPeriod(period);
  const { signed } = period.variable;
  const filter = maxGap !== null;

  // The values in view, tile by tile (NaN: none, or hidden).
  const chunks: Float32Array[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const index of viewTiles[drawn.level]) {
    const get = cachedAt(index);
    if (!loadedTile(drawn, filter, get)) continue;
    const { values: sum, quality, width, height, transform: [a, , c, , e, f] } = assemble(drawn, filter, get);
    // Columns and rows inside the box, by their pixel centres (the grid is lon/lat).
    const cols = Array.from({ length: width }, (_, i) => {
      const lon = unwrap(a * (i + 0.5) + c);
      return lon >= box.west && lon <= box.east;
    });
    for (let row = 0; row < height; row++) {
      const lat = e * (row + 0.5) + f;
      const inRow = lat >= box.south && lat <= box.north;
      for (let col = 0; col < width; col++) {
        const p = row * width + col;
        // As in the shader: no negative values (unless signed), and no quality value (255) is hidden too.
        const shown = signed ? sum[p] === sum[p] : sum[p] >= 0;
        if (!inRow || !cols[col] || !shown || (quality && quality[p] > maxGap!)) {
          sum[p] = Number.NaN;
          continue;
        }
        if (sum[p] < min) min = sum[p];
        if (sum[p] > max) max = sum[p];
      }
    }
    chunks.push(sum);
  }
  if (!(max >= min)) return null;
  if (cut === 0 || max === min) return [min, max];

  let total = 0;
  for (const sum of chunks) for (const v of sum) if (v === v) total++; // (not NaN)
  const every = Math.max(1, Math.ceil(total / SAMPLE));
  const sample = new Float32Array(Math.ceil(total / every));
  let n = 0;
  let k = 0;
  for (const sum of chunks) {
    for (const v of sum) {
      if (v !== v) continue;
      if (k++ % every === 0) sample[n++] = v;
    }
  }
  const sorted = sample.subarray(0, n).sort();
  /** The value below which `share` of the pixels lie. */
  const quantile = (share: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(share * (n - 1))))];
  return [quantile(cut / 100), quantile(1 - cut / 100)];
}

/** The samples of a one-band tile, in either layout. */
const samples = (array: RasterArray) => (array.layout === "band-separate" ? array.bands[0] : array.data);

function band(device: Texture["device"], data: RasterTypedArray, format: "r32float" | "r8unorm", width: number, height: number) {
  const texture = device.createTexture({ data, format, width, height, sampler: { minFilter: "nearest", magFilter: "nearest" } });
  return { texture, uvTransform: [0, 0, 1, 1] as [number, number, number, number], width, height, byteLength: data.byteLength };
}

// MultiCOGLayer opens its rasters again whenever it gets a new `sources` object. While
// playing, the map has two periods' layers: the one shown and the next.
const sourcesByKey = new Map<string, Record<string, WaporSource>>();

/**
 * The period's raster (or sum of rasters), coloured with `ramp`; nothing where
 * it has no data. With the period's quality raster, pixels with a gap longer than
 * `maxGap` dekads are left out too (null: none). No layer without a period: a hidden
 * MultiCOGLayer would still open its sources.
 */
export function waporLayer({
  period,
  ramp,
  maxGap = null,
  onLoad,
  id = "wapor-aeti",
  hidden = false,
  opacity = 1,
  onViewportLoad,
}: {
  period: WaporPeriod | null;
  ramp: WaporRamp;
  maxGap?: number | null;
  onLoad?: () => void;
  id?: string;
  /** Loads its tiles, but doesn't draw them (the next period while playing). */
  hidden?: boolean;
  /** How opaque it's drawn (fading in over the period before, see map.ts). */
  opacity?: number;
  /** Runs when every tile in view has loaded. */
  onViewportLoad?: () => void;
}) {
  if (!period) return null;
  const key = `${period.key} ${period.qualityUrl}`;
  let sources = sourcesByKey.get(key);
  if (!sources) {
    const source = (url: string) => ({ url: opened.get(url) ?? url });
    sources = {};
    period.terms.forEach(({ url, grid }, i) => grid || (sources![`t${i}`] = source(url)));
    if (period.qualityUrl) sources.quality = source(period.qualityUrl);
    sourcesByKey.set(key, sources);
    for (const old of sourcesByKey.keys()) if (sourcesByKey.size > 4) sourcesByKey.delete(old);
  }
  return new GlobeMultiCOGLayer({
    id,
    visible: !hidden,
    opacity,
    sources: sources as Record<string, { url: string }>,
    concurrencyLimiter: LIMITER,
    composite: period.qualityUrl ? { r: "aeti", g: "quality" } : { r: "aeti" },
    // A new ramp or maxGap only re-renders the loaded tiles.
    renderPipeline: [{ module: AetiRamp, props: rampProps(ramp, maxGap, period.variable.signed) }],
    // Linear filtering would blend values with the -9999 nodata at coasts.
    resampling: "nearest",
    parameters: { depthCompare: "always" },
    onGeoTIFFLoad: onLoad,
    // (Passed on to the TileLayer, though MultiCOGLayer's typings leave it out; `period`
    // for _getTileData.)
    ...({ onViewportLoad, period } as object),
  });
}
