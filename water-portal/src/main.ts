import { initBasinStats } from "./basin/basin-stats";
import { loadModelFiles } from "./basin/model";
import { initCountryPanel, type CountryInfo } from "./country/country-panel";
import { unionBox, type Box } from "./map/fly-to";
import { createMap } from "./map/map";
import { placeAt, type LngLat, type Place } from "./map/places";
import { downstreamFinder, upstreamFinder, type SubBasin } from "./map/sub-basin-network";
import { NOTHING, selection, type SelectedFeature, type Selection, type SelectionSource } from "./selection";
import { initLocalMaps, type LocalMaps } from "./local/local-maps";
import { initLocalPanel } from "./local/local-panel";
import { initWaporRaster } from "./local/wapor-raster";
import { damsData } from "./local/vector-maps";
import { makeResizable } from "./panels/floating";
import { makeFoldable } from "./panels/foldable";
import { initLayersMenu } from "./panels/layers-menu";
import { clearMapTip, initMapTips } from "./panels/map-tip";
import { initSlowServerCheck } from "./panels/slow-server";
import { initLoadBar } from "./panels/load-bar";
import { initCorsCheck } from "./panels/cors-check";
import { cornerWarning } from "./panels/corner-warning";
import { initThemeSwitch } from "./panels/theme-switch";
import { mk } from "./toolbar/dekads";
import { initPlacePicker, type Country, type MajorBasin } from "./toolbar/place-picker";
import { initRangePlayer } from "./toolbar/range-player";
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
import { byId as $ } from "./lib/dom";

// First, so it counts every request from here on.
initLoadBar();
initSlowServerCheck();
initCorsCheck();

const dark = initThemeSwitch();

// Hover: what's under the pointer (picked from the map as drawn: at once) is passed to
// the panels, and the map outlines what a click there would select (see selectPoint):
// the country; the major basin, or within the selected one the sub-basin, with
// everything upstream (green) and downstream (red) of it filled.
let view: View = "country";
let hovered: { lngLat: LngLat; place: Place } | null = null;
function showHover(lngLat: LngLat | null, place: Place | null) {
  hovered = lngLat && place && { lngLat, place };
  if (!hovered) {
    setHovered(null);
    countryPanel.hover(null);
    basinStats.hover(null);
    return;
  }
  const { country, majorBasin, subBasin } = hovered.place;
  countryPanel.hover(view === "country" ? (country?.m49 ?? null) : null);
  basinStats.hover(view === "basin" ? hovered.place : null);
  const inSelected = !!majorBasin && majorBasin.id === selection.get().majorBasin?.id;
  // Up- and downstream are picked out only while no sub-basin is selected (a click
  // outside its catchment clears it: see selectPoint).
  const flow = !selection.get().subBasin;
  setHovered(
    view === "country" && country ? { country: country.m49 }
    : view !== "basin" || !majorBasin ? null
    : inSelected && subBasin
      ? { sub: subBasin.id, flow, ...(flow ? flowOf(subBasin.id) : { upstream: NONE, downstream: NONE }) }
    : { major: majorBasin.id },
  );
}

/** The selected sub-basin and everything upstream of it (empty: none selected). */
const NONE = new Set<number>();
/** What's up- and downstream of a sub-basin, kept for the one hovered (walked once, not at every move). */
let flowCache = { id: -1, upstream: NONE, downstream: NONE };
function flowOf(id: number) {
  if (flowCache.id !== id) flowCache = { id, upstream: upstreamOf(id), downstream: downstreamOf(id) };
  return flowCache;
}
let catchment = { id: null as number | null, ids: NONE };
function selectedCatchment() {
  const id = selection.get().subBasin?.id ?? null;
  if (id !== catchment.id) catchment = { id, ids: id === null ? NONE : new Set([id, ...upstreamOf(id)]) };
  return catchment.ids;
}

/** After a selection: what a click under the pointer would select may have changed (a major basin's sub-basins are drawn now). */
async function refreshHover() {
  const before = hovered;
  if (!before) return;
  if (view !== "basin" || before.place.subBasin || !selection.get().majorBasin) return showHover(before.lngLat, before.place);
  // (Not drawn when picked: looked up instead, until the pointer moves.)
  const place = await placeAt(before.lngLat);
  if (hovered === before) showHover(before.lngLat, place);
}

