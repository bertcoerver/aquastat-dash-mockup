import type { PickingInfo } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import majorBasinsUrl from "@portal-data/major-basins.json?url";
import subBasinsUrl from "@portal-data/sub-basins.json?url";
import type { SubBasin } from "@portal/map/sub-basin-network";
import { fmtEnd, fmtStart } from "@portal/toolbar/dekads";
import {
  RAMP,
  dischargeColor,
  LANE_WIDTH,
  dischargeLanes,
  dischargeWidth,
  modelDischarge,
  modelShares,
  proxyDischarge,
  velocities,
  type ModelShares,
  type RGBA,
} from "./discharge";
import { FLOW_WRAP, FlowLayer } from "./flow-layer";
import { flowTimes, loadNetwork, type Network } from "./network";
import { basinDischarge, type BasinDischarge } from "./basin-model";
import "./style.css";

/** Hours of flow per second at zoom 0: ~40 px/s for 1 m/s at any zoom. */
const HOURS_PER_SECOND_Z0 = 870;
/** Cross-fade between old and new particle positions, seconds. */
const FADE = 0.35;
/** Playback: seconds per dekad. */
const DEKAD_SECONDS = 0.8;

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
const tailSlider = $<HTMLInputElement>("tail");
const bendSlider = $<HTMLInputElement>("bend");
const contrastSlider = $<HTMLInputElement>("contrast");
const clockEl = $("clock");

