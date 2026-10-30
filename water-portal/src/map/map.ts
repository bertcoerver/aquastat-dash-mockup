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
import { narrowLayout } from "../lib/dom";
import { basinOutlinesLayer, majorBasinsLayers, subBasinOutlinesLayer, subBasinsLayers, type BasinFills } from "./layers/basins";
import { bordersLayer } from "./layers/borders";
import { graticuleLabels, graticuleLayer } from "./layers/graticule";
import { HorizonExtension } from "./layers/horizon";
import { countriesLayer, countryOutlineLayer, countrySymbolsLayer, type CountryFills, type CountrySymbol } from "./layers/countries";
import { markerLayer } from "./layers/marker";
import { barsLayer, type Bar } from "./layers/bars";
import { basinSchemeLayers, PARTICLES_ID, type BasinScheme, type SchemeArrow, type SchemeLineStyle } from "./layers/basin-scheme";
import { EFFECTS_ID, effectGroundLayers, effectLayers, type BasinEffects } from "./layers/basin-effects";
import type { RasterSum, WaporPeriod } from "./layers/wapor-period";
import { DEFAULT_RAMP } from "./layers/wapor-variables";
import { onWaporLevel, prepareWapor, waporLayer, waporReady, waporShownLevel } from "./layers/wapor";
import type { WaporRamp } from "./layers/wapor-shader";
import { lakesLayer, riversLayer } from "./layers/water";
import type { LngLat, Place } from "./places";
import { spinControl } from "./spin";
import { THEMES, type Color, type MapTheme } from "./theme";
import { animate as ease, createFade, createTween, easeOut, linear, type Fade, type Timing } from "./tween";

/** Layers the user can switch on and off (see the layers menu). */
/** Map layers with a switch in the Layers menu (upstream, downstream: what hovering a sub-basin picks out). */
export type ToggleableLayer = "rivers" | "lakes" | "graticule" | "upstream" | "downstream" | "countries" | "basins" | "subBasins";

/** What's under the pointer, as the map picks it out (setHovered). */
/** A sub-basin's: `flow`, whether those up- and downstream of it are picked out (if any; switched on in the Layers menu). */
/** The sub-basins picked out upstream and downstream of the hovered one (null: switched off in the Layers menu). */
export interface Flow {
  sub: number;
  upstream: Set<number> | null;
  downstream: Set<number> | null;
}

export type Hovered = { country: number } | { major: number } | { sub: number; flow: boolean; upstream: Set<number>; downstream: Set<number> };
const hoverKey = (h: Hovered | null) => (!h ? "" : "country" in h ? `c${h.country}` : "major" in h ? `m${h.major}` : `s${h.sub}:${h.flow ? 1 : 0}`);
const NONE = new Set<number>();

