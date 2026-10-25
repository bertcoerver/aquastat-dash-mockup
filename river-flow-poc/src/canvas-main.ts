/*
 * The wind-map version on its own WebGL canvas (canvas.html; index.html is the deck.gl
 * layer version): rivers as a vector field, with particles blowing through it
 * (src/wind/river-wind.ts), on a canvas over a MapLibre map (north up, no tilt: the
 * field is drawn in plain Web Mercator screen space).
 */
import type { PickingInfo } from "@deck.gl/core";
import { PathLayer } from "@deck.gl/layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import majorBasinsUrl from "@portal-data/major-basins.json?url";
import subBasinsUrl from "@portal-data/sub-basins.json?url";
import type { SubBasin } from "@portal/map/sub-basin-network";
import { fmtEnd, fmtStart } from "@portal/toolbar/dekads";
import { basinDischarge, type BasinDischarge } from "./basin-model";
import {
  RAMPS,
  dischargeColor,
  dischargeWidth,
  rampColor,
  modelDischarge,
  modelShares,
  proxyDischarge,
  velocities,
  zoomFade,
  type ModelShares,
} from "./discharge";
import { loadNetwork, type Network } from "./network";
import { RiverWind } from "./wind/river-wind";
import "./style.css";

/** Playback: seconds per dekad. */
const DEKAD_SECONDS = 0.8;
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
// deck.gl only for hover: an invisible, pickable copy of the rivers under the particle
// canvas (which lets the mouse through), as wide as the rivers drawn.
const overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
map.on("style.load", () => {
  for (const { id } of map.getStyle().layers) if (id.startsWith("waterway")) map.setLayoutProperty(id, "visibility", "none");
  map.addControl(overlay);
});
map.on("zoom", () => updatePickLayer());

/** Rivers' width multiplier at a zoom (CSS px per unit of dischargeWidth). */
const riverWidthScale = (z: number) => Math.min(1.2, 0.2 + 0.15 * Math.max(0, z - 2));

const canvas = $<HTMLCanvasElement>("flow");
const wind = new RiverWind(canvas);
window.addEventListener("resize", () => wind.resize());

// --- State -----------------------------------------------------------------------

let net: Network;
let subBasins: SubBasin[] = [];
let subBasinNames = new Map<number, string>();
/** The arcs as deck.gl binary paths, for the pick layer; one object, so it's tessellated once. */
let pathData: { length: number; startIndices: Uint32Array; attributes: { getPath: { value: Float32Array; size: 2 } } };
let proxy: Float32Array;
/** Arcs with a model value (only with a basin selected). */
let modelled: Uint8Array | null = null;
/** Width per arc (dischargeWidth; 0: hidden), and a version for deck.gl's update trigger. */
let widths = new Float32Array(0);
let widthsVersion = 0;
/** Discharge per arc now shown, m³/s. */
let discharge: Float32Array;
let basin: { major: MajorBasin; model: BasinDischarge; shares: ModelShares; inBasin: Uint8Array } | null = null;
let dekadIndex = 0;
let playing = false;
let sinceStep = 0;
/** The zoom the arcs' look was made for, in half levels. */
let arcZoom = NaN;

// --- Discharge → the field -------------------------------------------------------

/** Whether an arc is drawn: all of them, or with a basin selected only the basin's. */
const shown = (a: number) => !basin || basin.inBasin[a] === 1;

/**
 * Each arc's width, spawn weight, speed and colour for RiverWind. The width grows with
 * discharge, and particles respawn on random river pixels, so a river's share of the
 * particles grows with its discharge through its width alone (a spawn weight that grew
 * with discharge too left the tributaries nearly empty). The weight only thins out
 * rivers faded at this zoom.
 */
function updateArcs() {
  arcZoom = Math.round(map.getZoom() * 2) / 2;
  const v = velocities(discharge, settings.exponent);
  const values = new Float32Array(net.nArcs * 8);
  const ramp = (RAMPS[settings.colors] ?? RAMPS.spectral).ramp;
  // Particles by discharge use the rivers' colour map, or Spectral if the rivers have none.
  const particleRamp = settings.colors in RAMPS && settings.colors !== "grey" ? ramp : RAMPS.spectral.ramp;
  const fixed = PARTICLE_COLORS[settings.particles];
  for (let a = 0; a < net.nArcs; a++) {
    if (!shown(a)) continue;
    const q = discharge[a];
    const [r, g, b] = dischargeColor(q, arcZoom, ramp);
    const weight = zoomFade(q, arcZoom) ** 2;
    // Particle colour: brighter than the river under it, so it shows on it.
    const particle = fixed ?? rampColor(q, particleRamp).map((c) => c + (255 - c) * 0.3);
    values.set(
      [
        dischargeWidth(q),
        weight,
        Math.min(1, v[a] / MAX_VELOCITY),
        Math.round(r) * 65536 + Math.round(g) * 256 + Math.round(b),
        particle[0] / 255,
        particle[1] / 255,
        particle[2] / 255,
        0,
      ],
      a * 8,
    );
  }
  wind.setArcs(values);
}

function showDischarge(q: Float32Array) {
  discharge = q;
  widths = Float32Array.from(q, (value, a) => (shown(a) ? dischargeWidth(value) : 0));
  widthsVersion++;
  updateArcs();
  updatePickLayer();
}

function updatePickLayer() {
  if (!pathData) return;
  overlay.setProps({
    layers: [
      new PathLayer({
        id: "rivers-pick",
        data: pathData as never,
        _pathType: "open",
        positionFormat: "XY",
        getWidth: (_: unknown, { index }: { index: number }) => widths[index],
        widthUnits: "pixels",
        widthScale: riverWidthScale(map.getZoom()),
        // Not quite transparent: deck.gl doesn't pick what has no alpha. The canvas covers it.
        getColor: [0, 0, 0, 1],
        pickable: true,
        updateTriggers: { getWidth: widthsVersion },
      }),
    ],
  });
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

// --- Animation ---------------------------------------------------------------------

let lastFrame = performance.now();

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
  const dpr = window.devicePixelRatio;
  const center = maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
  const z = map.getZoom();
  wind.frame(
    { centerX: center.x, centerY: center.y, worldSize: 512 * 2 ** z * dpr },
    {
      count: settings.count,
      speed: 2 * settings.speed * dpr,
      fade: settings.fade,
      drop: 0.003,
      widthScale: riverWidthScale(z),
      pixelRatio: dpr,
      riverBrightness: settings.colors === "off" ? 0 : 0.45,
      pointSize: 1.8 * dpr,
    },
    dt * 60,
  );
  requestAnimationFrame(frame);
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

// --- Start ---------------------------------------------------------------------------

let majorBasins: MajorBasin[] = [];

async function start() {
  statusEl.textContent = "Loading the river network…";
  statusEl.classList.add("busy");
  const [network, majors, subs] = await Promise.all([
    loadNetwork(`${import.meta.env.BASE_URL}data/rivers.bin`),
    fetch(majorBasinsUrl).then((r) => r.json() as Promise<MajorBasin[]>),
    fetch(subBasinsUrl).then((r) => r.json() as Promise<SubBasin[]>),
  ]);
  net = network;
  wind.setNetwork(net);
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
  requestAnimationFrame(frame);
}

start().catch((err) => {
  statusEl.classList.remove("busy");
  statusEl.textContent = (err as Error).message;
  console.error(err);
});
