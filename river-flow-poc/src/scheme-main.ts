/*
 * The water balance scheme: a major basin's sub-basins as a diagram on the map, over a
 * period (a dekad, month or year, or the whole record) that a timeline steps through.
 *
 * - Storage change (ΔS): a dot in the middle of each sub-basin, its area the mean change,
 *   green when storage rises and red when it falls.
 * - Discharge (Q): a line from each sub-basin's dot through its outlet to the dot of the
 *   sub-basin it drains into, as wide as its mean outflow (linear, so widths add up
 *   where rivers join: sub-basins meeting at a confluence share the line below it, a Y).
 *   Where the basin leaves the scheme (the sea, an inland sink) the line goes on a
 *   little past the outlet, with an arrow. See Line in scheme/balance.ts.
 * - Precipitation (P) and evapotranspiration (ET): the sub-basins filled by P − ET, P or
 *   ET (the FAO sub-basin tiles, as in the portal).
 *
 * The scales are fixed for a basin (and, for ΔS and the fills, a kind of period), so
 * stepping through the periods shows the changes. Hovering anything shows the
 * sub-basin's balance.
 */
import type { PickingInfo } from "@deck.gl/core";
import { MVTLayer } from "@deck.gl/geo-layers";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import majorBasinsUrl from "@portal-data/major-basins.json?url";
import subBasinsUrl from "@portal-data/sub-basins.json?url";
import type { SubBasin } from "@portal/map/sub-basin-network";
import { basinBalance } from "./basin-model";
import {
  buildScheme,
  periodBalance,
  periods,
  quantile,
  toFlow,
  type Aggregation,
  type Balance,
  type Node,
  type Line,
  type NodeFile,
  type Period,
  type Scheme,
} from "./scheme/balance";
import "./style.css";

const SUB_BASIN_TILES = "https://storage.googleapis.com/fao-cog-data/basins/SDG6_SBM_v1_tiles/{z}/{x}/{y}.pbf";

/** Line width (px) of the basin's biggest mean outflow over the whole record. */
const Q_PX = 14;
const Q_MIN_PX = 0.8;
const Q_MAX_PX = 32;
/** Dot radius (px) of the 98th percentile of |ΔS| over the periods. */
const DS_PX = 13;
const DS_MIN_PX = 2.5;
const DS_MAX_PX = 22;
/** Playback: ms per period. */
const STEP_MS = 900;

type RGB = [number, number, number];
type Color = RGB | [number, number, number, number];
const Q_COLOR: RGB = [235, 242, 250];
const CASING: Color = [10, 14, 20, 200];
const RISE: RGB = [52, 199, 104];
const FALL: RGB = [235, 64, 70];

type Fill = "PmE" | "PCP" | "AETI" | "none";
const FILLS: Record<Exclude<Fill, "none">, { label: string; ramp: string[]; diverging: boolean }> = {
  // Dark to light on the dark basemap, so dry or low reads as background.
  PCP: { label: "P", ramp: ["#17283a", "#1d4a73", "#2a73b0", "#58a2e0", "#a9d3fa"], diverging: false },
  AETI: { label: "ET", ramp: ["#211a30", "#3f2f5c", "#664a8e", "#9775c0", "#d1b6f2"], diverging: false },
  // ET above P (water used from storage or brought in) brown, P above ET teal.
  PmE: { label: "P − ET", ramp: ["#a0641a", "#6b4a26", "#2b2f36", "#2b6a64", "#2fa597"], diverging: true },
};

