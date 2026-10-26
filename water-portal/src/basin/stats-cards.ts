/*
 * What the Basin panel shows, per topic, as the Country panel does (country/cards.ts):
 * number tiles at the top and chart cards below them, each with the map that goes with
 * it (the map shows it while the pointer is over it, or after a click pins it).
 *
 * Every chart works with and without a major basin selected, as the Country view's do
 * with and without a country: groups of major basins (groups.ts) stand in for the
 * Country view's regions, by climate for precipitation and evapotranspiration, by
 * where the water goes for discharge and storage (each measure's GROUPING; PCP − AETI
 * has both); the selected basin gets a row of its own on top, and the trends compare
 * it with its group and the World. With a basin selected, its sub-basins have a card of
 * their own, and the maps of the tiles show them.
 *
 * Everything is over the date range in the top bar, and compared with the same days in
 * the other years of the record (sameDays): for ranges of a year or more, moved by
 * whole multiples of their length, so the ranges don't overlap. Below MIN_OTHERS such
 * years there is no average to compare with.
 *
 * The variables: precipitation (PCP), actual evapotranspiration (AETI), the share of
 * PCP that evaporates (AETI/PCP), PCP − AETI, all from WaPOR v3 L1 (stats-data.ts), in
 * the units picked in the legend (per day, month or year, or the total over the period;
 * per m² (mm) or over the basin (km³)); and the model's discharge (Q, at the outlets)
 * and storage change (ΔS), precomputed (model.ts), in m³/s.
 */
import { bars, lines, type BarRow, type LineSeries } from "../country/charts";
import { perDays, waporVariable, type WaporPer } from "../map/layers/wapor";
import { MONTHS, MIN_YEAR, dkM, dkY, startDay, endDay } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import { GROUPINGS, climateYears, groupById, groupOf, groupsOf, inGroup, type Grouping } from "./groups";
import type { Flux, FluxSeries } from "./model";
import type { Monthly, PeriodStats, WindowRates } from "./stats-data";
import { STYLES } from "./variables";

// --- Context ------------------------------------------------------------------------------

export type FluxStatus = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; result: FluxSeries };


/** The range and the same days in the other years of the record. */
export interface SameDays {
  ranges: DekadRange[];
  /** The index of the range itself. */
  current: number;
  /** The record they are taken from. */
  first: number;
  last: number;
}

/** Fewer other years than this: no average to compare with. */
export const MIN_OTHERS = 3;

/**
 * `range` and the same days in other years within [first, last]: moved by whole years,
 * or for a range of more than a year by whole multiples of its length in years.
 */
export function sameDays(range: DekadRange, first: number, last: number): SameDays {
  const step = 36 * Math.ceil((range.end - range.start + 1) / 36);
  const ranges: DekadRange[] = [];
  let current = 0;
  for (let k = -Math.floor((range.start - first) / step); range.end + k * step <= last; k++) {
    const r = { start: range.start + k * step, end: range.end + k * step };
    if (r.start < first) continue;
    if (k === 0) current = ranges.length;
    ranges.push(r);
  }
  return { ranges, current, first, last };
}

/** A range by its year(s): "2021", "2021/22" (across new year), "2018–2020". */
export function windowLabel(r: DekadRange) {
  const [y0, y1] = [dkY(r.start), dkY(r.end)];
  if (y0 === y1) return String(y0);
  return r.end - r.start < 36 ? `${y0}/${String(y1).slice(2)}` : `${y0}–${y1}`;
}

/** How many years the ranges are apart: 1, or for a range of more than a year, more. */
const spanYears = (c: BasinCtx) => Math.ceil((c.covered.end - c.covered.start + 1) / 36);

export interface BasinCtx {
  /** "1 Jan 2025 – 31 Oct 2025": the covered range. */
  period: string;
  covered: DekadRange;
  /** Days in the covered range. */
  days: number;
  stats: PeriodStats;
  windows: SameDays;
  /** PCP and AETI in the other years (null: loading; see ratesError). */
  rates: WindowRates | null;
  ratesError: string | null;
  /** The model's output: per major basin, and per sub-basin of the selected one. */
  flux: { majors: FluxStatus; sub: FluxStatus | null };
  monthly: Monthly | null;
  major: { id: number; name: string } | null;
  /** Every major basin. */
  majors: number[];
  majorName(id: number): string;
  subName(id: number): string;
  width: number;
  units: BasinUnits;
  /** Values computed for this context, by measure, area and range. */
  cache: Map<string, number>;
}

/**
 * The units values are shown in. Per: the data are per day, a month counts as 30 days
 * and a year as 365; "total" is the sum over the period. Over the basin (`basin`):
 * times its area, km³ instead of mm.
 */
