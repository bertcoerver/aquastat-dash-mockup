/*
 * The Basin view's chart cards, after the Basin tab of FAO's Water Portal (see
 * waterportal-inventory/), and the map that goes with each:
 *
 * - no basin selected: the major basins of the world, and the world's sub-basins;
 * - a major basin (or one of its sub-basins) selected: that basin's sub-basins.
 *
 * Everything is over the date range in the top bar: precipitation (P) and actual
 * evapotranspiration (AET) totals in mm, and P − AET, the water a basin has left for
 * runoff and storage. Volumes are depth × area.
 */
import { bars, lines, scatter, type BarRow, type LineSeries } from "../country/charts";
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
}

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
  note: string;
  /** Which basins are coloured. */
  level: "major" | "sub";
  value(id: number): number;
  ramp: string[];
  scale: "linear" | "log" | "diverging";
  /** Only these basins are coloured (null: all of the level). */
  only: Set<number> | null;
  /** Basins named in the chart (outlined on the map, sub-basins only). */
  listed?: number[];
}

export interface BasinCard {
  id: string;
  title(c: BasinCtx): string;
  caption(c: BasinCtx): string;
  render(c: BasinCtx): { html: string; csv: (string | number)[][] };
  map(c: BasinCtx, sub: string | null): BasinMapSpec;
}

const C = { pcp: "var(--c-pcp)", aeti: "var(--c-aeti)", balance: "var(--c-1)", now: "var(--c-now)" };
// Brown (less rain than evaporation) to teal (more), around a neutral grey.
const BALANCE_RAMP = ["#8c510a", "#bf812d", "#dfc27d", "#e3e1dc", "#80cdc1", "#35978f", "#01665e"];
const VOLUME_RAMP = ["#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"];

/** Sum P and AET of a set of sub-basins (area-weighted depths, summed volumes). */
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

type Measure = "balance" | "aeti" | "pcp" | "volume";

const MEASURES: Record<Measure, { title: string; unit: string; ramp: string[]; scale: BasinMapSpec["scale"] }> = {
  balance: { title: "Precipitation minus evapotranspiration", unit: "mm", ramp: BALANCE_RAMP, scale: "diverging" },
  aeti: { title: "Actual evapotranspiration", unit: "mm", ramp: STYLES.AETI.ramp, scale: "linear" },
  pcp: { title: "Precipitation", unit: "mm", ramp: STYLES.PCP.ramp, scale: "linear" },
  volume: { title: "Precipitation volume", unit: "km³", ramp: VOLUME_RAMP, scale: "log" },
};

const measureOf = (m: Measure, a: { pcp: number; aeti: number; area: number }) =>
  m === "balance" ? a.pcp - a.aeti : m === "aeti" ? a.aeti : m === "pcp" ? a.pcp : a.pcp * a.area * 1e-6;

function majorMap(c: BasinCtx, m: Measure, extra: Partial<BasinMapSpec> = {}): BasinMapSpec {
  const s = MEASURES[m];
  return {
    id: `major:${m}`,
    ...s,
    note: m === "balance" ? "Brown: more evaporates than falls · teal: water left over" : "Total per major basin",
    level: "major",
    value: (id) => {
      const a = c.majors.get(id);
      return a ? measureOf(m, a) : NaN;
    },
    only: null,
    ...extra,
  };
}