interface MajorBasin {
  id: number;
  name: string;
  bbox: [number, number, number, number];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const basinSelect = $<HTMLSelectElement>("basin");
const aggregationSelect = $<HTMLSelectElement>("aggregation");
const fillSelect = $<HTMLSelectElement>("fill");
const timeline = $("timeline");
const playButton = $<HTMLButtonElement>("play");
const periodSlider = $<HTMLInputElement>("period");
const dateEl = $("date");

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [20, 5],
  zoom: 2.2,
  hash: true,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
  maxPitch: 0,
  renderWorldCopies: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
map.on("style.load", () => {
  // The scheme stands in for the rivers.
  for (const { id } of map.getStyle().layers) if (id.startsWith("waterway")) map.setLayoutProperty(id, "visibility", "none");
  map.addControl(overlay);
});

// --- State -----------------------------------------------------------------------------

let subBasins: SubBasin[] = [];
let majorBasins: MajorBasin[] = [];
let nodeFile: NodeFile = {};

interface Current {
  major: MajorBasin;
  model: Awaited<ReturnType<typeof basinBalance>>;
  scheme: Scheme;
  /** m³/s at Q_PX. */
  qRef: number;
  // For the aggregation picked:
  periods: Period[];
  balances: Map<number, Balance>[];
  /** |ΔS| at DS_PX, m³/s. */
  dsRef: number;
  /** Fill colour domains, mm/day. */
  domains: Record<Exclude<Fill, "none">, [number, number]>;
}

let current: Current | null = null;
let periodIndex = 0;
let fill: Fill = "PmE";
let timer = 0;
/** Bumped when the basin or the kind of period changes (deck.gl's updateTriggers). */
let version = 0;

const balance = (id: number) => current?.balances[periodIndex]?.get(id);

// --- Scales ----------------------------------------------------------------------------

const qWidth = (q: number) =>
  current && Number.isFinite(q) && q > 0 ? Math.min(Q_MAX_PX, Math.max(Q_MIN_PX, (q / current.qRef) * Q_PX)) : 0;
const dsRadius = (ds: number) =>
  current && Number.isFinite(ds) ? Math.min(DS_MAX_PX, Math.max(DS_MIN_PX, Math.sqrt(Math.abs(ds) / current.dsRef) * DS_PX)) : 0;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

/** The ramp's colour at t (0–1). */
function rampColor(ramp: string[], t: number): RGB {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const [a, b] = [hex(ramp[i]), hex(ramp[i + 1])];
  return a.map((c, k) => Math.round(c + (b[k] - c) * (x - i))) as RGB;
}

function fillValue(b: Balance, f: Exclude<Fill, "none">) {
  return f === "PmE" ? b.PCP - b.AETI : b[f];
}

function fillColor(id: number): Color {
  const b = balance(id);
  if (!current || !b || fill === "none") return [0, 0, 0, 0];
  const value = fillValue(b, fill);
  if (!Number.isFinite(value)) return [60, 60, 60, 120];
  const [lo, hi] = current.domains[fill];
  return [...rampColor(FILLS[fill].ramp, (value - lo) / (hi - lo)), 200];
}

// --- Layers ----------------------------------------------------------------------------

const ARROW = {
  url:
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M4 8 L62 32 L4 56 L18 32 Z" fill="#fff"/></svg>'),
  width: 64,
  height: 64,
  anchorX: 18,
  anchorY: 32,
  mask: true,
};

function layers() {
  if (!current) return [];
  const { scheme } = current;
  const lineWidth = (line: Line) => qWidth(line.from.reduce((sum, id) => sum + (balance(id)?.Q ?? NaN), 0));
  const triggers = { version, periodIndex, fill };
  const mouths = scheme.lines.filter((l) => l.kind === "mouth");
  return [
    new MVTLayer({
      id: "sub-basins",
      data: SUB_BASIN_TILES,
      minZoom: 0,
      maxZoom: 8,
      onTileError: () => {}, // no files for empty tiles: 404 means nothing there
      uniqueIdProperty: "SDG6_SB_ID",
      getFillColor: (f: { properties: { SDG6_SB_ID: number } }) => fillColor(f.properties.SDG6_SB_ID),
      getLineColor: (f: { properties: { SDG6_SB_ID: number } }) =>
        scheme.nodes.has(f.properties.SDG6_SB_ID) ? [255, 255, 255, 45] : [0, 0, 0, 0],
      lineWidthUnits: "pixels",
      getLineWidth: 0.6,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 35],
      updateTriggers: { getFillColor: triggers, getLineColor: version },
    }),
    // A dark edge, so the lines read over any fill.
    new PathLayer({
      id: "q-casing",
      data: scheme.lines,
      getPath: (d) => d.path,
      getWidth: (d) => (lineWidth(d) ? lineWidth(d) + 2 : 0),
      getColor: CASING,
      widthUnits: "pixels",
      capRounded: true,
      updateTriggers: { getWidth: triggers },
    }),
    new PathLayer({
      id: "q",
      data: scheme.lines,
      getPath: (d) => d.path,
      getWidth: lineWidth,
      getColor: Q_COLOR,
      widthUnits: "pixels",
      capRounded: true,
      pickable: true,
      updateTriggers: { getWidth: triggers },
    }),
    new IconLayer({
      id: "mouths",
      data: mouths,
      getIcon: () => ARROW,
      getPosition: (d) => d.path[1],
      getAngle: (d) => {
        const [dx, dy] = scheme.nodes.get(d.in)!.direction;
        return (Math.atan2(dy, dx) * 180) / Math.PI;
      },
      getSize: (d) => Math.min(40, 12 + lineWidth(d)),
      getColor: Q_COLOR,
      sizeUnits: "pixels",
      pickable: true,
      updateTriggers: { getSize: triggers },
    }),
    new ScatterplotLayer({
      id: "ds",
      data: [...scheme.nodes.values()],
      getPosition: (n: Node) => n.position,
      getRadius: (n: Node) => dsRadius(balance(n.id)?.dS ?? NaN),
      getFillColor: (n: Node) => ((balance(n.id)?.dS ?? 0) >= 0 ? RISE : FALL),
      getLineColor: CASING,
      radiusUnits: "pixels",
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      pickable: true,
      updateTriggers: { getRadius: triggers, getFillColor: triggers },
    }),
  ];
}

