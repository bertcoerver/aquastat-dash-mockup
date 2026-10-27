/*
 * Basin view: the selected major basin's discharge map drawn as a water balance scheme
 * (scheme.ts) rather than as the sub-basins' colours, circles or 3D bars
 * (panels/shape-switch.ts):
 *
 * - as a network of lines along the rivers, as wide as the discharge they carry
 *   (linear, so widths add up where rivers join), with a slider in the legend for how
 *   far the lines may stray from the rivers;
 * - or as particles streaming down the real rivers (river-flow-poc's wind map), the
 *   rivers as wide as their discharge (each sub-basin's outflow shared over its arcs by
 *   upstream area), so big rivers carry more of the particles.
 *
 * Over another map's fills (the legend's layers, panels/legend.ts). basin-stats.ts asks
 * for it for the map that allows it (BasinMapSpec.scheme: discharge per sub-basin), and
 * a switch in its legend section picks between it and the other maps' shapes. The legend
 * shows a key to the widths in place of the colour ramp: the widest line is the basin's
 * largest outflow in the period (with the legend's lock on, the one when it was put on:
 * LayerLegend.hold). Also where storage change's circles stand: the scheme's dots, on
 * each sub-basin's river (riverPoints).
 */
import type { SchemeArrow, SchemeLineStyle, SchemeParticles } from "../map/layers/basin-scheme";
import type { WaterMap } from "../map/map";
import type { SubBasin } from "../map/sub-basin-network";
import type { Color } from "../map/theme";
import { nice, type LayerLegend, type LegendKey } from "../panels/legend";
import { LOADING } from "../panels/load-bar";
import { slideSelection } from "../panels/segmented";
import { SHAPES, SHAPE_LABELS, type Shape } from "../panels/shape-switch";
import { loadMiddles, loadRivers, type RiverNetwork } from "./rivers";
import { buildScheme, lineQ, simplify, type Scheme } from "./scheme";

export type SchemeKind = "Q";
/** The legend's slot of each kind drawn as the scheme. */
export const SCHEME_SLOT: Record<SchemeKind, "lines"> = { Q: "lines" };

/** A map to draw as the scheme: its value per sub-basin, `key` names those (for the cache), and `range` the map and its unit (for the lock). */
export interface SchemeLayer {
  kind: SchemeKind;
  value(id: number): number;
  key: string;
  range: string;
}

interface Options {
  map: WaterMap;
  subBasins: SubBasin[];
  /** The legend: the switches go in their layers' sections. */
  legend: LayerLegend;
  /** Draw the map again: the rivers loaded, or a switch moved (`kind`: its map). */
  onChange(kind?: SchemeKind): void;
  /** The line or dot under the pointer changed (see hovered). */
  onHover(): void;
}

export interface SchemeMap {
  /**
   * Whether a map of `kind` (BasinMapSpec.scheme; undefined: not allowed) of major basin
   * `major` is drawn as the scheme (true) or in a shape (see shape).
   */
  isScheme(kind: SchemeKind | undefined, major: number | null): boolean;
  /** The shape a map of `kind` is drawn in when it isn't the scheme. */
  shape(kind: SchemeKind): Shape;
  /**
   * Show each kind's switch in its section of the legend (`shown`: the maps of the kinds
   * on the map, in the slot they're in), hiding the others.
   */
  showSwitches(shown: { kind: SchemeKind; slot: string }[], major: number | null): void;
  /**
   * Draw `layers` (at most one of each kind) of major basin `major` as the scheme (none:
   * clear it). Returns each one's key for the legend, or why it isn't drawn (yet).
   */
  draw(major: number | null, layers: SchemeLayer[]): Map<SchemeKind, { status: string; key: LegendKey | null }>;
  /** The line under the pointer: its sub-basin and value (null: none). */
  hovered(): { subBasin: number; value: number; kind: SchemeKind } | null;
  /**
   * A point on each sub-basin's river of major basin `major`, near its middle (the
   * scheme's dots), or why there are none (yet): the river network loading, or failed.
   */
  riverPoints(major: number): Map<number, [number, number]> | string;
}

type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; scheme: Scheme; net: RiverNetwork | null };
type Mode = "scheme" | "particles" | Shape;

/** Line width (px) of the largest outflow in the basin. */
const Q_PX = 12;
const Q_MIN_PX = 0.8;
/**
 * How the particles are drawn. For now the legend has a slider for each (TUNING), to
 * find the best settings; they start at these.
 */
