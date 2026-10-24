import { onWaporTiles, waporAvailable, waporPeriod, type WaporPeriod } from "./map/layers/wapor";
import { createMap } from "./map/map";
import { placeAt, type LngLat } from "./map/places";
import { upstreamFinder, type SubBasin } from "./map/sub-basin-network";
import { NOTHING, selection, type SelectionSource } from "./selection";
import { initWaporLegend } from "./map/wapor-legend";
import { initDebugPanel } from "./panels/debug-panel";
import { initLayersMenu } from "./panels/layers-menu";
import { initLoadingIndicator } from "./panels/loading-indicator";
import { fmtEnd, fmtStart } from "./toolbar/dekads";
import { initPlacePicker, type Country, type MajorBasin } from "./toolbar/place-picker";
import { initToolbar, type ToolbarState } from "./toolbar/toolbar";
import type { View } from "./toolbar/range-rules";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/toolbar.css";
import "./styles/map.css";
import "./styles/panels.css";
import "./styles/legend.css";

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
    return debug("hover", null);
  }
  const place = await placeAt(lngLat);
  if (hovered !== lngLat) return;
  const upstream = place.subBasin && upstreamOf(place.subBasin.id);
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

const { map, setView, setLayerVisible, setWapor, setSelection, showBox, setHoveredSubBasin } = createMap(
  document.getElementById("map")!,
  {
    dark,
    // A click on the ocean (no country or basin) clears the selection.
    onClick: (lngLat, onArea) => selectPoint(onArea ? lngLat : null, "map"),
    onHover: showHover,
  },
);

const [countries, basins, subBasins] = await Promise.all([
  loadList<Country>("countries"),
  loadList<MajorBasin>("major-basins"),
  loadList<SubBasin>("sub-basins"),
]);
const upstreamOf = upstreamFinder(subBasins);
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
  debug("click", {
    source: s.source,
    lon: s.lngLat && round(s.lngLat[0]),
    lat: s.lngLat && round(s.lngLat[1]),
    country: s.country,
    majorBasin: s.majorBasin,
    subBasin: s.subBasin,
  });
});

async function loadList<T>(name: string): Promise<T[]> {
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
 * Local view: the WaPOR raster for the selected period. Waits until the range stops
 * changing (dragging the slider passes many periods), then checks the raster has been
 * published before opening it.
 */
const showWaporLegend = initWaporLegend();
let waporWanted: string | null = null;
let waporTimer = 0;
function showWapor(period: WaporPeriod | null) {
  waporWanted = period?.url ?? null;
  clearTimeout(waporTimer);
  showWaporLegend(period, "checking");
  if (!period) return hideWapor();
  waporTimer = window.setTimeout(async () => {
    const available = await waporAvailable(period);
    if (waporWanted !== period.url) return;
    if (!available) {
      hideWapor();
      return showWaporLegend(period, "missing");
    }
    showWaporLegend(period, "loading");
    setWapor(period, () => waporWanted === period.url && showWaporLegend(period, "ready"));
  }, 250);
}

// Debug: the map zoom and which overview the raster covers the view with. Tiles are
// picked on every frame while the map moves, so this redraws at most once a frame.
let waporDebugFrame = 0;
let waporDebugShown = "";
onWaporTiles((tiles) => {
  cancelAnimationFrame(waporDebugFrame);
  waporDebugFrame = requestAnimationFrame(() => {
    const value = { file: waporWanted?.split("/").pop(), ...tiles, zoom: Math.round(tiles.zoom * 100) / 100 };
    const json = JSON.stringify(value);
    if (json !== waporDebugShown) debug("wapor", value);
    waporDebugShown = json;
  });
});

function hideWapor() {
  setWapor(null);
  cancelAnimationFrame(waporDebugFrame);
  waporDebugShown = "";
  debug("wapor", null);
}

// The map follows the view tab, and in the Local view the date range.
function onToolbarChange({ view: newView, range }: ToolbarState) {
  if (newView !== view) setHoveredSubBasin(null);
  view = newView;
  setView(view);
  picker.setView(view);
  showWapor(view === "local" ? waporPeriod(range) : null);
  debug("time", {
    view,
    start: fmtStart(range.start),
    end: fmtEnd(range.end),
    dekads: { start: range.start, end: range.end, count: range.end - range.start + 1 },
  });
}
selection.set(NOTHING);
debug("hover", null);
onToolbarChange(initToolbar(onToolbarChange));
