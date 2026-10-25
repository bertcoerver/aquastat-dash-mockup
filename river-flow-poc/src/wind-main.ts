/*
 * The wind-map version as deck.gl layers, interleaved in a MapLibre map as in the
 * portal (flat, or the globe): the rivers (an ordinary, pickable PathLayer) and the
 * particles blowing through them (RiverParticlesLayer).
 */
import type { PickingInfo } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import majorBasinsUrl from "@portal-data/major-basins.json?url";
import subBasinsUrl from "@portal-data/sub-basins.json?url";
import { HorizonExtension } from "@portal/map/layers/horizon";
import type { SubBasin } from "@portal/map/sub-basin-network";
import { fmtEnd, fmtStart } from "@portal/toolbar/dekads";
import { basinDischarge, type BasinDischarge } from "./basin-model";
import {
  RAMPS,
  dischargeColor,
  dischargeWidth,
  modelDischarge,
  modelShares,
  proxyDischarge,
  rampColor,
  velocities,
  zoomFade,
  type ModelShares,
  type RGBA,
} from "./discharge";
import { loadNetwork, type Network } from "./network";
import { RiverParticlesLayer } from "./wind/river-particles-layer";
import "./style.css";

/** Playback: seconds per dekad. */
const DEKAD_SECONDS = 0.8;
/** The rivers are dimmed, so the particles show on them. */
const RIVER_BRIGHTNESS = 0.45;
/** Velocity (m/s) of a particle at the field's full speed. */
const MAX_VELOCITY = 2;

interface MajorBasin {
  id: number;
  name: string;
  bbox: [number, number, number, number];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const basinSelect = $<HTMLSelectElement>("basin");
const timeline = $("timeline");
const playButton = $<HTMLButtonElement>("play");
const dekadSlider = $<HTMLInputElement>("dekad");
const dateEl = $("date");
const speedSlider = $<HTMLInputElement>("speed");
const countSlider = $<HTMLInputElement>("count");
const trailSlider = $<HTMLInputElement>("trail");
const contrastSlider = $<HTMLInputElement>("contrast");
const colorsSelect = $<HTMLSelectElement>("colors");
const particleColorsSelect = $<HTMLSelectElement>("particle-colors");
const globeToggle = $<HTMLInputElement>("globe");
const statsEl = $("stats");

/** Particle colours: a fixed one, or (discharge) the colour map's. */
const PARTICLE_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  cyan: [120, 225, 255],
  amber: [255, 200, 90],
};

