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
import { majorBasinsLayers, subBasinsLayers } from "./layers/basins";
import { bordersLayer } from "./layers/borders";
import { countriesLayer } from "./layers/countries";
import { markerLayer } from "./layers/marker";
import { waporLayer, type WaporPeriod } from "./layers/wapor";
import { lakesLayer, riversLayer } from "./layers/water";
import type { LngLat } from "./places";
import { THEMES, type Color } from "./theme";

/** Layers the user can switch on and off (see the layers menu). */
export type ToggleableLayer = "rivers" | "lakes";

export interface WaterMap {
  map: maplibregl.Map;
  /** Show the areas for a toolbar view: basins in the Basin view, else countries. */
  setView(view: View): void;
  setLayerVisible(layer: ToggleableLayer, visible: boolean): void;
  /** Show the WaPOR raster for a period (null: none). `onLoad` runs once it's opened. */
  setWapor(period: WaporPeriod | null, onLoad?: () => void): void;
  /** Show the selection: a marker at the point, and the country and basins filled. */
  setSelection(selection: MapSelection): void;
  /** Move the camera to show a box: [west, south, east, north], west > east across 180°. */
  showBox(bbox: [number, number, number, number]): void;
  /** Basin view: shade a sub-basin and those upstream of it (null: none). */
  setHoveredSubBasin(subBasin: { id: number; upstream: Set<number> } | null): void;
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
    wapor: null as { period: WaporPeriod; onLoad?: () => void } | null,
    hoverFills: undefined as { key: number; colors: Map<number, Color> } | undefined,
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
    // Sub-basins are only drawn to fill the selected one, and to shade the hovered one
    // and those upstream of it.
    const sub = subBasinsLayers({
      fill: [0, 0, 0, 0],
      border: theme.basinBorder,
      visible: basins && Boolean(state.hoverFills || state.selection.subBasin),
      selected: state.selection.subBasin,
      selectedColor: theme.selectedSubBasin,
      fills: state.hoverFills,
    });
    return [
      countriesLayer({
        color: theme.land,
        selected: state.selection.country,
        selectedColor: theme.selected,
        visible: !basins,
      }),
      waporLayer({ period: state.wapor?.period ?? null, onLoad: state.wapor?.onLoad }),
      major.areas,
      sub.areas,
      bordersLayer({ color: theme.border, visible: !basins }),
      major.outlines, // (sub.outlines: not drawn for now)
      riversLayer({ color: theme.river, visible: state.visible.rivers }),
      lakesLayer({ color: theme.water, visible: state.visible.lakes }),
      markerLayer({ position: state.selection.lngLat, fill: theme.marker, ring: theme.markerRing }),
    ];
  }

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

  return {
    map,
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
    setWapor(period, onLoad) {
      if (period?.url === state.wapor?.period.url) return;
      state.wapor = period && { period, onLoad };
      render();
    },
  };
}

// deck.gl gives no coordinate (or NaN) for a point off the globe.
function toLngLat(coordinate: number[] | undefined): LngLat | null {
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
  return [coordinate[0], coordinate[1]];
}
