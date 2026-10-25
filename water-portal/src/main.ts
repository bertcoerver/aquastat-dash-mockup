import { initBasinStats } from "./basin/basin-stats";
import { loadModelFiles } from "./basin/model";
import { MODEL_SHOWN, initWaterBalance } from "./basin/water-balance";
import { initCountryPanel, type CountryInfo } from "./country/country-panel";
import {
  WAPOR_VARIABLES,
  checkedWaporPeriod,
  onWaporLevel,
  onWaporTile,
  onWaporTiles,
  waporPeriod,
  waporShownLevel,
  waporViewRange,
  type CheckedWaporPeriod,
  type WaporLevel,
  type WaporPeriod,
  type WaporStretch,
  type WaporTiles,
} from "./map/layers/wapor";
import type { WaporRamp } from "./map/layers/wapor-shader";
import { createMap } from "./map/map";
import { placeAt, type LngLat } from "./map/places";
import { upstreamFinder, type SubBasin } from "./map/sub-basin-network";
import { NOTHING, selection, type SelectionSource } from "./selection";
import { initLocalPanel } from "./local/local-panel";
import { waporPixelArea } from "./local/point-series";
import { initWaporLegend } from "./map/wapor-legend";
import { DEFAULT_PLAYBACK, initWaporPlayer, type PlaybackSettings, type PlaybackStatus } from "./map/wapor-player";
import { debugNumber, initDebugPanel } from "./panels/debug-panel";
import { makeResizable } from "./panels/floating";
import { initLayersMenu } from "./panels/layers-menu";
import { initLoadingIndicator } from "./panels/loading-indicator";
import { initThemeSwitch } from "./panels/theme-switch";
import { fmtDay, mk } from "./toolbar/dekads";
import { initPlacePicker, type Country, type MajorBasin } from "./toolbar/place-picker";
import { initToolbar, type Toolbar, type ToolbarState } from "./toolbar/toolbar";
import { isCountryYear, type DayRange, type View } from "./toolbar/range-rules";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/toolbar.css";
import "./styles/map.css";
import "./styles/panels.css";
import "./styles/legend.css";
import "./styles/basin.css";
import "./styles/country.css";

// First, so it counts every request from here on.
initLoadingIndicator();

const dark = initThemeSwitch();
const debug = initDebugPanel(["click", "time", "wapor", "series", "hover"]);
const round = (v: number) => Math.round(v * 1e4) / 1e4;

// Hover: what's under the pointer, shown in the debug window; in the Basin view, with
// the water balance model shown, the map also shades the sub-basin there and
// everything upstream of it. Only the latest
// lookup is shown, as tiles can arrive out of order while the pointer moves.
let view: View = "country";
let hovered: LngLat | null = null;
async function showHover(lngLat: LngLat | null) {
  hovered = lngLat;
  if (!lngLat) {
    setHoveredSubBasin(null);
    waterBalance.hover(null);
    countryPanel.hover(null);
    basinStats.hover(null);
    return debug("hover", null);
  }
  const place = await placeAt(lngLat);
  if (hovered !== lngLat) return;
  const upstream = place.subBasin && upstreamOf(place.subBasin.id);
  waterBalance.hover(view === "basin" ? (place.subBasin?.id ?? null) : null);
  countryPanel.hover(view === "country" ? (place.country?.m49 ?? null) : null);
  basinStats.hover(view === "basin" ? place : null);
  setHoveredSubBasin(MODEL_SHOWN && view === "basin" && place.subBasin ? { id: place.subBasin.id, upstream: upstream! } : null);
  debug("hover", {
    lon: round(lngLat[0]),
    lat: round(lngLat[1]),
    ...place,
    upstream: upstream && { count: upstream.size, ids: [...upstream] },
  });
}

// Sub-basins can only be selected for the water balance model; without it, picking a
// sub-basin (by name or on the map) selects its major basin.
const subBasinOf = <T>(subBasin: T | null): T | null => (MODEL_SHOWN ? subBasin : null);