export interface BasinUnits {
  per: WaporPer;
  basin: boolean;
}
/** In the order of the legend's unit menu. */
export const BASIN_UNITS: BasinUnits[] = [false, true].flatMap((basin) =>
  (["day", "month", "year", "total"] as WaporPer[]).map((per) => ({ per, basin })),
);
/** "mm/month", "mm" in total, "km³/month" over the basin. */
export const basinUnit = ({ per, basin }: BasinUnits) => `${basin ? "km³" : "mm"}${per === "total" ? "" : `/${per}`}`;
/** For the unit menu's tooltip, as the WaPOR legend's: "per month (30 days), over the basin". */
export const describeBasinUnits = ({ per, basin }: BasinUnits) =>
  (per === "total" ? "in total over the period" : per === "day" ? "per day" : `per ${per} (${perDays(per, 0)} days)`) +
  (basin ? ", over the basin" : "");
/** For CSV columns: "mm_per_month", "km3". */
const unitSlug = (u: BasinUnits) => basinUnit(u).replace("³", "3").replace("/", "_per_");

// --- Measures ------------------------------------------------------------------------------

export type MeasureKey = "pcp" | "aeti" | "ratio" | "balance" | "Q" | "Qmax" | "Qmin" | "dS";

interface Measure {
  label: string;
  short: string;
  /** Chart colour. */
  color: string;
  ramp: string[];
  scale: "linear" | "log" | "diverging";
  /** The model's (precomputed), or WaPOR's. */
  flux?: { v: Flux; stat: "mean" | "max" | "min" };
  /** How this period is compared with the average: as a % of it, or the difference. */
  anomaly: "relative" | "absolute";
}

/** The WaPOR variables', for their names. */
const V = { pcp: waporVariable("PCP"), aeti: waporVariable("AETI"), balance: waporVariable("PCP-AETI") };
const C = { pcp: "var(--c-pcp)", aeti: "var(--c-aeti)", balance: "var(--c-1)", base: "var(--c-base)", now: "var(--c-now)", world: "var(--c-world)", group: "var(--c-2)", focus: "var(--c-1)" };
// Brown (drier) to teal (wetter), around a neutral grey.
const BALANCE_RAMP = ["#8c510a", "#bf812d", "#dfc27d", "#e3e1dc", "#80cdc1", "#35978f", "#01665e"];
const RATIO_RAMP = ["#fff5eb", "#fee6ce", "#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#8c2d04"];

const MEASURES: Record<MeasureKey, Measure> = {
  pcp: { label: V.pcp.label, short: "PCP", color: C.pcp, ramp: STYLES.PCP.ramp, scale: "linear", anomaly: "relative" },
  aeti: { label: V.aeti.label, short: "AETI", color: C.aeti, ramp: STYLES.AETI.ramp, scale: "linear", anomaly: "relative" },
  ratio: { label: "Share of precipitation evaporated", short: "AETI/PCP", color: "#d94801", ramp: RATIO_RAMP, scale: "linear", anomaly: "absolute" },
  balance: { label: V.balance.label, short: V.balance.short, color: C.balance, ramp: BALANCE_RAMP, scale: "diverging", anomaly: "absolute" },
  Q: { label: STYLES.Q.label, short: "Q", color: STYLES.Q.color, ramp: STYLES.Q.ramp, scale: "log", flux: { v: "Q", stat: "mean" }, anomaly: "relative" },
  Qmax: { label: "Highest dekad of discharge", short: "Q max", color: STYLES.Q.color, ramp: STYLES.Q.ramp, scale: "log", flux: { v: "Q", stat: "max" }, anomaly: "relative" },
  Qmin: { label: "Lowest dekad of discharge", short: "Q min", color: STYLES.Q.color, ramp: STYLES.Q.ramp, scale: "log", flux: { v: "Q", stat: "min" }, anomaly: "relative" },
  dS: { label: STYLES.dS.label, short: "ΔS", color: STYLES.dS.color, ramp: STYLES.dS.ramp, scale: "diverging", flux: { v: "dS", stat: "mean" }, anomaly: "absolute" },
};

/** Which groups a measure's basins are compared in: the rain's by climate, the rivers' by where they go. */
const GROUPING: Record<MeasureKey, Grouping> = {
  pcp: "climate",
  aeti: "climate",
  ratio: "climate",
  balance: "climate",
  Q: "drain",
  Qmax: "drain",
  Qmin: "drain",
  dS: "drain",
};

/** Whether the legend's units apply (else: % or m³/s). */
const inUnits = (m: MeasureKey) => m === "pcp" || m === "aeti" || m === "balance";
const unitOf = (c: BasinCtx, m: MeasureKey) => (inUnits(m) ? basinUnit(c.units) : m === "ratio" ? "%" : "m³/s");
/** Whether values add up over basins (volumes), so a group's dwarfs a basin's. */
const extensive = (c: BasinCtx, m: MeasureKey) => !!MEASURES[m].flux || (inUnits(m) && c.units.basin);
const anomalyUnit = (c: BasinCtx, m: MeasureKey) => (MEASURES[m].anomaly === "relative" ? "%" : m === "ratio" ? "% points" : unitOf(c, m));

// --- Values per area -----------------------------------------------------------------------

