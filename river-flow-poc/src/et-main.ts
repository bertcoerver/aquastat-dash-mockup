/*
 * Evapotranspiration: WaPOR's dekadal AETI as vapour rising off a tilted map
 * (VapourLayer), split into transpiration and evaporation, through a heat shimmer
 * (HazeLayer), over a ground coloured by it. deck.gl layers interleaved in MapLibre, as
 * in the portal.
 */
import { COORDINATE_SYSTEM, type PickingInfo } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { fmtEnd, fmtStart, mk } from "@portal/toolbar/dekads";
import {
  GRID_MAX,
  RAMP_STOPS,
  cellAt,
  groundImage,
  loadEvapotranspiration,
  type Evapotranspiration,
} from "./et/evapotranspiration";
import { HazeLayer } from "./et/haze-layer";
import { VapourLayer } from "./et/vapour-layer";
import "./style.css";

/** Playback: seconds per dekad, and of the fade from one to the next. */
const DEKAD_SECONDS = 2.5;
const FADE_SECONDS = 0.8;
/** mm/day at which every puff rises and the shimmer is full (below it, less: (mm / this)^ET_GAMMA:
 * steeper than for rain, as deserts still give off a few tenths of a mm a day). */
const ET_FULL = 5;
const ET_GAMMA = 1.3;
const FIRST_YEAR = 2018;
const TRANSPIRATION: [number, number, number] = [120, 235, 140];
const EVAPORATION: [number, number, number] = [150, 205, 255];
/** Both, when they aren't split. */
const VAPOUR: [number, number, number] = [215, 230, 240];

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
  shimmer: $<HTMLInputElement>("shimmer"),
  split: $<HTMLInputElement>("split"),
  ground: $<HTMLInputElement>("ground"),
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [25, 2],
  zoom: 3.8,
  pitch: 55,
  bearing: -12,
  maxPitch: 75,
  hash: true,
  attributionControl: { compact: true },
  renderWorldCopies: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
let beforeId: string | undefined;
map.on("style.load", () => {
  // Relief, so the tilted map reads as terrain and the shimmer has something to bend
  // (shaded only: deck.gl draws at sea level, so MapLibre's 3D terrain would hide it).
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
  // Beneath the labels, so they don't shimmer.
  beforeId = firstSymbol;
  map.addControl(overlay);
});

// --- State -----------------------------------------------------------------------

let year = 2025;
let dekadIndex = 0;
let playing = false;
let sinceStep = 0;
let time = 0;
/** The dekad shown, and the one faded from (with fade 0 → 1). */
let current: Evapotranspiration | null = null;
let previous: Evapotranspiration | null = null;
let fade = 1;
const images = new WeakMap<Evapotranspiration, HTMLCanvasElement>();

/** The ground image of a dekad (made once). */
function imageOf(e: Evapotranspiration) {
  let canvas = images.get(e);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = e.width;
    canvas.height = e.height;
    canvas.getContext("2d")!.putImageData(groundImage(e), 0, 0);
    images.set(e, canvas);
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
    const e = await loadEvapotranspiration(dk);
    if (mk(year, 0, 0) + dekadIndex !== dk) return; // another dekad was asked for meanwhile
    statusEl.textContent = `Evapotranspiration ${fmtStart(dk)} – ${fmtEnd(dk)} (${Math.round(performance.now() - t0)} ms).`;
    previous = current;
    current = e;
    fade = previous ? 0 : 1;
    // Read ahead while playing.
    for (const ahead of [1, 2]) if (i + ahead < 36) void loadEvapotranspiration(dk + ahead).catch(() => {});
  } catch (err) {
    statusEl.textContent = `No evapotranspiration for ${fmtStart(dk)}: ${(err as Error).message}`;
  } finally {
    statusEl.classList.remove("busy");
  }
}

// --- Layers and animation ------------------------------------------------------------

function layers() {
  if (!current) return [];
  const ground = (e: Evapotranspiration, opacity: number, id: string) =>
    new BitmapLayer({
      id,
      image: imageOf(e),
      bounds: e.bounds,
      _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      opacity,
      pickable: id === "ground",
      visible: controls.ground.checked,
      parameters: { depthCompare: "always" },
      beforeId,
    });
  const reference = (ET_FULL / GRID_MAX) * 255;
  const wind = Number(controls.wind.value);
  const split = controls.split.checked;
  return [
    ...(previous && fade < 1 ? [ground(previous, 1 - fade, "ground-previous")] : []),
    ground(current, previous ? fade : 1, "ground"),
    new HazeLayer({
      id: "haze",
      grid: current,
      previous,
      mix: fade,
      time,
      strength: Number(controls.shimmer.value),
      reference,
      gamma: ET_GAMMA,
      beforeId,
    }),
    new VapourLayer({
      id: "vapour",
      grid: current,
      previous,
      mix: fade,
      count: Number(controls.count.value),
      time,
      period: Number(controls.period.value),
      height: Number(controls.height.value),
      wind: [wind, wind * 0.3],
      reference,
      gamma: ET_GAMMA,
      transpirationColor: split ? TRANSPIRATION : VAPOUR,
      evaporationColor: split ? EVAPORATION : VAPOUR,
      beforeId,
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
  overlay.setProps({ layers: layers() });
  frames++;
  if (now - statsSince > 1000) {
    statsEl.textContent = `${Math.round((frames * 1000) / (now - statsSince))} fps`;
    frames = 0;
    statsSince = now;
  }
  requestAnimationFrame(frame);
}

function getTooltip({ layer, coordinate }: PickingInfo) {
  if (layer?.id !== "ground" || !coordinate || !current) return null;
  const i = cellAt(current, coordinate[0], coordinate[1]);
  const aeti = current.aeti[i];
  if (!(i >= 0 && Number.isFinite(aeti))) return null;
  const t = current.transpiration[i];
  const share = aeti > 0 && Number.isFinite(t) ? ` · ${Math.round(Math.min(1, t / aeti) * 100)}% transpiration` : "";
  return {
    html: `<strong>${aeti.toFixed(1)} mm/day</strong>${share}<br>
      <span class="muted">${fmtStart(current.dekad)} – ${fmtEnd(current.dekad)}, dekad mean</span>`,
    className: "tooltip",
  };
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

const stops = RAMP_STOPS.map(([mm, [r, g, b, a]]) => `rgba(${r},${g},${b},${Math.max(a, 40) / 255}) ${(mm / 6) * 100}%`);
$("ramp").style.background = `linear-gradient(to right, ${stops.join(", ")})`;
const showKey = () => {
  $("key-t").style.background = `rgb(${(controls.split.checked ? TRANSPIRATION : VAPOUR).join(",")})`;
  $("key-e").style.background = `rgb(${(controls.split.checked ? EVAPORATION : VAPOUR).join(",")})`;
};
controls.split.addEventListener("change", showKey);
showKey();

// --- Start ---------------------------------------------------------------------------

async function start() {
  statusEl.textContent = "Loading evapotranspiration…";
  await showDekad(0);
  playing = true;
  updatePlayButton();
  requestAnimationFrame(frame);
}

start().catch((err) => {
  statusEl.classList.remove("busy");
  statusEl.textContent = (err as Error).message;
  console.error(err);
});