function redraw() {
  overlay.setProps({ layers: layers() });
}

// --- Tooltip ---------------------------------------------------------------------------

const fmt = (x: number) =>
  !Number.isFinite(x)
    ? "–"
    : Math.abs(x) >= 100
      ? Math.round(x).toLocaleString("en")
      : Math.abs(x) >= 1
        ? x.toFixed(1)
        : x === 0
          ? "0"
          : x.toPrecision(2);

function getTooltip({ object, layer }: PickingInfo) {
  if (!current || !object || !layer) return null;
  const id: number | undefined = layer.id.startsWith("sub-basins") ? object.properties?.SDG6_SB_ID : (object.in ?? object.id);
  const node = id === undefined ? undefined : current.scheme.nodes.get(id);
  const b = node && balance(node.id);
  if (!node || !b) return null;
  const down = node.downstream !== null ? current.scheme.nodes.get(node.downstream)!.name : node.mouth === "sea" ? "the sea" : node.mouth === "sink" ? "an inland sink" : "outside the model";
  const p = toFlow(b.PCP, node.area);
  const et = toFlow(b.AETI, node.area);
  const n = node.upstream.length;
  const row = (sign: string, label: string, value: number, note: string) =>
    `<tr><td>${sign}</td><td>${label}</td><td class="num">${fmt(value)}</td><td class="muted">${note}</td></tr>`;
  return {
    html: `<strong>${node.name}</strong> <span class="muted">${Math.round(node.area).toLocaleString("en")} km²</span><br>
      <span class="muted">${current.periods[periodIndex].label}, means in m³/s</span>
      <table class="balance">
        ${row("", "Q in", b.Qin, n ? `from ${n} sub-basin${n > 1 ? "s" : ""}` : "headwater")}
        ${row("+", "P", p, `${fmt(b.PCP)} mm/day`)}
        ${row("−", "ET", et, `${fmt(b.AETI)} mm/day`)}
        ${row("−", "ΔS", b.dS, b.dS >= 0 ? "storage rises" : "storage falls")}
        <tr class="total"><td>=</td><td>Q out</td><td class="num">${fmt(b.Q)}</td><td class="muted">to ${down}</td></tr>
      </table>`,
    className: "tooltip",
  };
}

// --- Legend ----------------------------------------------------------------------------

/** A round number at or below x (1, 2 or 5 × a power of ten). */
function nice(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= x) ?? p;
}

