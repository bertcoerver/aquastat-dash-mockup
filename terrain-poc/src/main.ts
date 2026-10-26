import type { Layer } from "@deck.gl/core";
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import { MVTLayer, TerrainLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AetiRamp } from "./aeti-shader";
import { GlobeMultiCOGLayer } from "./globe-cog-layer";
import "./style.css";

// --- sources ----------------------------------------------------------------

/** AWS Open Data terrain tiles (Mapzen terrarium encoding), up to zoom 15. CORS: *. */
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_MAX_ZOOM = 15;
/** Esri World Imagery, used both as the MapLibre basemap and as the deck.gl terrain texture. */
const IMAGERY_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/** FAO's vector tile sets (see water-portal/src/map/layers/tile-urls.ts), up to zoom 8. */
const faoTiles = (name: string) => `https://storage.googleapis.com/fao-cog-data/basins/${name}/{z}/{x}/{y}.pbf`;
const RIVERS = faoTiles("rivers_world_47950_tiles");
const SUB_BASINS = faoTiles("SDG6_SBM_v1_tiles");

/** WaPOR v3 annual actual evapotranspiration and interception, 300 m, global. */
const AETI = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L1-AETI-A/WAPOR-3.L1-AETI-A.2023.tif";
// Made once: MultiCOGLayer opens its rasters again whenever it gets a new `sources`.
const AETI_SOURCES = { aeti: { url: AETI } };
const AETI_PIPELINE = [{ module: AetiRamp, props: { opacity: 0.85 } }];

// --- state ------------------------------------------------------------------

/**
 * Who draws the relief:
 * - deck: deck.gl TerrainLayer; the other deck layers are draped on it with TerrainExtension.
 * - maplibre: MapLibre's own terrain (raster-dem); deck layers know nothing about it.
 * - none: flat globe.
 */
type TerrainMode = "deck" | "maplibre" | "none";