const PARTICLES = {
  /** Particles alive at once. */
  count: 3500,
  /** CSS pixels per frame (at 60 fps) on the fastest river. */
  speed: 1.5,
  /** Share of a trail kept from one frame to the next. */
  fade: 0.9,
  /** Particle size, CSS pixels. */
  pointSize: 1.8,
  /** Speed = (Q / largest Q) ^ this: 0 is the same speed everywhere. */
  contrast: 0,
  /** River widths (px), from the smallest drawn to the largest... */
  minWidth: 1,
  maxWidth: 7,
  /** ...which is this many powers of ten bigger (smaller rivers left out). */
  decades: 2.5,
  /** Opacity of the rivers under the particles (0: particles only). */
  opacity: 1,
  /** Share of the particles a big river gets per pixel of width that the smallest still get. */
  smallSpawn: 0.25,
  /** A key of PARTICLE_COLORS. */
  color: "theme",
};
type ParticleSettings = typeof PARTICLES;
type NumberSetting = Exclude<keyof ParticleSettings, "color">;

type RGB = [number, number, number];
/**
 * The particles' colour: one colour, or a colour map by discharge (from the smallest
 * river shown to the largest; the maps from river-flow-poc).
 */
const PARTICLE_COLORS: Record<string, { label: string; rgb?: RGB; ramp?: RGB[] }> = {
  theme: { label: "Theme (white)" },
  cyan: { label: "Cyan", rgb: [120, 225, 255] },
  amber: { label: "Amber", rgb: [255, 200, 90] },
  navy: { label: "Navy", rgb: [16, 44, 100] },
  black: { label: "Black", rgb: [20, 24, 28] },
  spectral: { label: "Spectral", ramp: [[70, 90, 170], [50, 130, 220], [30, 190, 220], [60, 210, 140], [225, 225, 80], [255, 140, 50], [235, 60, 120]] },
  viridis: { label: "Viridis", ramp: [[68, 1, 84], [68, 57, 131], [49, 104, 142], [33, 145, 140], [53, 183, 121], [144, 215, 67], [253, 231, 37]] },
  turbo: { label: "Turbo", ramp: [[48, 18, 59], [70, 117, 237], [27, 208, 213], [97, 252, 108], [210, 233, 53], [254, 155, 45], [200, 40, 10]] },
  blues: { label: "Blues (light to dark)", ramp: [[222, 235, 247], [158, 202, 225], [107, 174, 214], [66, 146, 198], [33, 113, 181], [8, 81, 156], [8, 48, 107]] },
  bluesDark: { label: "Blues (dark to light)", ramp: [[8, 48, 107], [8, 81, 156], [33, 113, 181], [66, 146, 198], [107, 174, 214], [158, 202, 225], [222, 235, 247]] },
};

/** A colour map's colour at t (0–1). */
function rampAt(ramp: RGB[], t: number): RGB {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => ramp[i][k] + (ramp[i + 1][k] - ramp[i][k]) * f) as RGB;
}

const TUNING: { key: NumberSetting; label: string; min: number; max: number; step: number }[] = [
  { key: "count", label: "Particles", min: 500, max: 20000, step: 500 },
  { key: "speed", label: "Speed", min: 0.25, max: 5, step: 0.25 },
  { key: "fade", label: "Trails", min: 0.8, max: 0.985, step: 0.005 },
  { key: "pointSize", label: "Particle size", min: 1, max: 4, step: 0.2 },
  { key: "contrast", label: "Speed contrast", min: 0, max: 1, step: 0.05 },
  { key: "maxWidth", label: "Widest river (px)", min: 2, max: 20, step: 0.5 },
  { key: "minWidth", label: "Thinnest river (px)", min: 0.5, max: 5, step: 0.25 },
  { key: "decades", label: "Rivers shown (×10)", min: 0.5, max: 4, step: 0.25 },
  { key: "opacity", label: "River opacity", min: 0, max: 1, step: 0.05 },
  { key: "smallSpawn", label: "On small rivers", min: 0, max: 1, step: 0.05 },
];

const MODES: Record<SchemeKind, [Mode, string, string][]> = {
  Q: [
    ["scheme", "Network", "Discharge along the rivers, from sub-basin to sub-basin"],
    ["particles", "Particles", "Discharge as particles streaming down the rivers"],
    ...SHAPES.map((s): [Mode, string, string] => [s, ...SHAPE_LABELS[s]]),
  ],
};
const isShape = (m: Mode): m is Shape => (SHAPES as Mode[]).includes(m);

