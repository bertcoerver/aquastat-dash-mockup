import { initBasinStats } from "./basin/basin-stats";
import { initWaterBalance } from "./basin/water-balance";
import { initCountryPanel, type CountryInfo } from "./country/country-panel";
import {
  checkedWaporPeriod,
  onWaporTiles,
  waporPeriod,
  type CheckedWaporPeriod,
  type WaporPeriod,
  type WaporTiles,
} from "./map/layers/wapor";
import { createMap } from "./map/map";
import { placeAt, type LngLat } from "./map/places";
import { upstreamFinder, type SubBasin } from "./map/sub-basin-network";
import { NOTHING, selection, type SelectionSource } from "./selection";
import { initWaporLegend } from "./map/wapor-legend";
import { initWaporPlayer } from "./map/wapor-player";
import { initDebugPanel } from "./panels/debug-panel";
import { initLayersMenu } from "./panels/layers-menu";
import { initLoadingIndicator } from "./panels/loading-indicator";
import { COUNTRY_MAX_YEAR, MIN_YEAR, fmtDay, mk } from "./toolbar/dekads";
import { initPlacePicker, type Country, type MajorBasin } from "./toolbar/place-picker";
import { initToolbar, type Toolbar, type ToolbarState } from "./toolbar/toolbar";
import type { DayRange, View } from "./toolbar/range-rules";
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

const toolbar = document.getElementById("toolbar")!;
const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const debug = initDebugPanel(["click", "time", "wapor", "hover"]);
const round = (v: number) => Math.round(v * 1e4) / 1e4;

// Hover: what's under the pointer, shown in the debug window; in the Basin view the
// map also shades the sub-basin there and everything upstream of it. Only the latest
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
  setHoveredSubBasin(view === "basin" && place.subBasin ? { id: place.subBasin.id, upstream: upstream! } : null);
  debug("hover", {
    lon: round(lngLat[0]),
    lat: round(lngLat[1]),
    ...place,
    upstream: upstream && { count: upstream.size, ids: [...upstream] },
  });
}

// Selecting a point (map click or typed coordinates) selects everything it lies in.
let pointWanted: LngLat | null = null;
async function selectPoint(lngLat: LngLat | null, source: SelectionSource) {
  pointWanted = lngLat;
  if (!lngLat) return selection.set(NOTHING);
  const place = await placeAt(lngLat);
  if (pointWanted !== lngLat) return;
  selection.set({ source, lngLat, ...place });
}

const waterMap = createMap(
  document.getElementById("map")!,
  {
    dark,
    // A click on the ocean (no country or basin) clears the selection.
    onClick: (lngLat, onArea) => selectPoint(onArea ? lngLat : null, "map"),
    onHover: showHover,
  },
);
const { map, setView, setLayerVisible, setWapor, setWaporMaxGap, setSelection, showBox, setHoveredSubBasin } = waterMap;

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
  canSelect: (year) => year >= MIN_YEAR && year <= COUNTRY_MAX_YEAR,
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
      subBasin: picked.kind === "sub" ? { id: picked.basin.id, name: picked.basin.name } : null,
    });
    showBox(picked.basin.bbox);
  },
  onPoint(lngLat) {
    selectPoint(lngLat, "coordinates");
    if (lngLat) map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), 5) });
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

// The top bar floats over the map; keep the map's centre in the visible part below it,
// and the floating panels just below it.
new ResizeObserver(() => {
  map.setPadding({ top: toolbar.offsetHeight, bottom: 0, left: 0, right: 0 });
  document.documentElement.style.setProperty("--toolbar-h", `${toolbar.offsetHeight}px`);
}).observe(toolbar);

initLayersMenu(setLayerVisible);

/**
 * Local view: WaPOR for the selected range, one raster or a sum of them. Waits until
 * the range stops changing (dragging the slider passes many), then checks the rasters
 * have been published before opening them. A dekad comes with its NDVI quality raster
 * when that has been published too, for the quality slider in the legend.
 */
let waporMaxGap: number | null = null;
const waporLegend = initWaporLegend({
  onMaxGap(maxGap) {
    waporMaxGap = maxGap;
    setWaporMaxGap(maxGap);
    showWaporDebug();
  },
});
let waporWanted: string | null = null; // the range, as "start-end" (days)
let waporShown: WaporPeriod | null = null;
let waporTimer = 0;
function showWapor(range: DayRange | null) {
  const wanted = range && `${range.start}-${range.end}`;
  waporWanted = wanted;
  clearTimeout(waporTimer);
  // Before the checks, as if everything were published (always possible: the range
  // doesn't go past the current dekad).
  const draft = range && waporPeriod(range);
  waporLegend.show(draft, "checking");
  waporLegend.quality(draft?.qualityUrl ? "checking" : null);
  if (!range || !draft) return hideWapor();
  waporTimer = window.setTimeout(async () => {
    let checked: CheckedWaporPeriod | null = null;
    let failed = false; // couldn't reach the bucket
    try {
      checked = await checkedWaporPeriod(range);
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
  showWaporDebug();
}

// Playback: each frame sets the range on the toolbar, and its period, loaded ahead, on
// the map. Any other change of range or view stops it.
let waporRange: DayRange | null = null;
let playing = false; // a frame is being shown
const player = initWaporPlayer({
  getRange: () => waporRange!,
  show(range, checked) {
    playing = true;
    toolbarApi!.setDays(range);
    playing = false;
    clearTimeout(waporTimer);
    waporWanted = `${range.start}-${range.end}`;
    showCheckedWapor(checked, true);
  },
  onState: (state) => toolbarApi?.setPlayback(state),
});

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
  picker.setView(view);
  waterBalance.setView(view);
  waterBalance.setRange(range);
  countryPanel.setView(view);
  countryPanel.setRange(range);
  basinStats.setView(view);
  basinStats.setRange(range);
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