/** What a value is of: a sub-basin, a major basin, a group of them (groups.ts), or the World. */
export type Area = { kind: "sub" | "major" | "group"; id: number } | { kind: "world" };
const areaKey = (a: Area) => (a.kind === "world" ? "world" : `${a.kind}:${a.id}`);
export function parseArea(sub: string | null): Area | null {
  if (sub === "world") return { kind: "world" };
  const [kind, id] = sub?.split(":") ?? [];
  return kind === "sub" || kind === "major" || kind === "group" ? { kind, id: Number(id) } : null;
}
/** The area the tiles and single-area charts are about: the selected basin, or the World. */
const focus = (c: BasinCtx): Area => (c.major ? { kind: "major", id: c.major.id } : { kind: "world" });
const areaName = (c: BasinCtx, a: Area) =>
  a.kind === "world" ? "World" : a.kind === "group" ? groupById(a.id)?.name ?? String(a.id) : a.kind === "major" ? c.majorName(a.id) : c.subName(a.id);

/** PCP and AETI of some sub-basins: their area (km²) and volumes per day (km² × mm/day). */
interface Sums {
  area: number;
  p: number;
  e: number;
}

/** Mean mm/day of a sub-basin in range `w` of c.windows (NaN: none). */
function rates(c: BasinCtx, id: number, w: number): [number, number] {
  if (w === c.windows.current) {
    const s = c.stats.sub.get(id);
    return s ? [s.pcp / c.days, s.aeti / c.days] : [NaN, NaN];
  }
  const r = c.rates?.sub.get(id);
  return r ? [r.pcp[w], r.aeti[w]] : [NaN, NaN];
}

/** Per major basin, its sub-basins' sums in range `w` (kept in the context's cache). */
const majorSumsCache = new WeakMap<BasinCtx, Map<number, Map<number, Sums>>>();
function majorSums(c: BasinCtx, w: number): Map<number, Sums> {
  let byWindow = majorSumsCache.get(c);
  if (!byWindow) majorSumsCache.set(c, (byWindow = new Map()));
  let sums = byWindow.get(w);
  if (!sums) {
    sums = new Map();
    for (const [id, s] of c.stats.sub) {
      const [p, e] = rates(c, id, w);
      if (!Number.isFinite(p) || !Number.isFinite(e)) continue;
      let m = sums.get(s.majorBasin);
      if (!m) sums.set(s.majorBasin, (m = { area: 0, p: 0, e: 0 }));
      m.area += s.area;
      m.p += p * s.area;
      m.e += e * s.area;
    }
    byWindow.set(w, sums);
  }
  return sums;
}

function sumsOf(c: BasinCtx, a: Area, w: number): Sums {
  if (a.kind === "sub") {
    const s = c.stats.sub.get(a.id);
    const [p, e] = rates(c, a.id, w);
    return s && Number.isFinite(p) && Number.isFinite(e) ? { area: s.area, p: p * s.area, e: e * s.area } : { area: 0, p: 0, e: 0 };
  }
  const total = { area: 0, p: 0, e: 0 };
  for (const [major, s] of majorSums(c, w)) {
    if (a.kind === "major" ? major !== a.id : a.kind === "group" ? !inGroup(major, a.id) : false) continue;
    total.area += s.area;
    total.p += s.p;
    total.e += s.e;
  }
  return total;
}

function waporValue(c: BasinCtx, m: MeasureKey, s: Sums) {
  if (!s.area) return NaN;
  if (m === "ratio") return s.p > 0 ? (s.e / s.p) * 100 : NaN;
  const volume = m === "pcp" ? s.p : m === "aeti" ? s.e : s.p - s.e;
  const perDay = c.units.basin ? volume * 1e-6 : volume / s.area; // km³ or mm per day
  return perDay * perDays(c.units.per, c.days);
}

/** The flux series of a major basin, or of a sub-basin of the selected one (null: not loaded). */
function fluxSeriesOf(c: BasinCtx, a: { kind: "sub" | "major"; id: number }, v: Flux): { s: Float64Array; first: number } | null {
  const status = a.kind === "major" ? c.flux.majors : c.flux.sub;
  if (status?.kind !== "ready") return null;
  const s = status.result.series.get(a.id);
  return s ? { s: s[v], first: status.result.dekads[0] } : null;
}

/** A flux statistic of a series over range `r` (NaN: no values in it). */
function fluxStat(s: Float64Array, first: number, r: DekadRange, stat: "mean" | "max" | "min") {
  const from = Math.max(0, r.start - first);
  const to = Math.min(s.length, r.end - first + 1);
  let acc = stat === "max" ? -Infinity : stat === "min" ? Infinity : 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = s[i];
    if (!Number.isFinite(v)) continue;
    acc = stat === "max" ? Math.max(acc, v) : stat === "min" ? Math.min(acc, v) : acc + v;
    n++;
  }
  return n ? (stat === "mean" ? acc / n : acc) : NaN;
}

/** The World's (or a group's) flux per dekad: summed over its major basins. */
function summedFlux(c: BasinCtx, a: Area, v: Flux): { s: Float64Array; first: number } | null {
  const status = c.flux.majors;
  if (status.kind !== "ready") return null;
  const { dekads, series } = status.result;
  const s = new Float64Array(dekads.length).fill(NaN);
  for (const [id, x] of series) {
    if (a.kind === "group" && !inGroup(id, a.id)) continue;
    const values = x[v];
    for (let i = 0; i < s.length; i++) if (Number.isFinite(values[i])) s[i] = (Number.isFinite(s[i]) ? s[i] : 0) + values[i];
  }
  return { s, first: dekads[0] };
}

