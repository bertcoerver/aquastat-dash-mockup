/*
 * What the Country panel shows, per topic: the number tiles at the top and the chart
 * cards below them, after the Country tabs of FAO's Water Portal (see
 * waterportal-inventory/). Each tile and card also says which map goes with it: the
 * map shows that while the pointer is over it, or after a click pins it.
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
  meanAt,
  meanOver,
  regionValue,
  series as seriesOf,
  yearPeriod,
  type Period,
  type Topic,
  type VarKey,
} from "./data";
import { bars, lines, shares, type BarRow, type LineSeries } from "./charts";


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
  | { kind: "categories"; categories: { label: string; color: string }[]; category(m49: number): { index: number; share: number } | null }
  | { kind: "circles"; color: string };

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
}

const RAMPS = {
  blues: ["#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"],
  oranges: ["#fee6ce", "#fdd0a2", "#fdae6b", "#fd8d3c", "#f16913", "#d94801", "#a63603", "#7f2704"],
  greens: ["#e5f5e0", "#c7e9c0", "#a1d99b", "#74c476", "#41ab5d", "#238b45", "#006d2c", "#00441b"],
  purples: ["#efedf5", "#dadaeb", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3", "#54278f", "#3f007d"],
  browns: ["#fff7bc", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#993404", "#662506"],
  // Red (falls) to blue (rises) around a neutral grey.
  change: ["#b2182b", "#d6604d", "#f4a582", "#e3e1dc", "#92c5de", "#4393c3", "#2166ac"],
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
const C = { base: "var(--c-base)", now: "var(--c-now)", s1: "var(--c-1)", s2: "var(--c-2)", s3: "var(--c-3)", world: "var(--c-world)" };
const MAP_C = { s1: "#2a78d6", s2: "#eb6834", s3: "#1baf7a" };

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

/** The country, its region and the World over the years, for one variable. */
function areaSeries(ctx: Ctx, key: VarKey, weight?: VarKey): LineSeries[] {
  const over = (area: number) => {
    if (isCountry(ctx, area) || !weight) {
      const own = seriesOf(area, key);
      if (own.size || isCountry(ctx, area)) return own;
    }
    const out = new Map<number, number>();
    for (let y = FIRST_YEAR; y <= ctx.period.to; y++) out.set(y, val(ctx, area, key, yearPeriod(y), weight));
    return out;
  };
  const s: LineSeries[] = [{ label: "World", color: C.world, values: over(WORLD) }];
  if (ctx.region) s.push({ label: ctx.region.name, color: C.s2, values: over(ctx.region.code) });
  if (ctx.country) s.push({ label: ctx.country.name, color: C.s1, values: over(ctx.country.m49), emphasis: true });
  return s;
}

function lineChart(ctx: Ctx, series: LineSeries[], unit: string, axis: string, height?: number) {
  return lines({ series, from: FIRST_YEAR, to: ctx.period.to, selected: ctx.period.from, selectedTo: ctx.period.to, unit, axis, width: ctx.width, height, clickable: ctx.canSelect });
}

function seriesCsv(series: LineSeries[], unit: string) {
  const rows: (string | number)[][] = [["series", "year", `value_${unit}`]];
  for (const s of series) for (const [y, v] of [...s.values].sort((a, b) => a[0] - b[0])) rows.push([s.label, y, v]);
  return rows;
}

function rowsCsv(rows: BarRow[], columns: string[]) {
  return [["area", ...columns], ...rows.map((r) => [r.label, ...r.values])];
}

/** The countries with the highest (or lowest) values, as ranked bars. */
function ranking(ctx: Ctx, key: VarKey, n: number, order: "top" | "bottom", scale = 1) {
  const ranked = ctx.countries
    .map((m49) => ({ m49, v: meanAt(m49, key, ctx.period) }))
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
}