const svgText = (x: number, y: number, text: string) => `<text x="${x}" y="${y}">${text}</text>`;

function buildLegend() {
  const qKey = $("q-key");
  const dsKey = $("ds-key");
  const fillLegend = $("fill-legend");
  if (!current) {
    qKey.innerHTML = dsKey.innerHTML = "";
    fillLegend.hidden = true;
    return;
  }
  // Q: three widths.
  const top = nice(current.qRef * 1.5);
  qKey.innerHTML = [top / 10, top / 2, top]
    .map((q, i) => {
      const x = i * 90;
      const w = qWidth(q);
      return `<line x1="${x + 2}" y1="16" x2="${x + 40}" y2="16" stroke="rgb(${Q_COLOR.join(",")})" stroke-width="${w}"/>` +
        svgText(x + 46, 20, fmt(q));
    })
    .join("") + svgText(0, 42, "m³/s");
  // ΔS: two sizes, rising and falling.
  const ds = nice(current.dsRef);
  dsKey.innerHTML = [
    [ds / 4, RISE, "+"],
    [ds, RISE, "+"],
    [ds, FALL, "−"],
  ]
    .map(([v, color, sign], i) => {
      const x = i * 90 + 14;
      const r = dsRadius(v as number);
      return `<circle cx="${x}" cy="16" r="${r}" fill="rgb(${(color as RGB).join(",")})" stroke="#0a0e14"/>` +
        svgText(x + 18, 20, `${sign}${fmt(v as number)}`);
    })
    .join("") + svgText(0, 42, "m³/s");
  // The fill.
  fillLegend.hidden = fill === "none";
  if (fill === "none") return;
  const { ramp } = FILLS[fill];
  const [lo, hi] = current.domains[fill];
  $("fill-ramp").style.background = `linear-gradient(to right, ${ramp.join(", ")})`;
  $("fill-ticks").innerHTML = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => `<span>${fmt(lo + (hi - lo) * t)}${t === 1 ? " mm/day" : ""}</span>`)
    .join("");
}

// --- Periods ---------------------------------------------------------------------------

function setAggregation(aggregation: Aggregation) {
  if (!current) return;
  const { model, scheme } = current;
  version++;
  current.periods = periods(model.dekads, aggregation);
  current.balances = current.periods.map((p) => periodBalance(model, scheme, p));
  const all = current.balances.flatMap((m) => [...m.values()]);
  current.dsRef = quantile(all.map((b) => Math.abs(b.dS)), 0.98) || 1;
  const top = (values: number[]) => quantile(values, 0.98) || 1;
  const pme = top(all.map((b) => Math.abs(b.PCP - b.AETI)));
  current.domains = {
    PCP: [0, top(all.map((b) => b.PCP))],
    AETI: [0, top(all.map((b) => b.AETI))],
    PmE: [-pme, pme],
  };
  periodSlider.max = String(current.periods.length - 1);
  timeline.hidden = current.periods.length < 2;
  // The latest whole period.
  const whole = current.periods.findLastIndex((p) => !p.partial);
  showPeriod(whole >= 0 ? whole : current.periods.length - 1);
  buildLegend();
}

function showPeriod(i: number) {
  if (!current) return;
  periodIndex = i;
  periodSlider.value = String(i);
  dateEl.textContent = current.periods[i].label;
  redraw();
}

function setPlaying(on: boolean) {
  clearInterval(timer);
  timer = 0;
  if (on && current) {
    timer = window.setInterval(() => showPeriod((periodIndex + 1) % current!.periods.length), STEP_MS);
  }
  playButton.textContent = on ? "❚❚" : "▶";
  playButton.setAttribute("aria-label", on ? "Pause" : "Play");
}

// --- Basin selection -------------------------------------------------------------------