/** An area's flux per dekad (null: not loaded). */
function areaFlux(c: BasinCtx, a: Area, v: Flux) {
  return a.kind === "sub" || a.kind === "major" ? fluxSeriesOf(c, { kind: a.kind, id: a.id }, v) : summedFlux(c, a, v);
}

/** A measure's value for an area over range `w` of c.windows (the period itself by default). */
export function valueOf(c: BasinCtx, m: MeasureKey, a: Area, w = c.windows.current): number {
  const key = `${m}|${areaKey(a)}|${w}`;
  let v = c.cache.get(key);
  if (v === undefined) {
    const flux = MEASURES[m].flux;
    if (flux) {
      // Groups and the World: of the sum of their basins' series.
      const series = areaFlux(c, a, flux.v);
      v = series ? fluxStat(series.s, series.first, c.windows.ranges[w], flux.stat) : NaN;
    } else {
      v = waporValue(c, m, sumsOf(c, a, w));
    }
    c.cache.set(key, v);
  }
  return v;
}

/** The average over the other years (NaN: fewer than MIN_OTHERS), and how many there are. */
function averageOf(c: BasinCtx, m: MeasureKey, a: Area): { avg: number; n: number } {
  let sum = 0;
  let n = 0;
  c.windows.ranges.forEach((_, w) => {
    if (w === c.windows.current) return;
    const v = valueOf(c, m, a, w);
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  });
  return { avg: n >= MIN_OTHERS ? sum / n : NaN, n };
}

/** This period against the average: % of it, or the difference. */
function anomalyOf(c: BasinCtx, m: MeasureKey, a: Area) {
  const v = valueOf(c, m, a);
  const { avg } = averageOf(c, m, a);
  return MEASURES[m].anomaly === "relative" ? (avg > 0 ? (v / avg - 1) * 100 : NaN) : v - avg;
}

/** Whether the other years' values are in (or why not), for a measure. */
function othersStatus(c: BasinCtx, m: MeasureKey): string {
  if (c.windows.ranges.length - 1 < MIN_OTHERS) {
    return `The record (${dkY(c.windows.first)}–${dkY(c.windows.last)}) has too few other ${spanYears(c) > 1 ? `${spanYears(c)}-year spans` : "years"} to compare this period with.`;
  }
  if (MEASURES[m].flux) return fluxMessage(c, m) ?? "";
  return c.ratesError ?? (c.rates ? "" : "Loading the other years…");
}

/** Why the model's output isn't there (null: it is). */
function fluxMessage(c: BasinCtx, m: MeasureKey, level: "major" | "sub" = "major"): string | null {
  if (!MEASURES[m].flux) return null;
  const status = level === "sub" ? c.flux.sub : c.flux.majors;
  if (!status || status.kind === "loading") return "Loading discharge and storage change…";
  return status.kind === "error" ? status.message : null;
}

// --- Maps ----------------------------------------------------------------------------------

export interface BasinMapSpec {
  id: string;
  title: string;
  unit: string;
  /** Whether the unit menu's units apply. */
  units: boolean;
  note: string;
  /** Which basins are coloured. */
  level: "major" | "sub";
  value(id: number): number;
  ramp: string[];
  scale: "linear" | "log" | "diverging";
  /** Only these basins are coloured (null: all of the level). */
  only: Set<number> | null;
  /** The basins a chart names: the others are faded. */
  listed?: Set<number>;
  /** Why the map has no values (yet), for the legend. */
  status?: string;
  /** Discharge per sub-basin: can be drawn along the rivers instead (river-map.ts). */
  rivers?: boolean;
}

/** The maps' level: the selected basin's sub-basins, or the major basins. */
const levelOf = (c: BasinCtx): "major" | "sub" => (c.major ? "sub" : "major");
const subBasinsOf = (c: BasinCtx, major: number) => [...c.stats.sub].filter(([, s]) => s.majorBasin === major).map(([id]) => id);

function valueNote(c: BasinCtx, m: MeasureKey, level: "major" | "sub") {
  const per = level === "major" ? "major basin" : "sub-basin";
  const flux = MEASURES[m].flux;
  if (flux) {
    const what = flux.stat === "mean" ? "Mean" : flux.stat === "max" ? "Highest dekad" : "Lowest dekad";
    return m === "dS" ? `${what} per ${per}` : level === "major" ? `${what} outflow per ${per}` : `${what} per ${per}`;
  }
  if (m === "ratio") return `AETI as a share of PCP, per ${per}`;
  if (m === "balance") return "Brown: more evaporates than falls · teal: water left over";
  return c.units.per === "total" ? `Total per ${per}` : `Average per ${c.units.per}, per ${per}`;
}

