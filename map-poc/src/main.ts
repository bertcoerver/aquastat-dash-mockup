/*
 * The page: a deck.gl map (no MapLibre) in a ProjectedView, a panel to choose the
 * projection and the layers, and a morph from one projection to the next.
 */
import { Deck, type Color, type Layer, type MapViewState, type PickingInfo } from "@deck.gl/core";
import * as L from "./layers";
import { ProjectedView } from "./projected-view";
import { globeWeight, isProjectedViewport, viewportClass, type Blend } from "./projected-viewport";
import { PROJECTIONS, projectionById, type ProjectionId } from "./projections";
import { loadRaster } from "./raster";
import { ReprojectExtension, setReprojection, setReprojectionView } from "./reproject-extension";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type LayerName = "choropleth" | "borders" | "basins" | "lakes" | "rivers" | "graticule" | "circles" | "bars" | "raster";

const initial = (window.location.hash.slice(1) || "robinson") as ProjectionId;
const start = PROJECTIONS.find((p) => p.id === initial) ?? projectionById("robinson");

const state = {
  blend: { from: start, to: start, t: 1 } as Blend,
  viewState: { longitude: 15, latitude: 10, zoom: 1.45, pitch: 0, bearing: 0, minZoom: 0.3, maxZoom: 12, maxPitch: 60 } as MapViewState,
  layers: { choropleth: true, borders: true, basins: false, lakes: true, rivers: true, graticule: true, circles: false, bars: false, raster: false } as Record<LayerName, boolean>,
  selected: null as number | null,
  hovered: null as number | null,
  raster: null as L.Raster | null,
  symbols: [] as L.Symbol[],
  colors: new Map<number, Color>(),
};
setReprojection(start);
/** The view as the shaders need it (the globe is seen from above the centre, in perspective). */
const tellView = () => setReprojectionView([state.viewState.longitude, state.viewState.latitude], state.viewState.zoom, $<HTMLCanvasElement>("map").clientHeight || 1);
tellView();

const extension = new ReprojectExtension();

const view = () =>
  new ProjectedView({
    id: "map",
    // (MapController reads `normalize` though its options type leaves it out: false keeps the centre from wrapping at ±180°.)
    controller: { ...({ normalize: false } as object), inertia: 300, dragRotate: true, keyboard: true },
    viewportClass: viewportClass(state.blend),
  });

/** Bottom to top; every layer drawn in the projection. */
function layers(): Layer[] {
  const on = state.layers;
  const globe = globeWeight(state.blend);
  const list: (Layer | null | false)[] = [
    globe > 0 && L.globeDiscLayer([state.viewState.longitude, state.viewState.latitude], state.viewState.zoom, $<HTMLCanvasElement>("map").clientHeight || 1, globe),
    L.oceanLayer(),
    L.polarCapLayer(),
    L.countriesLayer({ colors: on.choropleth ? state.colors : null, selected: state.selected, hovered: state.hovered }),
    L.rasterLayer(on.raster ? state.raster : null, 0.9),
    on.basins && L.majorBasinsLayer(),
    on.borders && L.bordersLayer(),
    on.lakes && L.lakesLayer(),
    on.rivers && L.riversLayer(),
    ...(on.graticule ? L.graticuleLayers() : []),
    on.circles && L.circlesLayer(state.symbols),
    on.bars && L.barsLayer(state.symbols, Math.round(state.viewState.zoom * 20) / 20),
  ];
  return list.filter((l): l is Layer => Boolean(l)).map((layer) => layer.clone({ extensions: [...layer.props.extensions, extension] }));
}

const pointer = $("pointer");
/** Whether the pointer is on the map (its viewport knows: beyond a flat map's edges, off the globe). */
const onMap = (info: PickingInfo) => {
  const viewport = deck.getViewports()[0];
  return isProjectedViewport(viewport) ? viewport.unprojectOnMap([info.x, info.y]) !== null : true;
};

function describe(info: PickingInfo): string {
  const object = info.object as { properties?: Record<string, unknown>; m49?: number; value?: number } | undefined;
  if (!object) return "";
  const p = object.properties;
  if (p?.name) return `${p.name} (M49 ${p.m49})`;
  if (p?.S6_MB_NAME) return `${p.S6_MB_NAME} (basin ${p.SDG6_MB_ID})`;
  if (object.value !== undefined) return `M49 ${object.m49}: ${object.value.toFixed(2)}`;
  return "";
}