/** The views with statistics maps of their own: circles, bars and the order they're drawn in. */
export type StatView = "country" | "basin" | "local";

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
  /** Local view: a GAEZ map (gaez.ts), drawn where the WaPOR raster is, in its colours (null: none). */
  setGaez(gaez: { sum: RasterSum; ramp: WaporRamp } | null): void;
  /** Show the selection: a marker at the point (Local view), and the country and basins filled. */
  setSelection(selection: MapSelection): void;
  /** Move the camera to show a box: [west, south, east, north], west > east across 180°. */
  showBox(bbox: [number, number, number, number]): void;
  /** Move the camera to a point at a zoom, flying (far) or easing (near). */
  showPoint(center: LngLat, zoom: number, how?: "fly" | "ease"): void;
  /**
   * Outline what's under the pointer: a country (Country view), a major basin, or a
   * sub-basin with those up- and downstream of it filled (Basin view); null: none.
   */
  setHovered(hovered: Hovered | null): void;
  /**
   * Called as the sub-basins upstream and downstream of the hovered one start or stop
   * being picked out (which of them: either may be switched off, or have none).
   */
  onFlow(listener: (flow: Flow | null) => void): void;
  /**
   * Basin view: a statistics map (basin-stats.ts): fill the major basins or the
   * sub-basins with their own colours, and outline some sub-basins. It takes over from
   * the selected fill (the selected sub-basin is outlined instead). `key` names the set
   * of colours: the map only repaints when it changes (null: none).
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
  /**
   * A view's circles (proportional symbols, rings): on countries (Country view), basins
   * (Basin view) or the points of a vector map (Local view, local/local-maps.ts; picked
   * for their tooltips), by `key` as above.
   */
  setSymbols(view: StatView, symbols: { key: string; items: CountrySymbol[] } | null): void;
  /**
   * 3D bars on the areas or points (a statistics map drawn as bars), by `key` as above.
   * While a view's bars are shown, the map is tilted, to see them stand.
   */
  setBars(view: StatView, bars: { key: string; items: Bar[] } | null): void;
  /**
   * The order to draw a view's statistics maps in, by slot, top first (the legend's:
   * "circles", "bars", "lines", "rain", "vapour"). The colours (and the Local view's
   * raster) stay at the bottom; slots not named keep their own order, under those named.
   */
  setLayerOrder(view: StatView, slots: string[]): void;
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
  /** A point of the Local view's maps at `lngLat` (a dam): its circle's id, and its name to show beside it. */
  feature: { id: string; name: string } | null;
  country: number | null;
  majorBasin: number | null;
  subBasin: number | null;
}

interface MapOptions {
  dark: boolean;
  /**
   * A click anywhere: the point on the globe (null off the globe), and whether it hit
   * a country or basin (whichever is shown) rather than the ocean; in the Local view,
   * the circle or bar clicked (its `id`; null: none); and what's drawn there, as for
   * onHover (null: nothing).
   */
  onClick?: (lngLat: LngLat | null, onArea: boolean, symbol: string | null, place: Place | null) => void;
  /**
   * The pointer moved: the point under it, or null off the globe or off the map; and
   * what's drawn there (picked from the map as shown, so at once: no tiles to load),
   * the country, or the major basin and, where the sub-basins are drawn, the sub-basin.
   */
  onHover?: (lngLat: LngLat | null, place: Place | null) => void;
  /**
   * The marker was dragged and dropped on a country or basin (whichever is shown).
   * Dropped on the ocean or off the globe, it goes back to where it was.
   */
  onMarkerDrop?: (lngLat: LngLat) => void;
  /**
   * Local view: the circle or bar under the pointer (its `id`; null: none), where the
   * pointer is on the page, for a tooltip, and on the map (null: off the globe).
   */
  onSymbolHover?: (id: string | null, x: number, y: number, lngLat: LngLat | null) => void;
}

/** How long a change of the map's colours and sizes is eased over (when not playing). */
const EASE_MS = 400;

/** How near the marker a press picks it up, in pixels. */
const MARKER_GRAB = 10;