/** A measure per basin of a level, over the period, or (`anomaly`) against the other years. */
function measureMap(c: BasinCtx, m: MeasureKey, level: "major" | "sub", mode: "value" | "anomaly" = "value", listed?: Set<number>): BasinMapSpec {
  const def = MEASURES[m];
  const only = level === "sub" && c.major ? new Set(subBasinsOf(c, c.major.id)) : null;
  const area = (id: number): Area => ({ kind: level, id });
  const anomaly = mode === "anomaly";
  const status = anomaly ? othersStatus(c, m) : fluxMessage(c, m, level) ?? "";
  return {
    id: `${mode}:${m}:${level}:${c.major?.id ?? ""}:${inUnits(m) ? unitSlug(c.units) : ""}:${status ? "wait" : "ok"}:${listed?.size ?? ""}`,
    title: anomaly ? `${def.label}: against other years` : def.label,
    unit: anomaly ? anomalyUnit(c, m) : unitOf(c, m),
    units: inUnits(m) && !(anomaly && def.anomaly === "relative"),
    note: anomaly
      ? def.anomaly === "relative"
        ? `% above or below the average of ${c.windows.ranges.length - 1} other years`
        : `Difference from the average of ${c.windows.ranges.length - 1} other years`
      : valueNote(c, m, level),
    level,
    value: (id) => (anomaly ? anomalyOf(c, m, area(id)) : valueOf(c, m, area(id))),
    ramp: anomaly ? (m === "aeti" || m === "dS" ? STYLES.dS.ramp : BALANCE_RAMP) : def.ramp,
    scale: anomaly ? "diverging" : def.scale,
    rivers: !anomaly && def.flux?.v === "Q" && level === "sub",
    only,
    listed,
    status: status || undefined,
  };
}

// --- Tiles and cards -----------------------------------------------------------------------

export interface BasinTile {
  id: string;
  label: string;
  color: string;
  measure: MeasureKey;
}

export interface BasinCard {
  id: string;
  title(c: BasinCtx): string;
  caption(c: BasinCtx): string;
  render(c: BasinCtx): { html: string; csv: (string | number)[][] };
  /** The card's map; `sub`: the row or series under the pointer (data-sub). */
  map(c: BasinCtx, sub: string | null): BasinMapSpec;
}

export interface TopicDef {
  id: string;
  label: string;
  tiles: BasinTile[];
  cards: BasinCard[];
  about: string;
}

/** A tile's value: the focus's over the period, and against the other years. */
export function tileValue(c: BasinCtx, t: BasinTile) {
  const a = focus(c);
  const def = MEASURES[t.measure];
  const { avg } = averageOf(c, t.measure, a);
  const v = valueOf(c, t.measure, a);
  const change = def.anomaly === "relative" ? (avg > 0 ? (v / avg - 1) * 100 : NaN) : v - avg;
  return { value: v, unit: unitOf(c, t.measure), change, changeUnit: anomalyUnit(c, t.measure) };
}

export const tileMap = (c: BasinCtx, t: BasinTile) => measureMap(c, t.measure, levelOf(c));

const empty = (text: string) => ({ html: `<p class="ch-empty">${text}</p>`, csv: [] as (string | number)[][] });
const csvOf = (rows: BarRow[], columns: string[]) => [
  ["area", ...columns],
  ...rows.filter((r) => !r.gap).map((r) => [r.label.replace(/^\d+\. /, ""), ...r.values]),
];
const column = (c: BasinCtx, m: MeasureKey) => `${m === "balance" ? "pcp_minus_aeti" : m.toLowerCase()}_${(inUnits(m) ? unitSlug(c.units) : unitOf(c, m)).replace("³", "3").replace("/", "_per_").replace("%", "pct")}`;
/** "1 Mar – 31 May", the period's days (in the other years too). */
const daysLabel = (c: BasinCtx) => {
  const r = c.covered;
  const day = (dk: number, d: number) => `${d} ${MONTHS[dkM(dk)]}`;
  return `${day(r.start, startDay(r.start))} – ${day(r.end, endDay(r.end))}`;
};
const others = (c: BasinCtx) => c.windows.ranges.filter((_, w) => w !== c.windows.current);
const othersLabel = (c: BasinCtx) => {
  const o = others(c);
  return o.length ? `${windowLabel(o[0])} to ${windowLabel(o[o.length - 1])}` : "none";
};

/** The rows of a group chart: the selected basin, the groups, the World. */
function areaRows(c: BasinCtx, grouping: Grouping, values: (a: Area) => number[]): BarRow[] {
  const rows: BarRow[] = [];
  if (c.major) rows.push({ sub: `major:${c.major.id}`, label: c.major.name, values: values({ kind: "major", id: c.major.id }), emphasis: true });
  for (const g of groupsOf(grouping)) rows.push({ sub: `group:${g.id}`, label: g.short, values: values({ kind: "group", id: g.id }) });
  rows.push({ sub: "world", label: "World", values: values({ kind: "world" }) });
  return rows;
}

/** How a grouping is made, for captions. */
const groupingNote = (grouping: Grouping) =>
  grouping === "climate" ? `${GROUPINGS.climate.about} (${climateYears()}). ` : `${GROUPINGS.drain.about} `;

