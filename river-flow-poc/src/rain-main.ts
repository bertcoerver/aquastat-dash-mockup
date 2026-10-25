/*
 * Rain: WaPOR's dekadal precipitation as 3D rain (RainLayer) on a tilted map, over a
 * ground coloured by it, with the river particles (RiverParticlesLayer, proxy discharge)
 * carrying the water away. deck.gl layers interleaved in MapLibre, as in the portal.
 */
import { COORDINATE_SYSTEM, type PickingInfo } from "@deck.gl/core";
import { BitmapLayer, PathLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { fmtEnd, fmtStart, mk } from "@portal/toolbar/dekads";
import { RAMPS, dischargeWidth, proxyDischarge, rampColor, velocities, zoomFade, type RGBA } from "./discharge";
import { loadNetwork, type Network } from "./network";
import { GRID_MAX, RAMP_STOPS, groundImage, loadPrecipitation, precipitationAt, type Precipitation } from "./rain/precipitation";
import { RainLayer } from "./rain/rain-layer";
import { RiverParticlesLayer } from "./wind/river-particles-layer";
import "./style.css";

/** Playback: seconds per dekad, and of the fade from one to the next. */
const DEKAD_SECONDS = 2.5;
const FADE_SECONDS = 0.8;
/** mm/day at which every drop falls (below it, fewer: (mm / this)^RAIN_GAMMA). */
const RAIN_FULL = 20;
const RAIN_GAMMA = 0.6;
const FIRST_YEAR = 2018;
/** The rivers are kept quiet, so the rain stands out. */
const RIVER_OPACITY = 0.25;
const RIVER_PARTICLES: [number, number, number] = [90, 190, 230];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const yearSelect = $<HTMLSelectElement>("year");
const playButton = $<HTMLButtonElement>("play");
const dekadSlider = $<HTMLInputElement>("dekad");
const dateEl = $("date");
const statsEl = $("stats");
const controls = {
  count: $<HTMLInputElement>("count"),
  period: $<HTMLInputElement>("period"),
  height: $<HTMLInputElement>("height"),
  wind: $<HTMLInputElement>("wind"),
  splash: $<HTMLInputElement>("splash"),
  ground: $<HTMLInputElement>("ground"),
  rivers: $<HTMLInputElement>("rivers"),
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [28, -12],
  zoom: 4.2,
  pitch: 55,
  bearing: -12,
  maxPitch: 75,
  hash: true,
  attributionControl: { compact: true },
  renderWorldCopies: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
map.on("style.load", () => {
  for (const { id } of map.getStyle().layers) if (id.startsWith("waterway")) map.setLayoutProperty(id, "visibility", "none");
  // Relief, so the tilted map reads as terrain (shaded only: deck.gl draws at sea level,
  // so MapLibre's 3D terrain would hide it).
  map.addSource("dem", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 12,
  });
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer(
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      paint: { "hillshade-exaggeration": 0.6, "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#3a3f47" },
    },
    firstSymbol,
  );
  map.addControl(overlay);
});

// --- State -----------------------------------------------------------------------

let year = 2025;
let dekadIndex = 0;
let playing = false;
let sinceStep = 0;
let time = 0;
/** The dekad shown, and the one faded from (with fade 0 → 1). */
let current: Precipitation | null = null;
let previous: Precipitation | null = null;
let fade = 1;
const images = new WeakMap<Precipitation, HTMLCanvasElement>();

/** The ground image of a dekad (made once). */
function imageOf(p: Precipitation) {
  let canvas = images.get(p);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = p.width;
    canvas.height = p.height;
    canvas.getContext("2d")!.putImageData(groundImage(p), 0, 0);
    images.set(p, canvas);
  }
  return canvas;
}