const settings = {
  speed: 1,
  tail: 1.5,
  bend: 1,
  exponent: 0,
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: [20, 5],
  zoom: 2.2,
  hash: true,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");

let overlay: MapboxOverlay | null = null;
let beforeId: string | undefined;
map.on("style.load", () => {
  const layers = map.getStyle().layers;
  // The basemap's own rivers would double ours.
  for (const { id } of layers) if (id.startsWith("waterway")) map.setLayoutProperty(id, "visibility", "none");
  beforeId = layers.find((l) => l.type === "symbol")?.id;
  overlay = new MapboxOverlay({ interleaved: true, layers: [], getTooltip });
  map.addControl(overlay);
});
map.on("zoomend", () => {
  if (discharge && Math.round(map.getZoom() * 2) / 2 !== colorZoom) updateColors();
});

// --- State -----------------------------------------------------------------------

let net: Network;
/** The arcs as deck.gl binary paths; one object, so deck.gl tessellates them once. */
let pathData: { length: number; startIndices: Uint32Array; attributes: { getPath: { value: Float32Array; size: 2 } } };
let subBasins: SubBasin[] = [];
let subBasinNames = new Map<number, string>();
let proxy: Float32Array;
/** Discharge per arc now shown, m³/s. */
let discharge: Float32Array;
/** Arcs with a model value (only with a basin selected). */
let modelled: Uint8Array | null = null;
let colors: RGBA[] = [];
let widths: Float32Array;
let styleVersion = 0;

// Two sets of flow times and bend leads, four values per vertex: the shown set, and
// the one being faded to (see FlowLayer).
let flows: Float32Array;
let flowVersion = 0;
let showingB = false;
let blend = 0;

/** The selected basin; `inBasin` marks the arcs its model covers (the rest of the world is hidden). */
let basin: { major: MajorBasin; model: BasinDischarge; shares: ModelShares; inBasin: Uint8Array } | null = null;
let dekadIndex = 0;
let playing = false;
let sinceStep = 0;

let clock = 0;
let lastFrame = performance.now();

// --- Discharge → what's drawn ----------------------------------------------------

/** Show `q` (m³/s per arc): colours and widths now, velocities cross-faded. */
function showDischarge(q: Float32Array) {
  discharge = q;
  // Zero width: not drawn, and not picked.
  widths = Float32Array.from(q, (value, a) => (shown(a) ? dischargeWidth(value) : 0));
  updateColors();
  updateVelocities();
}

const HIDDEN: RGBA = [0, 0, 0, 0];

/** Whether an arc is drawn: all of them, or with a basin selected only the basin's. */
const shown = (a: number) => !basin || basin.inBasin[a] === 1;

/** The zoom the colours were made for, in half levels. */
let colorZoom = NaN;

function updateColors() {
  colorZoom = Math.round(map.getZoom() * 2) / 2;
  colors = Array.from(discharge, (value, a) => (shown(a) ? dischargeColor(value, colorZoom) : HIDDEN));
  styleVersion++;
}

function updateVelocities() {
  const v = velocities(discharge, settings.exponent);
  // Write the hidden set and fade to it.
  flowTimes(net, v, FLOW_WRAP, flows, showingB ? 0 : 1);
  flowVersion++;
  showingB = !showingB;
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

// --- Layer and animation -----------------------------------------------------------

function riversLayer() {
  const z = map.getZoom();
  const widthScale = Math.min(1.2, 0.2 + 0.15 * Math.max(0, z - 2));
  const { starts } = net;
  return new FlowLayer({
    id: "rivers",
    beforeId,
    data: pathData,
    _pathType: "open",
    positionFormat: "XY",
    getColor: (_: unknown, { index }: { index: number }) => colors[index],
    getWidth: (_: unknown, { index }: { index: number }) => widths[index],
    widthUnits: "pixels",
    // Rivers and their lanes widen together as you zoom in, so a river keeps its number
    // of lanes at every zoom.
    widthScale,
    laneSpacing: LANE_WIDTH * widthScale,
    radius: Math.min(1.3, Math.max(0.7, 0.4 * LANE_WIDTH * widthScale)),
    capRounded: false, // round caps of adjacent arcs overlap: blobs at every arc end
    jointRounded: true,
    getFlows: (_: unknown, { index }: { index: number }) => flows.subarray(4 * starts[index], 4 * starts[index + 1]),
    updateTriggers: {
      getColor: styleVersion,
      getWidth: styleVersion,
      getFlows: flowVersion,
    },
    time: clock,
    spacing: 12,
    tail: settings.tail,
    bend: settings.bend,
    pixelRatio: window.devicePixelRatio,
    blend,
    baseBrightness: 0.5,
    pickable: true,
    parameters: { depthCompare: "always" },
  } as ConstructorParameters<typeof FlowLayer>[0]);
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const z = Math.max(0, map.getZoom());
  const hoursPerSecond = (HOURS_PER_SECOND_Z0 / 2 ** z) * settings.speed;
  clock = (clock + dt * hoursPerSecond) % FLOW_WRAP;
  clockEl.textContent = describeRate(hoursPerSecond);

  const target = showingB ? 1 : 0;
  blend = target > blend ? Math.min(target, blend + dt / FADE) : Math.max(target, blend - dt / FADE);

  if (playing && basin) {
    sinceStep += dt;
    if (sinceStep >= DEKAD_SECONDS) {
      sinceStep = 0;
      showDekad((dekadIndex + 1) % basin.model.dekads.length);
    }
  }
  overlay?.setProps({ layers: [riversLayer()] });
  requestAnimationFrame(frame);
}

function describeRate(hoursPerSecond: number) {
  return hoursPerSecond >= 48
    ? `1 s of animation ≈ ${(hoursPerSecond / 24).toFixed(1)} days of flow`
    : `1 s of animation ≈ ${hoursPerSecond.toFixed(hoursPerSecond < 10 ? 1 : 0)} h of flow`;
}

// --- Tooltip -----------------------------------------------------------------------

function getTooltip({ index, layer }: PickingInfo) {
  if (!layer || index < 0) return null;
  const q = discharge[index];
  const v = velocities(discharge.subarray(index, index + 1), settings.exponent)[0];
  const sb = net.subBasin[index];
  const source = modelled?.[index] ? "water balance model" : "proxy: upstream area × 315 mm/yr";
  return {
    html: `<strong>${subBasinNames.get(sb) ?? `Sub-basin ${sb}`}</strong><br>
      ${formatQ(q)} m³/s <span class="muted">(${source})</span><br>
      ${dischargeLanes(q)} lanes of dots at ${v.toFixed(2)} m/s · Strahler ${net.strahler[index]}${net.perennial[index] ? "" : " · intermittent"}<br>
      <span class="muted">Upstream area ${Math.round(net.acc[index] / 100).toLocaleString("en")} km²</span>`,
    className: "tooltip",
  };
}

function formatQ(q: number) {
  if (q >= 100) return Math.round(q).toLocaleString("en");
  if (q >= 1) return q.toFixed(1);
  return q.toPrecision(2);
}

// --- Basin selection -----------------------------------------------------------------

async function selectBasin(major: MajorBasin | null) {
  playing = false;
  updatePlayButton();
  if (!major) {
    basin = null;
    modelled = null;
    timeline.hidden = true;
    statusEl.textContent = "Whole world: discharge from upstream area (proxy). Pick a basin to run the model.";
    showDischarge(proxy);
    return;
  }
  const [w, s, e, n] = major.bbox;
  map.fitBounds([w, s, e, n], { padding: 60, duration: 1500 });
  const count = subBasins.filter((b) => b.majorBasin === major.id).length;
  statusEl.textContent = `Running FAO's water balance model for ${major.name} (${count} sub-basins)…`;
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
  const stops = RAMP.map(({ log, rgb }) => `rgb(${rgb.join(",")}) ${((log - RAMP[0].log) / (RAMP.at(-1)!.log - RAMP[0].log)) * 100}%`);
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
tailSlider.addEventListener("input", () => (settings.tail = Number(tailSlider.value)));
bendSlider.addEventListener("input", () => (settings.bend = Number(bendSlider.value)));
contrastSlider.addEventListener("change", () => {
  settings.exponent = Number(contrastSlider.value);
  updateVelocities();
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
  flows = new Float32Array(net.nVerts * 4);
  buildLegend();
  await selectBasin(null);
  blend = showingB ? 1 : 0; // nothing to fade from
  requestAnimationFrame(frame);
}

start().catch((err) => {
  statusEl.classList.remove("busy");
  statusEl.textContent = (err as Error).message;
  console.error(err);
});