function subMap(c: BasinCtx, m: Measure, extra: Partial<BasinMapSpec> = {}): BasinMapSpec {
  const s = MEASURES[m];
  const only = c.major ? new Set(subBasinsOf(c, c.major.id)) : null;
  return {
    id: `sub:${m}:${c.major?.id ?? "all"}`,
    ...s,
    note: m === "balance" ? "Brown: more evaporates than falls · teal: water left over" : "Total per sub-basin",
    level: "sub",
    value: (id) => {
      const st = c.stats.sub.get(id);
      return st ? measureOf(m, st) : NaN;
    },
    only,
    ...extra,
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

function monthlyChart(c: BasinCtx) {
  const m = c.monthly;
  if (!m) return { html: `<p class="ch-empty">Loading the monthly cycle…</p>`, csv: [] };
  if (!m.months.length) return { html: `<p class="ch-empty">No data</p>`, csv: [] };
  const at = (values: number[]) => new Map(m.months.map((mo, i) => [mo, values[i]]));
  const series: LineSeries[] = [
    { label: "Precipitation", color: C.pcp, values: at(m.pcp) },
    { label: "Evapotranspiration", color: C.aeti, values: at(m.aeti) },
    { label: "P − AET", color: C.balance, values: at(m.pcp.map((p, i) => p - m.aeti[i])), emphasis: true },
  ];
  const label = (mo: number) => `${MONTHS[mo % 12]}${mo % 12 === 0 || m.months.length <= 12 ? ` ${String(MIN_YEAR + Math.floor(mo / 12)).slice(2)}` : ""}`;
  const html = lines({
    series,
    from: m.months[0],
    to: m.months[m.months.length - 1],
    selected: NaN,
    unit: "mm/month",
    width: c.width,
    clickable: () => false,
    label,
  });
  const csv: (string | number)[][] = [["month", "precipitation_mm", "aet_mm", "p_minus_aet_mm"]];
  m.months.forEach((mo, i) => csv.push([`${MIN_YEAR + Math.floor(mo / 12)}-${String((mo % 12) + 1).padStart(2, "0")}`, m.pcp[i], m.aeti[i], m.pcp[i] - m.aeti[i]]));
  return { html, csv };
}

// --- World: all major basins ------------------------------------------------------------------

const majorItems = (c: BasinCtx, m: Measure): Ranked[] => [...c.majors].map(([id, a]) => ({ id, v: measureOf(m, a) }));
const subItems = (c: BasinCtx, m: Measure, ids?: number[]): Ranked[] =>
  (ids ?? [...c.stats.sub.keys()]).map((id) => ({ id, v: measureOf(m, c.stats.sub.get(id)!) }));

function rankingCard(
  id: string,
  title: (c: BasinCtx) => string,
  caption: string,
  level: "major" | "sub",
  m: Measure,
  order: "top" | "bottom",
  n = 10,
): BasinCard {
  const items = (c: BasinCtx) => {
    const raw = level === "major" ? majorItems(c, m) : subItems(c, m);
    return order === "bottom" ? raw.map((d) => ({ id: d.id, v: -d.v })) : raw;
  };
  const rows = (c: BasinCtx) =>
    rankRows(items(c), n, level === "major" ? c.majorName : c.subName, level, level === "major" ? c.major?.id ?? null : c.sub?.id ?? null)
      .map((r) => (order === "bottom" ? { ...r, values: r.values.map((v) => -v) } : r));
  return {
    id,
    title,
    caption: () => caption,
    render(c) {
      const r = rows(c);
      return { html: bars({ series: [{ label: MEASURES[m].title, color: m === "aeti" ? C.aeti : C.balance }], rows: r, unit: "mm", width: c.width }), csv: csvOf(r, `${m}_mm`) };
    },
    map: (c) => {
      const listed = level === "sub" ? rows(c).filter((r) => !r.gap).map((r) => Number(r.sub.split(":")[1])) : undefined;
      return level === "major" ? majorMap(c, m) : subMap(c, m, { listed });
    },
  };
}

export const WORLD_CARDS: BasinCard[] = [
  rankingCard("w-wettest", (c) => `Wettest major basins, ${c.period}`, "Precipitation minus actual evapotranspiration (P − AET): the water left for rivers, lakes and aquifers. Hover a basin to pick it out on the map.", "major", "balance", "top"),
  rankingCard("w-driest", (c) => `Driest major basins, ${c.period}`, "Where more water evaporates than falls as rain, the difference comes from storage or from upstream.", "major", "balance", "bottom"),
  rankingCard("w-aet", (c) => `Highest evapotranspiration, ${c.period}`, "Actual evapotranspiration: water used by vegetation and evaporated from soil and open water.", "major", "aeti", "top"),
  {
    id: "w-share",
    title: (c) => `Share of global precipitation, ${c.period}`,
    caption: () => "The major basins that receive the most rain, as a share of all precipitation on land. The map shows the volume per basin.",
    render(c) {
      const total = [...c.majors.values()].reduce((s, a) => s + (Number.isFinite(a.pcpVolume) ? a.pcpVolume : 0), 0);
      const r = rankRows(majorItems(c, "volume").map((d) => ({ id: d.id, v: (d.v / total) * 100 })), 10, c.majorName, "major", c.major?.id ?? null);
      return { html: bars({ series: [{ label: "%", color: C.pcp }], rows: r, unit: "%", width: c.width }), csv: csvOf(r, "share_pct") };
    },
    map: (c) => majorMap(c, "volume"),
  },
  {
    id: "w-monthly",
    title: (c) => `Precipitation and evapotranspiration by month, ${c.period}`,
    caption: () => "Averaged over all basins, in mm per month (months at the ends of the range only count the days in it).",
    render: monthlyChart,
    map: (c) => majorMap(c, "balance"),
  },
  rankingCard("w-sub-wettest", (c) => `Wettest sub-basins, ${c.period}`, "P − AET of the world's ~7,600 sub-basins. They are small, so the map outlines them.", "sub", "balance", "top"),
  rankingCard("w-sub-driest", (c) => `Driest sub-basins, ${c.period}`, "The sub-basins with the largest deficit (P − AET below zero).", "sub", "balance", "bottom"),
  rankingCard("w-sub-aet", (c) => `Sub-basins with the highest evapotranspiration, ${c.period}`, "Actual evapotranspiration per sub-basin.", "sub", "aeti", "top"),
];

// --- A major basin: its sub-basins --------------------------------------------------------------

export const MAJOR_CARDS: BasinCard[] = [
  {
    id: "m-balance",
    title: (c) => `${c.major!.name}: sub-basins from wettest to driest`,
    caption: (c) => `P − AET per sub-basin, ${c.period}. Hover a sub-basin to outline it on the map.`,
    render(c) {
      const r = rankRows(subItems(c, "balance", subBasinsOf(c, c.major!.id)), 16, c.subName, "sub", c.sub?.id ?? null, true);
      return { html: bars({ series: [{ label: "P − AET", color: C.balance }], rows: r, unit: "mm", width: c.width }), csv: csvOf(r, "p_minus_aet_mm") };
    },
    map: (c) => subMap(c, "balance"),
  },
  {
    id: "m-aet",
    title: (c) => `${c.major!.name}: highest evapotranspiration`,
    caption: (c) => `Actual evapotranspiration per sub-basin, ${c.period}.`,
    render(c) {
      const r = rankRows(subItems(c, "aeti", subBasinsOf(c, c.major!.id)), 10, c.subName, "sub", c.sub?.id ?? null);
      return { html: bars({ series: [{ label: "AET", color: C.aeti }], rows: r, unit: "mm", width: c.width }), csv: csvOf(r, "aet_mm") };
    },
    map: (c) => subMap(c, "aeti"),
  },
  {
    id: "m-share",
    title: (c) => `${c.major!.name}: where the rain falls`,
    caption: (c) => `Each sub-basin's share of the basin's precipitation volume, ${c.period}. The map shows precipitation depth.`,
    render(c) {
      const ids = subBasinsOf(c, c.major!.id);
      const total = c.majors.get(c.major!.id)?.pcpVolume ?? NaN;
      const r = rankRows(subItems(c, "volume", ids).map((d) => ({ id: d.id, v: (d.v / total) * 100 })), 10, c.subName, "sub", c.sub?.id ?? null);
      return { html: bars({ series: [{ label: "%", color: C.pcp }], rows: r, unit: "%", width: c.width }), csv: csvOf(r, "share_pct") };
    },
    map: (c) => subMap(c, "pcp"),
  },
  {
    id: "m-monthly",
    title: (c) => `${c.major!.name}: precipitation and evapotranspiration by month`,
    caption: () => "Averaged over the basin, in mm per month (months at the ends of the range only count the days in it).",
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
        return { sub: `sub:${id}`, label: c.subName(id), x: s.pcp, y: s.aeti, emphasis: id === c.sub?.id };
      });
      const csv: (string | number)[][] = [["sub_basin", "precipitation_mm", "aet_mm"], ...points.map((p) => [p.label, p.x, p.y])];
      return { html: scatter({ points, xName: "Precipitation", yName: "Evapotranspiration", unit: "mm", color: C.balance, width: c.width }), csv };
    },
    map: (c) => subMap(c, "balance"),
  },
];