const $ = (id: string) => document.getElementById(id)!;
const rgb = (c: Color | RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

export function initSchemeMap({ map, subBasins, legend, onChange, onHover }: Options): SchemeMap {
  const schemes = new Map<number, Status>();
  const mode: Record<SchemeKind, Mode> = { Q: "scheme" };
  let hover: { subBasin: number; value: number; kind: SchemeKind } | null = null;
  let lastMajor: number | null = null;
  const slider = $("bs-simplify");
  const input = $("bs-simplify-input") as HTMLInputElement;
  /** The basin's scheme last drawn (for the slider). */
  let drawnScheme: Scheme | null = null;

  // --- The switches, one per kind, in their layers' sections --------------------------------
  const toggles = {} as Record<SchemeKind, HTMLElement>;
  for (const kind of ["Q"] as SchemeKind[]) {
    const toggle = document.createElement("div");
    toggle.className = "wb-vars";
    toggle.setAttribute("role", "radiogroup");
    toggle.setAttribute("aria-label", "Discharge shown");
    toggle.style.margin = "6px 0 2px";
    toggle.hidden = true;
    toggle.innerHTML = MODES[kind]
      .map(([m, label, title]) => `<button type="button" role="radio" data-mode="${m}" title="${title}">${label}</button>`)
      .join("");
    slideSelection(toggle);
    toggle.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-mode]");
      if (!button || button.dataset.mode === mode[kind]) return;
      mode[kind] = button.dataset.mode as Mode;
      showMode(kind);
      onChange(kind);
    });
    toggles[kind] = toggle;
    showMode(kind);
  }
  function showMode(kind: SchemeKind) {
    for (const button of toggles[kind].querySelectorAll<HTMLElement>("[data-mode]")) {
      button.setAttribute("aria-checked", String(button.dataset.mode === mode[kind]));
    }
  }

  // --- The particles' settings (for now: sliders to find the best ones) -------------------
  const tune: ParticleSettings = { ...PARTICLES };
  const tuning = document.createElement("div");
  tuning.className = "legend-quality particle-tuning";
  tuning.hidden = true;
  tuning.innerHTML =
    TUNING.map(
      ({ key, label, min, max, step }) =>
        `<div><label class="legend-quality-head" for="bs-p-${key}">${label} <span data-value="${key}"></span></label>` +
        `<input class="legend-quality-input" id="bs-p-${key}" data-key="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${tune[key]}" /></div>`,
    ).join("") +
    '<div><label class="legend-quality-head" for="bs-p-color">Particle colour</label><select class="particle-tuning-select" id="bs-p-color">' +
    Object.entries(PARTICLE_COLORS).map(([key, { label }]) => `<option value="${key}">${label}</option>`).join("") +
    "</select></div>" +
    '<button type="button" class="particle-tuning-copy" title="Copy the settings">Copy settings</button>';
  slider.after(tuning);
  const showTune = () => {
    for (const el of tuning.querySelectorAll<HTMLElement>("[data-value]")) el.textContent = String(tune[el.dataset.value as NumberSetting]);
  };
  showTune();
  tuning.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === "bs-p-color") tune.color = el.value;
    else if (el.dataset.key) tune[el.dataset.key as NumberSetting] = Number(el.value);
    else return;
    showTune();
    drawn = "";
    onChange();
  });
  tuning.querySelector("button")!.addEventListener("click", (e) => {
    void navigator.clipboard?.writeText(JSON.stringify(tune));
    (e.target as HTMLElement).textContent = "Copied";
    setTimeout(() => ((e.target as HTMLElement).textContent = "Copy settings"), 1200);
  });

  // --- The simplification slider -----------------------------------------------------------
  /** Tolerance as a share of the basin's size. */
  const share = () => Number(input.value) / 100;
  function showSimplify() {
    const km = drawnScheme ? share() * drawnScheme.extent * 111 : 0;
    const text = share() === 0 ? "The rivers as mapped" : `Within ${km < 10 ? km.toFixed(1) : Math.round(km)} km of the rivers`;
    $("bs-simplify-value").textContent = text;
    input.setAttribute("aria-valuetext", text);
  }
  input.addEventListener("input", () => {
    if (!drawnScheme) return;
    simplify(drawnScheme.lines, share() * drawnScheme.extent);
    showSimplify();
    drawn = "";
    onChange();
  });

  function status(major: number): Status {
    let s = schemes.get(major);
    if (!s) {
      schemes.set(major, (s = { kind: "loading" }));
      Promise.all([loadRivers(major), loadMiddles()])
        .then(([net, middles]) => {
          const scheme = buildScheme(net, major, subBasins, middles);
          simplify(scheme.lines, share() * scheme.extent);
          schemes.set(major, { kind: "ready", scheme, net });
        })
        .catch((err: Error) => schemes.set(major, { kind: "error", message: err.message }))
        .then(() => onChange());
    }
    return s;
  }

  function clear() {
    drawn = "";
    drawnScheme = null;
    slider.hidden = tuning.hidden = true;
    map.setBasinScheme(null);
    if (hover) {
      hover = null;
      onHover();
    }
  }

  let drawn = "";
  /** The last drawing's keys, while `drawn` stays the same. */
  let drawnKeys = new Map<SchemeKind, { status: string; key: LegendKey | null }>();

  return {
    isScheme(kind, major) {
      return !!kind && major !== null && !isShape(mode[kind]);
    },

    shape(kind) {
      const m = mode[kind];
      return isShape(m) ? m : "fill";
    },

    showSwitches(shown, major) {
      for (const kind of ["Q"] as SchemeKind[]) {
        const s = major === null ? undefined : shown.find((x) => x.kind === kind);
        const toggle = toggles[kind];
        toggle.hidden = !s;
        if (s) legend.section(s.slot).extra.append(toggle);
      }
    },

    draw(major, layers) {
      const out = new Map<SchemeKind, { status: string; key: LegendKey | null }>();
      if (major === null || !layers.length) {
        clear();
        return out;
      }
      // A failed load is tried again once another basin has been picked.
      if (major !== lastMajor) for (const [id, s] of schemes) if (s.kind === "error") schemes.delete(id);
      lastMajor = major;
      const s = status(major);
      if (s.kind !== "ready") {
        clear();
        const message = s.kind === "loading" ? LOADING : s.message;
        for (const l of layers) out.set(l.kind, { status: message, key: null });
        return out;
      }
      const { scheme, net } = s;
      const q = layers.find((l) => l.kind === "Q");
      const particles = !!q && mode.Q === "particles";
      slider.hidden = !q || particles;
      tuning.hidden = !particles;
      if (q) legend.section(SCHEME_SLOT.Q).after.append(slider, tuning);
      drawnScheme = scheme;
      const mapKey =
        `${major}:${layers.map((l) => `${l.kind}:${mode[l.kind]}:${l.key}`).join("|")}:` +
        (particles ? Object.values(tune).join() : input.value) +
        `:${legend.lockKey()}`;
      if (mapKey === drawn) return drawnKeys;
      drawn = mapKey;
      showSimplify();

      const theme = map.theme;
      const ids = [...scheme.nodes.keys()];
      const lines: SchemeLineStyle[] = [];
      const arrows: SchemeArrow[] = [];
      let layer: SchemeParticles | undefined;

      if (q && particles) {
        const p = riverParticles(major, net, scheme, q.value, theme, tune, (ref) => legend.hold(`${q.range}:particles`, ref));
        layer = p.layer ?? undefined;
        const top = nice(p.ref);
        const color = rgb(theme.particleRiver);
        const fractions = tune.decades >= 2 ? [100, 10, 1] : [10, 3, 1];
        out.set("Q", { status: "", key: { kind: "lines", items: fractions.map((f) => ({ value: top / f, size: p.width(top / f), color })) } });
      } else if (q) {
        const ref = legend.hold(q.range, Math.max(0, ...ids.map(q.value).filter(Number.isFinite)) || 1);
        const width = (v: number) => (v > 0 ? Math.max(Q_MIN_PX, (v / ref) * Q_PX) : 0);
        for (const line of scheme.lines) {
          const v = lineQ(line, q.value, scheme);
          lines.push({ path: line.path, width: width(v), subBasin: line.in, value: v });
          if (line.kind !== "mouth") continue;
          const [[x0, y0], [x1, y1]] = line.path;
          const angle = (Math.atan2(y1 - y0, (x1 - x0) * Math.cos((y0 * Math.PI) / 180)) * 180) / Math.PI;
          arrows.push({ position: [x1, y1], angle, size: Math.min(36, 10 + width(v)), subBasin: line.in, value: v });
        }
        // Thin lines first, so the big rivers run over them at confluences.
        lines.sort((a, b) => a.width - b.width);
        const top = nice(ref);
        const color = rgb(theme.scheme);
        out.set("Q", { status: "", key: { kind: "lines", items: [top / 10, top / 2, top].map((v) => ({ value: v, size: width(v), color })) } });
      }

      map.setBasinScheme({
        key: mapKey,
        color: theme.scheme,
        casing: theme.schemeCasing,
        lines,
        arrows,
        particles: layer,
        subBasins: new Set(q ? ids : []),
        onHover(item) {
          const next = item && { ...item, kind: "Q" as SchemeKind };
          if (next?.subBasin === hover?.subBasin && next?.value === hover?.value) return;
          hover = next;
          onHover();
        },
      });
      drawnKeys = out;
      return out;
    },

    hovered() {
      return drawnScheme ? hover : null;
    },

    riverPoints(major) {
      // (A failed load is tried again once another basin has been picked, as in draw.)
      if (major !== lastMajor) for (const [id, s] of schemes) if (s.kind === "error") schemes.delete(id);
      lastMajor = major;
      const s = status(major);
      return s.kind === "ready" ? s.scheme.dots : s.kind === "loading" ? LOADING : s.message;
    },
  };
}

