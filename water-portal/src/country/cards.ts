/*
 * What the Country panel shows, per topic: the number tiles at the top and the chart
 * cards below them, after the Country tabs of FAO's Water Portal (see
 * waterportal-inventory/). Each tile and card also says which map goes with it: the
 * map shows that while the pointer is over it, or after a click pins it. A card can
 * bring more maps along (`also`), each in a shape of its own (fill, circles, bars), so
 * the map shows the chart's variables together: water stress under circles of the
 * water withdrawn, say (see waterportal-inventory/waterportal-multivariable-maps.md).
 *
 * The Water Portal shows some charts only for the World and others only for a
 * country. Here every chart works in both: regional charts get the selected country as
 * an extra row on top, and the trends compare it with its region and the World.
 */
import {
  BASE_YEAR,
  FIRST_YEAR,
  VARS,
  WORLD,
  latestYear,
  meanAt,
  meanOver,
  regionValue,
  series as seriesOf,
  yearPeriod,
  type Period,
  type Topic,
  type VarKey,
} from "./data";
import { bars, bubbles, lines, shares, type BarRow, type Bubble, type LineSeries } from "./charts";
import type { Shape } from "../panels/shape-switch";


export interface Region {
  code: number;
  name: string;
  short: string;
  members: number[];
}

export interface Ctx {
  /** The years shown (the top bar's, up to AQUASTAT's latest): values are their yearly mean. */
  period: Period;
  /** The period as shown, e.g. "2019–2023". */
  label: string;
  country: { m49: number; name: string } | null;
  /** The selected country's region. */
  region: Region | null;
  regions: Region[];
  /** Every country (M49) in a region. */
  countries: number[];
  nameOf(m49: number): string;
  /** Whether the top bar can select a year. */
  canSelect(year: number): boolean;
  width: number;
}

// --- Maps ---------------------------------------------------------------------------

export interface MapClass {
  max: number;
  label: string;
  color: string;
}

export type MapStyle =
  | { kind: "ramp"; ramp: string[]; scale: "linear" | "log" | "diverging"; domain?: [number, number] }
  | { kind: "classes"; classes: MapClass[] }
  /** `of`: what the share is of, for the tooltip ("of withdrawal"; none: no share shown). */
  | { kind: "categories"; categories: { label: string; color: string }[]; category(m49: number): { index: number; share: number } | null; of?: string }
  | { kind: "circles"; color: string }
  /** Circles split into parts (up to four), their area by the value (the whole). */
  | { kind: "pies"; parts: { label: string; color: string }[]; amounts(m49: number): number[] | null };

export interface MapSpec {
  /** Names the map (with the period): the map repaints when it changes. */
  id: string;
  title: string;
  unit: string;
  /** A line under the title: how the values are coloured. */
  note: string;
  value(m49: number): number;
  style: MapStyle;
  /** Classes (indices) hidden in the legend when the map is first shown; the reader can show them again. */
  hidden?: number[];
  /** Countries named in the chart: marked with a ring (many are small). */
  listed?: number[];
  /** The shape it's first drawn in (else the first it can take); the legend can switch it. */
  shape?: Shape;
}

const RAMPS = {
  blues: ["#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"],
  oranges: ["#fee6ce", "#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#a63603", "#7f2704"],
  greens: ["#e5f5e0", "#c7e9c0", "#a1d99b", "#74c476", "#41ab5d", "#238b45", "#006d2c", "#00441b"],
  purples: ["#efedf5", "#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#54278f", "#3f007d"],
  browns: ["#fff7bc", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#993404", "#662506"],
  // Red (falls) to blue (rises) around a neutral grey.
  change: ["#b2182b", "#d6604d", "#f4a582", "#e3e1dc", "#92c5de", "#4393c3", "#2166ac"],
  // The same, the other way: blue (falls) to red (rises), where rising is worse.
  worse: ["#2166ac", "#4393c3", "#92c5de", "#e3e1dc", "#f4a582", "#d6604d", "#b2182b"],
};

/** Official SDG 6.4.2 water stress levels. */
const STRESS: MapClass[] = [
  { max: 25, label: "No stress (< 25 %)", color: "#abcde3" },
  { max: 50, label: "Low (25–50 %)", color: "#fff6b0" },
  { max: 75, label: "Medium (50–75 %)", color: "#fdd84f" },
  { max: 100, label: "High (75–100 %)", color: "#f28b35" },
  { max: Infinity, label: "Critical (> 100 %)", color: "#d4342b" },
];

/** Renewable water per person: Falkenmark's scarcity thresholds, then plenty. */
const FALKENMARK: MapClass[] = [
  { max: 500, label: "Absolute scarcity (< 500)", color: "#b2182b" },
  { max: 1000, label: "Scarcity (500–1,000)", color: "#ef8a62" },
  { max: 1700, label: "Stress (1,000–1,700)", color: "#fddbc7" },
  { max: 5000, label: "1,700–5,000", color: "#d1e5f0" },
  { max: 20000, label: "5,000–20,000", color: "#67a9cf" },
  { max: Infinity, label: "> 20,000", color: "#2166ac" },
];

// Chart colours (country.css), and the same hues on the map.
const C = { base: "var(--c-base)", now: "var(--c-now)", s1: "var(--c-1)", s2: "var(--c-2)", s3: "var(--c-3)", s4: "var(--c-4)", world: "var(--c-world)" };
const MAP_C = { s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a", s4: "#eda100" };

/** Groundwater withdrawn as a share of renewable groundwater: as the stress levels. */
const GW_PRESSURE: MapClass[] = [
  { max: 25, label: "< 25 %", color: "#abcde3" },
  { max: 50, label: "25–50 %", color: "#fff6b0" },
  { max: 75, label: "50–75 %", color: "#fdd84f" },
  { max: 100, label: "75–100 %", color: "#f28b35" },
  { max: Infinity, label: "> 100 %: more than is renewed", color: "#d4342b" },
];

/** Thresholds of the scarcity and stress quadrants (N1): Falkenmark's stress, SDG 6.4.2's. */
const SCARCE = 1700;
const STRESSED = 25;
const QUADRANTS = [
  { label: "Scarce and stressed", color: "#e34948" },
  { label: "Stressed, not scarce: using too much", color: "#eda100" },
  { label: "Scarce, not stressed", color: "#6250d6" },
  { label: "Neither", color: "#c9c6bd" },
];

const unitOf = (key: VarKey) => VARS[key].unit;
const BASE = yearPeriod(BASE_YEAR);

function rampMap(ctx: Ctx, key: VarKey, title: string, ramp: string[], scale: "linear" | "log", domain?: [number, number]): MapSpec {
  return {
    id: `${key}:${scale}`,
    title,
    unit: unitOf(key),
    note: domain ? "" : scale === "log" ? "Log scale" : "",
    value: (m49) => meanAt(m49, key, ctx.period),
    style: { kind: "ramp", ramp, scale, domain },
  };
}

/** A ratio of two variables, in %. */
function shareMap(id: string, title: string, part: (m49: number) => number, whole: (m49: number) => number, ramp: string[]): MapSpec {
  return {
    id,
    title,
    unit: "%",
    note: "",
    value: (m49) => {
      const w = whole(m49);
      return w > 0 ? (part(m49) / w) * 100 : NaN;
    },
    style: { kind: "ramp", ramp, scale: "linear", domain: [0, 100] },
  };
}

function stressMap(ctx: Ctx, extra: Partial<MapSpec> = {}): MapSpec {
  return {
    id: "ws",
    title: "Water stress (SDG 6.4.2)",
    unit: "%",
    note: "Freshwater withdrawn, % of what is available",
    value: (m49) => meanAt(m49, "ws", ctx.period),
    style: { kind: "classes", classes: STRESS },
    ...extra,
  };
}

function falkenmarkMap(ctx: Ctx, extra: Partial<MapSpec> = {}): MapSpec {
  return {
    id: "trwrpc",
    title: "Renewable water resources per person",
    unit: "m³/inhab/yr",
    note: "Falkenmark scarcity thresholds",
    value: (m49) => meanAt(m49, "trwrpc", ctx.period),
    style: { kind: "classes", classes: FALKENMARK },
    ...extra,
  };
}

function circlesMap(id: string, title: string, unit: string, value: (m49: number) => number, extra: Partial<MapSpec> = {}): MapSpec {
  return { id, title, unit, note: "Circle area shows the amount", value, style: { kind: "circles", color: MAP_C.s1 }, ...extra };
}

/** An amount split into parts, as pies: their area the whole, slices the parts. */
function piesMap(id: string, title: string, unit: string, parts: { label: string; color: string }[], amounts: (m49: number) => number[], extra: Partial<MapSpec> = {}): MapSpec {
  const of = (m49: number) => {
    const a = amounts(m49);
    return a.some(Number.isFinite) ? a.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)) : null;
  };
  return {
    id,
    title,
    unit,
    note: "Circle area shows the whole, slices the parts",
    value: (m49) => of(m49)?.reduce((s, v) => s + v, 0) ?? NaN,
    style: { kind: "pies", parts, amounts: of },
    shape: "circles",
    ...extra,
  };
}