// The point (and the dam it's at) is the Local view's: selecting in the Country or Basin
// view (a click, a name) leaves it as it was.
const keptPoint = (): Pick<Selection, "lngLat" | "feature"> =>
  view === "local" ? { lngLat: null, feature: null } : { lngLat: selection.get().lngLat, feature: selection.get().feature };

// Selecting a point by coordinates, or in the Local view, selects everything it lies
// in. A map click in the Country or Basin view picks what the map shows: the country;
// the major basin, and only within the major basin already selected its sub-basin (its
// sub-basins are on the map then), so a sub-basin takes two clicks from the World.
// A point of a vector map (a dam: `feature`) is selected at its own coordinates.
// What the map shows there (`drawn`, as clicked) is selected at once; the rest (the
// country in the Basin view, say) once looked up in the tiles, which can take a while
// when much else is loading.
let pointWanted: LngLat | null = null;
async function selectPoint(lngLat: LngLat | null, source: SelectionSource, feature: SelectedFeature | null = null, drawn: Place | null = null) {
  pointWanted = lngLat;
  if (!lngLat) return selection.set({ ...NOTHING, ...keptPoint() });
  const before = selection.get();
  const precise = source !== "map" || view === "local";
  // With a sub-basin selected, a click elsewhere in its major basin than its catchment
  // goes back to the major basin.
  const own = selectedCatchment();
  const select = (place: Place) => {
    const sameMajor = !!place.majorBasin && place.majorBasin.id === before.majorBasin?.id;
    const inOwn = !own.size || (!!place.subBasin && own.has(place.subBasin.id));
    selection.set({
      ...NOTHING,
      ...place,
      source,
      ...(view === "local" ? { lngLat, feature } : keptPoint()),
      subBasin: precise || (sameMajor && inOwn) ? place.subBasin : null,
    });
  };
  // A click on another country (Country view), major basin or sub-basin (Basin view; a
  // sub-basin's with all upstream of it) flies to it, as picking it by name does.
  const flyTo = () => {
    if (source !== "map" || !boxes) return;
    const { country, majorBasin, subBasin } = selection.get();
    let box: Box | undefined;
    if (view === "country" && country && country.m49 !== before.country?.m49) box = boxes.country.get(country.m49);
    if (view === "basin" && majorBasin && majorBasin.id !== before.majorBasin?.id) box = boxes.major.get(majorBasin.id);
    if (view === "basin" && subBasin && subBasin.id !== before.subBasin?.id) box = catchmentBox(subBasin.id);
    if (box) showBox(box);
  };
  const quick = !!drawn && !precise;
  if (quick) {
    select(drawn);
    flyTo();
  }
  const found = await placeAt(lngLat);
  if (pointWanted !== lngLat) return;
  if (!quick) {
    select(found);
    return flyTo();
  }
  // (What's drawn wins: it's what was clicked on.)
  const place: Place = {
    country: drawn.country ?? found.country,
    majorBasin: drawn.majorBasin ?? found.majorBasin,
    subBasin: drawn.majorBasin ? drawn.subBasin : found.subBasin,
  };
  const now = selection.get();
  if (place.country?.m49 !== now.country?.m49 || place.majorBasin?.id !== now.majorBasin?.id) select(place);
}
// Outlines to fly to (once loaded).
let boxes: { country: Map<number, Box>; major: Map<number, Box>; sub: Map<number, Box> } | null = null;

const waterMap = createMap(
  document.getElementById("map")!,
  {
    dark,
    // A click on the ocean (no country or basin) clears the selection.
    // (A click on a dam in the Local view: the dam, where it is.)
    onClick(lngLat, onArea, symbol, drawn) {
      const hit = symbol ? localMaps?.featureAt(symbol) : null;
      if (hit) selectPoint(hit.lngLat, "map", hit.feature);
      else selectPoint(onArea ? lngLat : null, "map", null, drawn);
    },
    onMarkerDrop: (lngLat) => selectPoint(lngLat, "map"),
    onHover: showHover,
    // A point of the Local view's vector maps: its tooltip.
    onSymbolHover: (id, x, y, lngLat) => localMaps?.hover(id, x, y, lngLat),
  },
);
const { map, setView, setLayerVisible, setSelection, showBox, showPoint, setHovered } = waterMap;

