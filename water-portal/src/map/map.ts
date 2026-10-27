/*
 * The map: a MapLibre globe with deck.gl layers drawn into it (interleaved), so
 * deck.gl uses a GlobeView that moves with MapLibre's camera. There is no basemap:
 * MapLibre only paints the ocean, and all data are deck.gl layers.
 */
import type { Layer, PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { View } from "../toolbar/range-rules";
import { majorBasinsLayers, subBasinOutlinesLayer, subBasinsLayers, type BasinFills } from "./layers/basins";
import { bordersLayer } from "./layers/borders";
import { HorizonExtension } from "./layers/horizon";
import { countriesLayer, countryOutlineLayer, countrySymbolsLayer, type CountryFills, type CountrySymbol } from "./layers/countries";
import { markerLayer } from "./layers/marker";
import { barsLayer, type Bar } from "./layers/bars";
import { basinSchemeLayers, PARTICLES_ID, type BasinScheme, type SchemeArrow, type SchemeLineStyle } from "./layers/basin-scheme";
import { EFFECTS_ID, effectGroundLayers, effectLayers, type BasinEffects } from "./layers/basin-effects";
import { DEFAULT_RAMP, onWaporLevel, openWapor, waporLayer, waporOpened, waporShownLevel, type WaporPeriod } from "./layers/wapor";
import type { WaporRamp } from "./layers/wapor-shader";
import { lakesLayer, riversLayer } from "./layers/water";
import type { LngLat } from "./places";
import { THEMES, type Color, type MapTheme } from "./theme";
import { animate as ease, createFade, createTween, easeOut, linear, type Fade, type Timing } from "./tween";

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
   * every tile in view, then switch at once. Zoomed in where it has L2, that's shown
   * instead (see wapor.ts).
   */
  setWapor(period: WaporPeriod | null, onLoad?: () => void, seamless?: boolean): void;
  /** Hide WaPOR pixels with a longer NDVI gap than this, in dekads (null: none). */
  setWaporMaxGap(maxGap: number | null): void;
  /** The colour map for the WaPOR raster, in its variable's unit per day. */
  setWaporRamp(ramp: WaporRamp): void;
  /** Show the selection: a marker at the point (Local view), and the country and basins filled. */
  setSelection(selection: MapSelection): void;
  /** Move the camera to show a box: [west, south, east, north], west > east across 180°. */
  showBox(bbox: [number, number, number, number]): void;
  /** Move the camera to a point at a zoom, flying (far) or easing (near). */
  showPoint(center: LngLat, zoom: number, how?: "fly" | "ease"): void;
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
   * Basin view: a statistics map (basin-stats.ts): fill the major basins or the
   * sub-basins with their own colours, and outline some sub-basins. It takes over from
   * the model's values, the hover shading and the selected fill (the selected sub-basin
   * is outlined instead). `key` names the set, as above (null: none).
   */
  setBasinStatFills(fills: BasinStatFills | null): void;
  /**
   * Basin view: the water balance scheme (basin-stats.ts): discharge as lines along the
   * rivers, in place of the river tiles' in their sub-basins (null: none). By `key`, as above.
   */
  setBasinScheme(scheme: BasinScheme | null): void;
  /** Basin view: precipitation as rain, evapotranspiration as vapour (basin-stats.ts; null: none). By `key`, as above. */
  setBasinEffects(effects: BasinEffects | null): void;
  /**
   * Country view: fill countries with their own colours (a statistic's values), and
   * outline the selected country instead of filling it (null: none). `key` names the
   * set of colours: the map only repaints when it changes.
   */
  setCountryFills(fills: { key: string; colors: Map<number, Color> } | null): void;
  /** Country view: circles on countries (proportional symbols, rings), by `key` as above. */
  setCountrySymbols(symbols: { key: string; items: CountrySymbol[] } | null): void;
  /** Basin view: circles on basins (a statistics map drawn as circles), by `key` as above. */
  setBasinSymbols(symbols: { key: string; items: CountrySymbol[] } | null): void;
  /**
   * The Country or Basin view: 3D bars on the areas (a statistics map drawn as bars), by
   * `key` as above. While a view's bars are shown, the map is tilted, to see them stand.
   */
  setBars(view: "country" | "basin", bars: { key: string; items: Bar[] } | null): void;
  /**
   * A range playing in the Country or Basin view, a step every `stepMs` (null: not
   * playing): the map's changes are then eased over the whole step, evenly, so they flow
   * on from one step to the next (else, quicker, slowing at the end).
   */
  setPlayback(stepMs: number | null): void;
  theme: MapTheme;
}