export interface Card {
  id: string;
  title(ctx: Ctx): string;
  caption(ctx: Ctx): string;
  render(ctx: Ctx): { html: string; csv: (string | number)[][] };
  /** The map for this card; `sub` is the series under the pointer, if any (data-sub "var:…"). */
  map(ctx: Ctx, sub: string | null): MapSpec;
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
    { id: "t-tww", label: "Water withdrawal", unit: "10⁹ m³/yr", color: MAP_C.s1, value: (c) => val(c, focus(c), "tww", c.period), map: (c) => circlesMap("tww", "Total water withdrawal", unitOf("tww"), (m) => meanAt(m, "tww", c.period)) },
    { id: "t-pop", label: "Population", unit: "million", color: "#4292c6", value: (c) => val(c, focus(c), "pop", c.period) / 1000, map: (c) => ({ ...rampMap(c, "pop", "Population", RAMPS.blues, "log"), unit: "million", value: (m) => meanAt(m, "pop", c.period) / 1000 }) },
  ],
  cards: [
    {
      id: "sdg-stress-regions",
      title: (c) => `Water stress per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "Hover a row to pick out its countries on the map.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "ws", BASE), val(c, a, "ws", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "%", axis: "Water stress", width: c.width }), csv: rowsCsv(rows, [`ws_${BASE_YEAR}`, `ws_${c.label}`]) };
      },
      map: (c) => stressMap(c),
    },
    {
      id: "sdg-stress-top",
      title: (c) => `Highest water stress, ${c.label}`,
      caption: (c) => {
        const { count } = ranking(c, "ws", 12, "top");
        return `The 12 most water-stressed of ${count} countries; most are small, so the map rings them. The map hides countries below high stress (75 %); click a class in the legend to show it.`;
      },
      render(c) {
        const { rows } = ranking(c, "ws", 12, "top");
        return { html: bars({ series: [{ label: "Water stress", color: C.now }], rows, unit: "%", axis: "Water stress", width: c.width }), csv: rowsCsv(rows, [`ws_${c.label}`]) };
      },
      map: (c) => stressMap(c, { id: "ws:high", hidden: [0, 1, 2], listed: ranking(c, "ws", 12, "top").listed }),
    },
    {
      id: "sdg-stress-trend",
      title: () => "Water stress over time",
      caption: (c) => (c.country ? `${c.country.name} compared with ${c.region?.name ?? "its region"} and the World.` : "Pick a country to compare it with its region.") + " Click a year to map it.",
      render(c) {
        const s = areaSeries(c, "ws");
        return { html: lineChart(c, s, "%", "Water stress"), csv: seriesCsv(s, "%") };
      },
      map: (c) => stressMap(c),
    },
    {
      id: "sdg-stress-sectors",
      title: (c) => `What causes water stress in ${focusName(c)}`,
      caption: () => "Each sector's withdrawal as a share of the available water; together they make up water stress. Hover a sector in the legend to map it.",
      render(c) {
        const a = focus(c);
        const s: LineSeries[] = [
          { label: "Agriculture", color: C.s3, sub: "var:ascws", values: seriesOf(a, "ascws") },
          { label: "Industry", color: C.s2, sub: "var:iscws", values: seriesOf(a, "iscws") },
          { label: "Municipal", color: C.s1, sub: "var:mscws", values: seriesOf(a, "mscws") },
        ];
        return { html: lineChart(c, s, "%", "Contribution to water stress"), csv: seriesCsv(s, "%") };
      },
      map(c, sub) {
        const key = variable(sub, ["ascws", "iscws", "mscws"], "ascws") as VarKey;
        const label = { ascws: "Agriculture's", iscws: "Industry's", mscws: "Municipal" }[key as "ascws"];
        return { ...rampMap(c, key, `${label} contribution to water stress`, RAMPS.oranges, "log"), unit: "%" };
      },
    },
    {
      id: "sdg-wue-regions",
      title: (c) => `Water use efficiency per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "US$ of value added per m³ withdrawn.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "wue", BASE), val(c, a, "wue", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "US$/m³", axis: "Water use efficiency", width: c.width }), csv: rowsCsv(rows, [`wue_${BASE_YEAR}`, `wue_${c.label}`]) };
      },
      map: (c) => rampMap(c, "wue", "Water use efficiency (SDG 6.4.1)", RAMPS.purples, "log"),
    },
    {
      id: "sdg-wue-sectors",
      title: (c) => `Water use efficiency by sector, ${c.label}`,
      caption: (c) => `${c.country ? c.country.name : "Per region"}: value added per m³ in each sector, ${BASE_YEAR} and ${c.label}. Hover a row to map that sector.`,
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
    },
    {
      id: "sdg-wue-change",
      title: () => `Water use efficiency since ${BASE_YEAR}`,
      caption: (c) => `${c.country ? `${c.country.name} compared with its region and the World. ` : ""}The map shows the change from ${BASE_YEAR} to ${c.label}.`,
      render(c) {
        const s = areaSeries(c, "wue");
        return { html: lineChart(c, s, "US$/m³", "Water use efficiency"), csv: seriesCsv(s, "US$/m³") };
      },
      map: (c) => ({
        id: "wue:change",
        title: `Change in water use efficiency since ${BASE_YEAR}`,
        unit: "%",
        note: "Red: less efficient · blue: more",
        value(m49) {
          const a = meanAt(m49, "wue", BASE);
          const b = meanAt(m49, "wue", c.period);
          return a > 0 ? (b / a - 1) * 100 : NaN;
        },
        style: { kind: "ramp", ramp: RAMPS.change, scale: "diverging", domain: [-100, 100] },
      }),
    },
  ],
};

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
    { id: "t-dam", label: "Dam capacity", unit: "km³", color: "#08519c", value: (c) => val(c, focus(c), "dam", c.period), map: (c) => circlesMap("dam", "Total dam capacity", "km³", (m) => meanAt(m, "dam", c.period)) },
  ],
  cards: [
    {
      id: "wr-regions",
      title: (c) => `Renewable water per person per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "Falls as population grows. Hover a row to pick out its countries on the map.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "trwrpc", BASE), val(c, a, "trwrpc", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: "m³/inhab/yr", axis: "Renewable water per person", width: c.width }), csv: rowsCsv(rows, [`trwrpc_${BASE_YEAR}`, `trwrpc_${c.label}`]) };
      },
      map: (c) => falkenmarkMap(c),
    },
    {
      id: "wr-lowest",
      title: (c) => `Least renewable water per person, ${c.label}`,
      caption: () => "Below 500 m³ per person a year is absolute scarcity (Falkenmark). The map hides countries above that; click a class in the legend to show it.",
      render(c) {
        const { rows } = ranking(c, "trwrpc", 12, "bottom");
        return { html: bars({ series: [{ label: "m³/inhab/yr", color: C.now }], rows, unit: "m³/inhab/yr", axis: "Renewable water per person", width: c.width }), csv: rowsCsv(rows, [`trwrpc_${c.label}`]) };
      },
      map: (c) => falkenmarkMap(c, { id: "trwrpc:low", hidden: [1, 2, 3, 4, 5], listed: ranking(c, "trwrpc", 12, "bottom").listed }),
    },
    {
      id: "wr-origin",
      title: (c) => `Where ${c.country ? `${c.country.name}'s` : "the"} renewable water comes from`,
      caption: (c) => (c.country ? "Produced inside the country, or flowing in from upstream countries." : "Pick a country: for the World, all renewable water is internal."),
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
    },
    {
      id: "wr-source",
      title: (c) => `Surface water and groundwater${c.country ? ` in ${c.country.name}` : ""}`,
      caption: (c) => (c.country ? "Renewable resources by source. Rivers and aquifers exchange water; the overlap is counted once." : "Pick a country to split its renewable water by source."),
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
    },
  ],
};

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
    style: { kind: "categories", categories: SECTORS.map((s) => ({ label: s.label, color: s.map })), category },
  };
}

const USE: TopicDef = {
  id: "use",
  label: "Water use",
  about:
    "Water withdrawal is the water taken from rivers, lakes and aquifers (plus desalinated and reused water) for agriculture, industry and municipalities. Freshwater withdrawal leaves out desalinated water and reused wastewater.",
  tiles: [
    { id: "t-tww", label: "Water withdrawal", unit: "10⁹ m³/yr", color: MAP_C.s1, value: (c) => val(c, focus(c), "tww", c.period), map: (c) => circlesMap("tww", "Total water withdrawal", unitOf("tww"), (m) => meanAt(m, "tww", c.period)) },
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
      caption: () => "Hover a row to pick out its countries on the map.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "tfw", BASE), val(c, a, "tfw", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: unitOf("tfw"), axis: "Freshwater withdrawal", width: c.width }), csv: rowsCsv(rows, [`tfw_${BASE_YEAR}`, `tfw_${c.label}`]) };
      },
      map: (c) => circlesMap("tfw", "Freshwater withdrawal", unitOf("tfw"), (m) => meanAt(m, "tfw", c.period)),
    },
    {
      id: "wu-per-person",
      title: (c) => `Water withdrawal per person per region, ${BASE_YEAR} and ${c.label}`,
      caption: () => "Hover a row to pick out its countries on the map.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "twpc", BASE), val(c, a, "twpc", c.period)]);
        return { html: bars({ series: [{ label: String(BASE_YEAR), color: C.base }, { label: c.label, color: C.now }], rows, unit: unitOf("twpc"), axis: "Water withdrawal per person", width: c.width }), csv: rowsCsv(rows, [`twpc_${BASE_YEAR}`, `twpc_${c.label}`]) };
      },
      map: (c) => rampMap(c, "twpc", "Water withdrawal per person", RAMPS.oranges, "log"),
    },
    {
      id: "wu-sectors",
      title: (c) => `Water withdrawal by sector, ${c.label}`,
      caption: () => "The map colours each country by the sector that withdraws the most.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "aw", c.period), val(c, a, "iw", c.period), val(c, a, "mw", c.period)]);
        return { html: shares({ parts: SECTORS, rows, unit: unitOf("aw"), axis: "water withdrawal", width: c.width }), csv: rowsCsv(rows, ["agriculture_1e9m3", "industry_1e9m3", "municipal_1e9m3"]) };
      },
      map: (c) => dominantSector(c),
    },
    {
      id: "wu-source",
      title: (c) => `Freshwater withdrawal by source, ${c.label}`,
      caption: () => "Surface water (rivers, lakes) and groundwater (aquifers).",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "fsw", c.period), val(c, a, "fgw", c.period)]);
        return {
          html: shares({ parts: [{ label: "Surface water", color: C.s1, ink: "light" }, { label: "Groundwater", color: C.s2, ink: "light" }], rows, unit: unitOf("fsw"), axis: "freshwater withdrawal", width: c.width }),
          csv: rowsCsv(rows, ["surface_1e9m3", "groundwater_1e9m3"]),
        };
      },
      map: (c) => gwWithdrawalMap(c),
    },
    {
      id: "wu-nonconventional",
      title: (c) => `Non-conventional water, ${c.label}`,
      caption: () => "Desalinated water and treated wastewater used directly. Few countries use much, so the map shows amounts as circles.",
      render(c) {
        const rows = areaRows(c, (a) => [val(c, a, "desal", c.period), val(c, a, "reuse", c.period)]);
        return {
          html: bars({ series: [{ label: "Desalinated", color: C.s1 }, { label: "Treated wastewater", color: C.s3 }], rows, unit: unitOf("desal"), axis: "Volume", width: c.width }),
          csv: rowsCsv(rows, ["desalinated_1e9m3", "treated_wastewater_1e9m3"]),
        };
      },
      map: (c) =>
        circlesMap("nonconv", "Desalinated and reused water", unitOf("desal"), (m) => {
          const d = meanAt(m, "desal", c.period);
          const r = meanAt(m, "reuse", c.period);
          return Number.isFinite(d) || Number.isFinite(r) ? (d || 0) + (r || 0) : NaN;
        }),
    },
    {
      id: "wu-trend",
      title: (c) => `Water withdrawal per person in ${focusName(c)}`,
      caption: () => "Total and per sector. Hover a series in the legend to map it; click a year to map that year.",
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
    },
  ],
};

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
    { id: "t-aei", label: "Equipped for irrigation", unit: "million ha", color: MAP_C.s1, value: (c) => val(c, focus(c), "aei", c.period) / 1000, map: (c) => circlesMap("aei", "Area equipped for irrigation", "million ha", (m) => meanAt(m, "aei", c.period) / 1000) },
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
      caption: () => "In million hectares.",
      render(c) {
        const { rows } = ranking(c, "fci", 10, "top", 1 / 1000);
        return { html: bars({ series: [{ label: "million ha", color: C.now }], rows, unit: "million ha", axis: "Full control irrigation area", width: c.width }), csv: rowsCsv(rows, [`fci_Mha_${c.label}`]) };
      },
      map: (c) => circlesMap("fci", "Area equipped for full control irrigation", "million ha", (m) => meanAt(m, "fci", c.period) / 1000, { listed: ranking(c, "fci", 10, "top").listed }),
    },
    {
      id: "ir-method",
      title: (c) => `Irrigation methods, ${c.label}`,
      caption: () => "Area equipped for full control irrigation by method. The map shows the share irrigated by sprinkler or drip.",
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
    },
    {
      id: "ir-source",
      title: (c) => `Where irrigation water comes from, ${c.label}`,
      caption: () => "Area equipped for irrigation by water source (regions: weighted by each country's equipped area).",
      render(c) {
        const rows = areaRows(c, (a) => (["srcSurface", "srcGround", "srcMixed"] as VarKey[]).map((k) => val(c, a, k, c.period, "aei")));
        return {
          html: shares({ parts: [{ label: "Surface water", color: C.s1, ink: "light" }, { label: "Groundwater", color: C.s2, ink: "light" }, { label: "Mixed", color: C.s3, ink: "light" }], rows, unit: "%", axis: "area equipped for irrigation", width: c.width }),
          csv: rowsCsv(rows, ["surface_pct", "groundwater_pct", "mixed_pct"]),
        };
      },
      map: (c) => ({ ...rampMap(c, "srcGround", "Irrigated with groundwater", RAMPS.browns, "linear", [0, 100]), note: "% of the area equipped for irrigation" }),
    },
    {
      id: "ir-actual",
      title: () => "Equipped area actually irrigated",
      caption: (c) => (c.country ? `${c.country.name} compared with ${c.region?.name ?? "its region"} and the World.` : "Pick a country to compare it with its region.") + " Click a year to map it.",
      render(c) {
        const s = areaSeries(c, "pctaai");
        return { html: lineChart(c, s, "%", "Equipped area actually irrigated"), csv: seriesCsv(s, "%") };
      },
      map: (c) => utilisationMap(c),
    },
    {
      id: "ir-cropland",
      title: (c) => `Cropland and irrigation in ${focusName(c)}`,
      caption: () => "Cropland area and the part of it equipped for irrigation, in million hectares. The map shows that part as a share.",
      render(c) {
        const a = focus(c);
        const mha = (key: VarKey) => {
          const out = new Map<number, number>();
          for (let y = FIRST_YEAR; y <= c.period.to; y++) out.set(y, val(c, a, key, yearPeriod(y)) / 1000);
          return out;
        };
        const s: LineSeries[] = [
          { label: "Cropland", color: C.s3, values: mha("crop") },
          { label: "Equipped for irrigation", color: C.s1, values: mha("aei") },
        ];
        return { html: lineChart(c, s, "million ha", "Area"), csv: seriesCsv(s, "Mha") };
      },
      map: (c) => shareMap("aei-crop", "Cropland equipped for irrigation", (m) => meanAt(m, "aei", c.period), (m) => meanAt(m, "crop", c.period), RAMPS.greens),
    },
  ],
};

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

