/*
 * The map: a MapLibre globe with deck.gl layers drawn into it (interleaved), so
 * deck.gl uses a GlobeView that moves with MapLibre's camera. There is no basemap:
 * MapLibre only paints the ocean, and all data are deck.gl layers.
 */
import type { PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { View } from "../toolbar/range-rules";
import { majorBasinsLayers, subBasinOutlinesLayer, subBasinsLayers } from "./layers/basins";
import { bordersLayer } from "./layers/borders";
import { countriesLayer, countryOutlineLayer, countrySymbolsLayer, type CountrySymbol } from "./layers/countries";
import { markerLayer } from "./layers/marker";
import { waporLayer, type WaporPeriod } from "./layers/wapor";
import { lakesLayer, riversLayer } from "./layers/water";
import type { LngLat } from "./places";
import { THEMES, type Color, type MapTheme } from "./theme";

/** Layers the user can switch on and off (see the layers menu). */
export type ToggleableLayer = "rivers" | "lakes";

export interface WaterMap {
  map: maplibregl.Map;
  /** Show the areas for a toolbar view: basins in the Basin view, else countries. */
  setView(view: View): void;
  setLayerVisible(layer: ToggleableLayer, visible: boolean): void;
  /**
   * Show the WaPOR raster for a period (null: none). `onLoad` runs once it's opened.
   * `seamless` (playback): keep showing the current one until the new one has loaded
   * every tile in view, then switch at once.
   */
  setWapor(period: WaporPeriod | null, onLoad?: () => void, seamless?: boolean): void;
  /** Hide WaPOR pixels with a longer NDVI gap than this, in dekads (null: none). */
  setWaporMaxGap(maxGap: number | null): void;
  /** Show the selection: a marker at the point, and the country and basins filled. */
  setSelection(selection: MapSelection): void;
  /** Move the camera to show a box: [west, south, east, north], west > east across 180°. */
  showBox(bbox: [number, number, number, number]): void;
  /** Basin view: shade a sub-basin and those upstream of it (null: none). */
  setHoveredSubBasin(subBasin: { id: number; upstream: Set<number> } | null): void;
  /**
   * Basin view: fill sub-basins with their own colours (the water balance model's
   * values), instead of the hover shading and the selected fill (null: none). `key`
   * names the set of colours: the map only repaints when it changes.
   */
  setSubBasinFills(fills: { key: string; colors: Map<number, Color> } | null): void;
  /** Basin view: draw a thick outline around these sub-basins. */
  setOutlinedSubBasins(ids: number[]): void;
  /**
   * Country view: fill countries with their own colours (a statistic's values), and
   * outline the selected country instead of filling it (null: none). `key` names the
   * set of colours: the map only repaints when it changes.
   */
  setCountryFills(fills: { key: string; colors: Map<number, Color> } | null): void;
  /** Country view: circles on countries (proportional symbols, rings), by `key` as above. */
  setCountrySymbols(symbols: { key: string; items: CountrySymbol[] } | null): void;
  theme: MapTheme;
}

interface WaporEntry {
  period: WaporPeriod;
  onLoad?: () => void;
  id: number; // a layer of its own, so a new period doesn't take over the shown one's tiles
}

interface MapSelection {
  lngLat: LngLat | null;
  country: number | null;
  majorBasin: number | null;
  subBasin: number | null;
}

interface MapOptions {
  dark: boolean;
  /**
   * A click anywhere: the point on the globe (null off the globe), and whether it hit
   * a country or basin (whichever is shown) rather than the ocean.
   */
  onClick?: (lngLat: LngLat | null, onArea: boolean) => void;
  /** The pointer moved: the point under it, or null off the globe or off the map. */
  onHover?: (lngLat: LngLat | null) => void;
}

export function createMap(container: HTMLElement, { dark, onClick, onHover }: MapOptions): WaterMap {
  const theme = dark ? THEMES.dark : THEMES.light;
  const state = {
    view: "country" as View,
    selection: { lngLat: null, country: null, majorBasin: null, subBasin: null } as MapSelection,
    visible: { rivers: true, lakes: true } as Record<ToggleableLayer, boolean>,
    wapor: null as WaporEntry | null,
    waporNext: null as WaporEntry | null, // seamless: loading, not drawn yet
    waporMaxGap: null as number | null,
    hoverFills: undefined as { key: number; colors: Map<number, Color> } | undefined,
    valueFills: undefined as { key: string; colors: Map<number, Color> } | undefined,
    outlined: [] as number[],
    countryFills: undefined as { key: string; colors: Map<number, Color> } | undefined,
    countrySymbols: null as { key: string; items: CountrySymbol[] } | null,
  };

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      projection: { type: "globe" },
      sources: {},
      layers: [{ id: "ocean", type: "background", paint: { "background-color": theme.ocean } }],
    },
    center: [20, 15],
    zoom: 1.6,
    hash: true,
    attributionControl: {
      compact: true,
      customAttribution: "FAO M49 &amp; SDG 6 basins · HydroLAKES · HydroSHEDS",
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");

  // Bottom to top. Rivers and lakes stay on top of whichever areas are shown.
  function layers() {
    const basins = state.view === "basin";
    const major = majorBasinsLayers({
      fill: theme.land,
      border: theme.basinBorder,
      visible: basins,
      selected: state.selection.subBasin ? null : state.selection.majorBasin, // the most precise one only
      selectedColor: theme.selected,
    });
    // Sub-basins are only drawn to fill the selected one, to shade the hovered one
    // and those upstream of it, or to show the water balance model's values.
    const values = state.valueFills;
    const sub = subBasinsLayers({
      fill: [0, 0, 0, 0],
      border: theme.basinBorder,
      visible: basins && Boolean(values || state.hoverFills || state.selection.subBasin),
      selected: values ? null : state.selection.subBasin,
      selectedColor: theme.selectedSubBasin,
      fills: values ?? state.hoverFills,
    });
    return [
      countriesLayer({
        color: theme.land,
        selected: state.selection.country,
        selectedColor: theme.selected,
        visible: !basins,
        fills: state.view === "country" ? state.countryFills : undefined,
      }),
      ...[state.wapor, state.waporNext].map(
        (entry) =>
          entry &&
          waporLayer({
            id: `wapor-aeti-${entry.id}`,
            period: entry.period,
            maxGap: state.waporMaxGap,
            onLoad: entry.onLoad,
            hidden: entry === state.waporNext,
            onViewportLoad: entry === state.waporNext ? () => showNextWapor(entry) : undefined,
          }),
      ),
      major.areas,
      sub.areas,
      bordersLayer({ color: theme.border, visible: !basins }),
      major.outlines, // (sub.outlines: not drawn for now)
      riversLayer({ color: theme.river, visible: state.visible.rivers }),
      lakesLayer({ color: theme.water, visible: state.visible.lakes }),
      subBasinOutlinesLayer({ ids: state.outlined, color: theme.outline, visible: basins }),
      countryOutlineLayer({
        m49: state.selection.country,
        color: theme.outline,
        visible: state.view === "country" && Boolean(state.countryFills),
      }),
      countrySymbolsLayer({ symbols: state.view === "country" ? visibleSymbols() : null }),
      markerLayer({ position: state.selection.lngLat, fill: theme.marker, ring: theme.markerRing }),
    ];
  }

  // Only the circles on the near side of the globe: they are drawn without a depth
  // test (like everything here), so the far side's would show through.
  let symbolsKey = "";
  function visibleSymbols() {
    const symbols = state.countrySymbols;
    if (!symbols) return null;
    const { lng, lat } = map.getCenter();
    const zoom = map.getZoom();
    const near = symbols.items.filter((s) => facing(s.position, [lng, lat]) > 0.15 - Math.min(0.15, zoom * 0.03));
    // Re-key by the circles kept, so deck.gl redraws only when that changes.
    const key = `${symbols.key}:${near.length}:${near[0]?.position ?? ""}`;
    symbolsKey = key;
    return { key, items: near };
  }
  map.on("move", () => {
    if (!state.countrySymbols || state.view !== "country") return;
    const before = symbolsKey;
    visibleSymbols();
    if (symbolsKey !== before) render();
  });

  function handleClick(info: PickingInfo) {
    onClick?.(toLngLat(info.coordinate), Boolean(info.object));
  }

  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: layers(),
    onClick: handleClick,
    onHover: (info) => onHover?.(toLngLat(info.coordinate)),
  });
  map.addControl(overlay);
  map.getCanvasContainer().addEventListener("pointerleave", () => onHover?.(null));
  function render() {
    overlay.setProps({ layers: layers() });
  }

  let waporId = 0;
  function showNextWapor(entry: WaporEntry) {
    if (entry !== state.waporNext) return;
    state.wapor = entry;
    state.waporNext = null;
    // (Called while deck.gl updates its layers.)
    queueMicrotask(render);
  }

  return {
    map,
    theme,
    setView(view) {
      if (view === state.view) return;
      state.view = view;
      render();
    },
    setLayerVisible(layer, visible) {
      state.visible[layer] = visible;
      render();
    },
    setSelection(selection) {
      state.selection = selection;
      render();
    },
    showBox([west, south, east, north]) {
      // MapLibre takes a box across 180° as east beyond 180.
      const bounds: [number, number, number, number] = [west, south, east < west ? east + 360 : east, north];
      map.fitBounds(bounds, { padding: 60, maxZoom: 7, duration: 1200 });
    },
    setHoveredSubBasin(subBasin) {
      if (subBasin?.id === state.hoverFills?.key) return; // unchanged (or still none)
      state.hoverFills = subBasin
        ? {
            key: subBasin.id,
            colors: new Map<number, Color>([
              ...[...subBasin.upstream].map((id): [number, Color] => [id, theme.upstream]),
              [subBasin.id, theme.hovered],
            ]),
          }
        : undefined;
      render();
    },
    setSubBasinFills(fills) {
      if (fills?.key === state.valueFills?.key) return;
      state.valueFills = fills ?? undefined;
      render();
    },
    setOutlinedSubBasins(ids) {
      if (ids.join() === state.outlined.join()) return;
      state.outlined = ids;
      render();
    },
    setCountryFills(fills) {
      if (fills?.key === state.countryFills?.key) return;
      state.countryFills = fills ?? undefined;
      render();
    },
    setCountrySymbols(symbols) {
      if (symbols?.key === state.countrySymbols?.key) return;
      state.countrySymbols = symbols;
      render();
    },
    setWapor(period, onLoad, seamless = false) {
      const same = (entry: WaporEntry | null) =>
        period?.key === entry?.period.key && period?.qualityUrl === entry?.period.qualityUrl;
      if (same(state.waporNext)) return;
      if (same(state.wapor)) {
        if (!state.waporNext) return;
        state.waporNext = null;
      } else {
        const entry = period && { period, onLoad, id: ++waporId };
        if (seamless && entry && state.wapor) state.waporNext = entry;
        else [state.wapor, state.waporNext] = [entry, null];
      }
      render();
    },
    setWaporMaxGap(maxGap) {
      if (maxGap === state.waporMaxGap) return;
      state.waporMaxGap = maxGap;
      render();
    },
  };
}

/** Cosine of the angle between two points on the globe (1: same point, < 0: opposite sides). */
function facing([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]) {
  const r = Math.PI / 180;
  return Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng1 - lng2) * r);
}

// deck.gl gives no coordinate (or NaN) for a point off the globe.
function toLngLat(coordinate: number[] | undefined): LngLat | null {
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
  return [coordinate[0], coordinate[1]];
}