// Selecting a point (map click or typed coordinates) selects everything it lies in.
let pointWanted: LngLat | null = null;
async function selectPoint(lngLat: LngLat | null, source: SelectionSource) {
  pointWanted = lngLat;
  if (!lngLat) return selection.set(NOTHING);
  const place = await placeAt(lngLat);
  if (pointWanted !== lngLat) return;
  selection.set({ source, lngLat, ...place, subBasin: subBasinOf(place.subBasin) });
}

const waterMap = createMap(
  document.getElementById("map")!,
  {
    dark,
    // A click on the ocean (no country or basin) clears the selection.
    onClick: (lngLat, onArea) => selectPoint(onArea ? lngLat : null, "map"),
    onMarkerDrop: (lngLat) => selectPoint(lngLat, "map"),
    onHover: showHover,
  },
);
const { map, setView, setLayerVisible, setWapor, setWaporMaxGap, setWaporRamp, setSelection, showBox, showPoint, setHoveredSubBasin } =
  waterMap;

const [countries, basins, subBasins, countryInfo] = await Promise.all([
  loadList<Country>("countries"),
  loadList<MajorBasin>("major-basins"),
  loadList<SubBasin>("sub-basins"),
  loadData<CountryInfo>("country-info"),
]);
const upstreamOf = upstreamFinder(subBasins);
// Basin view: the water balance model for the selected sub-basin (map colours, panel).
let toolbarApi: Toolbar | null = null;
const waterBalance = initWaterBalance({
  map: waterMap,
  subBasins,
  upstreamOf,
  setRange: (range) => toolbarApi?.setRange(range),
});
// Basin view: statistics charts below the model, each with its map.
const basinStats = initBasinStats({
  map: waterMap,
  majorBasins: basins,
  subBasins,
  setMapOverride: (override) => waterBalance.setMapOverride(override),
});
// Country view: AQUASTAT statistics for the selected country (panel, map colours).
const countryPanel = initCountryPanel({
  map: waterMap,
  info: countryInfo,
  names: new Map(countries.map((c) => [c.m49, c.name])),
  boxes: new Map(countries.map((c) => [c.m49, c.bbox])),
  canSelect: isCountryYear,
  onLatestYear: (year) => toolbarApi?.setCountryLastYear(year),
  setYear: (year) => toolbarApi?.setRange({ start: mk(year, 0, 0), end: mk(year, 0, 0) + 35 }),
});
const picker = initPlacePicker({
  countries,
  basins,
  subBasins,
  // Picking a country or basin by name selects only that: no point, no other areas
  // (but a sub-basin comes with the major basin it is part of).
  onCountry(country) {
    pointWanted = null;
    selection.set(country ? { ...NOTHING, source: "country", country: { m49: country.m49, name: country.name } } : NOTHING);
    if (country) showBox(country.bbox);
  },
  onBasin(picked) {
    pointWanted = null;
    if (!picked) return selection.set(NOTHING);
    const major = picked.kind === "major" ? picked.basin : picked.majorBasin;
    selection.set({
      ...NOTHING,
      source: "basin",
      majorBasin: { id: major.id, name: major.name },
      subBasin: picked.kind === "sub" ? subBasinOf({ id: picked.basin.id, name: picked.basin.name }) : null,
    });
    showBox((picked.kind === "sub" && !MODEL_SHOWN ? picked.majorBasin : picked.basin).bbox);
  },
  onPoint(lngLat) {
    selectPoint(lngLat, "coordinates");
    if (lngLat) showPoint(lngLat, Math.max(map.getZoom(), 5), "ease");
  },
});

selection.subscribe((s) => {
  setSelection({
    lngLat: s.lngLat,
    country: s.country?.m49 ?? null,
    majorBasin: s.majorBasin?.id ?? null,
    subBasin: s.subBasin?.id ?? null,
  });
  picker.show(s);
  waterBalance.setSelection(s);
  countryPanel.setSelection(s);
  basinStats.setSelection(s);
  localPanel.setSelection(s);
  debug("click", {
    source: s.source,
    lon: s.lngLat && round(s.lngLat[0]),
    lat: s.lngLat && round(s.lngLat[1]),
    country: s.country,
    majorBasin: s.majorBasin,
    subBasin: s.subBasin,
  });
});