const popMap = (c: Ctx): MapSpec => ({ ...rampMap(c, "pop", "Population", RAMPS.blues, "log"), unit: "million", value: (m) => meanAt(m, "pop", c.period) / 1000 });
/** Population as circles, beside another map. */
const popCircles = (c: Ctx): MapSpec => ({ ...popMap(c), shape: "circles" });
const twwCircles = (c: Ctx, extra: Partial<MapSpec> = {}) => circlesMap("tww", "Total water withdrawal", unitOf("tww"), (m) => meanAt(m, "tww", c.period), extra);

/**
 * A variable's change since the base year: in % of its value then, or (`points`) in its
 * own unit (percentage points of a share). `worse`: rising is worse (red), else falling.
 */
function changeMap(c: Ctx, key: VarKey, title: string, how: "pct" | "points", worse: boolean, extra: Partial<MapSpec> = {}): MapSpec {
  return {
    id: `${key}:change`,
    title,
    unit: how === "pct" ? "%" : "% points",
    note: worse ? "Red: rose · blue: fell" : "Red: fell · blue: rose",
    value(m49) {
      const a = meanAt(m49, key, BASE);
      const b = meanAt(m49, key, c.period);
      return how === "pct" ? (a > 0 ? (b / a - 1) * 100 : NaN) : b - a;
    },
    style: { kind: "ramp", ramp: worse ? RAMPS.worse : RAMPS.change, scale: "diverging" },
    ...extra,
  };
}

/** A country's value of `a` over `b`, times `k` (NaN: either missing, or `b` not above 0). */
const ratio = (c: Ctx, a: VarKey, b: VarKey, k = 1) => (m49: number) => {
  const x = meanAt(m49, a, c.period);
  const y = meanAt(m49, b, c.period);
  return y > 0 && Number.isFinite(x) ? (x / y) * k : NaN;
};

// --- Values per area ------------------------------------------------------------------

const membersOf = (ctx: Ctx, area: number) =>
  area === WORLD ? ctx.countries : ctx.regions.find((r) => r.code === area)?.members ?? [area];
const isCountry = (ctx: Ctx, area: number) => area !== WORLD && !ctx.regions.some((r) => r.code === area);

/** A variable's yearly mean over a period, for a country, region or the World (see regionValue). */
function val(ctx: Ctx, area: number, key: VarKey, p: Period, weight?: VarKey) {
  return isCountry(ctx, area) ? meanAt(area, key, p) : meanOver(p, (y) => regionValue(area, key, y, membersOf(ctx, area), weight));
}

/** The rows of a regional chart: the selected country, the regions, the World. */
function areaRows(ctx: Ctx, values: (area: number) => number[]): BarRow[] {
  const rows: BarRow[] = [];
  if (ctx.country) rows.push({ sub: `area:${ctx.country.m49}`, label: ctx.country.name, values: values(ctx.country.m49), emphasis: true });
  for (const r of ctx.regions) rows.push({ sub: `area:${r.code}`, label: r.short, values: values(r.code) });
  rows.push({ sub: `area:${WORLD}`, label: "World", values: values(WORLD) });
  return rows;
}

/** The area the single-area charts are about: the country, or the World. */
const focus = (ctx: Ctx) => ctx.country?.m49 ?? WORLD;
const focusName = (ctx: Ctx) => ctx.country?.name ?? "the World";

/** The last year of the charts over time: AQUASTAT's latest, whatever the top bar's range. */
const lastYear = (ctx: Ctx) => Math.max(latestYear(), ctx.period.to);

/** The country, its region and the World over the years, for one variable. */
function areaSeries(ctx: Ctx, key: VarKey, weight?: VarKey): LineSeries[] {
  const over = (area: number) => {
    if (isCountry(ctx, area) || !weight) {
      const own = seriesOf(area, key);
      if (own.size || isCountry(ctx, area)) return own;
    }
    const out = new Map<number, number>();
    for (let y = FIRST_YEAR; y <= lastYear(ctx); y++) out.set(y, val(ctx, area, key, yearPeriod(y), weight));
    return out;
  };
  const s: LineSeries[] = [{ label: "World", color: C.world, values: over(WORLD) }];
  if (ctx.region) s.push({ label: ctx.region.name, color: C.s2, values: over(ctx.region.code) });
  if (ctx.country) s.push({ label: ctx.country.name, color: C.s1, values: over(ctx.country.m49), emphasis: true });
  return s;
}

function lineChart(ctx: Ctx, series: LineSeries[], unit: string, axis: string, height?: number) {
  return lines({ series, from: FIRST_YEAR, to: lastYear(ctx), selected: ctx.period.from, selectedTo: ctx.period.to, unit, axis, width: ctx.width, height, clickable: ctx.canSelect });
}

function seriesCsv(series: LineSeries[], unit: string) {
  const rows: (string | number)[][] = [["series", "year", `value_${unit}`]];
  for (const s of series) for (const [y, v] of [...s.values].sort((a, b) => a[0] - b[0])) rows.push([s.label, y, v]);
  return rows;
}

function rowsCsv(rows: BarRow[], columns: string[]) {
  return [["area", ...columns], ...rows.map((r) => [r.label, ...r.values])];
}

/** The countries with the highest (or lowest) values (a variable's, or worked out), as ranked bars. */
function ranking(ctx: Ctx, of: VarKey | ((m49: number) => number), n: number, order: "top" | "bottom", scale = 1) {
  const value = typeof of === "function" ? of : (m49: number) => meanAt(m49, of, ctx.period);
  const ranked = ctx.countries
    .map((m49) => ({ m49, v: value(m49) }))
    // AQUASTAT stores 0 for some small territories it has no figures for.
    .filter((d) => Number.isFinite(d.v) && d.v > 0)
    .sort((a, b) => (order === "top" ? b.v - a.v : a.v - b.v));
  const top = ranked.slice(0, n);
  const rank = ctx.country ? ranked.findIndex((d) => d.m49 === ctx.country!.m49) : -1;
  const rows: BarRow[] = top.map((d) => ({
    sub: `area:${d.m49}`,
    label: ctx.nameOf(d.m49),
    values: [d.v * scale],
    emphasis: d.m49 === ctx.country?.m49,
  }));
  // The selected country, if it isn't in the list: last, with its rank.
  if (ctx.country && rank >= n) {
    rows.push({ sub: `area:${ctx.country.m49}`, label: `${rank + 1}. ${ctx.country.name}`, values: [ranked[rank].v * scale], emphasis: true });
  }
  return { rows, listed: top.map((d) => d.m49), count: ranked.length, rank };
}

// --- Tiles and cards ------------------------------------------------------------------------

export interface Tile {
  id: string;
  label: string;
  unit: string;
  value(ctx: Ctx): number;
  /** The tile's colour (the top border): the map's darkest colour. */
  color: string;
  map(ctx: Ctx): MapSpec;
  /** Maps shown with it, each in a shape of its own. */
  also?(ctx: Ctx): MapSpec[];
}