const [countries, basins, subBasins, countryInfo] = await Promise.all([
  loadList<Country>("countries"),
  loadList<MajorBasin>("major-basins"),
  loadData<Record<keyof SubBasin, unknown[]>>("sub-basins").then(fromColumns<SubBasin>),
  loadData<CountryInfo>("country-info"),
]).catch((err: Error) => {
  // (Without them there's no top bar or panel: say so, rather than leave a bare globe.)
  const warning = cornerWarning();
  warning.textContent = `⚠ The page's data couldn't be loaded (${err.message}). Reload to try again.`;
  warning.hidden = false;
  throw err;
});
boxes = {
  country: new Map(countries.map((c) => [c.m49, c.bbox])),
  major: new Map(basins.map((b) => [b.id, b.bbox])),
  sub: new Map(subBasins.map((b) => [b.id, b.bbox])),
};
const upstreamOf = upstreamFinder(subBasins);
const downstreamOf = downstreamFinder(subBasins);
/** The box around a sub-basin and everything upstream of it. */
const catchmentBox = (id: number) => unionBox([id, ...upstreamOf(id)].map((sub) => boxes!.sub.get(sub)).filter((b): b is Box => !!b));
let toolbarApi: Toolbar | null = null;
// Basin view: statistics charts in the panel, each with its map.
const basinStats = initBasinStats({
  map: waterMap,
  majorBasins: basins,
  subBasins,
  upstreamOf,
  setRange: (range) => toolbarApi?.setRange(range),
  onTimed: (has) => setTimed("basin", has),
});
waterMap.onFlow((flow) => basinStats.flow(flow));
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
  regions: countryInfo.regions,
  regionOf: new Map(Object.entries(countryInfo.countries).map(([m49, c]) => [Number(m49), c.region])),
  basins,
  subBasins,
  // Picking a place by name selects only that: no other areas (but a sub-basin comes
  // with the major basin it is part of), and the Local view's point.
  onCountry(picked) {
    pointWanted = null;
    const kept = keptPoint();
    if (!picked) return selection.set({ ...NOTHING, ...kept });
    if (picked.kind === "region") {
      const { code, name } = picked.region;
      selection.set({ ...NOTHING, ...kept, source: "country", region: { code, name } });
      return countryPanel.showArea(code);
    }
    const { m49, name, bbox } = picked.country;
    selection.set({ ...NOTHING, ...kept, source: "country", country: { m49, name } });
    showBox(bbox);
  },
  onBasin(picked) {
    pointWanted = null;
    const kept = keptPoint();
    if (!picked) return selection.set({ ...NOTHING, ...kept });
    const major = picked.kind === "major" ? picked.basin : picked.majorBasin;
    selection.set({
      ...NOTHING,
      ...kept,
      source: "basin",
      majorBasin: { id: major.id, name: major.name },
      subBasin: picked.kind === "sub" ? { id: picked.basin.id, name: picked.basin.name } : null,
    });
    showBox(picked.kind === "sub" ? catchmentBox(picked.basin.id) : picked.basin.bbox);
  },
  onPoint(lngLat) {
    selectPoint(lngLat, "coordinates");
    if (lngLat) showPoint(lngLat, Math.max(map.getZoom(), 5), "ease");
  },
  // A dam by name: it, where it is (closer in than a point by coordinates).
  onFeature(feature, lngLat) {
    selectPoint(lngLat, "coordinates", feature);
    showPoint(lngLat, Math.max(map.getZoom(), 8), "fly");
  },
  onDropFeature: () => selectPoint(selection.get().lngLat, "coordinates"),
  onDamCountry: (box) => showBox(box),
});

selection.subscribe((s) => {
  setSelection({
    lngLat: s.lngLat,
    feature: s.feature && { id: `${s.feature.map}:${s.feature.index}`, name: s.feature.name },
    country: s.country?.m49 ?? null,
    majorBasin: s.majorBasin?.id ?? null,
    subBasin: s.subBasin?.id ?? null,
  });
  picker.show(s);
  countryPanel.setSelection(s);
  basinStats.setSelection(s);
  localPanel.setSelection(s);
  refreshHover();
});

function loadList<T>(name: string): Promise<T[]> {
  return loadData<T[]>(name);
}