/**
 * Discharge per arc of the major basin's rivers (its sub-basin's outflow times the arc's
 * share of the sub-basin's largest upstream area) and how the particles draw it: rivers
 * as wide as log(Q), from minWidth at 10^-decades of the largest to maxWidth, smaller
 * ones left out, and fewer particles spawning on small rivers.
 */
function riverParticles(
  major: number,
  net: RiverNetwork | null,
  scheme: Scheme,
  value: (id: number) => number,
  theme: WaterMap["theme"],
  tune: ParticleSettings,
  /** The largest discharge as it is, or as it was locked (LayerLegend.hold). */
  hold: (ref: number) => number,
) {
  if (!net) return { layer: null, ref: 1, width: () => 0 };
  const maxArea = new Map<number, number>();
  for (let a = 0; a < net.n; a++) {
    const sb = net.subBasin[a];
    if (scheme.nodes.has(sb)) maxArea.set(sb, Math.max(maxArea.get(sb) ?? 0, net.area[a]));
  }
  const q = new Float32Array(net.n);
  for (let a = 0; a < net.n; a++) {
    const max = maxArea.get(net.subBasin[a]);
    const v = max ? value(net.subBasin[a]) : NaN;
    if (Number.isFinite(v) && v > 0) q[a] = (v * net.area[a]) / max!;
  }
  const ref = hold(q.reduce((m, v) => Math.max(m, v), 0) || 1);
  /** 0 at 10^-decades of the largest discharge, 1 at it (below 0: not drawn). */
  const level = (v: number) => (v > 0 ? 1 + Math.log10(v / ref) / tune.decades : -1);
  const width = (v: number) => (level(v) >= 0 ? tune.minWidth + level(v) * (tune.maxWidth - tune.minWidth) : 0);
  const arcs = new Float32Array(net.n * 8);
  const colors: Color[] = new Array(net.n);
  const [r, g, b] = theme.particleRiver;
  const colorOf = PARTICLE_COLORS[tune.color] ?? PARTICLE_COLORS.theme;
  const fixed = colorOf.rgb ?? (colorOf.ramp ? null : (theme.particle.slice(0, 3) as RGB));
  for (let a = 0; a < net.n; a++) {
    const t = level(q[a]);
    // (Never quite transparent: deck.gl doesn't pick what has no alpha.)
    colors[a] = [r, g, b, t >= 0 ? Math.max(1, Math.round(255 * tune.opacity * (0.45 + 0.55 * t))) : 0];
    if (t < 0) continue;
    const spawn = tune.smallSpawn + (1 - tune.smallSpawn) * t * t;
    const speed = Math.max(0.05, (q[a] / ref) ** tune.contrast);
    const particle = fixed ?? rampAt(colorOf.ramp!, t);
    arcs.set([width(q[a]), spawn, speed, 0, particle[0] / 255, particle[1] / 255, particle[2] / 255, 0], a * 8);
  }
  const { count, speed, fade, pointSize } = tune;
  const layer: SchemeParticles = { id: String(major), network: net, arcs, colors, q, subBasin: net.subBasin, count, speed, fade, pointSize };
  return { layer, ref, width };
}