export interface Card {
  id: string;
  title(ctx: Ctx): string;
  caption(ctx: Ctx): string;
  render(ctx: Ctx): { html: string; csv: (string | number)[][] };
  /** The map for this card; `sub` is the series under the pointer, if any (data-sub "var:…"). */
  map(ctx: Ctx, sub: string | null): MapSpec;
  /** Maps shown with it, each in a shape of its own (the legend can switch them). */
  also?(ctx: Ctx, sub: string | null): MapSpec[];
}

export interface TopicDef {
  id: Topic;
  label: string;
  tiles: Tile[];
  cards: Card[];
  about: string;
}

const variable = (sub: string | null, allowed: string[], fallback: string) => {
  const v = sub?.startsWith("var:") ? sub.slice(4) : null;
  return v && allowed.includes(v) ? v : fallback;
};


// --- SDG 6.4 ---------------------------------------------------------------------------------

const SDG: TopicDef = {
  id: "sdg",
  label: "SDG 6.4",
  about:
    "SDG 6.4.1 water use efficiency is the value added per cubic metre of water withdrawn (US$/m³, constant 2015 prices). SDG 6.4.2 water stress is the freshwater withdrawn as a share of the renewable freshwater available after environmental flow requirements.",
  tiles: [
    { id: "t-ws", label: "Water stress", unit: "%", color: "#c8402f", value: (c) => val(c, focus(c), "ws", c.period), map: (c) => stressMap(c) },
    { id: "t-wue", label: "Water use efficiency", unit: "US$/m³", color: "#54278f", value: (c) => val(c, focus(c), "wue", c.period), map: (c) => rampMap(c, "wue", "Water use efficiency (SDG 6.4.1)", RAMPS.purples, "log") },
    { id: "t-tww", label: "Water withdrawal", unit: "10⁹ m³/yr", color: MAP_C.s1, value: (c) => val(c, focus(c), "tww", c.period), map: (c) => twwCircles(c), also: (c) => [stressMap(c)] },
    { id: "t-pop", label: "Population", unit: "million", color: "#4292c6", value: (c) => val(c, focus(c), "pop", c.period) / 1000, map: popMap },
  ],
  cards: [
    {
      id: "sdg-stress-regions",
      title: (c) => `Water stress per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "Hover a row to pick out its countries on the map. Circles: their populations.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "ws", BASE), val(c, a, "ws", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "%", axis: "Water stress", width: c.width }), csv: rowsCsv(rows, [`ws_${BASE_YEAR}`, `ws_${c.label}`]) };
      },
      map: (c) => stressMap(c),
      // How many people live under each level of stress.
      also: (c) => [popCircles(c)],
    },
    {
      id: "sdg-stress-top",
      title: (c) => `Highest water stress, ${c.label}`,
      caption: (c) => {
        const { count } = ranking(c, "ws", 12, "top");
        return `The 12 most water-stressed of ${count} countries; most are small, so the map rings them. The map hides countries below high stress (75 %), click a class in the legend to show it; circles: the water they withdraw.`;
      },
      render(c) {
        const { rows } = ranking(c, "ws", 12, "top");
        return { html: bars({ series: [{ label: "Water stress", color: C.now }], rows, unit: "%", axis: "Water stress", width: c.width }), csv: rowsCsv(rows, [`ws_${c.label}`]) };
      },
      map: (c) => stressMap(c, { id: "ws:high", hidden: [0, 1, 2], listed: ranking(c, "ws", 12, "top").listed }),
      also: (c) => [twwCircles(c)],
    },
    {
      id: "sdg-stress-trend",
      title: () => "Water stress over time",
      caption: (c) => (c.country ? `${c.country.name} compared with ${c.region?.name ?? "its region"} and the World.` : "Pick a country to compare it with its region.") + ` Click a year to map it; bars: the change since ${BASE_YEAR}.`,
      render(c) {
        const s = areaSeries(c, "ws");
        return { html: lineChart(c, s, "%", "Water stress"), csv: seriesCsv(s, "%") };
      },
      map: (c) => stressMap(c),
      also: (c) => [wsChange(c, { shape: "bars" })],
    },
    {
      id: "sdg-stress-sectors",
      title: (c) => `What causes water stress in ${focusName(c)}`,
      caption: () => "Each sector's withdrawal as a share of the available water; together they make up water stress. The map colours each country by its largest sector, under bars of its water stress; hover a sector in the legend for its share instead.",
      render(c) {
        const a = focus(c);
        const s: LineSeries[] = [
          { label: "Agriculture", color: C.s3, sub: "var:ascws", values: seriesOf(a, "ascws") },
          { label: "Industry", color: C.s2, sub: "var:iscws", values: seriesOf(a, "iscws") },
          { label: "Municipal", color: C.s1, sub: "var:mscws", values: seriesOf(a, "mscws") },
        ];
        return { html: lineChart(c, s, "%", "Contribution to water stress"), csv: seriesCsv(s, "%") };
      },
      map: (c) => dominantSector(c),
      also(c, sub) {
        if (!sub?.startsWith("var:")) return [stressMap(c, { shape: "bars" })];
        const key = variable(sub, ["ascws", "iscws", "mscws"], "ascws") as VarKey;
        return [{ ...sectorStress(c, key), shape: "bars" }];
      },
    },
    {
      id: "sdg-wue-regions",
      title: (c) => `Water use efficiency per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "US$ of value added per m³ withdrawn. Circles: the water withdrawn, where more value per m³ would save the most.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "wue", BASE), val(c, a, "wue", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "US$/m³", axis: "Water use efficiency", width: c.width }), csv: rowsCsv(rows, [`wue_${BASE_YEAR}`, `wue_${c.label}`]) };
      },
      map: (c) => rampMap(c, "wue", "Water use efficiency (SDG 6.4.1)", RAMPS.purples, "log"),
      also: (c) => [twwCircles(c)],
    },
    {
      id: "sdg-wue-sectors",
      title: (c) => `Water use efficiency by sector, ${c.label}`,
      caption: (c) => `${c.country ? c.country.name : "Per region"}: value added per m³ in each sector, ${BASE_YEAR} and ${c.label}. Hover a row to map that sector, with circles of the water it withdraws.`,
      render(c) {
        const a = focus(c);
        const rows: BarRow[] = [
          { sub: "var:iawue", label: "Irrigated agriculture", values: [val(c, a, "iawue", BASE), val(c, a, "iawue", c.period)] },
          { sub: "var:iwue", label: "Industry", values: [val(c, a, "iwue", BASE), val(c, a, "iwue", c.period)] },
          { sub: "var:swue", label: "Services", values: [val(c, a, "swue", BASE), val(c, a, "swue", c.period)] },
        ];
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "US$/m³", axis: "Water use efficiency", width: c.width }), csv: rowsCsv(rows, [String(BASE_YEAR), c.label]) };
      },
      map(c, sub) {
        const key = variable(sub, ["iawue", "iwue", "swue"], "iawue") as VarKey;
        const label = { iawue: "irrigated agriculture", iwue: "industry", swue: "services" }[key as "iwue"];
        return rampMap(c, key, `Water use efficiency in ${label}`, RAMPS.purples, "log");
      },
      also(c, sub) {
        const key = variable(sub, ["iawue", "iwue", "swue"], "iawue") as "iawue" | "iwue" | "swue";
        return [sectorCircles(c, ({ iawue: "aw", iwue: "iw", swue: "mw" } as const)[key])];
      },
    },
    {
      id: "sdg-wue-change",
      title: () => `Water use efficiency since ${BASE_YEAR}`,
      caption: (c) => `${c.country ? `${c.country.name} compared with its region and the World. ` : ""}The map shows the change from ${BASE_YEAR} to ${c.label} as circles (green: more efficient), over water stress: whether the stressed countries are getting more out of their water.`,
      render(c) {
        const s = areaSeries(c, "wue");
        return { html: lineChart(c, s, "US$/m³", "Water use efficiency"), csv: seriesCsv(s, "US$/m³") };
      },
      map: (c) => wueChange(c),
      also: (c) => [stressMap(c)],
    },
    {
      id: "sdg-scarcity",
      title: (c) => `Little water, or using too much? ${c.label}`,
      caption: () =>
        `Each dot a country, as big as its population. Left of ${fmtN(SCARCE)} m³ per person a country is short of water (Falkenmark); above ${STRESSED} % it withdraws enough to be stressed (SDG 6.4.2). Hover a dot to find it on the map.`,
      render(c) {
        const points = c.countries.map((m): Bubble => ({
          ...bubbleOf(c, m),
          x: meanAt(m, "trwrpc", c.period),
          y: meanAt(m, "ws", c.period),
          size: meanAt(m, "pop", c.period) / 1000,
        }));
        return {
          html: bubbles({
            points,
            x: { name: "Renewable water per person", unit: "m³/yr", log: true, at: SCARCE },
            y: { name: "Water stress", unit: "%", log: true, at: STRESSED },
            size: { name: "Population", unit: "million" },
            series: bubbleSeries(c),
            corners: ["Scarce and stressed", "Stressed: using too much", "Scarce, not stressed", "Neither"],
            width: c.width,
          }),
          csv: [["country", "trwrpc_m3_per_inhab", "ws_pct", "pop_million"], ...points.map((p) => [p.label, p.x, p.y, p.size])],
        };
      },
      map: (c) => quadrantMap(c),
      also: (c) => [popCircles(c)],
    },
    {
      id: "sdg-quadrant",
      title: (c) => `Water use efficiency and water stress, ${BASE_YEAR} to ${c.label}`,
      caption: (c) =>
        `SDG 6.4 in one picture: each dot a country, as big as the water it withdraws, with a line from where it was in ${BASE_YEAR}${c.country ? " (for " + (c.region?.name ?? "its region") + ")" : " (for the largest)"}. The target: down (less stress) and right (more value per m³). The vertical line is the World's efficiency.`,
      render(c) {
        const arrows = new Set(c.country ? c.region?.members ?? [c.country.m49] : largest(c, "tww", 15));
        const points = c.countries.map((m): Bubble => ({
          ...bubbleOf(c, m),
          x: meanAt(m, "wue", c.period),
          y: meanAt(m, "ws", c.period),
          size: meanAt(m, "tww", c.period),
          from: arrows.has(m) ? { x: meanAt(m, "wue", BASE), y: meanAt(m, "ws", BASE) } : undefined,
        }));
        return {
          html: bubbles({
            points,
            x: { name: "Water use efficiency", unit: "US$/m³", log: true, at: val(c, WORLD, "wue", c.period) },
            y: { name: "Water stress", unit: "%", log: true, at: STRESSED },
            size: { name: "Water withdrawal", unit: unitOf("tww") },
            series: bubbleSeries(c),
            corners: ["Stressed, little value per m³", "", "", "Less stress, more value per m³"],
            width: c.width,
          }),
          csv: [
            ["country", `wue_${BASE_YEAR}`, "wue", `ws_${BASE_YEAR}`, "ws", "tww_1e9m3"],
            ...c.countries.map((m) => [c.nameOf(m), meanAt(m, "wue", BASE), meanAt(m, "wue", c.period), meanAt(m, "ws", BASE), meanAt(m, "ws", c.period), meanAt(m, "tww", c.period)]),
          ],
        };
      },
      map: (c) => stressMap(c),
      also: (c) => [wueChange(c)],
    },
  ],
};

