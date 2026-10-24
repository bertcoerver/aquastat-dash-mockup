import { MVTLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { loadWaterStress, stressColor, stressLabel, type WaterStress } from "./sdg64";
import { SumBands, type SumBandsProps } from "./sum-shader";
import "./style.css";

// GAEZ v4 harvested area of wheat, 2010, 5 arc-minute global grid, 1000 ha per
// cell. Served through the Vite proxy in vite.config.ts (the bucket has no CORS).
const gaezUrl = (name: string) =>
  new URL(`${import.meta.env.BASE_URL}gaez/RES06-HAR/${name}.tif`, window.location.href).href;
const WHEAT_SOURCES = {
  rainfed: { url: gaezUrl("GAEZ-V4.RES06-HAR.WHE.RAF") },
  irrigated: { url: gaezUrl("GAEZ-V4.RES06-HAR.WHE.IRR") },
};
const tileUrl = (set: string) =>
  new URL(`${import.meta.env.BASE_URL}tiles/${set}/{z}/{x}/{y}.pbf`, window.location.href).href
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}");

const WEIGHTS: Record<string, SumBandsProps["weights"]> = {
  sum: [1, 1],
  rainfed: [1, 0],
  irrigated: [0, 1],
};

type CountryFeature = { properties: { m49: number; name: string } };

const state = {
  showCog: true,
  showCountries: true,
  cogMode: "sum",
  year: 0,
  stress: null as WaterStress | null,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [20, 15],
  zoom: 1.6,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");

let overlay: MapboxOverlay | null = null;
let beforeId: string | undefined;

map.on("style.load", () => {
  map.setProjection({ type: "globe" });
  // Draw the data over everything but the basemap's labels. Positron has a label
  // layer early on (waterway_label), so anchor on the labels after the last road,
  // rail or building layer rather than on the first symbol layer.
  const layers = map.getStyle().layers;
  const lastNonLabel = layers.findLastIndex((l) => l.type !== "symbol");
  beforeId = layers[lastNonLabel + 1]?.id;
  // The M49 border layer replaces the basemap's (OSM) boundaries, which don't line
  // up with FAO's polygons and would show through the fill.
  for (const { id } of map.getStyle().layers) {
    if (id.startsWith("boundary_")) map.setLayoutProperty(id, "visibility", "none");
  }
  overlay = new MapboxOverlay({
    interleaved: true,
    layers: buildLayers(),
    getTooltip,
  });
  map.addControl(overlay);
});

function buildLayers() {
  const yearStress = state.stress?.byYear.get(state.year);

  const countries = new MVTLayer<CountryFeature["properties"]>({
    id: "m49-countries",
    data: tileUrl("m49"),
    minZoom: 0,
    maxZoom: 5,
    binary: false,
    visible: state.showCountries,
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 255, 255, 80],
    // Outlines come from the borders layer: tiles cut polygons at their edges, and
    // a stroke here would outline every cut.
    stroked: false,
    getFillColor: (f: CountryFeature) => stressColor(yearStress?.get(f.properties.m49)),
    updateTriggers: { getFillColor: [state.year, state.stress?.source] },
    // Geometry lies on the globe surface, coplanar with MapLibre's sphere: skip the
    // depth test (the overlay's GlobeView still culls the far side). visgl/deck.gl#9592
    parameters: { depthCompare: "always" },
    // @ts-expect-error beforeId is read by @deck.gl/mapbox in interleaved mode
    beforeId,
  });

  const wheat = new MultiCOGLayer({
    id: "gaez-wheat-sum",
    sources: WHEAT_SOURCES,
    composite: { r: "rainfed", g: "irrigated" },
    renderPipeline: [{ module: SumBands, props: { weights: WEIGHTS[state.cogMode] } }],
    resampling: "nearest",
    visible: state.showCog,
    opacity: 0.95,
    parameters: { depthCompare: "always" },
    onGeoTIFFLoad: () => setStatus("cog", "GAEZ COGs opened"),
    // @ts-expect-error beforeId is read by @deck.gl/mapbox in interleaved mode
    beforeId,
  });

  // The same M49 rings as lines (scripts/rings-to-lines.py), so they match the fill.
  // Opaque, because line tiles overlap by tippecanoe's buffer.
  const borders = new MVTLayer({
    id: "m49-borders",
    data: tileUrl("m49-borders"),
    minZoom: 0,
    maxZoom: 5,
    visible: state.showCountries,
    getLineColor: [255, 255, 255, 255],
    // Sized in metres so borders thicken as you zoom in, clamped to stay legible.
    getLineWidth: 10_000,
    lineWidthMinPixels: 0.6,
    lineWidthMaxPixels: 2.5,
    lineJointRounded: true,
    parameters: { depthCompare: "always" },
    beforeId,
  });

  // Later layers draw on top: the raster is transparent where there is no wheat.
  return [countries, wheat, borders];
}

function render() {
  overlay?.setProps({ layers: buildLayers() });
}

function getTooltip({ object, layer }: { object?: CountryFeature; layer?: { id: string } | null }) {
  if (!object || !layer?.id.startsWith("m49-countries")) return null;
  const { m49, name } = object.properties;
  const ws = state.stress?.byYear.get(state.year)?.get(m49);
  const label = state.stress?.names.get(m49) ?? name;
  return {
    html:
      ws === undefined
        ? `<strong>${label}</strong><br><span class="muted">No SDG 6.4.2 value (M49 ${m49})</span>`
        : `<strong>${label}</strong><br>Water stress ${state.year}: <b>${ws.toFixed(1)}%</b> · ${stressLabel(ws)}`,
    className: "tooltip",
  };
}

const statuses = new Map<string, string>();
function setStatus(key: string, msg: string) {
  statuses.set(key, msg);
  statusEl.textContent = [...statuses.values()].join(" · ");
}

// --- controls -------------------------------------------------------------

$<HTMLInputElement>("toggle-cog").addEventListener("change", (e) => {
  state.showCog = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>("toggle-countries").addEventListener("change", (e) => {
  state.showCountries = (e.target as HTMLInputElement).checked;
  render();
});
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="cog-mode"]')) {
  input.addEventListener("change", () => {
    state.cogMode = input.value;
    render();
  });
}
const yearSelect = $<HTMLSelectElement>("year");
yearSelect.addEventListener("change", () => {
  state.year = Number(yearSelect.value);
  render();
});

setStatus("sdg", "Loading SDG 6.4.2…");
loadWaterStress()
  .then((stress) => {
    state.stress = stress;
    state.year = stress.years[stress.years.length - 1];
    yearSelect.innerHTML = stress.years
      .map((y) => `<option value="${y}"${y === state.year ? " selected" : ""}>${y}</option>`)
      .join("");
    yearSelect.disabled = false;
    setStatus(
      "sdg",
      `SDG 6.4.2: ${stress.byYear.get(state.year)!.size} countries (${stress.source === "live" ? "live FAO API" : "local snapshot"})`,
    );
    render();
  })
  .catch((err) => {
    console.error(err);
    setStatus("sdg", "SDG 6.4.2 failed to load");
  });

// Exposed for debugging in the console.
Object.assign(window, { map, state });