const state = {
  terrain: "deck" as TerrainMode,
  exaggeration: 1.5,
  drape: true,
  showRaster: true,
  showRivers: true,
  showBasins: true,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- map --------------------------------------------------------------------

const style: StyleSpecification = {
  version: 8,
  projection: { type: "globe" },
  sources: {
    imagery: {
      type: "raster",
      tiles: [IMAGERY_TILES],
      tileSize: 256,
      maxzoom: 18,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
    dem: {
      type: "raster-dem",
      tiles: [DEM_TILES],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: DEM_MAX_ZOOM,
      attribution: "Terrain: Mapzen / AWS Open Data",
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0b1418" } },
    { id: "imagery", type: "raster", source: "imagery" },
  ],
  sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
};

// Ethiopian highlands: Lake Tana and the Blue Nile gorge, looking north.
const map = new maplibregl.Map({
  container: "map",
  style,
  center: [37.6, 10.6],
  zoom: 8,
  pitch: 62,
  bearing: -10,
  maxPitch: 85,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

/**
 * Turns the relief on and off, in whichever mode was picked last. MapLibre's own
 * TerrainControl only knows about MapLibre terrain; this one borrows its icon.
 */
const terrainButton = document.createElement("button");
terrainButton.type = "button";
terrainButton.innerHTML = '<span class="maplibregl-ctrl-icon" aria-hidden="true"></span>';
terrainButton.addEventListener("click", () => setTerrain(state.terrain === "none" ? lastRelief : "none"));
map.addControl(
  {
    onAdd() {
      const group = document.createElement("div");
      group.className = "maplibregl-ctrl maplibregl-ctrl-group";
      group.append(terrainButton);
      return group;
    },
    onRemove() {},
  },
  "bottom-right",
);

const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
map.on("load", () => {
  map.addControl(overlay);
  render();
});

// --- layers -----------------------------------------------------------------

function buildLayers(): Layer[] {
  const deckTerrain = state.terrain === "deck";
  // Draping only means something when deck.gl draws the terrain itself.
  const drape = deckTerrain && state.drape;
  const extensions = drape ? [new TerrainExtension()] : [];
  // Draped layers are rendered into a texture that the terrain mesh samples, so the
  // depth test is the terrain's. Undraped layers lie on the sphere, coplanar with
  // MapLibre's globe: skip the depth test there, as globe-poc does.
  const parameters = drape ? {} : { depthCompare: "always" as const };

  const terrain = new TerrainLayer({
    id: "terrain",
    elevationData: DEM_TILES,
    texture: IMAGERY_TILES,
    elevationDecoder: terrariumDecoder(state.exaggeration),
    minZoom: 0,
    maxZoom: DEM_MAX_ZOOM,
    meshMaxError: 4,
    // terrain: the other layers' TerrainExtension reads heights from it; draw: show it.
    operation: "terrain+draw",
    onTileError: () => {},
  });

  const aeti = new GlobeMultiCOGLayer({
    id: "wapor-aeti",
    sources: AETI_SOURCES,
    composite: { r: "aeti" },
    renderPipeline: AETI_PIPELINE,
    visible: state.showRaster,
    extensions,
    // The raster is drawn as an instanced mesh, which TerrainExtension takes for a 3D
    // object and lifts to the terrain height ("offset"): it then z-fights with the
    // terrain mesh. Drape it like a polygon instead.
    // @ts-expect-error extension props aren't in MultiCOGLayer's typings
    terrainDrawMode: "drape",
    parameters,
    onGeoTIFFLoad: () => setStatus("aeti", "WaPOR COG opened"),
    onTileLoad: redrawDrape,
  });

  const basins = new MVTLayer({
    id: "sub-basins",
    data: SUB_BASINS,
    minZoom: 0,
    maxZoom: 8,
    visible: state.showBasins,
    onTileError: () => {},
    pickable: true,
    autoHighlight: true,
    highlightColor: [255, 210, 80, 110],
    filled: true,
    getFillColor: [255, 255, 255, 0],
    stroked: true,
    getLineColor: [255, 255, 255, 220],
    getLineWidth: 1.5,
    lineWidthUnits: "pixels",
    extensions,
    parameters,
  });

  const rivers = new MVTLayer({
    id: "rivers",
    data: RIVERS,
    minZoom: 0,
    maxZoom: 8,
    visible: state.showRivers,
    onTileError: () => {},
    getLineColor: [80, 200, 255, 255],
    getLineWidth: (f: { properties: { Strahler: number } }) => f.properties.Strahler,
    lineWidthUnits: "meters",
    lineWidthScale: 120,
    lineWidthMinPixels: 1,
    lineJointRounded: true,
    lineCapRounded: true,
    extensions,
    parameters,
  });

  // The terrain first: it has to exist before the draped layers sample it. Left out
  // rather than hidden otherwise, as a hidden TileLayer still loads its tiles.
  return [...(deckTerrain ? [terrain] : []), aeti, basins, rivers];
}

/**
 * Terrarium: height = (r * 256 + g + b / 256) - 32768 metres, here times the
 * exaggeration. TerrainLayer reloads every tile when it gets a new decoder object, so
 * there's one per exaggeration.
 */
const decoders = new Map<number, { rScaler: number; gScaler: number; bScaler: number; offset: number }>();
function terrariumDecoder(ex: number) {
  if (!decoders.has(ex)) decoders.set(ex, { rScaler: 256 * ex, gScaler: ex, bScaler: ex / 256, offset: -32768 * ex });
  return decoders.get(ex)!;
}

/**
 * TerrainExtension renders draped layers into a texture per terrain tile ("terrain
 * cover") and only re-renders it when a draped layer changes. A TileLayer shows a tile
 * that has loaded by filtering its sub-layers at draw time, which changes no layer, so
 * the cover keeps the view from before the tile loaded until the camera moves. Mark the
 * covers stale by hand. This reaches into deck.gl internals (TerrainEffect).
 */
function redrawDrape() {
  type TerrainEffect = { terrainCovers?: Map<string, { isDirty: boolean }> };
  const deck = (overlay as unknown as { _deck?: { effectManager?: { getEffects(): TerrainEffect[] } } })._deck;
  for (const effect of deck?.effectManager?.getEffects() ?? []) {
    effect.terrainCovers?.forEach((cover) => (cover.isDirty = true));
  }
  map.triggerRepaint();
}

function render() {
  if (state.terrain === "maplibre") {
    map.setTerrain({ source: "dem", exaggeration: state.exaggeration });
  } else {
    map.setTerrain(null);
  }
  overlay.setProps({ layers: buildLayers() });
  $<HTMLInputElement>("drape").disabled = state.terrain !== "deck";
  const on = state.terrain !== "none";
  terrainButton.className = on ? "maplibregl-ctrl-terrain-enabled" : "maplibregl-ctrl-terrain";
  terrainButton.title = on ? "Disable terrain" : "Enable terrain";
  terrainButton.setAttribute("aria-pressed", String(on));
}

function getTooltip({ object, layer }: { object?: { properties: Record<string, unknown> }; layer?: Layer | null }) {
  if (!object || !layer?.id.startsWith("sub-basins")) return null;
  const p = object.properties;
  return {
    html: `<strong>${p.S6_SB_NAME ?? "Sub-basin"}</strong><br><span class="muted">${p.S6_MB_NAME ?? ""}</span>`,
    className: "tooltip",
  };
}

const statuses = new Map<string, string>();
function setStatus(key: string, msg: string) {
  statuses.set(key, msg);
  $("status").textContent = [...statuses.values()].join(" · ");
}

// --- controls ---------------------------------------------------------------

/** The relief mode the map-corner button turns back on. */
let lastRelief: Exclude<TerrainMode, "none"> = state.terrain === "none" ? "deck" : state.terrain;

const terrainInputs = document.querySelectorAll<HTMLInputElement>('input[name="terrain"]');
function setTerrain(mode: TerrainMode) {
  state.terrain = mode;
  if (mode !== "none") lastRelief = mode;
  for (const input of terrainInputs) input.checked = input.value === mode;
  render();
}
for (const input of terrainInputs) {
  input.addEventListener("change", () => setTerrain(input.value as TerrainMode));
}
const exInput = $<HTMLInputElement>("exaggeration");
exInput.value = String(state.exaggeration);
$("exaggeration-value").textContent = `${state.exaggeration}×`;
exInput.addEventListener("change", () => {
  state.exaggeration = Number(exInput.value);
  render();
});
exInput.addEventListener("input", () => {
  $("exaggeration-value").textContent = `${exInput.value}×`;
});
const toggles: [string, "drape" | "showRaster" | "showRivers" | "showBasins"][] = [
  ["drape", "drape"],
  ["toggle-raster", "showRaster"],
  ["toggle-rivers", "showRivers"],
  ["toggle-basins", "showBasins"],
];
for (const [id, key] of toggles) {
  const input = $<HTMLInputElement>(id);
  input.checked = state[key];
  input.addEventListener("change", () => {
    state[key] = input.checked;
    render();
  });
}

// Exposed for debugging in the console.
Object.assign(window, { map, overlay, state });
