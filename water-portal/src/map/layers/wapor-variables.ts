/*
 * The WaPOR variables: what the map can show (WAPOR_VARIABLES), their colours, units
 * and where their rasters are. The catalogue, with no raster read: the panels and
 * legends import this, not the raster code (wapor.ts, which says what WaPOR is).
 */
import { block, blockName, type Block, type BlockKind } from "./wapor-plan";
import { type WaporRamp } from "./wapor-shader";

export const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";

/** WaPOR's level 1 (global, 300 m) or 2 (some countries, 100 m). */
export type WaporLevel = "L1" | "L2";

export const qualityOf = (level: WaporLevel) => `${level}-QUAL-NDVI-D`;

export type WaporResolution = "dekadal" | "monthly" | "annual" | "custom";

export const RESOLUTIONS: Record<BlockKind, WaporResolution> = { D: "dekadal", M: "monthly", A: "annual" };

/** GAEZ: a static map from GAEZ v5, drawn the same way (see gaez.ts). */
export type WaporVariableId = "AETI" | "RET" | "T" | "E" | "I" | "PCP" | "NPP" | "PCP-AETI" | "WP" | "T-AETI" | "GAEZ";

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
  /**
   * Kinds read from another variable's mapset (L1-<id>-<kind>), times `scale` instead of
   * this one's: NPP's years are total biomass production's (see WAPOR_VARIABLES).
   */
  from?: Partial<Record<BlockKind, { id: string; scale: number }>>;
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
  /** 0 is no data (a share of land cover where there's none). */
  zeroEmpty?: boolean;
  /**
   * Its rasters are areas per pixel, in ha: shown as % of the pixel's area. This is the
   * full-resolution pixel's size in degrees, as an overview's pixels are the average of
   * the full-resolution pixels under them (not their sum).
   */
  perArea?: number;
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
  // TBP-A's (kg DM/ha) as NPP: × 0.045 gC/m² (see NPP in WAPOR_VARIABLES).
  NPP_A: {
    quantities: [0, 1000, 3000, 6000, 9000, 12000, 15000, 18000, 21000].map((q) => q * 0.045),
    colors: ["#f7fcf5", "#e5f5e0", "#c9e9c2", "#a5da9f", "#7ac77b", "#4aaf61", "#29924a", "#077331", "#00441b"],
  },
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
    // WaPOR has no annual NPP, but its annual total biomass production (L1-TBP-A, kg
    // DM/ha) is the year's NPP converted: × 10 (gC/m² → kg/ha) / 0.45 (carbon in dry
    // matter). So the year's NPP (gC/m²) = TBP × 0.045, to within TBP's rounding to whole
    // kg/ha (checked against the sum of NPP-M at four points, 2023: TBP / NPP = 22.2217).
    kinds: ["D", "M", "A"],
    from: { A: { id: "TBP", scale: 0.045 } },
    l2: true,
    quality: true,
    ramp: { quantities: [0, 1, 2, 3, 4], colors: ["#ffffcc", "#d9f0a3", "#78c679", "#238443", "#004529"] },
    styles: { D: STYLES.NPP, M: STYLES.NPP_M, A: STYLES.NPP_A },
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
export const levelOf = (variable: WaporVariable, level: WaporLevel): WaporLevel => (variable.l2 ? level : "L1");

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
  // (A ratio has no total: its own units, then.)
  return (
    all.find((u) => u.per === units.per && u.pixel === units.pixel) ??
    all.find((u) => u.per === (units.per === "total" ? "total" : "day")) ??
    all[0]
  );
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

export const mapsetOf = (variable: WaporVariable, kind: BlockKind, level: WaporLevel = "L1") =>
  `${levelOf(variable, level)}-${variable.from?.[kind]?.id ?? variable.id}-${kind}`;
/** Physical value = raw * this, for a variable's rasters of a kind. */
export const scaleOf = (variable: WaporVariable, kind: BlockKind) => variable.from?.[kind]?.scale ?? variable.scale;
/** A raster in an equation: "M[2025-01]", or from another variable's mapset "TBP[2025]×0.045". */
export const termName = (variable: WaporVariable, b: Block) => {
  const from = variable.from?.[b.kind];
  return from ? `${from.id}[${b.code}]×${from.scale}` : blockName(b);
};
export const rasterUrl = (mapset: string, code: string) => `${BUCKET}/${mapset}/WAPOR-3.${mapset}.${code}.tif`;

/** A variable's raster for one dekad (of a variable with rasters of its own), at a level (L1 if it has no L2). */
export const waporDekadUrl = (variable: WaporVariable, dk: number, level: WaporLevel = "L1") =>
  rasterUrl(mapsetOf(variable, "D", level), block("D", dk).code);

/** How much of the values in view the colour map spans: all, or without this % at either end. */
export type WaporStretch = 0 | 1 | 5;

