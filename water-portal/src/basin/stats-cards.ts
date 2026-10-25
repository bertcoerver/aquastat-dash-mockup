/*
 * The Basin view's chart cards, after the Basin tab of FAO's Water Portal (see
 * waterportal-inventory/), and the map that goes with each:
 *
 * - no basin selected: the major basins of the world;
 * - a major basin (or one of its sub-basins) selected: that basin's sub-basins.
 *
 * Everything is over the date range in the top bar: precipitation (PCP), actual
 * evapotranspiration (AETI) and PCP − AETI, the water a basin has left for runoff and
 * storage, named as the WaPOR variables (map/layers/wapor.ts). In the units picked in the legend (as the WaPOR legend's): per day, month or
 * year, or the total over the period; per m² (mm) or over the basin (km³: mm × area).
 */
import { bars, lines, scatter, type BarRow, type LineSeries } from "../country/charts";
import { PER_DAYS, perDays, waporVariable, type WaporPer } from "../map/layers/wapor";
import { MONTHS, MIN_YEAR } from "../toolbar/dekads";
import type { Monthly, PeriodStats } from "./stats-data";
import { STYLES } from "./variables";

export interface BasinCtx {
  /** "1 Jan 2025 – 31 Oct 2025": the covered range. */
  period: string;
  stats: PeriodStats;
  majors: Map<number, BasinAgg>;
  /** The selected major basin, and sub-basin within it. */
  major: { id: number; name: string } | null;
  sub: { id: number; name: string } | null;
  /** The monthly cycle for the major basin (or all basins); null while loading. */
  monthly: Monthly | null;
  majorName(id: number): string;
  subName(id: number): string;
  width: number;
  units: BasinUnits;
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
  (per === "total" ? "in total over the period" : per === "day" ? "per day" : `per ${per} (${PER_DAYS[per]} days)`) +
  (basin ? ", over the basin" : "");
/** For CSV columns: "mm_per_month", "km3". */
const unitSlug = (u: BasinUnits) => basinUnit(u).replace("³", "3").replace("/", "_per_");

/** A major basin's (or all basins') totals: depth in mm, volume in km³. */
export interface BasinAgg {
  area: number;
  pcp: number;
  aeti: number;
  pcpVolume: number;
  aetiVolume: number;
}

export interface BasinMapSpec {
  id: string;
  title: string;
  unit: string;
  /** Whether the unit menu's units apply (not to the model's maps: they have their own). */
  units: boolean;
  note: string;
  /** Which basins are coloured. */
  level: "major" | "sub";
  value(id: number): number;
  ramp: string[];
  scale: "linear" | "log" | "diverging";
  /** Only these basins are coloured (null: all of the level). */
  only: Set<number> | null;
}

export interface BasinCard {
  id: string;
  title(c: BasinCtx): string;
  caption(c: BasinCtx): string;
  render(c: BasinCtx): { html: string; csv: (string | number)[][] };
  map(c: BasinCtx, sub: string | null): BasinMapSpec;
}

const C = { pcp: "var(--c-pcp)", aeti: "var(--c-aeti)", balance: "var(--c-1)", now: "var(--c-now)" };
/** The WaPOR variables', for their names. */
const V = { pcp: waporVariable("PCP"), aeti: waporVariable("AETI"), balance: waporVariable("PCP-AETI") };
// Brown (less rain than evaporation) to teal (more), around a neutral grey.
const BALANCE_RAMP = ["#8c510a", "#bf812d", "#dfc27d", "#e3e1dc", "#80cdc1", "#35978f", "#01665e"];

/** Sum PCP and AETI of a set of sub-basins (area-weighted depths, summed volumes). */
export function aggregate(stats: PeriodStats, ids: Iterable<number>): BasinAgg {
  let area = 0;
  let pv = 0;
  let ev = 0;
  let eArea = 0;
  for (const id of ids) {
    const s = stats.sub.get(id);
    if (!s || !Number.isFinite(s.pcp)) continue;
    area += s.area;
    pv += s.pcp * s.area * 1e-6;
    if (Number.isFinite(s.aeti)) {
      ev += s.aeti * s.area * 1e-6;
      eArea += s.area;
    }
  }
  return { area, pcp: area ? (pv / area) * 1e6 : NaN, aeti: eArea ? (ev / eArea) * 1e6 : NaN, pcpVolume: pv, aetiVolume: ev };
}

// --- Maps --------------------------------------------------------------------------------

type Measure = "balance" | "aeti" | "pcp";

const MEASURES: Record<Measure, { title: string; ramp: string[]; scale: BasinMapSpec["scale"] }> = {
  balance: { title: V.balance.label, ramp: BALANCE_RAMP, scale: "diverging" },
  aeti: { title: V.aeti.label, ramp: STYLES.AETI.ramp, scale: "linear" },
  pcp: { title: V.pcp.label, ramp: STYLES.PCP.ramp, scale: "linear" },
};

type Totals = { pcp: number; aeti: number; area: number };

/** A measure's total over the period, in mm. */
const totalOf = (m: Measure, a: Totals) => (m === "balance" ? a.pcp - a.aeti : m === "aeti" ? a.aeti : a.pcp);

/** The same in the chosen units. */
function measureOf(c: BasinCtx, m: Measure, a: Totals) {
  const { per, basin } = c.units;
  const v = totalOf(m, a) * (perDays(per, c.stats.days) / c.stats.days);
  return basin ? v * a.area * 1e-6 : v;
}

const unitOf = (c: BasinCtx) => basinUnit(c.units);

/** The map's note: "Total per major basin", "Average per month, per sub-basin". */
const noteOf = (c: BasinCtx, m: Measure, level: string) =>
  m === "balance"
    ? "Brown: more evaporates than falls · teal: water left over"
    : c.units.per === "total"
      ? `Total per ${level}`
      : `Average per ${c.units.per}, per ${level}`;

function majorMap(c: BasinCtx, m: Measure): BasinMapSpec {
  const s = MEASURES[m];
  return {
    id: `major:${m}:${unitSlug(c.units)}`,
    ...s,
    unit: unitOf(c),
    units: true,
    note: noteOf(c, m, "major basin"),
    level: "major",
    value: (id) => {
      const a = c.majors.get(id);
      return a ? measureOf(c, m, a) : NaN;
    },
    only: null,
  };
}

function subMap(c: BasinCtx, m: Measure): BasinMapSpec {
  const s = MEASURES[m];
  const only = c.major ? new Set(subBasinsOf(c, c.major.id)) : null;
  return {
    id: `sub:${m}:${c.major?.id ?? "all"}:${unitSlug(c.units)}`,
    ...s,
    unit: unitOf(c),
    units: true,
    note: noteOf(c, m, "sub-basin"),
    level: "sub",
    value: (id) => {
      const st = c.stats.sub.get(id);
      return st ? measureOf(c, m, st) : NaN;
    },
    only,
  };
}

const subBasinsOf = (c: BasinCtx, major: number) => [...c.stats.sub].filter(([, s]) => s.majorBasin === major).map(([id]) => id);

// --- Chart helpers ----------------------------------------------------------------------------

interface Ranked {
  id: number;
  v: number;
}

/** Rank items by a value; `n` from the top, or the top and bottom halves with a gap row. */
function rankRows(items: Ranked[], n: number, name: (id: number) => string, prefix: string, emphasis: number | null, ends = false): BarRow[] {
  const sorted = items.filter((d) => Number.isFinite(d.v)).sort((a, b) => b.v - a.v);
  const row = (d: Ranked, i: number): BarRow => ({
    sub: `${prefix}:${d.id}`,
    label: `${i + 1}. ${name(d.id)}`,
    values: [d.v],
    emphasis: d.id === emphasis,
  });
  if (!ends || sorted.length <= n) {
    const rows = sorted.slice(0, n).map(row);
    const at = emphasis === null ? -1 : sorted.findIndex((d) => d.id === emphasis);
    if (at >= n) rows.push(row(sorted[at], at));
    return rows;
  }
  const half = Math.floor(n / 2);
  const gap = sorted.length - 2 * half;
  const rows = [
    ...sorted.slice(0, half).map(row),
    { sub: "", label: `… ${gap} more`, values: [NaN], gap: true },
    ...sorted.slice(-half).map((d, i) => row(d, sorted.length - half + i)),
  ];
  const at = emphasis === null ? -1 : sorted.findIndex((d) => d.id === emphasis);
  if (at >= half && at < sorted.length - half) rows.splice(half + 1, 0, row(sorted[at], at));
  return rows;
}

const csvOf = (rows: BarRow[], column: string) => [["basin", column], ...rows.filter((r) => !r.gap).map((r) => [r.label.replace(/^\d+\. /, ""), r.values[0]])];

/** The monthly chart's area (km²): the selected major basin's, or all of them. */
const monthlyArea = (c: BasinCtx) =>
  c.major ? (c.majors.get(c.major.id)?.area ?? NaN) : [...c.majors.values()].reduce((s, a) => s + a.area, 0);

/** Per month whatever the units, per m² or over the basin (`c.units.basin`). */
function monthlyChart(c: BasinCtx) {
  const m = c.monthly;
  if (!m) return { html: `<p class="ch-empty">Loading the monthly cycle…</p>`, csv: [] };
  if (!m.months.length) return { html: `<p class="ch-empty">No data</p>`, csv: [] };
  const units = { per: "month", basin: c.units.basin } as const;
  const k = units.basin ? monthlyArea(c) * 1e-6 : 1;
  const pcp = m.pcp.map((v) => v * k);
  const aeti = m.aeti.map((v) => v * k);
  const at = (values: number[]) => new Map(m.months.map((mo, i) => [mo, values[i]]));
  const series: LineSeries[] = [
    { label: V.pcp.short, color: C.pcp, values: at(pcp) },
    { label: V.aeti.short, color: C.aeti, values: at(aeti) },
    { label: V.balance.short, color: C.balance, values: at(pcp.map((p, i) => p - aeti[i])), emphasis: true },
  ];
  const label = (mo: number) => `${MONTHS[mo % 12]}${mo % 12 === 0 || m.months.length <= 12 ? ` ${String(MIN_YEAR + Math.floor(mo / 12)).slice(2)}` : ""}`;
  const html = lines({
    series,
    from: m.months[0],
    to: m.months[m.months.length - 1],
    selected: NaN,
    unit: basinUnit(units),
    width: c.width,
    clickable: () => false,
    label,
  });
  const u = unitSlug({ ...units, per: "total" });
  const csv: (string | number)[][] = [["month", `pcp_${u}`, `aeti_${u}`, `pcp_minus_aeti_${u}`]];
  m.months.forEach((mo, i) => csv.push([`${MIN_YEAR + Math.floor(mo / 12)}-${String((mo % 12) + 1).padStart(2, "0")}`, pcp[i], aeti[i], pcp[i] - aeti[i]]));
  return { html, csv };
}

// --- World: all major basins ------------------------------------------------------------------

const majorItems = (c: BasinCtx, m: Measure): Ranked[] => [...c.majors].map(([id, a]) => ({ id, v: measureOf(c, m, a) }));
const subItems = (c: BasinCtx, m: Measure, ids: number[]): Ranked[] => ids.map((id) => ({ id, v: measureOf(c, m, c.stats.sub.get(id)!) }));
/** Shares of the period's precipitation volume (km³), in %. */
const shareItems = (items: [number, Totals][], total: number): Ranked[] => items.map(([id, a]) => ({ id, v: ((a.pcp * a.area * 1e-6) / total) * 100 }));
/** A measure's CSV column: "pcp_minus_aeti_mm_per_month". */
const columnOf = (c: BasinCtx, m: Measure) => `${m === "balance" ? "pcp_minus_aeti" : m}_${unitSlug(c.units)}`;

function rankingCard(id: string, title: (c: BasinCtx) => string, caption: string, m: Measure, order: "top" | "bottom", n = 10): BasinCard {
  const items = (c: BasinCtx) => {
    const raw = majorItems(c, m);
    return order === "bottom" ? raw.map((d) => ({ id: d.id, v: -d.v })) : raw;
  };
  const rows = (c: BasinCtx) =>
    rankRows(items(c), n, c.majorName, "major", c.major?.id ?? null).map((r) => (order === "bottom" ? { ...r, values: r.values.map((v) => -v) } : r));
  return {
    id,
    title,
    caption: () => caption,
    render(c) {
      const r = rows(c);
      return { html: bars({ series: [{ label: MEASURES[m].title, color: m === "aeti" ? C.aeti : C.balance }], rows: r, unit: unitOf(c), width: c.width }), csv: csvOf(r, columnOf(c, m)) };
    },
    map: (c) => majorMap(c, m),
  };
}

export const WORLD_CARDS: BasinCard[] = [
  rankingCard("w-wettest", (c) => `Wettest major basins, ${c.period}`, "Precipitation − evapotranspiration (PCP − AETI): the water left for rivers, lakes and aquifers. Hover a basin to pick it out on the map.", "balance", "top"),
  rankingCard("w-driest", (c) => `Driest major basins, ${c.period}`, "Where more water evaporates than falls as rain, the difference comes from storage or from upstream.", "balance", "bottom"),
  rankingCard("w-aet", (c) => `Highest evapotranspiration, ${c.period}`, "Actual evapotranspiration: water used by vegetation and evaporated from soil and open water.", "aeti", "top"),
  {
    id: "w-share",
    title: (c) => `Share of global precipitation, ${c.period}`,
    caption: () => "The major basins that receive the most rain, as a share of all precipitation on land. The map shows precipitation per basin.",
    render(c) {
      const total = [...c.majors.values()].reduce((s, a) => s + (Number.isFinite(a.pcpVolume) ? a.pcpVolume : 0), 0);
      const r = rankRows(shareItems([...c.majors], total), 10, c.majorName, "major", c.major?.id ?? null);
      return { html: bars({ series: [{ label: "%", color: C.pcp }], rows: r, unit: "%", width: c.width }), csv: csvOf(r, "share_pct") };
    },
    map: (c) => majorMap(c, "pcp"),
  },
  {
    id: "w-monthly",
    title: (c) => `Precipitation and evapotranspiration by month, ${c.period}`,
    caption: (c) => `${c.units.basin ? "Summed over all basins, in km³" : "Averaged over all basins, in mm"} per month (months at the ends of the range only count the days in it).`,
    render: monthlyChart,
    map: (c) => majorMap(c, "balance"),
  },
];

// --- A major basin: its sub-basins --------------------------------------------------------------

export const MAJOR_CARDS: BasinCard[] = [
  {
    id: "m-balance",
    title: (c) => `${c.major!.name}: sub-basins from wettest to driest`,
    caption: (c) => `${V.balance.short} per sub-basin, ${c.period}. Hover a sub-basin to outline it on the map.`,
    render(c) {
      const r = rankRows(subItems(c, "balance", subBasinsOf(c, c.major!.id)), 16, c.subName, "sub", c.sub?.id ?? null, true);
      return { html: bars({ series: [{ label: V.balance.short, color: C.balance }], rows: r, unit: unitOf(c), width: c.width }), csv: csvOf(r, columnOf(c, "balance")) };
    },
    map: (c) => subMap(c, "balance"),
  },
  {
    id: "m-aet",
    title: (c) => `${c.major!.name}: highest evapotranspiration`,
    caption: (c) => `${V.aeti.label} per sub-basin, ${c.period}.`,
    render(c) {
      const r = rankRows(subItems(c, "aeti", subBasinsOf(c, c.major!.id)), 10, c.subName, "sub", c.sub?.id ?? null);
      return { html: bars({ series: [{ label: V.aeti.short, color: C.aeti }], rows: r, unit: unitOf(c), width: c.width }), csv: csvOf(r, columnOf(c, "aeti")) };
    },
    map: (c) => subMap(c, "aeti"),
  },
  {
    id: "m-share",
    title: (c) => `${c.major!.name}: where the rain falls`,
    caption: (c) => `Each sub-basin's share of the basin's precipitation volume, ${c.period}. The map shows precipitation per sub-basin.`,
    render(c) {
      const ids = subBasinsOf(c, c.major!.id);
      const total = c.majors.get(c.major!.id)?.pcpVolume ?? NaN;
      const r = rankRows(shareItems(ids.map((id) => [id, c.stats.sub.get(id)!]), total), 10, c.subName, "sub", c.sub?.id ?? null);
      return { html: bars({ series: [{ label: "%", color: C.pcp }], rows: r, unit: "%", width: c.width }), csv: csvOf(r, "share_pct") };
    },
    map: (c) => subMap(c, "pcp"),
  },
  {
    id: "m-monthly",
    title: (c) => `${c.major!.name}: precipitation and evapotranspiration by month`,
    caption: (c) => `${c.units.basin ? "Summed over the basin, in km³" : "Averaged over the basin, in mm"} per month (months at the ends of the range only count the days in it).`,
    render: monthlyChart,
    map: (c) => subMap(c, "balance"),
  },
  {
    id: "m-scatter",
    title: (c) => `${c.major!.name}: precipitation against evapotranspiration`,
    caption: (c) => `One dot per sub-basin, ${c.period}. Above the line more evaporates than falls as rain. Hover a dot to outline it on the map.`,
    render(c) {
      const ids = subBasinsOf(c, c.major!.id);
      const points = ids.map((id) => {
        const s = c.stats.sub.get(id)!;
        return { sub: `sub:${id}`, label: c.subName(id), x: measureOf(c, "pcp", s), y: measureOf(c, "aeti", s), emphasis: id === c.sub?.id };
      });
      const u = unitSlug(c.units);
      const csv: (string | number)[][] = [["sub_basin", `pcp_${u}`, `aeti_${u}`], ...points.map((p) => [p.label, p.x, p.y])];
      return { html: scatter({ points, xName: V.pcp.label, yName: V.aeti.label, unit: unitOf(c), color: C.balance, width: c.width }), csv };
    },
    map: (c) => subMap(c, "balance"),
  },
];