/** The change in water use efficiency since the base year, as circles: green more efficient, red less. */
function wueChange(c: Ctx): MapSpec {
  return {
    ...changeMap(c, "wue", `Change in water use efficiency since ${BASE_YEAR}`, "pct", false),
    note: "Red: less efficient · blue: more",
    style: { kind: "ramp", ramp: RAMPS.change, scale: "diverging", domain: [-100, 100] },
    shape: "circles",
  };
}

const wsChange = (c: Ctx, extra: Partial<MapSpec> = {}) => changeMap(c, "ws", `Change in water stress since ${BASE_YEAR}`, "points", true, extra);

function sectorStress(c: Ctx, key: VarKey): MapSpec {
  const label = { ascws: "Agriculture's", iscws: "Industry's", mscws: "Municipal" }[key as "ascws"];
  return { ...rampMap(c, key, `${label} contribution to water stress`, RAMPS.oranges, "log"), unit: "%" };
}

/** A sector's withdrawal as circles in its colour. */
function sectorCircles(c: Ctx, key: "aw" | "iw" | "mw" | "tww"): MapSpec {
  if (key === "tww") return twwCircles(c);
  const [label, color] = { aw: ["Agricultural", MAP_C.s3], iw: ["Industrial", MAP_C.s2], mw: ["Municipal", MAP_C.s1] }[key];
  return { ...circlesMap(key, `${label} water withdrawal`, unitOf(key), (m) => meanAt(m, key, c.period)), style: { kind: "circles", color } };
}

/** Where a country is short of water, withdraws enough to be stressed, both, or neither. */
function quadrantMap(c: Ctx): MapSpec {
  const category = (m49: number) => {
    const scarce = meanAt(m49, "trwrpc", c.period) < SCARCE;
    const ws = meanAt(m49, "ws", c.period);
    if (!Number.isFinite(ws)) return null;
    const stressed = ws >= STRESSED;
    return { index: scarce && stressed ? 0 : stressed ? 1 : scarce ? 2 : 3, share: 1 };
  };
  return {
    id: "quadrant",
    title: "Water scarcity and water stress",
    unit: "",
    note: `Scarce: under ${fmtN(SCARCE)} m³ per person · stressed: over ${STRESSED} % withdrawn`,
    value: (m49) => meanAt(m49, "ws", c.period),
    style: { kind: "categories", categories: QUADRANTS, category },
  };
}

const fmtN = (v: number) => v.toLocaleString("en-US");

/** A country's dot: the selected one in the first colour, its region's in the second, the rest grey. */
function bubbleOf(c: Ctx, m49: number): Omit<Bubble, "x" | "y" | "size"> {
  const own = m49 === c.country?.m49;
  const near = !own && !!c.region?.members.includes(m49);
  return { sub: `area:${m49}`, label: c.nameOf(m49), color: own ? C.s1 : near ? C.s2 : undefined, emphasis: own };
}
const bubbleSeries = (c: Ctx) =>
  c.country ? [{ label: c.country.name, color: C.s1 }, { label: c.region?.name ?? "Its region", color: C.s2 }, { label: "Other countries", color: C.world }] : [];

/** The `n` countries with the most of a variable. */
function largest(c: Ctx, key: VarKey, n: number) {
  return c.countries
    .map((m) => ({ m, v: meanAt(m, key, c.period) }))
    .filter((d) => Number.isFinite(d.v))
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map((d) => d.m);
}

// --- Water resources ----------------------------------------------------------------------------