async function showDekad(i: number) {
  dekadIndex = i;
  dekadSlider.value = String(i);
  const dk = mk(year, 0, 0) + i;
  dateEl.textContent = `${fmtStart(dk)} – ${fmtEnd(dk)}`;
  statusEl.classList.add("busy");
  try {
    const t0 = performance.now();
    const p = await loadPrecipitation(dk);
    if (mk(year, 0, 0) + dekadIndex !== dk) return; // another dekad was asked for meanwhile
    statusEl.textContent = `Precipitation ${fmtStart(dk)} – ${fmtEnd(dk)} (${Math.round(performance.now() - t0)} ms).`;
    previous = current;
    current = p;
    fade = previous ? 0 : 1;
    // Read ahead while playing.
    for (const ahead of [1, 2]) if (i + ahead < 36) void loadPrecipitation(dk + ahead).catch(() => {});
  } catch (err) {
    statusEl.textContent = `No precipitation for ${fmtStart(dk)}: ${(err as Error).message}`;
  } finally {
    statusEl.classList.remove("busy");
  }
}

// --- Rivers ------------------------------------------------------------------------

let net: Network | null = null;
let pathData: { length: number; startIndices: Uint32Array; attributes: { getPath: { value: Float32Array; size: 2 } } };
let discharge: Float32Array;
let widths = new Float32Array(0);
let colors: RGBA[] = [];
let arcs = new Float32Array(0);
let arcZoom = NaN;

const riverWidthScale = (z: number) => Math.min(1.2, 0.2 + 0.15 * Math.max(0, z - 2));

function updateArcs() {
  if (!net) return;
  arcZoom = Math.round(map.getZoom() * 2) / 2;
  const v = velocities(discharge, 0);
  arcs = new Float32Array(net.nArcs * 8);
  colors = new Array(net.nArcs);
  for (let a = 0; a < net.nArcs; a++) {
    const q = discharge[a];
    // Faded with transparency, not towards black as on the river page: the ground is coloured here.
    const [r, g, b] = rampColor(q, RAMPS.blues.ramp);
    colors[a] = [r, g, b, 255 * RIVER_OPACITY * zoomFade(q, arcZoom)];
    const [pr, pg, pb] = RIVER_PARTICLES;
    arcs.set([widths[a], zoomFade(q, arcZoom) ** 2, Math.min(1, v[a] / 2), 0, pr / 255, pg / 255, pb / 255, 0], a * 8);
  }
}

map.on("zoomend", () => {
  if (net && Math.round(map.getZoom() * 2) / 2 !== arcZoom) updateArcs();
});

async function loadRivers() {
  if (net) return;
  net = await loadNetwork(`${import.meta.env.BASE_URL}data/rivers.bin`);
  pathData = { length: net.nArcs, startIndices: net.starts.subarray(0, net.nArcs), attributes: { getPath: { value: net.coords, size: 2 } } };
  discharge = proxyDischarge(net);
  widths = Float32Array.from(discharge, dischargeWidth);
  updateArcs();
}

// --- Layers and animation ------------------------------------------------------------

function layers(frameScale: number) {
  if (!current) return [];
  const z = map.getZoom();
  const ground = (p: Precipitation, opacity: number, id: string) =>
    new BitmapLayer({
      id,
      image: imageOf(p),
      bounds: p.bounds,
      _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      opacity,
      pickable: id === "ground",
      visible: controls.ground.checked,
      parameters: { depthCompare: "always" },
    });
  const showRivers = controls.rivers.checked && net !== null;
  return [
    ...(previous && fade < 1 ? [ground(previous, 1 - fade, "ground-previous")] : []),
    ground(current, previous ? fade : 1, "ground"),
    ...(showRivers
      ? [
          new PathLayer({
            id: "rivers",
            data: pathData as never,
            _pathType: "open",
            positionFormat: "XY",
            getColor: (_: unknown, { index }: { index: number }) => colors[index],
            getWidth: (_: unknown, { index }: { index: number }) => widths[index],
            widthUnits: "pixels",
            widthScale: riverWidthScale(z),
            widthMinPixels: 0,
            jointRounded: true,
            capRounded: true,
            pickable: true,
            updateTriggers: { getColor: arcZoom },
            parameters: { depthCompare: "always" },
          }),
          new RiverParticlesLayer({
            id: "river-particles",
            network: net!,
            arcs,
            count: 6000,
            speed: 2,
            fade: 0.9,
            widthScale: riverWidthScale(z),
            pointSize: 1.4,
            frameScale,
          }),
        ]
      : []),
    new RainLayer({
      id: "rain",
      precipitation: current,
      previous,
      mix: fade,
      count: Number(controls.count.value),
      time,
      period: Number(controls.period.value),
      dropHeight: Number(controls.height.value),
      wind: [Number(controls.wind.value), Number(controls.wind.value) * 0.3],
      splash: controls.splash.checked ? 4 : 0,
      reference: (RAIN_FULL / GRID_MAX) * 255,
      gamma: RAIN_GAMMA,
    }),
  ];
}