/** Per group (and the selected basin, and the World): the other years' average and this period. */
function groupCard(m: MeasureKey, grouping = GROUPING[m]): BasinCard {
  const def = MEASURES[m];
  return {
    id: `${m}-${grouping}`,
    title: (c) => `${def.label} by ${GROUPINGS[grouping].label}, ${c.period}`,
    caption: (c) => {
      const status = othersStatus(c, m);
      return (status ? `${status} ` : `Against the average of the same days in ${others(c).length} other years (${othersLabel(c)}). `) +
        groupingNote(grouping) +
        (MEASURES[m].flux ? "Groups and the World: summed over their major basins. " : "") + "Hover a row to pick out its basins on the map.";
    },
    render(c) {
      const message = fluxMessage(c, m);
      if (message) return empty(message);
      const compare = !othersStatus(c, m);
      const rows = areaRows(c, grouping, (a) => (compare ? [averageOf(c, m, a).avg, valueOf(c, m, a)] : [valueOf(c, m, a)]));
      const series = compare ? [{ label: "Other years, average", color: C.base }, { label: "This period", color: C.now }] : [{ label: "This period", color: C.now }];
      return {
        html: bars({ series, rows, unit: unitOf(c, m), axis: def.label, width: c.width }),
        csv: csvOf(rows, compare ? [`${column(c, m)}_other_years`, column(c, m)] : [column(c, m)]),
      };
    },
    map: (c) => measureMap(c, m, "major"),
  };
}

interface Ranked {
  id: number;
  v: number;
}

/** Rank items by value; `n` from the top, or the top and bottom halves with a gap row. The emphasised one is added if left out. */
function rankRows(items: Ranked[], n: number, name: (id: number) => string, prefix: string, emphasis: number | null, ends = false): BarRow[] {
  const sorted = items.filter((d) => Number.isFinite(d.v)).sort((a, b) => b.v - a.v);
  const row = (d: Ranked, i: number): BarRow => ({ sub: `${prefix}:${d.id}`, label: `${i + 1}. ${name(d.id)}`, values: [d.v], emphasis: d.id === emphasis });
  const at = emphasis === null ? -1 : sorted.findIndex((d) => d.id === emphasis);
  if (!ends || sorted.length <= n) {
    const rows = sorted.slice(0, n).map(row);
    if (at >= n) rows.push(row(sorted[at], at));
    return rows;
  }
  const half = Math.floor(n / 2);
  const rows: BarRow[] = [
    ...sorted.slice(0, half).map(row),
    { sub: "", label: `… ${sorted.length - 2 * half} more`, values: [NaN], gap: true },
    ...sorted.slice(-half).map((d, i) => row(d, sorted.length - half + i)),
  ];
  if (at >= half && at < sorted.length - half) rows.splice(half + 1, 0, row(sorted[at], at));
  return rows;
}

const listedOf = (rows: BarRow[]) => new Set(rows.filter((r) => !r.gap).map((r) => Number(r.sub.split(":")[1])));

/** The major basins ranked: the highest `n`, or the highest and lowest; the selected one with its rank. */
function rankCard(m: MeasureKey, order: "top" | "ends", title: string, note = "", n = 12): BasinCard {
  const def = MEASURES[m];
  const rows = (c: BasinCtx) =>
    rankRows(c.majors.map((id) => ({ id, v: valueOf(c, m, { kind: "major", id }) })), n, c.majorName, "major", c.major?.id ?? null, order === "ends");
  return {
    id: `${m}-rank-${order}`,
    title: (c) => `${title}, ${c.period}`,
    caption: () => `${note}Out of all major basins. The map shows only the basins named; hover one to pick it out.`,
    render(c) {
      const message = fluxMessage(c, m);
      if (message) return empty(message);
      const r = rows(c);
      return { html: bars({ series: [{ label: def.short, color: def.color }], rows: r, unit: unitOf(c, m), axis: def.label, width: c.width }), csv: csvOf(r, [column(c, m)]) };
    },
    map: (c) => measureMap(c, m, "major", "value", fluxMessage(c, m) ? undefined : listedOf(rows(c))),
  };
}

/**
 * The same days every year: the selected basin (or the World) and, for values that
 * don't add up over basins, its group (GROUPING) and the World. Clicking a year selects it.
 */