const RESOURCES: TopicDef = {
  id: "resources",
  label: "Water resources",
  about:
    "Renewable water resources are the long-term average water a country can count on each year: produced inside it from precipitation (internal), plus what flows in from upstream countries (external). Surface water and groundwater overlap, as rivers and aquifers feed each other.",
  tiles: [
    { id: "t-trwrpc", label: "Renewable water per person", unit: "m³/yr", color: "#2166ac", value: (c) => val(c, focus(c), "trwrpc", c.period), map: (c) => falkenmarkMap(c) },
    {
      id: "t-trwr",
      label: "Renewable water resources",
      unit: "10⁹ m³/yr",
      color: MAP_C.s1,
      // The World's is the sum of what countries produce internally (external water comes from another country).
      value: (c) => (c.country ? meanAt(c.country.m49, "trwr", c.period) : meanOver(c.period, (y) => regionValue(WORLD, "irwr", y, c.countries))),
      map: (c) => circlesMap("trwr", "Total renewable water resources", unitOf("trwr"), (m) => meanAt(m, "trwr", c.period)),
    },
    { id: "t-dep", label: "From other countries", unit: "%", color: "#a63603", value: (c) => (c.country ? meanAt(c.country.m49, "dep", c.period) : NaN), map: (c) => ({ ...rampMap(c, "dep", "Dependency ratio", RAMPS.oranges, "linear", [0, 100]), note: "Renewable water that comes from other countries" }) },
    { id: "t-dam", label: "Dam capacity", unit: "km³", color: "#08519c", value: (c) => val(c, focus(c), "dam", c.period), map: (c) => damCircles(c), also: (c) => [storageMap(c)] },
  ],
  cards: [
    {
      id: "wr-regions",
      title: (c) => `Renewable water per person per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => `Falls as population grows. Hover a row to pick out its countries on the map: circles, their populations; bars, the change since ${BASE_YEAR}.`,
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "trwrpc", BASE), val(c, a, "trwrpc", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "m³/inhab/yr", axis: "Renewable water per person", width: c.width }), csv: rowsCsv(rows, [`trwrpc_${BASE_YEAR}`, `trwrpc_${c.label}`]) };
      },
      map: (c) => falkenmarkMap(c),
      also: (c) => [popCircles(c), changeMap(c, "trwrpc", `Change in renewable water per person since ${BASE_YEAR}`, "pct", false, { shape: "bars" })],
    },
    {
      id: "wr-lowest",
      title: (c) => `Least renewable water per person, ${c.label}`,
      caption: () => "Below 500 m³ per person a year is absolute scarcity (Falkenmark). The map hides countries above that (click a class in the legend to show it), with pies of the desalinated and reused water that makes up for it.",
      render(c) {
        const { rows } = ranking(c, "trwrpc", 12, "bottom");
        return { html: bars({ series: [{ label: "m³/inhab/yr", color: C.now }], rows, unit: "m³/inhab/yr", axis: "Renewable water per person", width: c.width }), csv: rowsCsv(rows, [`trwrpc_${c.label}`]) };
      },
      map: (c) => falkenmarkMap(c, { id: "trwrpc:low", hidden: [1, 2, 3, 4, 5], listed: ranking(c, "trwrpc", 12, "bottom").listed }),
      also: (c) => [nonConventionalPies(c)],
    },
    {
      id: "wr-origin",
      title: (c) => `Where ${c.country ? `${c.country.name}'s` : "the"} renewable water comes from`,
      caption: (c) => (c.country ? "Produced inside the country, or flowing in from upstream countries." : "Pick a country: for the World, all renewable water is internal.") + " Circles: how much flows in.",
      render(c) {
        if (!c.country) return { html: "", csv: [] };
        const m = c.country.m49;
        const rows: BarRow[] = [{ sub: `area:${m}`, label: c.country.name, values: [meanAt(m, "irwr", c.period), meanAt(m, "ext", c.period)], emphasis: true }];
        return {
          html: shares({ parts: [{ label: "Internal", color: C.s1, ink: "light" }, { label: "External (inflow)", color: C.s2, ink: "light" }], rows, unit: unitOf("irwr"), axis: "renewable water resources", width: c.width }),
          csv: rowsCsv(rows, ["internal_1e9m3", "external_1e9m3"]),
        };
      },
      map: (c) => ({ ...rampMap(c, "dep", "Dependency ratio", RAMPS.oranges, "linear", [0, 100]), note: "Renewable water that comes from other countries" }),
      also: (c) => [{ ...circlesMap("ext", "Inflow from other countries", unitOf("ext"), (m) => meanAt(m, "ext", c.period)), style: { kind: "circles", color: MAP_C.s2 } }],
    },
    {
      id: "wr-source",
      title: (c) => `Surface water and groundwater${c.country ? ` in ${c.country.name}` : ""}`,
      caption: (c) => (c.country ? "Renewable resources by source. Rivers and aquifers exchange water; the overlap is counted once." : "Pick a country to split its renewable water by source.") + " Circles: the groundwater withdrawn.",
      render(c) {
        if (!c.country) return { html: "", csv: [] };
        const m = c.country.m49;
        const sw = meanAt(m, "rsw", c.period);
        const gw = meanAt(m, "rgw", c.period);
        const both = meanAt(m, "overlap", c.period) || 0;
        const rows: BarRow[] = [{ sub: `area:${m}`, label: c.country.name, values: [sw - both, both, gw - both], emphasis: true }];
        return {
          html: shares({
            parts: [
              { label: "Surface water only", color: C.s1, ink: "light" },
              { label: "Both (overlap)", color: C.s3, ink: "light" },
              { label: "Groundwater only", color: C.s2, ink: "light" },
            ],
            rows,
            unit: unitOf("rsw"),
            axis: "renewable water resources",
            width: c.width,
          }),
          csv: rowsCsv(rows, ["surface_only_1e9m3", "overlap_1e9m3", "groundwater_only_1e9m3"]),
        };
      },
      map: (c) => ({
        ...shareMap("gw-share", "Groundwater, % of renewable water", (m) => meanAt(m, "rgw", c.period), (m) => meanAt(m, "trwr", c.period), RAMPS.browns),
        note: "Can pass 100 % where groundwater and surface water overlap",
        style: { kind: "ramp", ramp: RAMPS.browns, scale: "linear", domain: [0, 100] },
      }),
      also: (c) => [fgwCircles(c)],
    },
    {
      id: "wr-trend",
      title: () => "Renewable water per person over time",
      caption: (c) => (c.country ? `${c.country.name} compared with ${c.region?.name ?? "its region"} and the World.` : "Pick a country to compare it with its region.") + " Click a year to map it.",
      render(c) {
        const s = areaSeries(c, "trwrpc");
        return { html: lineChart(c, s, "m³/inhab/yr", "Renewable water per person"), csv: seriesCsv(s, "m3/inhab/yr") };
      },
      map: (c) => falkenmarkMap(c),
      // Played through the years, the circles grow as the colours turn to scarcity.
      also: (c) => [popCircles(c)],
    },
    {
      id: "wr-gw-pressure",
      title: (c) => `Groundwater withdrawn against what is renewed, ${c.label}`,
      caption: () =>
        "Fresh groundwater withdrawal as a share of renewable groundwater, the 15 highest. Above 100 % aquifers are drawn down (or fossil water is mined). Circles on the map: the groundwater withdrawn.",
      render(c) {
        const { rows } = ranking(c, gwPressure(c), 15, "top");
        return { html: bars({ series: [{ label: "%", color: C.s2 }], rows, unit: "%", axis: "Of renewable groundwater", width: c.width }), csv: rowsCsv(rows, [`gw_withdrawn_pct_of_renewable_${c.label}`]) };
      },
      map: (c) => ({
        id: "gw-pressure",
        title: "Groundwater withdrawn, % of renewable groundwater",
        unit: "%",
        note: "Fresh groundwater withdrawal over renewable groundwater",
        value: gwPressure(c),
        style: { kind: "classes", classes: GW_PRESSURE },
        listed: ranking(c, gwPressure(c), 15, "top").listed,
      }),
      also: (c) => [fgwCircles(c)],
    },
    {
      id: "wr-storage",
      title: (c) => `Dam storage against renewable water, ${c.label}`,
      caption: () =>
        "Dam capacity as a share of the renewable water resources: how much of a year's water can be held back for dry years. Hover a row to pick out its countries; circles: the dam capacity.",
      render(c) {
        const rows = areaRows(c, (a) => [storageOf(c, a)]);
        return { html: bars({ series: [{ label: "%", color: C.s1 }], rows, unit: "%", axis: "Of renewable water", width: c.width }), csv: rowsCsv(rows, [`dam_pct_of_trwr_${c.label}`]) };
      },
      map: (c) => storageMap(c),
      also: (c) => [damCircles(c)],
    },
  ],
};

const damCircles = (c: Ctx) => ({ ...circlesMap("dam", "Total dam capacity", "km³", (m) => meanAt(m, "dam", c.period)), style: { kind: "circles" as const, color: "#08519c" } });
const fgwCircles = (c: Ctx) => ({ ...circlesMap("fgw", "Fresh groundwater withdrawal", unitOf("fgw"), (m) => meanAt(m, "fgw", c.period)), style: { kind: "circles" as const, color: "#993404" } });
const gwPressure = (c: Ctx) => ratio(c, "fgw", "rgw", 100);

/** Dam capacity over renewable water, %: a country's, or a region's or the World's (summed). */
function storageOf(c: Ctx, area: number) {
  const dam = val(c, area, "dam", c.period);
  // The World's renewable water: what its countries produce inside them (as the tile).
  const trwr = area === WORLD ? meanOver(c.period, (y) => regionValue(WORLD, "irwr", y, c.countries)) : val(c, area, "trwr", c.period);
  return trwr > 0 ? (dam / trwr) * 100 : NaN;
}

function storageMap(c: Ctx): MapSpec {
  return {
    ...rampMap(c, "dam", "Dam capacity, % of renewable water", RAMPS.blues, "log"),
    id: "storage",
    unit: "%",
    note: "Log scale · how much of a year's water dams can hold",
    value: ratio(c, "dam", "trwr", 100),
  };
}

/** Desalinated and reused water, as pies. */
function nonConventionalPies(c: Ctx): MapSpec {
  return piesMap(
    "nonconv",
    "Desalinated and reused water",
    unitOf("desal"),
    [{ label: "Desalinated", color: MAP_C.s1 }, { label: "Treated wastewater", color: MAP_C.s3 }],
    (m) => [meanAt(m, "desal", c.period), meanAt(m, "reuse", c.period)],
  );
}

// --- Water use ---------------------------------------------------------------------------------

const SECTORS = [
  { label: "Agriculture", color: C.s3, map: MAP_C.s3, ink: "light" as const },
  { label: "Industry", color: C.s2, map: MAP_C.s2, ink: "light" as const },
  { label: "Municipal", color: C.s1, map: MAP_C.s1, ink: "light" as const },
];

function dominantSector(c: Ctx): MapSpec {
  const keys: VarKey[] = ["aw", "iw", "mw"];
  const category = (m49: number) => {
    const v = keys.map((k) => meanAt(m49, k, c.period));
    const total = v.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
    if (!(total > 0)) return null;
    const index = v.indexOf(Math.max(...v.filter(Number.isFinite)));
    return { index, share: v[index] / total };
  };
  return {
    id: "sector",
    title: "Largest water-using sector",
    unit: "",
    note: "Paler: the sector uses a smaller share",
    value: (m49) => category(m49)?.share ?? NaN,
    style: { kind: "categories", categories: SECTORS.map((s) => ({ label: s.label, color: s.map })), category, of: "of withdrawal" },
  };
}

const USE: TopicDef = {
  id: "use",
  label: "Water use",
  about:
    "Water withdrawal is the water taken from rivers, lakes and aquifers (plus desalinated and reused water) for agriculture, industry and municipalities. Freshwater withdrawal leaves out desalinated water and reused wastewater.",
  tiles: [
    { id: "t-tww", label: "Water withdrawal", unit: "10⁹ m³/yr", color: MAP_C.s1, value: (c) => val(c, focus(c), "tww", c.period), map: (c) => twwCircles(c) },
    { id: "t-twpc", label: "Per person", unit: "m³/yr", color: "#a63603", value: (c) => val(c, focus(c), "twpc", c.period), map: (c) => rampMap(c, "twpc", "Water withdrawal per person", RAMPS.oranges, "log") },
    {
      id: "t-agri",
      label: "Agriculture's share",
      unit: "%",
      color: MAP_C.s3,
      value: (c) => (val(c, focus(c), "aw", c.period) / val(c, focus(c), "tww", c.period)) * 100,
      map: (c) => shareMap("aw-share", "Agriculture, % of water withdrawal", (m) => meanAt(m, "aw", c.period), (m) => meanAt(m, "tww", c.period), RAMPS.greens),
    },
    {
      id: "t-gw",
      label: "From groundwater",
      unit: "%",
      color: "#993404",
      value: (c) => {
        const a = focus(c);
        const gw = val(c, a, "fgw", c.period);
        return (gw / (gw + val(c, a, "fsw", c.period))) * 100;
      },
      map: (c) => gwWithdrawalMap(c),
    },
  ],
  cards: [
    {
      id: "wu-volume",
      title: (c) => `Freshwater withdrawal per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "Hover a row to pick out its countries on the map. Circles: the water withdrawn, over the water stress it causes.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "tfw", BASE), val(c, a, "tfw", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: unitOf("tfw"), axis: "Freshwater withdrawal", width: c.width }), csv: rowsCsv(rows, [`tfw_${BASE_YEAR}`, `tfw_${c.label}`]) };
      },
      map: (c) => circlesMap("tfw", "Freshwater withdrawal", unitOf("tfw"), (m) => meanAt(m, "tfw", c.period)),
      also: (c) => [stressMap(c)],
    },
    {
      id: "wu-per-person",
      title: (c) => `Water withdrawal per person per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "Hover a row to pick out its countries on the map. Circles: the total withdrawn (per person × people).",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "twpc", BASE), val(c, a, "twpc", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: unitOf("twpc"), axis: "Water withdrawal per person", width: c.width }), csv: rowsCsv(rows, [`twpc_${BASE_YEAR}`, `twpc_${c.label}`]) };
      },
      map: (c) => rampMap(c, "twpc", "Water withdrawal per person", RAMPS.oranges, "log"),
      also: (c) => [twwCircles(c)],
    },
    {
      id: "wu-sectors",
      title: (c) => `Water withdrawal by sector, ${c.label}`,
      caption: () => "The map colours each country by the sector that withdraws the most, with pies of all three, as big as the water withdrawn.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "aw", c.period), val(c, a, "iw", c.period), val(c, a, "mw", c.period)]);
        return { html: shares({ parts: SECTORS, rows, unit: unitOf("aw"), axis: "water withdrawal", width: c.width }), csv: rowsCsv(rows, ["agriculture_1e9m3", "industry_1e9m3", "municipal_1e9m3"]) };
      },
      map: (c) => dominantSector(c),
      also: (c) => [
        piesMap("sector-pies", "Water withdrawal by sector", unitOf("aw"), SECTORS.map((x) => ({ label: x.label, color: x.map })), (m) =>
          (["aw", "iw", "mw"] as VarKey[]).map((k) => meanAt(m, k, c.period)),
        ),
      ],
    },
    {
      id: "wu-source",
      title: (c) => `Freshwater withdrawal by source, ${c.label}`,
      caption: () => "Surface water (rivers, lakes) and groundwater (aquifers). Circles: the groundwater withdrawn.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "fsw", c.period), val(c, a, "fgw", c.period)]);
        return {
          html: shares({ parts: [{ label: "Surface water", color: C.s1, ink: "light" }, { label: "Groundwater", color: C.s2, ink: "light" }], rows, unit: unitOf("fsw"), axis: "freshwater withdrawal", width: c.width }),
          csv: rowsCsv(rows, ["surface_1e9m3", "groundwater_1e9m3"]),
        };
      },
      map: (c) => gwWithdrawalMap(c),
      also: (c) => [fgwCircles(c)],
    },
    {
      id: "wu-nonconventional",
      title: (c) => `Non-conventional water, ${c.label}`,
      caption: () => "Desalinated water and treated wastewater used directly. Few countries use much, so the map shows them as pies, over the water stress they relieve.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "desal", c.period), val(c, a, "reuse", c.period)]);
        return {
          html: bars({ series: [{ label: "Desalinated", color: C.s1 }, { label: "Treated wastewater", color: C.s3 }], rows, unit: unitOf("desal"), axis: "Volume", width: c.width }),
          csv: rowsCsv(rows, ["desalinated_1e9m3", "treated_wastewater_1e9m3"]),
        };
      },
      map: (c) => nonConventionalPies(c),
      also: (c) => [stressMap(c)],
    },
    {
      id: "wu-trend",
      title: (c) => `Water withdrawal per person in ${focusName(c)}`,
      caption: () => "Total and per sector. Hover a series in the legend to map it, with circles of its volume; click a year to map that year.",
      render(c) {
        const a = focus(c);
        const s: LineSeries[] = [
          { label: "Total", color: C.world, sub: "var:twpc", values: seriesOf(a, "twpc") },
          { label: "Agriculture", color: C.s3, sub: "var:awpc", values: seriesOf(a, "awpc") },
          { label: "Industry", color: C.s2, sub: "var:iwpc", values: seriesOf(a, "iwpc") },
          { label: "Municipal", color: C.s1, sub: "var:mwpc", values: seriesOf(a, "mwpc") },
        ];
        return { html: lineChart(c, s, "m³/inhab/yr", "Water withdrawal per person"), csv: seriesCsv(s, "m3/inhab/yr") };
      },
      map(c, sub) {
        const key = variable(sub, ["twpc", "awpc", "iwpc", "mwpc"], "twpc") as VarKey;
        const label = { twpc: "Water withdrawal", awpc: "Agricultural withdrawal", iwpc: "Industrial withdrawal", mwpc: "Municipal withdrawal" }[key as "twpc"];
        return rampMap(c, key, `${label} per person`, RAMPS.oranges, "log");
      },
      also(c, sub) {
        const key = variable(sub, ["twpc", "awpc", "iwpc", "mwpc"], "twpc") as "twpc" | "awpc" | "iwpc" | "mwpc";
        return [sectorCircles(c, ({ twpc: "tww", awpc: "aw", iwpc: "iw", mwpc: "mw" } as const)[key])];
      },
    },
    {
      id: "wu-supply",
      title: (c) => `Where the water comes from, ${c.label}`,
      caption: () =>
        "All water withdrawn by source: surface water, groundwater, desalination and reused wastewater (regions: summed over their countries). The map shows the groundwater share under pies of the four.",
      render(c) {
        const keys: VarKey[] = ["fsw", "fgw", "desal", "reuse"];
        const rows = areaRows(c, (a) => keys.map((k) => (isCountry(c, a) ? meanAt(a, k, c.period) : meanOver(c.period, (y) => regionValue(a, k, y, membersOf(c, a))))));
        return {
          html: shares({ parts: SUPPLY.map((x) => ({ label: x.label, color: x.color, ink: x.ink })), rows, unit: unitOf("fsw"), axis: "water withdrawal", width: c.width }),
          csv: rowsCsv(rows, ["surface_1e9m3", "groundwater_1e9m3", "desalinated_1e9m3", "reused_1e9m3"]),
        };
      },
      map: (c) => gwWithdrawalMap(c),
      also: (c) => [
        piesMap("supply", "Water withdrawal by source", unitOf("fsw"), SUPPLY.map((x) => ({ label: x.label, color: x.map })), (m) =>
          (["fsw", "fgw", "desal", "reuse"] as VarKey[]).map((k) => meanAt(m, k, c.period)),
        ),
      ],
    },
    {
      id: "wu-drivers",
      title: (c) => `What changed since ${BASE_YEAR}, to ${c.label}`,
      caption: () =>
        `Change in %: more people, more water withdrawn (in all, or per person), less renewable water per person. The map shows the change in water stress, with bars of the change in withdrawal. Hover a row to pick out its countries.`,
      render(c) {
        const change = (a: number, k: VarKey) => {
          const x = val(c, a, k, BASE);
          const y = val(c, a, k, c.period);
          return x > 0 ? (y / x - 1) * 100 : NaN;
        };
        const keys: VarKey[] = ["pop", "tww", "twpc", "trwrpc"];
        const rows = areaRows(c, (a) => keys.map((k) => change(a, k)));
        return {
          html: bars({
            series: [
              { label: "Population", color: C.world },
              { label: "Water withdrawal", color: C.s1 },
              { label: "Per person", color: C.s2 },
              { label: "Renewable water per person", color: C.s3 },
            ],
            rows,
            unit: "%",
            axis: `Change since ${BASE_YEAR}`,
            width: c.width,
          }),
          csv: rowsCsv(rows, keys.map((k) => `${k}_change_pct`)),
        };
      },
      map: (c) => wsChange(c),
      also: (c) => [changeMap(c, "tww", `Change in water withdrawal since ${BASE_YEAR}`, "pct", true, { shape: "bars" })],
    },
  ],
};

/** The sources of all water withdrawn, in the charts' and the map's colours. */
const SUPPLY = [
  { label: "Surface water", color: C.s1, map: MAP_C.s1, ink: "light" as const },
  { label: "Groundwater", color: C.s2, map: MAP_C.s2, ink: "light" as const },
  { label: "Desalinated", color: C.s3, map: MAP_C.s3, ink: "light" as const },
  { label: "Reused wastewater", color: C.s4, map: MAP_C.s4, ink: "dark" as const },
];

function gwWithdrawalMap(c: Ctx): MapSpec {
  return shareMap(
    "gw-withdrawal",
    "Groundwater, % of freshwater withdrawal",
    (m) => meanAt(m, "fgw", c.period),
    (m) => meanAt(m, "fgw", c.period) + meanAt(m, "fsw", c.period),
    RAMPS.browns,
  );
}

// --- Irrigation ---------------------------------------------------------------------------------

const IRRIGATION: TopicDef = {
  id: "irrigation",
  label: "Irrigation",
  about:
    "Area equipped for irrigation is the area with infrastructure to supply water to crops; not all of it is irrigated every year. Full control irrigation is by surface (furrows, basins), sprinkler or localized (drip) methods.",
  tiles: [
    { id: "t-aei", label: "Equipped for irrigation", unit: "million ha", color: MAP_C.s1, value: (c) => val(c, focus(c), "aei", c.period) / 1000, map: (c) => aeiCircles(c) },
    { id: "t-pctci", label: "Of cultivated area", unit: "%", color: "#238b45", value: (c) => val(c, focus(c), "pctci", c.period), map: (c) => rampMap(c, "pctci", "Cultivated area equipped for irrigation", RAMPS.greens, "linear", [0, 100]) },
    { id: "t-pctaai", label: "Actually irrigated", unit: "%", color: "#006d2c", value: (c) => val(c, focus(c), "pctaai", c.period), map: (c) => utilisationMap(c) },
    {
      id: "t-pressurised",
      label: "Sprinkler or drip",
      unit: "%",
      color: MAP_C.s3,
      value(c) {
        const a = focus(c);
        const [s, sp, l] = (["fcSurface", "fcSprinkler", "fcLocalized"] as VarKey[]).map((k) => val(c, a, k, c.period));
        return ((sp + l) / (s + sp + l)) * 100;
      },
      map: (c) => pressurisedMap(c),
    },
  ],
  cards: [
    {
      id: "ir-top",
      title: (c) => `Largest areas equipped for full control irrigation, ${c.label}`,
      caption: () => "In million hectares. The map colours countries by how much of their water stress comes from agriculture.",
      render(c) {
        const { rows } = ranking(c, "fci", 10, "top", 1 / 1000);
        return { html: bars({ series: [{ label: "million ha", color: C.now }], rows, unit: "million ha", axis: "Full control irrigation area", width: c.width }), csv: rowsCsv(rows, [`fci_Mha_${c.label}`]) };
      },
      map: (c) => circlesMap("fci", "Area equipped for full control irrigation", "million ha", (m) => meanAt(m, "fci", c.period) / 1000, { listed: ranking(c, "fci", 10, "top").listed }),
      also: (c) => [sectorStress(c, "ascws")],
    },
    {
      id: "ir-method",
      title: (c) => `Irrigation methods, ${c.label}`,
      caption: () => "Area equipped for full control irrigation by method. The map shows the share irrigated by sprinkler or drip, with pies of the three methods, as big as the area.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "fcSurface", c.period), val(c, a, "fcSprinkler", c.period), val(c, a, "fcLocalized", c.period)]);
        return {
          html: shares({
            parts: [{ label: "Surface", color: C.s1, ink: "light" }, { label: "Sprinkler", color: C.s2, ink: "light" }, { label: "Localized (drip)", color: C.s3, ink: "light" }],
            rows,
            unit: "1000 ha",
            axis: "full control irrigation area",
            width: c.width,
          }),
          csv: rowsCsv(rows, ["surface_1000ha", "sprinkler_1000ha", "localized_1000ha"]),
        };
      },
      map: (c) => pressurisedMap(c),
      also: (c) => [
        piesMap("methods", "Full control irrigation by method", "million ha", METHODS, (m) =>
          (["fcSurface", "fcSprinkler", "fcLocalized"] as VarKey[]).map((k) => meanAt(m, k, c.period) / 1000),
        ),
      ],
    },
    {
      id: "ir-cultivated",
      title: () => "Cultivated area equipped for irrigation",
      caption: (c) => (c.country ? `${c.country.name} compared with ${c.region?.name ?? "its region"} and the World.` : "Pick a country to compare it with its region.") + " Click a year to map it.",
      render(c) {
        const s = areaSeries(c, "pctci");
        return { html: lineChart(c, s, "%", "Cultivated area equipped for irrigation"), csv: seriesCsv(s, "%") };
      },
      map: (c) => rampMap(c, "pctci", "Cultivated area equipped for irrigation", RAMPS.greens, "linear", [0, 100]),
      also: (c) => [aeiCircles(c)],
    },
    {
      id: "ir-source",
      title: (c) => `Where irrigation water comes from, ${c.label}`,
      caption: () => "Area equipped for irrigation by water source (regions: weighted by each country's equipped area). Circles: the area equipped.",
      render(c) {
        const rows = areaRows(c, (a) => (["srcSurface", "srcGround", "srcMixed"] as VarKey[]).map((k) => val(c, a, k, c.period, "aei")));
        return {
          html: shares({ parts: [{ label: "Surface water", color: C.s1, ink: "light" }, { label: "Groundwater", color: C.s2, ink: "light" }, { label: "Mixed", color: C.s3, ink: "light" }], rows, unit: "%", axis: "area equipped for irrigation", width: c.width }),
          csv: rowsCsv(rows, ["surface_pct", "groundwater_pct", "mixed_pct"]),
        };
      },
      map: (c) => ({ ...rampMap(c, "srcGround", "Irrigated with groundwater", RAMPS.browns, "linear", [0, 100]), note: "% of the area equipped for irrigation" }),
      also: (c) => [aeiCircles(c)],
    },
    {
      id: "ir-actual",
      title: () => "Equipped area actually irrigated",
      caption: (c) => (c.country ? `${c.country.name} compared with ${c.region?.name ?? "its region"} and the World.` : "Pick a country to compare it with its region.") + " Click a year to map it; circles: the equipped hectares not irrigated.",
      render(c) {
        const s = areaSeries(c, "pctaai");
        return { html: lineChart(c, s, "%", "Equipped area actually irrigated"), csv: seriesCsv(s, "%") };
      },
      map: (c) => utilisationMap(c),
      // Where the idle hectares are: the share is low in many small countries.
      also: (c) => [
        {
          ...circlesMap("idle", "Equipped area not irrigated", "million ha", (m) => {
            const idle = meanAt(m, "aei", c.period) - meanAt(m, "aai", c.period);
            return idle > 0 ? idle / 1000 : NaN;
          }),
          style: { kind: "circles", color: "#a63603" },
        },
      ],
    },
    {
      id: "ir-cropland",
      title: (c) => `Cropland and irrigation in ${focusName(c)}`,
      caption: () => "Cropland area and the part of it equipped for irrigation, in million hectares. The map shows the cropland per person, with circles of the cropland and bars of the part equipped for irrigation.",
      render(c) {
        const a = focus(c);
        const mha = (key: VarKey) => {
          const out = new Map<number, number>();
          for (let y = FIRST_YEAR; y <= lastYear(c); y++) out.set(y, val(c, a, key, yearPeriod(y)) / 1000);
          return out;
        };
        const s: LineSeries[] = [
          { label: "Cropland", color: C.s3, values: mha("crop") },
          { label: "Equipped for irrigation", color: C.s1, values: mha("aei") },
        ];
        return { html: lineChart(c, s, "million ha", "Area"), csv: seriesCsv(s, "Mha") };
      },
      map: (c) => ({
        ...rampMap(c, "crop", "Cropland per person", RAMPS.greens, "log"),
        id: "crop-pc",
        unit: "ha/person",
        // (1000 ha over 1000 people.)
        value: ratio(c, "crop", "pop"),
      }),
      also: (c) => [
        { ...circlesMap("crop", "Cropland area", "million ha", (m) => meanAt(m, "crop", c.period) / 1000), style: { kind: "circles", color: MAP_C.s3 } },
        { ...aeiCircles(c), shape: "bars" },
      ],
    },
    {
      id: "ir-water-per-ha",
      title: (c) => `Water per irrigated hectare, ${c.label}`,
      caption: () =>
        `Agricultural water withdrawal over the area actually irrigated, the 15 highest of the countries irrigating at least ${fmtN(PER_HA_FROM * 1000)} ha: a rough measure (it counts livestock and aquaculture too) of how much water each irrigated hectare takes. Circles on the map: the area irrigated.`,
      render(c) {
        const { rows } = ranking(c, perHectare(c), 15, "top");
        return { html: bars({ series: [{ label: "m³/ha", color: C.s3 }], rows, unit: "m³/ha/yr", axis: "Water per irrigated hectare", width: c.width }), csv: rowsCsv(rows, [`m3_per_ha_${c.label}`]) };
      },
      map: (c) => ({
        ...rampMap(c, "aw", "Agricultural water per irrigated hectare", RAMPS.blues, "log"),
        id: "per-ha",
        unit: "m³/ha/yr",
        note: "Agricultural withdrawal over the area actually irrigated",
        value: perHectare(c),
        listed: ranking(c, perHectare(c), 15, "top").listed,
      }),
      also: (c) => [{ ...circlesMap("aai", "Area actually irrigated", "million ha", (m) => meanAt(m, "aai", c.period) / 1000), style: { kind: "circles", color: MAP_C.s3 } }],
    },
  ],
};

const METHODS = [
  { label: "Surface", color: MAP_C.s1 },
  { label: "Sprinkler", color: MAP_C.s2 },
  { label: "Localized (drip)", color: MAP_C.s3 },
];

const aeiCircles = (c: Ctx): MapSpec => circlesMap("aei", "Area equipped for irrigation", "million ha", (m) => meanAt(m, "aei", c.period) / 1000);
/** Below this many hectares irrigated (in 1000 ha), the ratio says more about livestock and fish farms than irrigation. */
const PER_HA_FROM = 50;
/** m³ per hectare: 10⁹ m³ over 1000 ha (NaN below PER_HA_FROM). */
const perHectare = (c: Ctx) => (m49: number) => (meanAt(m49, "aai", c.period) >= PER_HA_FROM ? ratio(c, "aw", "aai", 1e6)(m49) : NaN);

function utilisationMap(c: Ctx): MapSpec {
  return { ...rampMap(c, "pctaai", "Equipped area actually irrigated", RAMPS.greens, "linear", [0, 100]), note: "Low: equipment idle or out of use" };
}

function pressurisedMap(c: Ctx): MapSpec {
  const v = (m: number, k: VarKey) => meanAt(m, k, c.period);
  return shareMap(
    "pressurised",
    "Irrigated by sprinkler or drip",
    (m) => v(m, "fcSprinkler") + v(m, "fcLocalized"),
    (m) => v(m, "fcSurface") + v(m, "fcSprinkler") + v(m, "fcLocalized"),
    RAMPS.greens,
  );
}

export const TOPICS: TopicDef[] = [SDG, RESOURCES, USE, IRRIGATION];