const settings = {
  speed: 1,
  count: 8000,
  fade: 0.9,
  exponent: 0,
  /** A key of RAMPS, or "off": rivers not drawn, only the particles. */
  colors: "spectral",
  /** A key of PARTICLE_COLORS, or "discharge". */
  particles: "white",
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [20, 5],
  zoom: 2.2,
  hash: true,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
  maxPitch: 0,
  renderWorldCopies: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
map.on("style.load", () => {
  for (const { id } of map.getStyle().layers) if (id.startsWith("waterway")) map.setLayoutProperty(id, "visibility", "none");
  map.setProjection({ type: globeToggle.checked ? "globe" : "mercator" });
  map.addControl(overlay);
});

/** Rivers' width multiplier at a zoom (CSS px per unit of dischargeWidth). */
const riverWidthScale = (z: number) => Math.min(1.2, 0.2 + 0.15 * Math.max(0, z - 2));

// --- State -----------------------------------------------------------------------

let net: Network;
let subBasins: SubBasin[] = [];
let subBasinNames = new Map<number, string>();
/** The arcs as deck.gl binary paths; one object, so deck.gl tessellates them once. */
let pathData: { length: number; startIndices: Uint32Array; attributes: { getPath: { value: Float32Array; size: 2 } } };
let proxy: Float32Array;
/** Discharge per arc now shown, m³/s. */
let discharge: Float32Array;
/** Arcs with a model value (only with a basin selected). */
let modelled: Uint8Array | null = null;
let basin: { major: MajorBasin; model: BasinDischarge; shares: ModelShares; inBasin: Uint8Array } | null = null;
let dekadIndex = 0;
let playing = false;
let sinceStep = 0;

// What the layers draw, per arc (new arrays, or a new version, when they change).
let widths = new Float32Array(0);
let colors: RGBA[] = [];
let arcs = new Float32Array(0);
let styleVersion = 0;
/** The zoom the arcs' look was made for, in half levels. */
let arcZoom = NaN;

// --- Discharge → the layers ---------------------------------------------------------

/** Whether an arc is drawn: all of them, or with a basin selected only the basin's. */
const shown = (a: number) => !basin || basin.inBasin[a] === 1;

/**
 * Each arc's colour (rivers) and its width, spawn weight, speed and particle colour
 * (particles). A river's share of the particles grows with its discharge through its
 * width; the spawn weight only thins out rivers faded at this zoom.
 */
function updateArcs() {
  arcZoom = Math.round(map.getZoom() * 2) / 2;
  const v = velocities(discharge, settings.exponent);
  const ramp = (RAMPS[settings.colors] ?? RAMPS.spectral).ramp;
  // Particles by discharge use the rivers' colour map, or Spectral if the rivers have none.
  const particleRamp = settings.colors in RAMPS && settings.colors !== "grey" ? ramp : RAMPS.spectral.ramp;
  const fixed = PARTICLE_COLORS[settings.particles];
  const off = settings.colors === "off";
  arcs = new Float32Array(net.nArcs * 8);
  colors = new Array(net.nArcs);
  for (let a = 0; a < net.nArcs; a++) {
    if (!shown(a)) {
      colors[a] = [0, 0, 0, 0];
      continue;
    }
    const q = discharge[a];
    // Not quite transparent when off: deck.gl doesn't pick what has no alpha.
    const [r, g, b] = dischargeColor(q, arcZoom, ramp);
    colors[a] = off ? [0, 0, 0, 1] : [r * RIVER_BRIGHTNESS, g * RIVER_BRIGHTNESS, b * RIVER_BRIGHTNESS, 255];
    const particle = fixed ?? rampColor(q, particleRamp).map((c) => c + (255 - c) * 0.3);
    arcs.set([widths[a], zoomFade(q, arcZoom) ** 2, Math.min(1, v[a] / MAX_VELOCITY), 0, particle[0] / 255, particle[1] / 255, particle[2] / 255, 0], a * 8);
  }
  styleVersion++;
}

function showDischarge(q: Float32Array) {
  discharge = q;
  widths = Float32Array.from(q, (value, a) => (shown(a) ? dischargeWidth(value) : 0));
  updateArcs();
}

function showDekad(i: number) {
  if (!basin) return;
  dekadIndex = i;
  dekadSlider.value = String(i);
  const dk = basin.model.dekads[i];
  dateEl.textContent = `${fmtStart(dk)} – ${fmtEnd(dk)}`;
  const q = new Float32Array(net.nArcs);
  modelled = modelDischarge(net, basin.model, basin.shares, i, proxy, q);
  showDischarge(q);
}

map.on("zoomend", () => {
  if (discharge && Math.round(map.getZoom() * 2) / 2 !== arcZoom) updateArcs();
});

// --- Layers and animation ------------------------------------------------------------

/** For measuring: ?rivers=0 or ?particles=0 leaves that layer out. */
const query = new URLSearchParams(location.search);

function layers(frameScale: number) {
  const z = map.getZoom();
  const widthScale = riverWidthScale(z);
  return [
    new PathLayer({
      id: "rivers",
      data: pathData as never,
      _pathType: "open",
      positionFormat: "XY",
      getColor: (_: unknown, { index }: { index: number }) => colors[index],
      getWidth: (_: unknown, { index }: { index: number }) => widths[index],
      widthUnits: "pixels",
      widthScale,
      widthMinPixels: 0,
      jointRounded: true,
      capRounded: true,
      pickable: true,
      updateTriggers: { getColor: styleVersion, getWidth: styleVersion },
      parameters: { depthCompare: "always" },
      extensions: [new HorizonExtension()],
      visible: query.get("rivers") !== "0",
    }),
    new RiverParticlesLayer({
      visible: query.get("particles") !== "0",
      id: "particles",
      network: net,
      arcs,
      count: settings.count,
      speed: 2 * settings.speed,
      fade: settings.fade,
      widthScale,
      pointSize: 1.8,
      frameScale,
    }),
  ];
}

let lastFrame = performance.now();
let frames = 0;
let statsSince = performance.now();

function frame(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing && basin) {
    sinceStep += dt;
    if (sinceStep >= DEKAD_SECONDS) {
      sinceStep = 0;
      showDekad((dekadIndex + 1) % basin.model.dekads.length);
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

function getTooltip({ index, layer }: PickingInfo) {
  if (!layer || index < 0 || !discharge) return null;
  const q = discharge[index];
  const v = velocities(discharge.subarray(index, index + 1), settings.exponent)[0];
  const sb = net.subBasin[index];
  const source = modelled?.[index] ? "water balance model" : "proxy: upstream area × 315 mm/yr";
  const format = (x: number) => (x >= 100 ? Math.round(x).toLocaleString("en") : x >= 1 ? x.toFixed(1) : x.toPrecision(2));
  return {
    html: `<strong>${subBasinNames.get(sb) ?? `Sub-basin ${sb}`}</strong><br>
      ${format(q)} m³/s <span class="muted">(${source})</span><br>
      Particles at ${v.toFixed(2)} m/s · Strahler ${net.strahler[index]}${net.perennial[index] ? "" : " · intermittent"}<br>
      <span class="muted">Upstream area ${Math.round(net.acc[index] / 100).toLocaleString("en")} km²</span>`,
    className: "tooltip",
  };
}

// --- Basin selection -----------------------------------------------------------------

async function selectBasin(major: MajorBasin | null) {
  playing = false;
  updatePlayButton();
  if (!major) {
    basin = null;
    modelled = null;
    timeline.hidden = true;
    statusEl.textContent = "Whole world: discharge from upstream area (proxy). Pick a basin for the model's discharge.";
    showDischarge(proxy);
    return;
  }
  const [w, s, e, n] = major.bbox;
  map.fitBounds([w, s, e, n], { padding: 60, duration: 1500 });
  const count = subBasins.filter((b) => b.majorBasin === major.id).length;
  statusEl.textContent = `Loading FAO's water balance model for ${major.name} (${count} sub-basins)…`;
  statusEl.classList.add("busy");
  try {
    const t0 = performance.now();
    const model = await basinDischarge(major.id, subBasins);
    if (Number(basinSelect.value) !== major.id) return;
    if (!model.dekads.length) throw new Error("the model returned no dekads");
    const shares = modelShares(net, model);
    const inBasin = new Uint8Array(net.nArcs);
    for (const a of shares.arcs) inBasin[a] = 1;
    basin = { major, model, shares, inBasin };
    statusEl.textContent =
      `${major.name}: model discharge for ${model.q.size} sub-basins, ` +
      `${model.dekads.length} dekads (${model.source === "files" ? "precomputed" : "run in the browser"}, ` +
      `${((performance.now() - t0) / 1000).toFixed(1)} s).`;
    dekadSlider.max = String(model.dekads.length - 1);
    timeline.hidden = false;
    showDekad(Math.max(0, model.dekads.length - 72));
    playing = true;
    updatePlayButton();
  } catch (err) {
    if (Number(basinSelect.value) !== major.id) return;
    statusEl.textContent = `The model failed: ${(err as Error).message}`;
    basin = null;
  } finally {
    statusEl.classList.remove("busy");
  }
}

function updatePlayButton() {
  playButton.textContent = playing ? "❚❚" : "▶";
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
}

// --- Controls ------------------------------------------------------------------------

function buildLegend() {
  // The rivers' colour map; or, with none, the particles' (Spectral) if they're by discharge.
  const riverRamp = settings.colors !== "grey" ? RAMPS[settings.colors]?.ramp : undefined;
  const ramp = riverRamp ?? (settings.particles === "discharge" ? RAMPS.spectral.ramp : undefined);
  $("legend").hidden = !ramp;
  if (!ramp) return;
  const stops = ramp.map(({ log, rgb }) => `rgb(${rgb.join(",")}) ${((log - ramp[0].log) / (ramp.at(-1)!.log - ramp[0].log)) * 100}%`);
  $("ramp").style.background = `linear-gradient(to right, ${stops.join(", ")})`;
}

basinSelect.addEventListener("change", () => {
  const id = Number(basinSelect.value);
  void selectBasin(majorBasins.find((b) => b.id === id) ?? null);
});
playButton.addEventListener("click", () => {
  playing = !playing;
  sinceStep = 0;
  updatePlayButton();
});
dekadSlider.addEventListener("input", () => {
  playing = false;
  updatePlayButton();
  showDekad(Number(dekadSlider.value));
});
speedSlider.addEventListener("input", () => (settings.speed = 2 ** Number(speedSlider.value)));
countSlider.addEventListener("input", () => (settings.count = Number(countSlider.value)));
trailSlider.addEventListener("input", () => (settings.fade = Number(trailSlider.value)));
for (const [key, { label }] of Object.entries(RAMPS)) colorsSelect.add(new Option(label, key), colorsSelect.options.length - 1);
colorsSelect.value = settings.colors;
particleColorsSelect.addEventListener("change", () => {
  settings.particles = particleColorsSelect.value;
  buildLegend();
  if (discharge) updateArcs();
});
colorsSelect.addEventListener("change", () => {
  settings.colors = colorsSelect.value;
  buildLegend();
  if (discharge) updateArcs();
});
contrastSlider.addEventListener("change", () => {
  settings.exponent = Number(contrastSlider.value);
  updateArcs();
});
globeToggle.addEventListener("change", () => map.setProjection({ type: globeToggle.checked ? "globe" : "mercator" }));

// --- Start ---------------------------------------------------------------------------

let majorBasins: MajorBasin[] = [];

async function start() {
  const t0 = performance.now();
  statusEl.textContent = "Loading the river network…";
  statusEl.classList.add("busy");
  const [network, majors, subs] = await Promise.all([
    loadNetwork(`${import.meta.env.BASE_URL}data/rivers.bin`),
    fetch(majorBasinsUrl).then((r) => r.json() as Promise<MajorBasin[]>),
    fetch(subBasinsUrl).then((r) => r.json() as Promise<SubBasin[]>),
  ]);
  net = network;
  pathData = {
    length: net.nArcs,
    startIndices: net.starts.subarray(0, net.nArcs),
    attributes: { getPath: { value: net.coords, size: 2 } },
  };
  majorBasins = majors.sort((a, b) => a.name.localeCompare(b.name));
  subBasins = subs;
  subBasinNames = new Map(subs.map((b) => [b.id, b.name]));
  for (const b of majorBasins) basinSelect.add(new Option(b.name, String(b.id)));
  statusEl.classList.remove("busy");
  proxy = proxyDischarge(net);
  buildLegend();
  await selectBasin(null);
  console.log(`river network ready in ${Math.round(performance.now() - t0)} ms`);
  requestAnimationFrame(frame);
}

start().catch((err) => {
  statusEl.classList.remove("busy");
  statusEl.textContent = (err as Error).message;
  console.error(err);
});