const deck = new Deck({
  canvas: $<HTMLCanvasElement>("map"),
  views: [view()],
  // The controller keeps the view state (setting `viewState` back on every change, the
  // controlled way, stops deck.gl's tap recognizer: a click's pointerdown reports a
  // change, and the props set during the gesture reset it). A move is set as a new
  // `initialViewState` (see moveTo).
  initialViewState: { map: state.viewState },
  useDevicePixels: true,
  onViewStateChange: ({ viewState }) => {
    const v = viewState as MapViewState;
    state.viewState = { ...state.viewState, ...v };
    tellView();
    // (The globe's disc sits on the centre.)
    if (globeWeight(state.blend) > 0) render();
    // The centre may leave the map a little, not run away.
    const longitude = Math.max(-200, Math.min(200, v.longitude));
    const latitude = Math.max(-100, Math.min(100, v.latitude));
    if (longitude !== v.longitude || latitude !== v.latitude) moveTo({ longitude, latitude });
    if (state.layers.bars) render(); // (their height is set in pixels at the zoom drawn for)
  },
  layers: layers(),
  onHover: (info) => {
    const m49 = (info.layer?.id === "countries" && (info.object as { properties?: L.CountryProperties } | null)?.properties?.m49) || null;
    if (m49 !== state.hovered) {
      state.hovered = m49;
      render();
    }
    const c = info.coordinate;
    pointer.textContent = c
      ? `${onMap(info) ? "" : "off the map: "}${c[1].toFixed(2)}°, ${c[0].toFixed(2)}°\n${describe(info)}`
      : "";
  },
  onClick: (info) => {
    const props = (info.object as { properties?: L.CountryProperties } | null)?.properties;
    state.selected = info.layer?.id === "countries" && props ? props.m49 : null;
    render();
  },
  getCursor: ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
});

function render() {
  deck.setProps({ layers: layers() });
}

/** Move the camera: deck.gl takes a new initialViewState object as the view to show. */
function moveTo(change: Partial<MapViewState>) {
  state.viewState = { ...state.viewState, ...change };
  deck.setProps({ initialViewState: { map: state.viewState } });
}

// --- The projection: a select, and a morph to the chosen one. -------------------

const select = $<HTMLSelectElement>("projection");
const note = $("note");
for (const p of PROJECTIONS) {
  const option = document.createElement("option");
  option.value = p.id;
  option.textContent = p.name;
  select.append(option);
}
select.value = start.id;
note.textContent = start.description;

const MORPH_MS = 800;
let morph = 0;
function switchTo(id: ProjectionId) {
  const to = projectionById(id);
  const from = state.blend.to;
  note.textContent = to.description;
  window.location.hash = id;
  if (from === to) return;
  const started = performance.now();
  const run = ++morph;
  const frame = () => {
    if (run !== morph) return;
    const t = Math.min(1, (performance.now() - started) / MORPH_MS);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
    state.blend = { from, to, t: e };
    setReprojection(to, from, e);
    // (A new view redraws the layers, whose shaders read the blend: the layers stay.)
    deck.setProps({ views: [view()] });
    if (t < 1) requestAnimationFrame(frame);
  };
  frame();
}
select.addEventListener("change", () => switchTo(select.value as ProjectionId));

// --- The layers' switches. -----------------------------------------------------

const status = $("status");
for (const input of $("layers").querySelectorAll<HTMLInputElement>("input[data-layer]")) {
  input.addEventListener("change", () => {
    const name = input.dataset.layer as LayerName;
    state.layers[name] = input.checked;
    if (name === "raster" && input.checked && !state.raster) {
      loadRaster((text) => (status.textContent = `Raster: ${text}`)).then(
        (raster) => {
          state.raster = raster;
          render();
        },
        (error: unknown) => (status.textContent = `Raster failed: ${String(error)}`),
      );
    }
    if (name === "bars") tilt(input.checked ? 40 : 0);
    render();
  });
}

/** Ease the tilt (the bars want one; flat again without them). */
function tilt(pitch: number) {
  const from = state.viewState.pitch ?? 0;
  if ((pitch > 0 && from >= 15) || from === pitch) return;
  const started = performance.now();
  const frame = () => {
    const t = Math.min(1, (performance.now() - started) / 700);
    const e = 1 - (1 - t) ** 3;
    moveTo({ pitch: from + (pitch - from) * e });
    if (t < 1) requestAnimationFrame(frame);
  };
  frame();
}

// --- Demo values per country (the portal's country centres), for the choropleth, circles and bars. ---

fetch("/data/country-info.json")
  .then((r) => r.json())
  .then((info: { countries: Record<string, { center: [number, number] }> }) => {
    for (const [code, { center }] of Object.entries(info.countries)) {
      const m49 = Number(code);
      // A fixed pseudo-random value per country, so the map is the same on every load.
      const value = ((m49 * 2654435761) % 1000) / 1000;
      state.colors.set(m49, L.ramp(value));
      state.symbols.push({ m49, position: center, value, color: L.ramp(0.35 + value * 0.6) });
    }
    render();
  })
  .catch(() => (status.textContent = "No country-info.json (run the portal's npm run country-info)."));

/** A blend held still (for a look at the morph half way, from the console or a test). */
function hold(from: ProjectionId, to: ProjectionId, t: number) {
  morph++;
  state.blend = { from: projectionById(from), to: projectionById(to), t };
  setReprojection(state.blend.to, state.blend.from, t);
  deck.setProps({ views: [view()], layers: layers() });
}

// (For poking at it from the console.)
Object.assign(window, { poc: { deck, state, moveTo, switchTo, hold } });