function yearsCard(m: MeasureKey): BasinCard {
  const def = MEASURES[m];
  const group = (c: BasinCtx) => (c.major ? groupOf(c.major.id, GROUPING[m]) : null);
  return {
    id: `${m}-years`,
    title: (c) => (spanYears(c) > 1 ? `${def.label}, every ${spanYears(c)}-year span` : `${def.label}, ${daysLabel(c)} every year`),
    caption: (c) =>
      (extensive(c, m)
        ? `${areaName(c, focus(c))} only: its values add up over basins, so a group's would dwarf it. `
        : c.major ? `${c.major.name} compared with ${group(c) ? `${group(c)!.basins} and ` : ""}the World. ` : "") +
      `Click ${spanYears(c) > 1 ? "a span" : "a year"} to select it; the map shows this period against the average of the others.`,
    render(c) {
      const message = fluxMessage(c, m);
      if (message) return empty(message);
      const { ranges, current } = c.windows;
      const at = (a: Area) => new Map(ranges.map((_, w) => [w, valueOf(c, m, a, w)]));
      const series: LineSeries[] = [];
      if (!extensive(c, m) && c.major) {
        series.push({ label: "World", color: C.world, values: at({ kind: "world" }), sub: "world" });
        const g = group(c);
        if (g) series.push({ label: g.short, color: C.group, values: at({ kind: "group", id: g.id }), sub: `group:${g.id}` });
      }
      series.push({ label: areaName(c, focus(c)), color: def.color, values: at(focus(c)), emphasis: true });
      const label = (w: number) => windowLabel(ranges[w] ?? ranges[0]);
      const html = lines({ series, from: 0, to: ranges.length - 1, selected: current, unit: unitOf(c, m), axis: def.label, width: c.width, clickable: (w) => w !== current, label }) +
        (c.rates || def.flux ? "" : `<p class="ch-empty">${c.ratesError ?? "Loading the other years…"}</p>`);
      const csv: (string | number)[][] = [["years", ...series.map((s) => `${s.label} ${column(c, m)}`)]];
      ranges.forEach((_, w) => csv.push([label(w), ...series.map((s) => s.values.get(w) ?? NaN)]));
      return { html, csv };
    },
    map: (c) => measureMap(c, m, levelOf(c), "anomaly"),
  };
}

/** The selected basin's sub-basins, the highest and lowest. */
function subCard(m: MeasureKey, order: "top" | "ends", n = 14): BasinCard {
  const def = MEASURES[m];
  return {
    id: `${m}-sub`,
    title: (c) => (c.major ? `${c.major.name}: sub-basins by ${def.label.toLowerCase()}` : `Sub-basins by ${def.label.toLowerCase()}`),
    caption: (c) => (c.major ? `${c.period}. Hover a sub-basin to outline it on the map.` : "Pick a basin to compare its sub-basins."),
    render(c) {
      if (!c.major) return empty("Pick a major basin, on the map or above.");
      const message = fluxMessage(c, m, "sub");
      if (message) return empty(message);
      const ids = subBasinsOf(c, c.major.id);
      const r = rankRows(ids.map((id) => ({ id, v: valueOf(c, m, { kind: "sub", id }) })), n, c.subName, "sub", null, order === "ends");
      return { html: bars({ series: [{ label: def.short, color: def.color }], rows: r, unit: unitOf(c, m), axis: def.label, width: c.width }), csv: csvOf(r, [column(c, m)]) };
    },
    map: (c) => measureMap(c, m, levelOf(c)),
  };
}

/** Discharge through the period, dekad by dekad, with the other years' average for the same dekads. */
const hydrograph: BasinCard = {
  id: "Q-dekads",
  title: (c) => `${areaName(c, focus(c))}: discharge through the period`,
  caption: (c) =>
    (c.major ? "At its outlets" : "Summed over the outlets of all major basins") +
    `, per dekad. ${others(c).length >= MIN_OTHERS ? `Grey: the average of the same dekads in ${others(c).length} other years.` : ""}`,
  render(c) {
    const message = fluxMessage(c, "Q");
    if (message) return empty(message);
    const series = areaFlux(c, focus(c), "Q");
    if (!series) return empty("No discharge for this basin.");
    const { ranges, current } = c.windows;
    const len = c.covered.end - c.covered.start + 1;
    const at = (r: DekadRange, i: number) => series.s[r.start + i - series.first] ?? NaN;
    const now = new Map<number, number>();
    const avg = new Map<number, number>();
    for (let i = 0; i < len; i++) {
      now.set(i, at(ranges[current], i));
      const vs = ranges.filter((_, w) => w !== current).map((r) => at(r, i)).filter(Number.isFinite);
      avg.set(i, vs.length >= MIN_OTHERS ? vs.reduce((s, v) => s + v, 0) / vs.length : NaN);
    }
    const label = (i: number) => {
      const dk = c.covered.start + i;
      return `${startDay(dk)} ${MONTHS[dkM(dk)]}${len > 36 ? ` ${String(dkY(dk)).slice(2)}` : ""}`;
    };
    const lineSeries: LineSeries[] = [
      { label: "Other years, average", color: C.world, values: avg },
      { label: "This period", color: STYLES.Q.color, values: now, emphasis: true },
    ];
    const html = lines({ series: lineSeries, from: 0, to: len - 1, selected: NaN, unit: "m³/s", axis: "Discharge", width: c.width, clickable: () => false, label });
    const csv: (string | number)[][] = [["dekad", "q_m3_per_s", "q_other_years_m3_per_s"]];
    for (let i = 0; i < len; i++) csv.push([label(i), now.get(i)!, avg.get(i)!]);
    return { html, csv };
  },
  map: (c) => measureMap(c, "Q", levelOf(c)),
};