interface WaporEntry {
  period: WaporPeriod;
  onLoad?: () => void;
  id: number; // a layer of its own, so a new period doesn't take over the shown one's tiles
  /** Its L2 layer has loaded every tile in view: its L1 layer, kept until then, can go. */
  l2Loaded?: boolean;
}

export interface BasinStatFills {
  level: "major" | "sub";
  key: string;
  colors: Map<number, Color>;
  outlined: number[];
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
  /**
   * The marker was dragged and dropped on a country or basin (whichever is shown).
   * Dropped on the ocean or off the globe, it goes back to where it was.
   */
  onMarkerDrop?: (lngLat: LngLat) => void;
}

/** How long a change of the map's colours and sizes is eased over (when not playing). */
const EASE_MS = 400;

/** How near the marker a press picks it up, in pixels. */
const MARKER_GRAB = 10;

export function createMap(container: HTMLElement, { dark, onClick, onHover, onMarkerDrop }: MapOptions): WaterMap {
  const theme = dark ? THEMES.dark : THEMES.light;
  const state = {
    view: "country" as View,
    selection: { lngLat: null, country: null, majorBasin: null, subBasin: null } as MapSelection,
    visible: { rivers: true, lakes: true } as Record<ToggleableLayer, boolean>,
    wapor: null as WaporEntry | null,
    waporNext: null as WaporEntry | null, // seamless: loading, not drawn yet
    waporLast: null as WaporEntry | null, // seamless: the one before, under `wapor` while it fades in
    waporFade: 1, // `wapor`'s opacity
    waporMaxGap: null as number | null,
    waporRamp: DEFAULT_RAMP,
    hoverFills: undefined as { key: number; colors: Map<number, Color> } | undefined,
    valueFills: undefined as { key: string; colors: Map<number, Color> } | undefined,
    outlined: [] as number[],
    countryFills: undefined as { key: string; colors: Map<number, Color> } | undefined,
    countrySymbols: null as { key: string; items: CountrySymbol[] } | null,
    basinSymbols: null as { key: string; items: CountrySymbol[] } | null,
    bars: { country: null, basin: null } as Record<"country" | "basin", { key: string; items: Bar[] } | null>,
    basinStats: null as BasinStatFills | null,
    scheme: null as BasinScheme | null,
    effects: null as BasinEffects | null,
    dragged: null as LngLat | null, // the marker while it is dragged
  };

  // Changes eased in (tween.ts): the fills faded in over the last, the rest paired by key.
  // (The same object until the playback changes: a new one is a changed prop to deck.gl.)
  const EASED: Timing = { duration: EASE_MS, easing: easeOut };
  let playing: Timing | null = null;
  const timing = () => playing ?? EASED;
  const tween = <T extends object>(keyOf: (item: T) => unknown, zero: Partial<T>) =>
    createTween<T>({ keyOf, zero, timing, onFrame: () => render() });
  const symbolTweens = {
    country: tween<CountrySymbol>((s) => s.id, { radius: 0 }),
    basin: tween<CountrySymbol>((s) => s.id, { radius: 0 }),
  };
  const barTweens = {
    country: tween<Bar>((b) => b.position.join(), { height: 0 }),
    basin: tween<Bar>((b) => b.position.join(), { height: 0 }),
  };
  const schemeTweens = {
    // (A line's path is the scheme's own: the same array as long as the scheme is.)
    lines: tween<SchemeLineStyle>((l) => l.path, { width: 0 }),
    arrows: tween<SchemeArrow>((a) => a.subBasin, { size: 0 }),
  };
  const fades = {
    countries: createFade<CountryFills | undefined>(() => render()),
    major: createFade<BasinFills | undefined>(() => render()),
    sub: createFade<BasinFills | undefined>(() => render()),
  };
  const schemeShown = () => {
    const shown = <T>(t: { get(): { key: string; items: T[] } | null }) => t.get() ?? { key: "", items: [] };
    return { lines: shown(schemeTweens.lines), arrows: shown(schemeTweens.arrows), transition: timing() };
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
  // The URL keeps the place and the zoom, not a tilt or turn (the bars' tilt, say):
  // always opened flat, north up.
  map.jumpTo({ pitch: 0, bearing: 0 });
  // The compass shows the tilt too: dragged, it turns and tilts the map; clicked, it
  // puts it back flat, north up.
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  // MapLibre spells the credits out at first, until the map is moved; keep them to the
  // ⓘ from the start (they show on a click).
  const attrib = container.querySelector(".maplibregl-ctrl-attrib")!;
  const shut = () => {
    if (!attrib.classList.contains("maplibregl-compact-show")) return false;
    attrib.classList.remove("maplibregl-compact-show");
    attrib.removeAttribute("open");
    return true;
  };
  if (!shut()) {
    // (not yet compact: it's opened when it becomes so)
    const watch = new MutationObserver(() => shut() && watch.disconnect());
    watch.observe(attrib, { attributeFilter: ["class"] });
  }

  /** A fading layer's copies, with `fills` as the ones to show (eased in by `t`). */
  function faded<F extends { key: unknown } | undefined>(fade: Fade<F>, fills: F, t: Timing | null) {
    fade.to(fills, t);
    return fade.copies();
  }

  // Bottom to top. Rivers and lakes stay on top of whichever areas are shown.
  function layers() {
    const basins = state.view === "basin";
    const stats = basins ? state.basinStats : null;
    const major = majorBasinsLayers({
      fill: theme.land,
      border: theme.basinBorder,
      visible: basins,
      // the most precise one only
      selected: state.selection.subBasin || stats ? null : state.selection.majorBasin,
      selectedColor: theme.selected,
      fills: faded(fades.major, stats?.level === "major" ? stats : undefined, timing()),
    });
    // Sub-basins are only drawn to fill the selected one, to shade the hovered one
    // and those upstream of it, or to show the water balance model's values or a
    // statistics map.
    const values = stats ? (stats.level === "sub" ? stats : undefined) : state.valueFills;
    const sub = subBasinsLayers({
      fill: [0, 0, 0, 0],
      border: theme.basinBorder,
      visible: basins && Boolean(stats ? values : values || state.hoverFills || state.selection.subBasin),
      selected: values ? null : state.selection.subBasin,
      selectedColor: theme.selectedSubBasin,
      // (The shading under the pointer follows it at once.)
      fills: faded(fades.sub, values ?? state.hoverFills, values ? timing() : null),
    });
    const scheme = basins ? state.scheme : null;
    const effects = basins ? state.effects : null;
    const outlined = stats
      ? [...stats.outlined, ...(state.selection.subBasin ? [state.selection.subBasin] : [])]
      : state.outlined;
    return [
      ...countriesLayer({
        color: theme.land,
        selected: state.selection.country,
        selectedColor: theme.selected,
        visible: !basins,
        fills: faded(fades.countries, state.view === "country" ? state.countryFills : undefined, timing()),
      }),
      ...[state.waporLast, state.wapor, state.waporNext].flatMap((entry) => (entry ? waporLayers(entry) : [])),
      ...major.areas,
      ...sub.areas,
      bordersLayer({ color: theme.border, visible: !basins }),
      major.outlines, // (sub.outlines: not drawn for now)
      ...effectGroundLayers(effects),
      riversLayer({
        color: theme.river,
        visible: state.visible.rivers,
        hidden: scheme ? { key: scheme.subBasinsKey, subBasins: scheme.subBasins } : undefined,
      }),
      lakesLayer({ color: theme.water, visible: state.visible.lakes }),
      subBasinOutlinesLayer({ ids: outlined, color: theme.outline, visible: basins }),
      ...basinSchemeLayers(scheme, schemeShown()),
      ...effectLayers(effects),
      countryOutlineLayer({
        m49: state.selection.country,
        color: theme.outline,
        halo: theme.markerRing,
        visible: state.view === "country" && Boolean(state.countryFills),
      }),
      barsLayer({ bars: shownBars(), zoom: barsZoom }),
      countrySymbolsLayer({ symbols: visibleSymbols() }),
      // The clicked point: only the Local view is about a point.
      markerLayer({
        position: state.view === "local" ? (state.dragged ?? state.selection.lngLat) : null,
        fill: theme.marker,
        ring: theme.markerRing,
      }),
    ];
  }

  // Only the circles on the near side of the globe: they are drawn without a depth
  // test (like everything here), so the far side's would show through.
  let symbolsKey = "";
  const shownSymbols = () => (state.view === "country" || state.view === "basin" ? symbolTweens[state.view].get() : null);
  function visibleSymbols() {
    const symbols = shownSymbols();
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
    // The bars keep their height in pixels: drawn again as the zoom changes.
    const zoom = Math.round(map.getZoom() * 20) / 20;
    if (shownBars() && zoom !== barsZoom) {
      barsZoom = zoom;
      return render();
    }
    if (!shownSymbols()) return;
    const before = symbolsKey;
    visibleSymbols();
    if (symbolsKey !== before) render();
  });

  const shownBars = () => (state.view === "country" || state.view === "basin" ? barTweens[state.view].get() : null);
  let barsZoom = Math.round(map.getZoom() * 20) / 20;
  // Tilted for the bars (and back flat when they go), unless it was tilted already.
  const TILT = 40;
  let tilted = false;
  function tilt() {
    // (The bars set, not those still shrinking away.)
    const want = (state.view === "country" || state.view === "basin") && Boolean(state.bars[state.view]);
    if (want && !tilted && map.getPitch() < 15) {
      tilted = true;
      map.easeTo({ pitch: TILT, duration: 800 });
    } else if (!want && tilted) {
      tilted = false;
      map.easeTo({ pitch: 0, duration: 800 });
    }
  }

  function handleClick(info: PickingInfo) {
    onClick?.(toLngLat(info.coordinate), Boolean(info.object));
  }

  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: drawn(),
    onClick: handleClick,
    onHover: (info) => onHover?.(toLngLat(info.coordinate)),
  });
  map.addControl(overlay);
  map.on("load", () => render());
  map.getCanvasContainer().addEventListener("pointerleave", () => onHover?.(null));
  function render() {
    overlay.setProps({ layers: drawn() });
  }

  // The scheme's particles, the rain and the vapour move every frame (deck.gl draws on each of MapLibre's repaints).
  let animating = false;
  function animate() {
    if (animating) return;
    const frame = () => {
      animating = Boolean(state.scheme?.particles || state.effects) && state.view === "basin";
      if (!animating) return;
      map.triggerRepaint();
      requestAnimationFrame(frame);
    };
    frame();
  }

  /** The layers as drawn: each hides the far side of the globe. */
  function drawn() {
    // (The particles are drawn off screen and pasted on, flat: no extensions. The rain
    // and vapour hide the far side themselves.)
    return layers().map((layer: Layer | null) =>
      !layer || layer.id.startsWith(PARTICLES_ID) || layer.id.startsWith(EFFECTS_ID) ? layer : layer.clone({ extensions: [...layer.props.extensions, HORIZON] }),
    );
  }

  // Dragging the marker: a press on it holds the map still (preventDefault keeps
  // MapLibre from panning), the marker follows the pointer, and the drop is passed on.
  const canvas = map.getCanvas();
  function onMarker(point: maplibregl.Point) {
    const at = state.selection.lngLat;
    if (!at || state.view !== "local") return false; // (only shown in the Local view)
    const { lng, lat } = map.getCenter();
    if (facing(at, [lng, lat]) <= 0) return false; // on the far side of the globe
    return map.project(at).dist(point) <= MARKER_GRAB;
  }
  let grabbed = false;
  function grab(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
    if (!onMarker(e.point)) return;
    e.preventDefault();
    grabbed = true;
    canvas.style.cursor = "grabbing";
  }
  function drag(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
    if (!grabbed) {
      // (mouse only: show that the marker can be picked up)
      if (e.type === "mousemove") canvas.style.cursor = onMarker(e.point) ? "grab" : "";
      return;
    }
    state.dragged = toLngLat([e.lngLat.lng, e.lngLat.lat]);
    render();
  }
  function drop(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
    if (!grabbed) return;
    grabbed = false;
    canvas.style.cursor = onMarker(e.point) ? "grab" : "";
    const dropped = state.dragged;
    state.dragged = null;
    if (!dropped) return; // pressed without moving: a click
    const onArea = Boolean(overlay.pickObject({ x: e.point.x, y: e.point.y }));
    // Keep it where it was dropped until the new selection comes in.
    if (onArea) state.selection = { ...state.selection, lngLat: dropped };
    render();
    if (onArea) onMarkerDrop?.(dropped);
  }
  map.on("mousedown", grab);
  map.on("mousemove", drag);
  map.on("mouseup", drop);
  map.on("touchstart", (e) => e.points.length === 1 && grab(e));
  map.on("touchmove", drag);
  map.on("touchend", drop);
  map.on("touchcancel", drop);
  // Released off the map: the marker goes back.
  window.addEventListener("mouseup", () => {
    if (!grabbed) return;
    grabbed = false;
    canvas.style.cursor = "";
    state.dragged = null;
    render();
  });

  /**
   * A period's layers: L1 while the view asks for L1, L2 while it asks for L2 (and
   * the period has it). Until L2 has loaded every tile in view, L1 keeps showing the
   * tiles it had, so zooming in doesn't blank the map. A level's rasters are opened
   * before its layer is made (the layer would open them again, not knowing the
   * tiles' reader does), and only when it's shown: a period loaded ahead while
   * playing at L2 never opens its L1 rasters.
   */
  function waporLayers(entry: WaporEntry) {
    const next = entry === state.waporNext;
    const opacity = entry === state.wapor ? state.waporFade : 1;
    const { period } = entry;
    const atL2 = waporShownLevel(period) === "L2";
    const layer = (p: WaporPeriod, id: string, hidden: boolean, onViewportLoad?: () => void) => {
      if (!waporOpened(p)) {
        openWapor(p).then(render, () => {});
        return null;
      }
      return waporLayer({ id, period: p, ramp: state.waporRamp, maxGap: state.waporMaxGap, onLoad: entry.onLoad, hidden, opacity, onViewportLoad });
    };
    const l1 = !atL2
      ? layer(period, `wapor-aeti-${entry.id}`, next, next ? () => showNextWapor(entry) : undefined)
      : !next && !entry.l2Loaded && waporOpened(period)
        ? layer(period, `wapor-aeti-${entry.id}`, false)
        : null;
    const l2 = atL2
      ? layer(period.l2!, `wapor-aeti-${entry.id}-l2`, next, () => {
          if (!entry.l2Loaded) {
            entry.l2Loaded = true;
            queueMicrotask(render); // (called while deck.gl updates its layers)
          }
          if (next) showNextWapor(entry);
        })
      : null;
    return [l1, l2];
  }
  // The view asks for the other level: add or drop the L2 layers. (Called while
  // deck.gl picks tiles.)
  onWaporLevel(() => {
    for (const entry of [state.waporLast, state.wapor, state.waporNext]) if (entry) entry.l2Loaded = false;
    queueMicrotask(render);
  });

  let waporId = 0;
  let cancelWaporFade = () => {};
  // The next period has loaded: it fades in over the one shown (over the step, while
  // playing), which then goes.
  function showNextWapor(entry: WaporEntry) {
    if (entry !== state.waporNext) return;
    cancelWaporFade();
    state.waporLast = state.wapor;
    state.wapor = entry;
    state.waporNext = null;
    state.waporFade = 0;
    cancelWaporFade = ease(timing(), (t) => {
      state.waporFade = t;
      if (t === 1) state.waporLast = null;
      render();
    });
    // (Called while deck.gl updates its layers.)
    queueMicrotask(render);
  }
  /** No fade (a period shown at once). */
  function stopWaporFade() {
    cancelWaporFade();
    state.waporLast = null;
    state.waporFade = 1;
  }

  return {
    map,
    theme,
    setView(view) {
      if (view === state.view) return;
      state.view = view;
      render();
      animate();
      tilt();
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
      // Padding given here only applies to this move: the globe stays put when a panel
      // opens or closes later.
      const { left, right } = coveredSides(container);
      map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60 + left, right: 60 + right }, maxZoom: 7, duration: 1200 });
    },
    showPoint(center, zoom, how = "fly") {
      // Centre the point in the part of the map left uncovered (an offset, unlike
      // padding, only applies to this move). While the whole globe fits across the
      // map, keep it on screen.
      const { left, right } = coveredSides(container);
      let dx = (left - right) / 2;
      const radius = (512 * 2 ** zoom) / (2 * Math.PI);
      const width = container.clientWidth;
      if (2 * radius < width) {
        const room = Math.max(0, width / 2 - radius - 12);
        dx = Math.max(-room, Math.min(room, dx));
      }
      const options = { center, zoom, offset: [dx, 0] as [number, number] };
      if (how === "fly") map.flyTo({ ...options, duration: 1200 });
      else map.easeTo(options);
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
    setBasinStatFills(fills) {
      if (fills?.key === state.basinStats?.key) return;
      state.basinStats = fills;
      render();
    },
    setBasinEffects(effects) {
      if (effects?.key === state.effects?.key) return;
      state.effects = effects;
      render();
      animate();
    },
    setBasinScheme(scheme) {
      if (scheme?.key === state.scheme?.key) return;
      state.scheme = scheme;
      schemeTweens.lines.set(scheme && { key: scheme.key, items: scheme.lines });
      schemeTweens.arrows.set(scheme && { key: scheme.key, items: scheme.arrows });
      render();
      animate();
    },
    setCountryFills(fills) {
      if (fills?.key === state.countryFills?.key) return;
      state.countryFills = fills ?? undefined;
      render();
    },
    setCountrySymbols(symbols) {
      if (symbols?.key === state.countrySymbols?.key) return;
      state.countrySymbols = symbols;
      symbolTweens.country.set(symbols);
      render();
    },
    setBasinSymbols(symbols) {
      if (symbols?.key === state.basinSymbols?.key) return;
      state.basinSymbols = symbols;
      symbolTweens.basin.set(symbols);
      render();
    },
    setPlayback(stepMs) {
      if ((playing?.duration ?? null) === (stepMs || null)) return;
      playing = stepMs ? { duration: stepMs, easing: linear } : null;
    },
    setBars(view, bars) {
      if (bars?.key === state.bars[view]?.key) return;
      state.bars[view] = bars;
      barTweens[view].set(bars);
      barsZoom = Math.round(map.getZoom() * 20) / 20;
      render();
      tilt();
    },
    setWapor(period, onLoad, seamless = false) {
      const same = (entry: WaporEntry | null) =>
        period && entry ? period.key === entry.period.key && period.qualityUrl === entry.period.qualityUrl : period === entry;
      // (No period and nothing loading isn't the same as nothing shown.)
      if (state.waporNext && same(state.waporNext)) return;
      if (same(state.wapor)) {
        if (!state.waporNext) return;
        state.waporNext = null;
      } else {
        const entry = period && { period, onLoad, id: ++waporId };
        if (seamless && entry && state.wapor) state.waporNext = entry;
        else {
          [state.wapor, state.waporNext] = [entry, null];
          stopWaporFade();
        }
      }
      render();
    },
    setWaporMaxGap(maxGap) {
      if (maxGap === state.waporMaxGap) return;
      state.waporMaxGap = maxGap;
      render();
    },
    setWaporRamp(ramp) {
      const same = (a: WaporRamp, b: WaporRamp) => a.quantities.join() === b.quantities.join() && a.colors.join() === b.colors.join();
      if (same(ramp, state.waporRamp)) return;
      state.waporRamp = ramp;
      render();
    },
  };
}