function loadList<T>(name: string): Promise<T[]> {
  return loadData<T[]>(name);
}

async function loadData<T>(name: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${name}.json`);
  return response.json();
}

// The graph panes (one per view, one shows at a time) share a width that can be changed.
const $ = (id: string) => document.getElementById(id)!;
for (const id of ["cp-panel", "wb-panel", "lp-panel"]) makeResizable($(id), "side-panel");

// The loading spinner and the Layers button go with the map's controls, above zoom
// (MapLibre stacks later bottom controls on top).
for (const id of ["layers-menu", "map-loading"]) {
  const box = document.createElement("div");
  box.className = "maplibregl-ctrl maplibregl-ctrl-group";
  box.append($(id));
  waterMap.map.addControl({ onAdd: () => box, onRemove: () => box.remove() }, "bottom-right");
}

// The date range goes in the middle of the strip along the bottom between the graph
// pane (when it reaches down there) and the map's controls. (Not the credits: the
// pane would move each time they're opened or closed; it goes over them instead.)
const controls = document.querySelector<HTMLElement>(".maplibregl-ctrl-bottom-right .maplibregl-ctrl-group")!;
const graphPanes = ["cp-panel", "wb-panel", "lp-panel"].map($);
function fitRange() {
  let left = 0;
  for (const pane of graphPanes) {
    const r = pane.getBoundingClientRect();
    if (r.width > 0 && r.bottom > window.innerHeight - 120) left = Math.max(left, r.right);
  }
  const right = window.innerWidth - controls.getBoundingClientRect().left;
  document.documentElement.style.setProperty("--range-left", `${Math.round(left)}px`);
  document.documentElement.style.setProperty("--range-right", `${Math.round(right)}px`);
}
const rangeObserver = new ResizeObserver(fitRange);
for (const pane of graphPanes) rangeObserver.observe(pane);
window.addEventListener("resize", fitRange);

const layersMenu = initLayersMenu(setLayerVisible);

/**
 * Local view: a WaPOR variable (picked in the legend) for the selected range, one
 * raster or a sum of them. Waits until the range stops changing (dragging the slider
 * passes many), then checks the rasters have been published before opening them. A
 * dekad comes with its NDVI quality raster when that has been published too, for the
 * quality slider in the legend.
 */
let waporVariable = WAPOR_VARIABLES[0];
let waporMaxGap: number | null = null;
let waporStretch: WaporStretch = 1;
let stretchTimer = 0; // (before initWaporLegend, which calls onStretch)
const waporLegend = initWaporLegend({
  variable: waporVariable,
  onMaxGap(maxGap) {
    waporMaxGap = maxGap;
    setWaporMaxGap(maxGap);
    stretchWapor();
    showWaporDebug();
  },
  onStretch(cut) {
    waporStretch = cut;
    stretchWapor();
  },
  onVariable(variable) {
    waporVariable = variable;
    localPanel.setVariable(variable);
    showPixelArea();
    player.stop();
    hideWapor(); // not the last variable's values in this one's colours
    // Its own colours until its values in view are known.
    setWaporRamp(variable.ramp);
    waporLegend.ramp(variable.ramp);
    showWapor(view === "local" ? waporRange : null);
  },
  onUnits: (units) => localPanel.setUnits(units),
});
waporLegend.ramp(waporVariable.ramp);
// Local view: the legend's variable at the selected point, over WaPOR's whole record.
const localPanel = initLocalPanel({
  variable: waporVariable,
  setRange: (range) => toolbarApi?.setRange(range),
  setDays: (days) => toolbarApi?.setDays(days),
  debug: (value) => debug("series", value),
  // The chart's y axis title goes through the units, as the legend's menu.
  onUnits(units) {
    waporLegend.setUnits(units);
    localPanel.setUnits(units);
  },
});
let waporWanted: string | null = null; // the variable and range, as "AETI start-end" (days)
let waporShown: WaporPeriod | null = null;
let levelShown: WaporLevel = "L1"; // (of waporShown, in the legend)
let waporTimer = 0;
const waporKey = (range: DayRange) => `${waporVariable.id} ${range.start}-${range.end}`;
function showWapor(range: DayRange | null) {
  const wanted = range && waporKey(range);
  const variable = waporVariable;
  waporWanted = wanted;
  clearTimeout(waporTimer);
  // Before the checks, as if everything were published (always possible: the range
  // doesn't go past the current dekad).
  const draft = range && waporPeriod(variable, range);
  waporLegend.show(draft, "checking");
  waporLegend.quality(draft?.qualityUrl ? "checking" : null);
  if (!range || !draft) return hideWapor();
  waporTimer = window.setTimeout(async () => {
    let checked: CheckedWaporPeriod | null = null;
    let failed = false; // couldn't reach the bucket
    try {
      checked = await checkedWaporPeriod(variable, range);
    } catch {
      failed = true;
    }
    if (waporWanted !== wanted) return;
    if (!checked) {
      hideWapor();
      waporLegend.quality(null);
      return waporLegend.show(draft, failed ? "error" : "missing");
    }
    showCheckedWapor(checked, false);
  }, 250);
}

/** Show a checked period; `seamless` (a playback frame): it's loaded already. */
function showCheckedWapor({ period, quality }: CheckedWaporPeriod, seamless: boolean) {
  const wanted = waporWanted;
  waporLegend.show(period, seamless ? "ready" : "loading");
  waporLegend.quality(quality);
  waporShown = period;
  setWapor(period, () => waporWanted === wanted && waporLegend.show(period, "ready"), seamless);
  showWaporLevel();
  stretchWapor();
  showWaporDebug();
}

/**
 * The colour map spans the values on screen (see the stretch button in the legend):
 * worked out again when the view moves, a tile loads, or the period, quality filter or
 * stretch changes, at most every so often. While playing it's kept, so frames compare.
 * Until there's a value in view, the last colour map stays.
 */
function stretchWapor() {
  clearTimeout(stretchTimer);
  stretchTimer = window.setTimeout(() => {
    if (!waporShown || playback !== "stopped") return;
    const range = waporViewRange(waporShown, waporMaxGap, waporStretch);
    if (!range) return;
    let lo = range[0];
    let hi = Math.max(range[1], lo + 0.01);
    // A signed variable's colours are centred on 0, as far either way.
    if (waporShown.variable.signed) [lo, hi] = [-1, 1].map((s) => s * Math.max(-lo, hi, 0.01));
    const ramp: WaporRamp = {
      quantities: [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4) as WaporRamp["quantities"],
      colors: waporShown.variable.ramp.colors,
    };
    setWaporRamp(ramp);
    waporLegend.ramp(ramp);
  }, 150);
}
onWaporTile(stretchWapor);
map.on("moveend", stretchWapor);

// Values over a pixel in the legend: a pixel's area at the centre of the view (it
// changes with latitude, and is L2's when zoomed in where it has it). Only the latest
// lookup counts.
let areaWanted = "";
const shownLevel = () => (waporShown ? waporShownLevel(waporShown) : "L1");
function showPixelArea() {
  if (view !== "local") return;
  const lat = map.getCenter().lat;
  const level = shownLevel();
  const wanted = (areaWanted = `${waporVariable.id} ${lat} ${level}`);
  waporPixelArea(waporVariable, lat, level).then((area) => areaWanted === wanted && waporLegend.pixelArea(area, lat));
}
map.on("moveend", showPixelArea);

// The legend's pixel size follows the level the map shows.
function showWaporLevel() {
  const level = shownLevel();
  waporLegend.level(level);
  if (level === levelShown) return;
  levelShown = level;
  showPixelArea();
}
// (The level changes while deck.gl picks tiles.)
onWaporLevel(() => queueMicrotask(showWaporLevel));

// Playback: each frame sets the range on the toolbar, and its period, loaded ahead, on
// the map. Any other change of range or view stops it.
let waporRange: DayRange | null = null;
let playing = false; // a frame is being shown
let playback: PlaybackStatus = "stopped";
const player = initWaporPlayer({
  getRange: () => waporRange!,
  getVariable: () => waporVariable,
  show(range, checked) {
    playing = true;
    toolbarApi!.setDays(range);
    playing = false;
    clearTimeout(waporTimer);
    waporWanted = waporKey(range);
    showCheckedWapor(checked, true);
  },
  onState(state) {
    playback = state.status;
    if (playback === "stopped") stretchWapor();
    toolbarApi?.setPlayback(state);
  },
});
const playbackTuning: { key: keyof PlaybackSettings; label: string; min: number; max: number; step?: number }[] = [
  { key: "stepDays", label: "Step (days, next play)", min: 1, max: 366 },
  { key: "frameMs", label: "Frame (ms)", min: 16, max: 5000, step: 10 },
  { key: "ahead", label: "Frames ahead", min: 1, max: 200 },
  { key: "loaders", label: "Loaders (next play)", min: 1, max: 12 },
  { key: "startAhead", label: "Frames to start", min: 1, max: 50 },
];
for (const { key, ...input } of playbackTuning) {
  debugNumber({ key: `playback.${key}`, value: DEFAULT_PLAYBACK[key], ...input }, (value) => player.tune({ [key]: value }));
}

// Debug: how the value is made, the map zoom and which overview the rasters cover the
// view with. Tiles are picked on every frame while the map moves, so this redraws at
// most once a frame.
let waporDebugFrame = 0;
let waporDebugShown = "";
let waporTiles: WaporTiles | null = null;
onWaporTiles((tiles) => {
  waporTiles = tiles;
  showWaporDebug();
});
function showWaporDebug() {
  const period = waporShown;
  if (!period) return;
  const tiles = waporTiles;
  cancelAnimationFrame(waporDebugFrame);
  waporDebugFrame = requestAnimationFrame(() => {
    const value = {
      variable: period.variable.id,
      equation: period.equation,
      note: period.note,
      rasters: period.terms.length,
      cost: Math.round(period.cost * 10) / 10,
      unpublished: period.unpublished.length ? period.unpublished : null,
      quality: period.qualityUrl?.split("/").pop() ?? null,
      maxGap: period.qualityUrl ? waporMaxGap : null,
      ...tiles,
      zoom: tiles && Math.round(tiles.zoom * 100) / 100,
    };
    const json = JSON.stringify(value);
    if (json !== waporDebugShown) debug("wapor", value);
    waporDebugShown = json;
  });
}

function hideWapor() {
  setWapor(null);
  waporShown = null;
  showWaporLevel();
  waporTiles = null;
  cancelAnimationFrame(waporDebugFrame);
  waporDebugShown = "";
  debug("wapor", null);
}

// The map follows the view tab, and in the Local view the date range.
function onToolbarChange({ view: newView, range, days }: ToolbarState) {
  if (newView !== view) setHoveredSubBasin(null);
  view = newView;
  setView(view);
  layersMenu.setView(view);
  picker.setView(view);
  waterBalance.setView(view);
  waterBalance.setRange(range);
  countryPanel.setView(view);
  countryPanel.setRange(range);
  basinStats.setView(view);
  basinStats.setRange(range);
  localPanel.setView(view);
  localPanel.setRange(days);
  showPixelArea();
  waporRange = days;
  if (!playing) {
    player.stop();
    showWapor(view === "local" ? days : null);
  }
  debug("time", {
    view,
    start: fmtDay(days.start),
    end: fmtDay(days.end),
    days: { start: days.start, end: days.end, count: days.end - days.start + 1 },
    dekads: { start: range.start, end: range.end, count: range.end - range.start + 1 },
  });
}
selection.set(NOTHING);
debug("hover", null);
toolbarApi = initToolbar(onToolbarChange, () => player.toggle());
onToolbarChange(toolbarApi.state);
// The Basin view's range ends at the latest dekad of the model output. Without the
// output (not built yet, or unreachable) it isn't limited; Q and ΔS then say so.
loadModelFiles().then(
  (files) => toolbarApi!.setBasinLastDekad(files.last),
  (err: Error) => console.warn(err.message),
);