let lastFrame = performance.now();
let frames = 0;
let statsSince = performance.now();

function frame(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  time += dt;
  if (fade < 1) fade = Math.min(1, fade + dt / FADE_SECONDS);
  if (playing && current) {
    sinceStep += dt;
    if (sinceStep >= DEKAD_SECONDS) {
      sinceStep = 0;
      void showDekad((dekadIndex + 1) % 36);
    }
  }
  overlay.setProps({ layers: layers(dt * 60) });
  frames++;
  if (now - statsSince > 1000) {
    statsEl.textContent = `${Math.round((frames * 1000) / (now - statsSince))} fps`;
    frames = 0;
    statsSince = now;
  }
  requestAnimationFrame(frame);
}

function getTooltip({ layer, index, coordinate }: PickingInfo) {
  if (!layer || !coordinate) return null;
  if (layer.id === "rivers" && net && index >= 0) {
    const q = discharge[index];
    return {
      html: `<strong>River</strong><br>${q >= 100 ? Math.round(q).toLocaleString("en") : q.toPrecision(2)} m³/s
        <span class="muted">(proxy: upstream area)</span>`,
      className: "tooltip",
    };
  }
  if (layer.id === "ground" && current) {
    const mm = precipitationAt(current, coordinate[0], coordinate[1]);
    if (!Number.isFinite(mm)) return null;
    return {
      html: `<strong>${mm.toFixed(1)} mm/day</strong><br>
        <span class="muted">${fmtStart(current.dekad)} – ${fmtEnd(current.dekad)}, dekad mean</span>`,
      className: "tooltip",
    };
  }
  return null;
}

// --- Controls ------------------------------------------------------------------------

function updatePlayButton() {
  playButton.textContent = playing ? "❚❚" : "▶";
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
}

playButton.addEventListener("click", () => {
  playing = !playing;
  sinceStep = 0;
  updatePlayButton();
});
dekadSlider.addEventListener("input", () => {
  playing = false;
  updatePlayButton();
  void showDekad(Number(dekadSlider.value));
});
for (let y = new Date().getUTCFullYear(); y >= FIRST_YEAR; y--) yearSelect.add(new Option(String(y), String(y)));
yearSelect.value = String(year);
yearSelect.addEventListener("change", () => {
  year = Number(yearSelect.value);
  void showDekad(0);
});
controls.rivers.addEventListener("change", () => {
  if (controls.rivers.checked) void startRivers();
});

const stops = RAMP_STOPS.map(([mm, [r, g, b, a]]) => `rgba(${r},${g},${b},${Math.max(a, 40) / 255}) ${(mm / 30) * 100}%`);
$("ramp").style.background = `linear-gradient(to right, ${stops.join(", ")})`;

async function startRivers() {
  const t0 = performance.now();
  await loadRivers();
  console.log(`river network ready in ${Math.round(performance.now() - t0)} ms`);
}

// --- Start ---------------------------------------------------------------------------

async function start() {
  statusEl.textContent = "Loading precipitation…";
  await showDekad(0);
  playing = true;
  updatePlayButton();
  requestAnimationFrame(frame);
  if (controls.rivers.checked) await startRivers();
}

start().catch((err) => {
  statusEl.classList.remove("busy");
  statusEl.textContent = (err as Error).message;
  console.error(err);
});