async function selectBasin(major: MajorBasin | null) {
  setPlaying(false);
  const url = new URL(location.href);
  if (major) url.searchParams.set("basin", String(major.id));
  else url.searchParams.delete("basin");
  history.replaceState(null, "", url);
  current = null;
  redraw();
  buildLegend();
  timeline.hidden = true;
  if (!major) {
    statusEl.textContent = "Pick a major basin to see its water balance.";
    return;
  }
  const [w, s, e, n] = major.bbox;
  map.fitBounds([w, s, e, n], { padding: { top: 60, bottom: 100, left: 340, right: 60 }, duration: 1200 });
  const count = subBasins.filter((b) => b.majorBasin === major.id).length;
  statusEl.textContent = `Running FAO's water balance model for ${major.name} (${count} sub-basins)…`;
  statusEl.classList.add("busy");
  try {
    const t0 = performance.now();
    const model = await basinBalance(major.id, subBasins);
    if (Number(basinSelect.value) !== major.id) return;
    if (!model.dekads.length) throw new Error("the model returned no dekads");
    const scheme = buildScheme(model, subBasins, nodeFile);
    const nodes = [...scheme.nodes.values()];
    const whole = periodBalance(model, scheme, { label: "", from: 0, to: model.dekads.length, partial: false });
    current = {
      major,
      model,
      scheme,
      qRef: Math.max(...[...whole.values()].map((b) => b.Q).filter(Number.isFinite)) || 1,
      periods: [],
      balances: [],
      dsRef: 1,
      domains: { PCP: [0, 1], AETI: [0, 1], PmE: [-1, 1] },
    };
    const unplaced = nodes.filter((n) => !n.outlet).length;
    statusEl.textContent =
      `${major.name}: ${nodes.length} sub-basins (with any upstream of it), ${model.dekads.length} dekads, ` +
      `${((performance.now() - t0) / 1000).toFixed(1)} s.` +
      (unplaced ? ` ${unplaced} without a river ${unplaced > 1 ? "have" : "has"} no outlet: ${unplaced > 1 ? "their lines go" : "its line goes"} straight from the dot.` : "");
    setAggregation(aggregationSelect.value as Aggregation);
  } catch (err) {
    if (Number(basinSelect.value) !== major.id) return;
    statusEl.textContent = `The model failed: ${(err as Error).message}`;
  } finally {
    statusEl.classList.remove("busy");
  }
}

// --- Controls --------------------------------------------------------------------------

basinSelect.addEventListener("change", () => {
  const id = Number(basinSelect.value);
  void selectBasin(majorBasins.find((b) => b.id === id) ?? null);
});
aggregationSelect.addEventListener("change", () => {
  setPlaying(false);
  setAggregation(aggregationSelect.value as Aggregation);
});
fillSelect.addEventListener("change", () => {
  fill = fillSelect.value as Fill;
  buildLegend();
  redraw();
});
playButton.addEventListener("click", () => setPlaying(!timer));
periodSlider.addEventListener("input", () => {
  setPlaying(false);
  showPeriod(Number(periodSlider.value));
});

// --- Start -----------------------------------------------------------------------------

async function start() {
  statusEl.textContent = "Loading the sub-basins…";
  statusEl.classList.add("busy");
  const [majors, subs, file] = await Promise.all([
    fetch(majorBasinsUrl).then((r) => r.json() as Promise<MajorBasin[]>),
    fetch(subBasinsUrl).then((r) => r.json() as Promise<SubBasin[]>),
    fetch(`${import.meta.env.BASE_URL}data/nodes.json`).then((r) => {
      if (!r.ok) throw new Error(`Couldn't load the sub-basins' middles and outlets (${r.status}); run npm run nodes`);
      return r.json() as Promise<NodeFile>;
    }),
  ]);
  statusEl.classList.remove("busy");
  majorBasins = majors.sort((a, b) => a.name.localeCompare(b.name));
  subBasins = subs;
  nodeFile = file;
  for (const b of majorBasins) basinSelect.add(new Option(b.name, String(b.id)));
  fill = fillSelect.value as Fill;
  const wanted = majorBasins.find((b) => b.id === Number(new URLSearchParams(location.search).get("basin")));
  if (wanted) basinSelect.value = String(wanted.id);
  await selectBasin(wanted ?? null);
}

start().catch((err) => {
  statusEl.classList.remove("busy");
  statusEl.textContent = (err as Error).message;
  console.error(err);
});