// Every layer hides the far side of the globe (tile layers pass it on to their tiles).
const HORIZON = new HorizonExtension();

/** The side panels: when one is open (not folded, foldable.ts), the camera frames what it shows beside it. */
const SIDE_PANELS = ".wb-panel:not([hidden]):not(.folding)";
/** Leave a panel out where it would leave less than this much of the map, in pixels. */
const MIN_UNCOVERED = 320;

/**
 * How far in from the map's left and right edges the open side panels reach, in
 * pixels. Small floating boxes (legends, the layers menu) don't count.
 */
function coveredSides(container: HTMLElement) {
  const box = container.getBoundingClientRect();
  const sides = { left: 0, right: 0 };
  for (const panel of document.querySelectorAll<HTMLElement>(SIDE_PANELS)) {
    const r = panel.getBoundingClientRect();
    if (r.width === 0 || r.height < box.height / 2) continue;
    if (r.left - box.left > box.right - r.right) sides.right = Math.max(sides.right, box.right - r.left);
    else sides.left = Math.max(sides.left, r.right - box.left);
  }
  return box.width - sides.left - sides.right < MIN_UNCOVERED ? { left: 0, right: 0 } : sides;
}

/** Cosine of the angle between two points on the globe (1: same point, < 0: opposite sides). */
export function facing([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]) {
  const r = Math.PI / 180;
  return Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng1 - lng2) * r);
}

// deck.gl gives no coordinate (or NaN) for a point off the globe.
function toLngLat(coordinate: number[] | undefined): LngLat | null {
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
  return [coordinate[0], coordinate[1]];
}