export function createMap(container: HTMLElement, { dark, onClick, onHover, onMarkerDrop, onSymbolHover }: MapOptions): WaterMap {
  const theme = dark ? THEMES.dark : THEMES.light;
  const state = {
    view: "country" as View,
    selection: { lngLat: null, feature: null, country: null, majorBasin: null, subBasin: null } as MapSelection,
    visible: { rivers: true, lakes: true, graticule: false, upstream: true, downstream: true, countries: true, basins: false, subBasins: false } as Record<ToggleableLayer, boolean>,
    wapor: null as WaporEntry | null,
    waporNext: null as WaporEntry | null, // seamless: loading, not drawn yet
    waporLast: null as WaporEntry | null, // seamless: the one before, under `wapor` while it fades in
    waporFade: 1, // `wapor`'s opacity
    waporMaxGap: null as number | null,
    waporRamp: DEFAULT_RAMP,
    gaez: null as { sum: RasterSum; ramp: WaporRamp } | null,
    hovered: null as Hovered | null,
    countryFills: undefined as { key: string; colors: Map<number, Color> } | undefined,
    symbols: { country: null, basin: null, local: null } as Record<StatView, { key: string; items: CountrySymbol[] } | null>,
    /** The Local view's symbols by id (the picked point's circle is looked up at every frame). */
    localById: new Map<string, CountrySymbol>(),
    bars: { country: null, basin: null, local: null } as Record<StatView, { key: string; items: Bar[] } | null>,
    order: { country: [], basin: [], local: [] } as Record<StatView, string[]>,
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
    local: tween<CountrySymbol>((s) => s.id, { radius: 0 }),
  };
  const barTweens = {
    country: tween<Bar>((b) => b.position.join(), { height: 0 }),
    basin: tween<Bar>((b) => b.position.join(), { height: 0 }),
    local: tween<Bar>((b) => b.position.join(), { height: 0 }),
  };
  const schemeTweens = {
    lines: tween<SchemeLineStyle>((l) => l.id, { width: 0 }),
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
    // (As a parameter among the page's others: see url-state.ts.)
    hash: "map",
    attributionControl: {
      compact: true,
      customAttribution: "FAO M49 &amp; SDG 6 basins · HydroLAKES · HydroSHEDS",
    },
  });
  // The URL keeps the place and the zoom, not a tilt or turn (the bars' tilt, say):
  // always opened flat, north up.
  map.jumpTo({ pitch: 0, bearing: 0 });
  // MapLibre skips its ResizeObserver's first report, taking it for the size the map was
  // made at. Safari can lay the page out again in between (a tab opened in the
  // background, a window being restored), and the map then stays at that first size —
  // a small globe in the top-left — until reloaded. Catch it up whenever the two differ.
  new ResizeObserver(() => {
    const canvas = map.getCanvas();
    if (canvas.clientWidth !== container.clientWidth || canvas.clientHeight !== container.clientHeight) map.resize();
  }).observe(container);
  // Let go mid-drag, the globe spins on for a while (MapLibre's own inertia stops short).
  map.dragPan.enable({
    linearity: 0.6,
    easing: (t) => 1 - Math.pow(1 - t, 3),
    maxSpeed: 20000,
    deceleration: 60,
  });
  // The compass shows the tilt too: dragged, it turns and tilts the map; clicked, it
  // puts it back flat, north up.
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  // Above them, a button to set the globe spinning.
  map.addControl(spinControl(map), "bottom-right");
  // The graticule's longitudes: markers, shown with its lines.
  const graticuleNames = graticuleLabels(map);
  // The picked point's name (a dam's), beside its target: a marker too (deck.gl draws no text here).
  const featureLabel = document.createElement("div");
  featureLabel.className = "feature-label";
  const featureMarker = new maplibregl.Marker({ element: featureLabel, anchor: "left", opacityWhenCovered: "0" });
  let featureShown = "";
  function showFeatureLabel() {
    const { lngLat, feature } = state.selection;
    const radius = featureRadius();
    const key = radius !== null && lngLat && feature ? `${feature.name} ${lngLat} ${radius}` : "";
    if (key === featureShown) return;
    featureShown = key;
    if (!key) return void featureMarker.remove();
    featureLabel.textContent = feature!.name;
    featureMarker.setOffset([radius! + 10, 0]).setLngLat(lngLat!).addTo(map);
  }
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

  let wasFlow = false; // (whether the last layers had sub-basins picked out up- and downstream)

  /**
   * The Basin view's: the major and sub-basins' areas (a statistics map's colours, the
   * selected basin, up- and downstream of the hovered sub-basin), the outlines (shown
   * in the other views if switched on), the sub-basins picked out and the hovered ones.
   */
  function basinLayers() {
    const basins = state.view === "basin";
    const stats = basins ? state.basinStats : null;
    // Upstream and downstream of the sub-basin under the pointer: the sub-basins filled
    // green and red, over plain land (no map's colours meanwhile). At once, not eased:
    // they follow the pointer.
    const hovered = state.hovered;
    const { flow, upstream, downstream } = flowOf();
    const fillTiming = flow || wasFlow ? null : timing();
    wasFlow = flow;
    const colors = new Map<number, Color>();
    for (const id of upstream) colors.set(id, theme.upstreamVeil);
    for (const id of downstream) colors.set(id, theme.downstreamVeil);
    const flowFills = flow && hovered && "sub" in hovered ? { key: `flow:${hovered.sub}`, colors } : undefined;
    const major = majorBasinsLayers({
      fill: theme.land,
      border: theme.basinBorder,
      visible: basins,
      // (outside the Basin view: the outlines alone, if switched on)
      outlined: basins || state.visible.basins,
      // the most precise one only
      selected: state.selection.subBasin || stats ? null : state.selection.majorBasin,
      selectedColor: theme.selected,
      fills: faded(fades.major, stats?.level === "major" && !flow ? stats : undefined, fillTiming),
    });
    // Sub-basins are only drawn to fill the selected one, to show a statistics map, or
    // up- and downstream.
    const values = !flow && stats?.level === "sub" ? stats : undefined;
    const sub = subBasinsLayers({
      fill: [0, 0, 0, 0],
      border: theme.basinBorder,
      visible: basins && (flow || Boolean(stats ? values : state.selection.subBasin)),
      // (in the Basin view, only with up- and downstream picked out)
      outlined: basins ? flow : state.visible.subBasins,
      outlineWidth: basins ? 0.9 : 0.6,
      selected: values ? null : state.selection.subBasin,
      selectedColor: theme.selectedSubBasin,
      fills: faded(fades.sub, flowFills ?? values, fillTiming),
    });
    const picked = stats ? [...stats.outlined, ...(state.selection.subBasin ? [state.selection.subBasin] : [])] : [];
    return {
      areas: [...major.areas, ...sub.areas],
      outlines: [sub.outlines, major.outlines], // (the sub-basins': not in the Basin view, for now)
      picked: subBasinOutlinesLayer({ ids: picked, color: theme.outline, visible: basins }),
      // (Under the pointer: an outline thinner than the selected one's.)
      hovered: [
        basinOutlinesLayer({ id: "major-basin-hovered", level: "major", ids: hovered && "major" in hovered ? [hovered.major] : [], color: theme.outline, halo: theme.markerRing, width: 1.75, visible: basins }),
        basinOutlinesLayer({ id: "sub-basin-hovered", level: "sub", ids: hovered && "sub" in hovered ? [hovered.sub] : [], color: theme.outline, halo: theme.markerRing, width: 1.75, visible: basins }),
      ],
      scheme: basins ? state.scheme : null,
      effects: basins ? state.effects : null,
    };
  }

  /** The Country view's: the countries' areas (a map's colours), and the selected and the hovered one's outlines. */
  function countryLayers() {
    const countries = state.view === "country";
    const hovered = state.hovered;
    return {
      areas: countriesLayer({
        color: theme.land,
        // (Not in the Local view: it's about the point, not the country it's in.)
        selected: state.view === "local" ? null : state.selection.country,
        selectedColor: theme.selected,
        visible: state.view !== "basin",
        fills: faded(fades.countries, countries ? state.countryFills : undefined, timing()),
      }),
      selected: countryOutlineLayer({
        m49: state.selection.country,
        color: theme.outline,
        halo: theme.markerRing,
        visible: countries && Boolean(state.countryFills),
      }),
      hovered: countryOutlineLayer({
        id: "m49-hovered",
        m49: hovered && "country" in hovered ? hovered.country : null,
        color: theme.outline,
        halo: theme.markerRing,
        width: 1.75,
        visible: countries,
      }),
    };
  }

  /** The Local view's: the WaPOR raster (and the next one while playing), GAEZ's map, and the picked point's marker. */
  function localLayers() {
    return {
      rasters: [...[state.waporLast, state.wapor, state.waporNext].flatMap((entry) => (entry ? waporLayers(entry) : [])), gaezLayer()],
      // The clicked point: only the Local view is about a point. A dam picked: a target
      // round its circle (as drawn: of the size it has, else as a point), and its name.
      marker: markerLayer({
        position: state.view === "local" ? (state.dragged ?? state.selection.lngLat) : null,
        ring: theme.markerRing,
        around: featureRadius(),
      }),
    };
  }

  // Bottom to top. Rivers and lakes stay on top of whichever areas are shown.
  function layers() {
    const basin = basinLayers();
    const country = countryLayers();
    const local = localLayers();
    const { scheme, effects } = basin;
    return [
      ...country.areas,
      ...local.rasters,
      ...basin.areas,
      // The country view always has them; the others if switched on.
      bordersLayer({ color: theme.border, visible: state.view === "country" || state.visible.countries }),
      graticuleLayer({ color: theme.graticule, visible: state.visible.graticule }),
      ...basin.outlines,
      ...effectGroundLayers(effects),
      riversLayer({
        color: theme.river,
        visible: state.visible.rivers,
        hidden: scheme ? { key: scheme.subBasinsKey, subBasins: scheme.subBasins } : undefined,
      }),
      lakesLayer({ color: theme.river, visible: state.visible.lakes }),
      basin.picked,
      country.selected,
      ...basin.hovered,
      country.hovered,
      ...stacked({
        lines: basinSchemeLayers(scheme, schemeShown()),
        vapour: effects?.vapour ? effectLayers({ ...effects, rain: undefined }) : [],
        rain: effects?.rain ? effectLayers({ ...effects, vapour: undefined }) : [],
        // (In the Local view they're points of their own, with a tooltip each.)
        bars: [barsLayer({ bars: shownBars(), zoom: barsZoom, pickable: state.view === "local" })],
        circles: [countrySymbolsLayer({ symbols: visibleSymbols(), pickable: state.view === "local" })],
      }),
      ...local.marker,
    ];
  }

  /** The statistics maps' layers, bottom to top: in the view's order (setLayerOrder), else as `groups` are. */
  function stacked(groups: Record<string, Layer[]>) {
    const order = state.order[state.view] ?? [];
    const names = Object.keys(groups);
    const rank = (slot: string) => (order.includes(slot) ? names.length + order.length - order.indexOf(slot) : names.indexOf(slot));
    return names.sort((a, b) => rank(a) - rank(b)).flatMap((slot) => groups[slot]);
  }

  // Only the circles on the near side of the globe: they are drawn without a depth
  // test (like everything here), so the far side's would show through.
  const shownSymbols = () => symbolTweens[state.view]?.get() ?? null;
  /** The picked point's circle's radius (px; one of a bar's, or not drawn: a point's), null: none picked, or it's being dragged off. */
  function featureRadius() {
    const feature = state.selection.feature;
    if (state.view !== "local" || !feature || state.dragged) return null;
    return state.localById.get(feature.id)?.radius ?? 4;
  }

  /**
   * The same array as long as the same circles are kept (deck.gl takes a new one for new
   * data: every attribute of every circle again), re-keyed by them (the key says what to
   * recompute: while easing, the items change in place).
   */
  let visible: { key: string; items: CountrySymbol[] } | null = null;
  function visibleSymbols() {
    const symbols = shownSymbols();
    if (!symbols) return (visible = null);
    const { lng, lat } = map.getCenter();
    const cut = 0.15 - Math.min(0.15, map.getZoom() * 0.03);
    const near = symbols.items.filter((s) => facing(s.position, [lng, lat]) > cut);
    const kept = visible !== null && near.length === visible.items.length && near.every((s, i) => s === visible!.items[i]);
    const key = `${symbols.key}:${near.length}:${near[0]?.position ?? ""}`;
    if (!kept || key !== visible!.key) visible = { key, items: kept ? visible!.items : near };
    return visible;
  }
  map.on("move", () => {
    // The bars keep their height in pixels: drawn again as the zoom changes.
    const zoom = Math.round(map.getZoom() * 20) / 20;
    if (shownBars() && zoom !== barsZoom) {
      barsZoom = zoom;
      return render();
    }
    if (!shownSymbols()) return;
    const before = visible?.items;
    if (visibleSymbols()?.items !== before) render();
  });

  const shownBars = () => barTweens[state.view]?.get() ?? null;
  let barsZoom = Math.round(map.getZoom() * 20) / 20;
  // Tilted for the bars (and back flat when they go), unless it was tilted already.
  const TILT = 40;
  let tilted = false;
  function tilt() {
    // (The bars set, not those still shrinking away.)
    const want = Boolean(state.bars[state.view]);
    if (want && !tilted && map.getPitch() < 15) {
      tilted = true;
      map.easeTo({ pitch: TILT, duration: 800 });
    } else if (!want && tilted) {
      tilted = false;
      map.easeTo({ pitch: 0, duration: 800 });
    }
  }

  function handleClick(info: PickingInfo) {
    const symbol = state.view === "local" && info.layer && SYMBOL_LAYERS.includes(info.layer.id) ? (info.object as { id?: string } | null)?.id ?? null : null;
    onClick?.(toLngLat(info.coordinate), Boolean(info.object), symbol, areaAt(info));
  }

  // deck.gl's own pick, unless it's of something over the areas (a circle, a bar):
  // then a second one, of the areas only (each waits on the GPU).
  function areaAt(info: PickingInfo): Place | null {
    const isArea = (id: string | undefined) => !!id && AREA_LAYERS.some((a) => id.startsWith(a));
    const picked = !info.coordinate || !info.object ? null : isArea(info.layer?.id) ? info : overlay.pickObject({ x: info.x, y: info.y, layerIds: AREA_LAYERS });
    return picked ? placeOf(picked.layer?.id ?? "", picked.object?.properties) : null;
  }

  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: drawn(),
    onClick: handleClick,
    onHover: (info) => {
      const lngLat = toLngLat(info.coordinate);
      if (state.view === "local") {
        const symbol = info.layer && SYMBOL_LAYERS.includes(info.layer.id) ? (info.object as { id?: string } | null)?.id ?? null : null;
        onSymbolHover?.(symbol, info.x + container.getBoundingClientRect().left, info.y + container.getBoundingClientRect().top, lngLat);
      }
      onHover?.(lngLat, lngLat ? areaAt(info) : null);
    },
  });
  map.addControl(overlay);
  map.on("load", () => render());
  map.getCanvasContainer().addEventListener("pointerleave", () => {
    onHover?.(null, null);
    onSymbolHover?.(null, 0, 0, null);
  });
  function render() {
    overlay.setProps({ layers: drawn() });
    showFeatureLabel();
  }

  /**
   * Whether the sub-basins upstream and downstream of the hovered one are picked out
   * (also when it has none: the map's colours are left off all the same), and which (as
   * switched on in the Layers menu).
   */
  function flowOf() {
    const hovered = state.view === "basin" && state.hovered && "sub" in state.hovered && state.hovered.flow ? state.hovered : null;
    return {
      flow: !!hovered && (state.visible.upstream || state.visible.downstream),
      upstream: hovered && state.visible.upstream ? hovered.upstream : NONE,
      downstream: hovered && state.visible.downstream ? hovered.downstream : NONE,
    };
  }
  const flowListeners: ((flow: Flow | null) => void)[] = [];
  let flowKey = "";
  function tellFlow() {
    const { flow: on, upstream, downstream } = flowOf();
    const flow = on && state.hovered && "sub" in state.hovered
      ? { sub: state.hovered.sub, upstream: state.visible.upstream ? upstream : null, downstream: state.visible.downstream ? downstream : null }
      : null;
    const key = flow ? `${flow.sub}:${flow.upstream?.size}:${flow.downstream?.size}` : "";
    if (key === flowKey) return;
    flowKey = key;
    for (const listener of flowListeners) listener(flow);
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
      if (!waporReady(p)) {
        openThenRender(p);
        return null;
      }
      return waporLayer({ id, period: p, ramp: state.waporRamp, maxGap: state.waporMaxGap, onLoad: entry.onLoad, hidden, opacity, onViewportLoad });
    };
    const l1 = !atL2
      ? layer(period, `wapor-aeti-${entry.id}`, next, next ? () => showNextWapor(entry) : undefined)
      : !next && !entry.l2Loaded && waporReady(period)
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
  // Opens a period's rasters (and loads the layer) and draws again once they are: once,
  // however many times the map is drawn meanwhile (each draw would add a redraw to the
  // one opening).
  const opening = new WeakSet<object>();
  function openThenRender(sum: RasterSum) {
    if (opening.has(sum)) return;
    opening.add(sum);
    prepareWapor(sum)
      .then(render, () => {})
      .finally(() => opening.delete(sum));
  }
  /** The GAEZ map, once its rasters are open (as WaPOR's: the layer would open them again). */
  function gaezLayer() {
    const gaez = state.gaez;
    if (!gaez) return null;
    if (!waporReady(gaez.sum)) {
      openThenRender(gaez.sum);
      return null;
    }
    return waporLayer({ id: `gaez ${gaez.sum.key}`, period: gaez.sum, ramp: gaez.ramp });
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
      tellFlow();
      animate();
      tilt();
    },
    setLayerVisible(layer, visible) {
      state.visible[layer] = visible;
      render();
      tellFlow();
      if (layer === "graticule") graticuleNames.show(visible);
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
      const { top, bottom, left, right } = coveredEdges(container);
      const margin = narrowLayout.matches ? MARGIN_NARROW : MARGIN;
      const padding = { top: margin + top, bottom: margin + bottom, left: margin + left, right: margin + right };
      map.fitBounds(bounds, { padding, maxZoom: 7, duration: 1200 });
    },
    showPoint(center, zoom, how = "fly") {
      // Centre the point in the part of the map left uncovered (an offset, unlike
      // padding, only applies to this move). While the whole globe fits across the
      // map, keep it on screen.
      const { top, bottom, left, right } = coveredEdges(container);
      const radius = (512 * 2 ** zoom) / (2 * Math.PI);
      const keep = (shift: number, size: number) => {
        if (2 * radius >= size) return shift;
        const room = Math.max(0, size / 2 - radius - 12);
        return Math.max(-room, Math.min(room, shift));
      };
      const offset: [number, number] = [keep((left - right) / 2, container.clientWidth), keep((top - bottom) / 2, container.clientHeight)];
      const options = { center, zoom, offset };
      if (how === "fly") map.flyTo({ ...options, duration: 1200 });
      else map.easeTo(options);
    },
    setHovered(hovered) {
      if (hoverKey(hovered) === hoverKey(state.hovered)) return; // unchanged (or still none)
      state.hovered = hovered;
      render();
      tellFlow();
    },
    onFlow(listener) {
      flowListeners.push(listener);
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
    setSymbols(view, symbols) {
      if (symbols?.key === state.symbols[view]?.key) return;
      state.symbols[view] = symbols;
      if (view === "local") state.localById = new Map(symbols?.items.map((s) => [s.id, s]));
      symbolTweens[view].set(symbols);
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
    setLayerOrder(view, slots) {
      if (slots.join() === state.order[view].join()) return;
      state.order[view] = slots;
      render();
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
    setGaez(gaez) {
      if ((gaez && `${gaez.sum.key} ${gaez.ramp.colors}`) === (state.gaez && `${state.gaez.sum.key} ${state.gaez.ramp.colors}`)) return;
      state.gaez = gaez;
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

/**
 * What floats over the map's edges, and so should be left out of the camera's frame:
 * the open side panels (not folded, foldable.ts), the legends, the date range (unless
 * faded out, toolbar.ts), the map's controls and the corner warnings. Not what comes
 * and goes under the pointer (tooltips, menus, the tuning pane).
 */
const OVERLAYS =
  ".wb-panel:not([hidden]):not(.folding), .legend:not([hidden]), .range-pane:not(.timeless), .corner-warnings, " +
  ".maplibregl-ctrl-top-left, .maplibregl-ctrl-top-right, .maplibregl-ctrl-bottom-left, .maplibregl-ctrl-bottom-right";
/** An overlay is along an edge when it comes within this much of it, in pixels. */
const AT_EDGE = 24;
/** Leave the overlays out where they would leave less than this much of the map, in pixels. */
const MIN_UNCOVERED = { width: 320, height: 240 };
/** The space kept between the frame and the map's edge or an overlay, in pixels (less on a phone). */
const MARGIN = 60;
const MARGIN_NARROW = 24;
/** On a phone, what's left of the map between the legend and the sheet is less: frame in less. */
const MIN_UNCOVERED_NARROW = { width: 200, height: 160 };

interface Edges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * How far in from each of the map's edges the overlays reach, in pixels. A side panel
 * or legend counts against its side, whatever its height (on a phone, where they lie
 * across the screen, against its top or bottom like the rest). Any other overlay in a
 * corner counts against the edge it takes the smaller share of the map from: the
 * controls against the right, the date range against the bottom.
 */
function coveredEdges(container: HTMLElement): Edges {
  const box = container.getBoundingClientRect();
  const edges: Edges = { top: 0, bottom: 0, left: 0, right: 0 };
  const narrow = narrowLayout.matches;
  const minUncovered = narrow ? MIN_UNCOVERED_NARROW : MIN_UNCOVERED;
  for (const el of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const depths: [keyof Edges, number, number][] = [
      ["top", r.bottom - box.top, box.height],
      ["bottom", box.bottom - r.top, box.height],
      ["left", r.right - box.left, box.width],
      ["right", box.right - r.left, box.width],
    ];
    const column = !narrow && el.matches(".wb-panel, .legend");
    let best: (typeof depths)[number] | null = null;
    for (const d of depths) {
      const vertical = d[0] === "top" || d[0] === "bottom";
      if (column && vertical) continue;
      // Along the edge: its own extent reaches to within AT_EDGE of it.
      if (d[1] - (vertical ? r.height : r.width) > AT_EDGE) continue;
      if (best === null || d[1] / d[2] < best[1] / best[2]) best = d;
    }
    if (best !== null) edges[best[0]] = Math.max(edges[best[0]], best[1]);
  }
  if (box.width - edges.left - edges.right < minUncovered.width) edges.left = edges.right = 0;
  if (box.height - edges.top - edges.bottom < minUncovered.height) edges.top = edges.bottom = 0;
  return edges;
}

/** Cosine of the angle between two points on the globe (1: same point, < 0: opposite sides). */
export function facing([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]) {
  const r = Math.PI / 180;
  return Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng1 - lng2) * r);
}

// The layers of areas the pointer can be over (ids, as prefixes: their copies too), top first.
const AREA_LAYERS = ["sub-basins", "major-basins", "m49-countries"];
/** The circles' and bars' layers (countries.ts, bars.ts). */
const SYMBOL_LAYERS = ["m49-symbols", "area-bars"];

/** The place a picked area stands for, from its layer and tile properties. */
function placeOf(layerId: string, p: Record<string, unknown> | undefined): Place {
  const place: Place = { country: null, majorBasin: null, subBasin: null };
  if (!p) return place;
  if (layerId.startsWith("m49-countries")) place.country = { m49: p.m49 as number, name: p.name as string };
  else place.majorBasin = { id: p.SDG6_MB_ID as number, name: p.S6_MB_NAME as string };
  if (layerId.startsWith("sub-basins")) place.subBasin = { id: p.SDG6_SB_ID as number, name: p.S6_SB_NAME as string };
  return place;
}

// deck.gl gives no coordinate (or NaN) for a point off the globe.
function toLngLat(coordinate: number[] | undefined): LngLat | null {
  if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
  return [coordinate[0], coordinate[1]];
}