/** The area the monthly chart averages over (km²): the selected major basin, or all. */
const monthlyArea = (c: BasinCtx) => sumsOf(c, focus(c), c.windows.current).area;

/** PCP, AETI and PCP − AETI by month: per month whatever the units, per m² or over the basin. */
const monthlyCard: BasinCard = {
  id: "monthly",
  title: (c) => `${areaName(c, focus(c))}: precipitation and evapotranspiration by month`,
  caption: (c) => `${c.units.basin ? "Summed, in km³" : "Averaged over the area, in mm"} per month (months at the ends of the range only count the days in it). Hover a series to map it.`,
  render(c) {
    const m = c.monthly;
    if (!m) return empty("Loading the monthly cycle…");
    if (!m.months.length) return empty("No data");
    const units = { per: "month", basin: c.units.basin } as const;
    const k = units.basin ? monthlyArea(c) * 1e-6 : 1;
    const pcp = m.pcp.map((v) => v * k);
    const aeti = m.aeti.map((v) => v * k);
    const at = (values: number[]) => new Map(m.months.map((mo, i) => [mo, values[i]]));
    const series: LineSeries[] = [
      { label: V.pcp.short, color: C.pcp, values: at(pcp), sub: "var:pcp" },
      { label: V.aeti.short, color: C.aeti, values: at(aeti), sub: "var:aeti" },
      { label: V.balance.short, color: C.balance, values: at(pcp.map((p, i) => p - aeti[i])), sub: "var:balance", emphasis: true },
    ];
    const label = (mo: number) => `${MONTHS[mo % 12]}${mo % 12 === 0 || m.months.length <= 12 ? ` ${String(MIN_YEAR + Math.floor(mo / 12)).slice(2)}` : ""}`;
    const html = lines({ series, from: m.months[0], to: m.months[m.months.length - 1], selected: NaN, unit: basinUnit(units), width: c.width, clickable: () => false, label });
    const u = unitSlug({ ...units, per: "total" });
    const csv: (string | number)[][] = [["month", `pcp_${u}`, `aeti_${u}`, `pcp_minus_aeti_${u}`]];
    m.months.forEach((mo, i) => csv.push([`${MIN_YEAR + Math.floor(mo / 12)}-${String((mo % 12) + 1).padStart(2, "0")}`, pcp[i], aeti[i], pcp[i] - aeti[i]]));
    return { html, csv };
  },
  map(c, sub) {
    const m = sub?.startsWith("var:") ? (sub.slice(4) as MeasureKey) : "balance";
    return measureMap(c, m, levelOf(c));
  },
};

export const TOPICS: TopicDef[] = [
  {
    id: "rain",
    label: "Rain and evaporation",
    tiles: [
      { id: "t-pcp", label: "Precipitation", color: STYLES.PCP.color, measure: "pcp" },
      { id: "t-aeti", label: "Evapotranspiration", color: STYLES.AETI.color, measure: "aeti" },
      { id: "t-ratio", label: "Share evaporated", color: MEASURES.ratio.color, measure: "ratio" },
    ],
    cards: [
      groupCard("pcp"),
      yearsCard("pcp"),
      rankCard("pcp", "top", "Wettest major basins"),
      groupCard("aeti"),
      yearsCard("aeti"),
      groupCard("ratio"),
      rankCard("ratio", "ends", "Where most and least of the rain evaporates", "Above 100%, more evaporates than falls: the rest comes from storage, irrigation or upstream. "),
      subCard("pcp", "ends"),
      monthlyCard,
    ],
    about: "Precipitation (PCP) and actual evapotranspiration (AETI): WaPOR v3 L1, dekadal means per sub-basin, area-weighted (or summed) over basins and groups of them.",
  },
  {
    id: "water",
    label: "Water left",
    tiles: [
      { id: "t-balance", label: "PCP − AETI", color: "#35978f", measure: "balance" },
      { id: "t-dS", label: "Storage change", color: STYLES.dS.color, measure: "dS" },
    ],
    cards: [
      groupCard("balance"),
      groupCard("balance", "drain"),
      yearsCard("balance"),
      rankCard("balance", "ends", "Wettest and driest major basins"),
      subCard("balance", "ends"),
      groupCard("dS"),
      yearsCard("dS"),
    ],
    about: "PCP − AETI: the water left for rivers, lakes and aquifers (WaPOR v3 L1). Storage change (ΔS): from the water balance model, summed over a basin's sub-basins.",
  },
  {
    id: "discharge",
    label: "Discharge",
    tiles: [
      { id: "t-q", label: "Mean discharge", color: STYLES.Q.color, measure: "Q" },
      { id: "t-qmax", label: "Highest dekad", color: "#08519c", measure: "Qmax" },
      { id: "t-qmin", label: "Lowest dekad", color: "#9ecae1", measure: "Qmin" },
    ],
    cards: [hydrograph, groupCard("Q"), rankCard("Q", "top", "Largest outflows"), yearsCard("Q"), subCard("Q", "top")],
    about: "Discharge (Q): from the water balance model, routed through the sub-basins as linear reservoirs; a major basin's is the sum at its outlets, a group's the sum over its major basins.",
  },
];