/** Rows from an object of columns (sub-basins.json: 7,596 rows with the same keys, a fifth smaller so). */
function fromColumns<T>(columns: Record<keyof T, unknown[]>): T[] {
  const keys = Object.keys(columns) as (keyof T)[];
  return columns[keys[0]].map((_, i) => Object.fromEntries(keys.map((k) => [k, columns[k][i]])) as T);
}

async function loadData<T>(name: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${name}.json`);
  if (!response.ok) throw new Error(`${name}.json: ${response.status} ${response.statusText}`);
  return response.json();
}

// The graph panes (one per view, one shows at a time) share a width that can be changed,
// and fold away when the pointer isn't over them.
for (const id of ["cp-panel", "wb-panel", "lp-panel"]) {
  makeResizable($(id), "side-panel");
  makeFoldable($(id));
}

// The Layers button goes with the map's controls, above zoom (MapLibre stacks later
// bottom controls on top).
const layersBox = document.createElement("div");
layersBox.className = "maplibregl-ctrl maplibregl-ctrl-group";
layersBox.append($("layers-menu"));
waterMap.map.addControl({ onAdd: () => layersBox, onRemove: () => layersBox.remove() }, "bottom-right");

// The date range goes in the middle of the strip along the bottom between the graph
// pane (when it reaches down there, folded) and the map's controls. (Not the credits:
// the pane would move each time they're opened or closed; it goes over them instead.
// Nor the unfolded pane, which would push it aside on every hover.) Where the range is
// under the pane, the unfolded pane stops above it (--pane-bottom). Its width can be
// changed too, from either side at once, as far as under the pane.
const controls = document.querySelector<HTMLElement>(".maplibregl-ctrl-bottom-right .maplibregl-ctrl-group")!;
const graphPanes = ["cp-panel", "wb-panel", "lp-panel"].map($);
const rangePane = $("pane-range");
// The map's tooltips, pinned right of it at first.
initMapTips(rangePane);
makeResizable(rangePane, "range", { centered: true });
function fitRange() {
  const root = document.documentElement.style;
  if (graphPanes.every((pane) => pane.classList.contains("resting"))) {
    let left = 0;
    for (const pane of graphPanes) {
      const r = pane.getBoundingClientRect();
      if (r.width > 0 && r.bottom > window.innerHeight - 120) left = Math.max(left, r.right);
    }
    const right = window.innerWidth - controls.getBoundingClientRect().left;
    root.setProperty("--range-left", `${Math.round(left)}px`);
    root.setProperty("--range-right", `${Math.round(right)}px`);
  }
  const range = rangePane.getBoundingClientRect();
  const paneRight = Math.max(...graphPanes.map((pane) => pane.getBoundingClientRect().right));
  const shown = range.height > 0 && !rangePane.classList.contains("timeless");
  if (shown && paneRight > range.left) root.setProperty("--pane-bottom", `${Math.round(window.innerHeight - range.top + 12)}px`);
  else root.removeProperty("--pane-bottom");
}
const rangeObserver = new ResizeObserver(fitRange);
for (const el of [...graphPanes, rangePane]) rangeObserver.observe(el);
// (Hidden a while after it's dimmed: toolbar.ts setTimeless.)
new MutationObserver(fitRange).observe(rangePane, { attributes: true, attributeFilter: ["class"] });
window.addEventListener("resize", fitRange);

const layersMenu = initLayersMenu(setLayerVisible);

// Local view: a WaPOR variable (picked in the legend) for the selected range, on the map
// (local/wapor-raster.ts, which owns its legend and playback).
let localMaps: LocalMaps | null = null; // (after the map: its tooltips)
// A map on screen has time (see onTimed): in the Local view, and in the Basin view.
const timed = { local: true, basin: true };
function setTimed(view: "local" | "basin", has: boolean) {
  timed[view] = has;
  const any = timed.local && timed.basin;
  if (!any) rangePlayer.stop();
  toolbarApi?.setTimeless(!any);
  fitRange(); // (the graph pane can reach down where it was)
}
const raster = initWaporRaster({
  map: waterMap,
  getView: () => view,
  onVariable: (variable) => localPanel.setVariable(variable),
  onUnits: (units) => localPanel.setUnits(units),
  setDays: (days) => toolbarApi!.setDays(days),
  onPlayback: (state) => toolbarApi?.setPlayback(state),
  lockLegend: () => localMaps?.lockLegend(),
  unlockLegend: () => localMaps?.unlockLegend(),
});
// The Local legend: WaPOR's variables and the vector maps, a checklist (one raster at a time).
localMaps = initLocalMaps({
  map: waterMap,
  wapor: $("wapor-legend"),
  variable: raster.variable(),
  onWapor(variable, checked) {
    // The Local panel's series: of the variable checked, or none (no map with time; not
    // the one a card's preview takes off the map for the while).
    localPanel.setVariable(checked);
    raster.pick(variable);
  },
  onMapped: (ids) => localPanel.setMapped(ids),
  // The pixel under the pointer, in the legend's units (over a pixel: a full-resolution one's area there).
  waporTip: (lngLat) => raster.tip(lngLat),
  // Without time on the map (only GAEZ's maps, the dams), the range changes nothing.
  onGaez: (gaez, crop) => localPanel.setGaez(gaez, crop),
  onTimed: (has) => setTimed("local", has),
});
// Local view: the legend's variable at the selected point, over WaPOR's whole record.
const localPanel = initLocalPanel({
  variable: raster.variable(),
  setRange: (range) => toolbarApi?.setRange(range),
  setDays: (days) => toolbarApi?.setDays(days),
  // The chart's y axis title goes through the units, as the legend's menu.
  onUnits(units) {
    raster.setUnits(units);
    localPanel.setUnits(units);
  },
  // The dams' cards: hovered, the dams on the map by the card's attribute; pinned, checked in the legend so.
  previewMap: (id, attribute) => localMaps?.preview(id, attribute),
  addMap: (id, attribute) => localMaps?.add(id, attribute),
});
// The dams, for the Local panel's search and card (loaded on opening the Local view).
let damsLoading: Promise<void> | null = null;
function loadDams() {
  damsLoading ??= damsData().then(
    (dams) => {
      picker.setDams(dams);
      localPanel.setDams(dams);
    },
    () => void (damsLoading = null),
  );
}

// In Country and Basin, only the range moves on (range-player.ts).
let waporRange: DayRange | null = null;
let rangePlaying = false; // a step is being shown
const rangePlayer = initRangePlayer({
  getView: () => view,
  getRange: () => waporRange!,
  show(range) {
    rangePlaying = true;
    toolbarApi!.setDays(range);
    rangePlaying = false;
  },
  onState(status, stepMs) {
    toolbarApi?.setPlayback({ status, bufferedTo: null, loading: null });
    // (Locked before the first step: its ranges are the ones held, until it stops.)
    // (Both unlocked, as a stop can come once the view has changed.)
    if (status === "playing") (view === "basin" ? basinStats : view === "local" ? localMaps! : countryPanel).lockLegend();
    else for (const panel of [basinStats, countryPanel, localMaps!]) panel.unlockLegend();
    waterMap.setPlayback(stepMs);
  },
});

// The map follows the view tab, and in the Local view the date range.
function onToolbarChange({ view: newView, range, days }: ToolbarState) {
  if (newView !== view) {
    setHovered(null);
    clearMapTip();
  }
  view = newView;
  setView(view);
  layersMenu.setView(view);
  picker.setView(view);
  countryPanel.setView(view);
  countryPanel.setRange(range);
  basinStats.setView(view);
  basinStats.setRange(range);
  localPanel.setView(view);
  localPanel.setRange(days);
  localMaps?.setView(view);
  if (view === "local") loadDams();
  waporRange = days;
  if (rangePlaying) return raster.showPixelArea();
  rangePlayer.stop();
  raster.show(view === "local" ? days : null);
}
selection.set(NOTHING);
// (In the Local view without a WaPOR raster on the map, only the range moves on.)
toolbarApi = initToolbar(onToolbarChange, () => (raster.playable() ? raster.togglePlay() : rangePlayer.toggle()));
onToolbarChange(toolbarApi.state);
toolbarApi.setTimeless(!(timed.local && timed.basin));
// The Basin view's range ends at the latest dekad of the model output. Without the
// output (not built yet, or unreachable) it isn't limited; Q and ΔS then say so.
loadModelFiles().then(
  (files) => toolbarApi!.setBasinLastDekad(files.last),
  (err: Error) => console.warn(err.message),
);
