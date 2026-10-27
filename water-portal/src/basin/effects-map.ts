/*
 * Basin view: the selected major basin's precipitation as rain, and its
 * evapotranspiration as vapour rising through a heat shimmer (river-flow-poc's rain and
 * evapotranspiration pages), instead of as the sub-basins' colours, circles or 3D bars
 * (panels/shape-switch.ts).
 *
 * Both follow WaPOR's rasters over the period (basin-grids.ts: the mean per day, on a
 * grid over the basin, nothing outside it), so they're finer than the sub-basins: the
 * drops and puffs per area grow with the mm/day there, all of them at the "all drops
 * at" value and fewer below it, as (mm/day ÷ that)^contrast. Vapour is green where
 * it's transpiration (by T's share of AETI) and blue where it evaporates. Under each,
 * the raster can be drawn on the ground too.
 *
 * Like the scheme (scheme-map.ts), basin-stats.ts asks for it for the maps that allow it
 * (BasinMapSpec.effect: precipitation or evapotranspiration per sub-basin), and a switch
 * in each one's legend section picks between it and the other maps' shapes. The tuning
 * pane (panels/tuning-pane.ts: a triple click on the legend) has sliders for how they're
 * drawn (RAIN_TUNING, VAPOUR_TUNING).
 */
import type { BasinEffects, EffectGround } from "../map/layers/basin-effects";
import type { EffectGrid } from "../map/layers/rain";
import type { WaterMap } from "../map/map";
import type { Color } from "../map/theme";
import type { LayerLegend, LegendKey } from "../panels/legend";
import { LOADING } from "../panels/load-bar";
import { tuningSection } from "../panels/tuning-pane";
import { slideSelection } from "../panels/segmented";
import { SHAPES, SHAPE_LABELS, type Shape } from "../panels/shape-switch";
import type { MajorBasin } from "../toolbar/place-picker";
import type { DayRange } from "../toolbar/range-rules";
import { loadBasinGrid, type BasinGrid } from "./basin-grids";

export type EffectKind = "rain" | "vapour";

interface Options {
  map: WaterMap;
  majorBasins: MajorBasin[];
  /** The legend: the switches go in their layers' sections. */
  legend: LayerLegend;
  /** Draw the map again: the rasters loaded, or a switch moved (`kind`: its map). */
  onChange(kind?: EffectKind): void;
}

export interface EffectsMap {
  /** Whether a map of `kind` (BasinMapSpec.effect; undefined: not allowed) of major basin `major` is drawn as the effect. */
  isEffect(kind: EffectKind | undefined, major: number | null): boolean;
  /** The shape a map of `kind` is drawn in when it isn't the effect. */
  shape(kind: EffectKind): Shape;
  /** Show each kind's switch in its section of the legend (`shown`: the maps of the kinds on the map, in their slots). */
  showSwitches(shown: { kind: EffectKind; slot: string }[], major: number | null): void;
  /**
   * Draw `kinds` of major basin `major` over `range` (none: clear them). Returns each
   * one's key for the legend, or why it isn't drawn (yet).
   */
  draw(major: number | null, range: DayRange | null, kinds: EffectKind[]): Map<EffectKind, { status: string; key: LegendKey | null }>;
}

type Mode = Shape | "effect";
type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; grids: BasinGrid[] };
type RGB = [number, number, number];

/** How the rain is drawn. The tuning pane has a slider for each (RAIN_TUNING); they start at these. */
const RAIN = {
  /** Drops at once (most aren't shown: only where it rains). */
  count: 60000,
  /** Seconds a drop takes to fall. */
  period: 1.4,
  /** Height they fall from, their length and width, and the splash's radius: CSS pixels. */
  height: 140,
  length: 8,
  width: 1.4,
  splash: 4,
  /** Drift while falling, as a share of the height. */
  wind: 0.12,
  /** mm/day at which every drop falls; below it, (mm/day ÷ this)^gamma of them. */
  full: 8,
  gamma: 0.6,
  opacity: 0.9,
  /** Opacity of the raster on the ground (0: not drawn). */
  ground: 0.5,
  /** A key of RAIN_COLORS. */
  color: "theme",
};

/** How the vapour and the shimmer are drawn (VAPOUR_TUNING). */
const VAPOUR = {
  /** Puffs at once (most aren't shown: only where water goes up). */
  count: 300000,
  /** Seconds a puff takes to rise. */
  period: 3,
  /** Height they rise to, their size at the ground and at the top, and their sway: CSS pixels. */
  height: 160,
  sizeBase: 3,
  sizeTop: 14,
  sway: 5,
  /** Drift while rising, as a share of the height. */
  wind: 0.15,
  /** mm/day at which every puff rises and the shimmer is full; below it, (mm/day ÷ this)^gamma. */
  full: 4,
  gamma: 1.3,
  opacity: 0.4,
  /** The shimmer's largest shift, CSS pixels (0: none). */
  shimmer: 2,
  ground: 0.5,
  /** A key of VAPOUR_COLORS. */
  color: "split",
};

type Settings = Record<string, number | string>;
type Slider = { key: string; label: string; min: number; max: number; step: number };

const RAIN_TUNING: Slider[] = [
  { key: "count", label: "Drops", min: 5000, max: 300000, step: 5000 },
  { key: "period", label: "Fall time (s)", min: 0.4, max: 4, step: 0.1 },
  { key: "height", label: "Height (px)", min: 20, max: 400, step: 10 },
  { key: "length", label: "Drop length", min: 2, max: 30, step: 1 },
  { key: "width", label: "Drop width", min: 0.5, max: 4, step: 0.1 },
  { key: "splash", label: "Splash", min: 0, max: 12, step: 0.5 },
  { key: "wind", label: "Wind", min: 0, max: 0.6, step: 0.02 },
  { key: "full", label: "All drops at (mm/d)", min: 1, max: 30, step: 0.5 },
  { key: "gamma", label: "Contrast", min: 0.2, max: 2, step: 0.05 },
  { key: "opacity", label: "Opacity", min: 0.1, max: 1, step: 0.05 },
  { key: "ground", label: "Ground", min: 0, max: 1, step: 0.05 },
];

const VAPOUR_TUNING: Slider[] = [
  { key: "count", label: "Puffs", min: 20000, max: 1000000, step: 20000 },
  { key: "period", label: "Rise time (s)", min: 1, max: 8, step: 0.25 },
  { key: "height", label: "Height (px)", min: 20, max: 400, step: 10 },
  { key: "sizeBase", label: "Size at ground", min: 1, max: 10, step: 0.5 },
  { key: "sizeTop", label: "Size at top", min: 4, max: 40, step: 1 },
  { key: "sway", label: "Sway", min: 0, max: 15, step: 0.5 },
  { key: "wind", label: "Wind", min: 0, max: 0.6, step: 0.02 },
  { key: "full", label: "All puffs at (mm/d)", min: 0.5, max: 10, step: 0.25 },
  { key: "gamma", label: "Contrast", min: 0.3, max: 2.5, step: 0.05 },
  { key: "opacity", label: "Opacity", min: 0.05, max: 1, step: 0.05 },
  { key: "shimmer", label: "Shimmer (px)", min: 0, max: 6, step: 0.25 },
  { key: "ground", label: "Ground", min: 0, max: 1, step: 0.05 },
];

/** The drops' colour: the theme's, or one of these. */
const RAIN_COLORS: Record<string, { label: string; rgb?: RGB }> = {
  theme: { label: "Theme" },
  white: { label: "White", rgb: [235, 245, 255] },
  lightBlue: { label: "Light blue", rgb: [150, 200, 255] },
  blue: { label: "Blue", rgb: [40, 110, 220] },
  navy: { label: "Navy", rgb: [16, 44, 100] },
  black: { label: "Black", rgb: [20, 24, 28] },
};

/** The puffs' colours: transpiration's and evaporation's (the theme's), the same for both, or one of these for both. */
const VAPOUR_COLORS: Record<string, { label: string; rgb?: RGB }> = {
  split: { label: "Transpiration / evaporation" },
  one: { label: "One colour" },
  white: { label: "White", rgb: [235, 245, 255] },
  grey: { label: "Grey", rgb: [120, 130, 140] },
  green: { label: "Green", rgb: [60, 170, 90] },
};

/** The ground's colours (RGBA) at shares of the "all at" value: clear when dry (river-flow-poc's). */
const RAIN_GROUND: [number, Color][] = [
  [0, [0, 0, 0, 0]],
  [0.025, [40, 70, 110, 0]],
  [0.1, [45, 100, 160, 50]],
  [0.3, [50, 130, 200, 85]],
  [0.75, [90, 170, 235, 115]],
  [1.5, [170, 215, 255, 140]],
];
const VAPOUR_GROUND: [number, Color][] = [
  [0, [0, 0, 0, 0]],
  [0.06, [70, 90, 60, 0]],
  [0.2, [80, 120, 70, 45]],
  [0.5, [80, 155, 95, 80]],
  [0.8, [95, 190, 130, 105]],
  [1.2, [170, 230, 190, 130]],
];

const MODES: Record<EffectKind, [Mode, string, string][]> = {
  rain: [
    ...SHAPES.map((s): [Mode, string, string] => [s, ...SHAPE_LABELS[s]]),
    ["effect", "Rain", "Precipitation as rain, as much as WaPOR's raster says"],
  ],
  vapour: [
    ...SHAPES.map((s): [Mode, string, string] => [s, ...SHAPE_LABELS[s]]),
    ["effect", "Vapour", "Evapotranspiration as vapour rising, as much as WaPOR's raster says"],
  ],
};

const rgb = (c: Color | RGB) => `${c[0]},${c[1]},${c[2]}`;
const rgb3 = (c: Color): RGB => [c[0], c[1], c[2]];

export function initEffectsMap({ map, majorBasins, legend, onChange }: Options): EffectsMap {
  const boxes = new Map(majorBasins.map((b) => [b.id, b.bbox]));
  const statuses = new Map<string, Status>();
  const mode: Record<EffectKind, Mode> = { rain: "fill", vapour: "fill" };
  let lastMajor: number | null = null;

  // --- The switches, one per kind, in their layers' sections --------------------------------
  const toggles = {} as Record<EffectKind, HTMLElement>;
  for (const kind of ["rain", "vapour"] as EffectKind[]) {
    const toggle = document.createElement("div");
    toggle.className = "wb-vars";
    toggle.setAttribute("role", "radiogroup");
    toggle.setAttribute("aria-label", kind === "rain" ? "Precipitation shown" : "Evapotranspiration shown");
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
  function showMode(kind: EffectKind) {
    for (const button of toggles[kind].querySelectorAll<HTMLElement>("[data-mode]")) {
      button.setAttribute("aria-checked", String(button.dataset.mode === mode[kind]));
    }
  }

  // --- The settings: sliders in the tuning pane --------------------------------------------
  const rain = { ...RAIN };
  const vapour = { ...VAPOUR };
  const panels: Record<EffectKind, HTMLElement> = {
    rain: tuningSection("Rain", "Draw the precipitation map as rain to tune it."),
    vapour: tuningSection("Vapour", "Draw the evapotranspiration map as vapour to tune it."),
  };
  panels.rain.append(tuningPanel("rain", rain, RAIN_TUNING, RAIN_COLORS, () => onChange()));
  panels.vapour.append(tuningPanel("vapour", vapour, VAPOUR_TUNING, VAPOUR_COLORS, () => onChange()));

  /** The rasters a kind needs over a range (loading them the first time). */
  function status(kind: EffectKind, range: DayRange, major: number): Status {
    const id = `${kind}:${range.start}-${range.end}:${major}`;
    let s = statuses.get(id);
    if (!s) {
      statuses.set(id, (s = { kind: "loading" }));
      const box = boxes.get(major)!;
      Promise.all((kind === "rain" ? (["PCP"] as const) : (["AETI", "T"] as const)).map((v) => loadBasinGrid(v, range, major, box)))
        .then((grids) => statuses.set(id, { kind: "ready", grids }))
        .catch((err: Error) => statuses.set(id, { kind: "error", message: err.message }))
        .then(() => onChange());
    }
    return s;
  }

  function clear() {
    drawn = "";
    panels.rain.hidden = panels.vapour.hidden = true;
    map.setBasinEffects(null);
  }

  let drawn = "";
  let drawnKeys = new Map<EffectKind, { status: string; key: LegendKey | null }>();

  return {
    isEffect(kind, major) {
      return !!kind && major !== null && boxes.has(major) && mode[kind] === "effect";
    },

    shape(kind) {
      const m = mode[kind];
      return m === "effect" ? "fill" : m;
    },

    showSwitches(shown, major) {
      for (const kind of ["rain", "vapour"] as EffectKind[]) {
        const s = major === null ? undefined : shown.find((x) => x.kind === kind);
        toggles[kind].hidden = !s;
        if (s) legend.section(s.slot).extra.append(toggles[kind]);
      }
    },

    draw(major, range, kinds) {
      const out = new Map<EffectKind, { status: string; key: LegendKey | null }>();
      if (major === null || !range || !kinds.length || !boxes.has(major)) {
        clear();
        return out;
      }
      // A failed load is tried again once another basin has been picked.
      if (major !== lastMajor) for (const [id, s] of statuses) if (s.kind === "error") statuses.delete(id);
      lastMajor = major;
      const theme = map.theme;
      const fx: BasinEffects = { key: "" };
      for (const kind of ["rain", "vapour"] as EffectKind[]) {
        panels[kind].hidden = !kinds.includes(kind);
        if (!kinds.includes(kind)) continue;
        const s = status(kind, range, major);
        if (s.kind !== "ready") {
          out.set(kind, { status: s.kind === "loading" ? LOADING : s.message, key: null });
          continue;
        }
        if (kind === "rain") {
          const [pcp] = s.grids;
          const { grid, max } = effectGrid(pcp);
          const color = RAIN_COLORS[rain.color]?.rgb ?? rgb3(theme.rain);
          fx.rain = {
            grid,
            ground: ground(pcp, RAIN_GROUND, rain.full, rain.ground),
            count: rain.count,
            period: rain.period,
            dropHeight: rain.height,
            dropLength: rain.length,
            dropWidth: rain.width,
            splash: rain.splash,
            wind: [rain.wind, rain.wind * 0.3],
            reference: (rain.full / max) * 255,
            gamma: rain.gamma,
            color,
            opacity: rain.opacity,
          };
          out.set(kind, { status: "", key: densityKey(color, rain.full, rain.gamma) });
        } else {
          const [aeti, t] = s.grids;
          const { grid, max } = effectGrid(aeti, t);
          const reference = (vapour.full / max) * 255;
          const one = VAPOUR_COLORS[vapour.color]?.rgb ?? (vapour.color === "one" ? rgb3(theme.vapour) : null);
          const [tColor, eColor] = one ? [one, one] : [rgb3(theme.transpiration), rgb3(theme.evaporation)];
          fx.vapour = {
            grid,
            ground: ground(aeti, VAPOUR_GROUND, vapour.full, vapour.ground),
            haze: { strength: vapour.shimmer, reference, gamma: vapour.gamma },
            count: vapour.count,
            period: vapour.period,
            height: vapour.height,
            size: [vapour.sizeBase, vapour.sizeTop],
            sway: vapour.sway,
            wind: [vapour.wind, vapour.wind * 0.3],
            reference,
            gamma: vapour.gamma,
            transpirationColor: tColor,
            evaporationColor: eColor,
            opacity: vapour.opacity,
          };
          out.set(kind, { status: "", key: densityKey(tColor, vapour.full, vapour.gamma, one ? null : eColor) });
        }
      }
      const key =
        `${major}:${range.start}-${range.end}:${kinds.join()}:${[...out.values()].map((o) => o.status).join()}:` +
        `${JSON.stringify(rain)}:${JSON.stringify(vapour)}:${rgb(theme.rain)}`;
      if (key === drawn) return drawnKeys;
      drawn = key;
      fx.key = key;
      map.setBasinEffects(fx.rain || fx.vapour ? fx : null);
      drawnKeys = out;
      return out;
    },
  };
}

/** A panel of sliders and a colour menu that change `values` in place. */
function tuningPanel(id: string, values: Settings, sliders: Slider[], colors: Record<string, { label: string }>, onChange: () => void) {
  const panel = document.createElement("div");
  panel.className = "legend-quality particle-tuning";
  panel.innerHTML =
    sliders
      .map(
        ({ key, label, min, max, step }) =>
          `<div><label class="legend-quality-head" for="bs-${id}-${key}">${label} <span data-value="${key}"></span></label>` +
          `<input class="legend-quality-input" id="bs-${id}-${key}" data-key="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${values[key]}" /></div>`,
      )
      .join("") +
    `<div><label class="legend-quality-head" for="bs-${id}-color">Colour</label><select class="particle-tuning-select" id="bs-${id}-color" data-key="color">` +
    Object.entries(colors).map(([key, { label }]) => `<option value="${key}"${key === values.color ? " selected" : ""}>${label}</option>`).join("") +
    "</select></div>" +
    '<button type="button" class="particle-tuning-copy" title="Copy the settings">Copy settings</button>';
  const show = () => {
    for (const el of panel.querySelectorAll<HTMLElement>("[data-value]")) el.textContent = String(values[el.dataset.value!]);
  };
  show();
  panel.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    const key = el.dataset.key;
    if (!key) return;
    values[key] = key === "color" ? el.value : Number(el.value);
    show();
    onChange();
  });
  const copy = panel.querySelector("button")!;
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(JSON.stringify(values));
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy settings"), 1200);
  });
  return panel;
}

const effectGrids = new WeakMap<BasinGrid, { grid: EffectGrid; max: number }>();

/**
 * A grid as bytes for the layers, relative to its largest value; with a second grid
 * (transpiration), its share of the first as a second channel.
 */
function effectGrid(g: BasinGrid, share?: BasinGrid) {
  let out = effectGrids.get(g);
  if (!out) {
    const max = g.values.reduce((m, v) => (v > m ? v : m), 0) || 1;
    const channels = share ? 2 : 1;
    const data = new Uint8Array(g.values.length * channels);
    for (let i = 0; i < g.values.length; i++) {
      const v = g.values[i];
      if (!(v > 0)) continue;
      data[i * channels] = Math.round((v / max) * 255);
      if (share) data[i * 2 + 1] = Math.round(Math.min(1, Math.max(0, share.values[i] / v || 0)) * 255);
    }
    out = { grid: { data, channels, width: g.width, height: g.height, bounds: g.bounds }, max };
    effectGrids.set(g, out);
  }
  return out;
}

const grounds = new WeakMap<BasinGrid, { full: number; image: HTMLCanvasElement }>();

/** A grid on the ground in a ramp's colours, the ramp's shares of `full` (opacity 0: none). */
function ground(g: BasinGrid, stops: [number, Color][], full: number, opacity: number): EffectGround | null {
  if (opacity <= 0) return null;
  let cached = grounds.get(g);
  if (cached?.full !== full) {
    const image = document.createElement("canvas");
    image.width = g.width;
    image.height = g.height;
    const data = new ImageData(g.width, g.height);
    for (let i = 0; i < g.values.length; i++) data.data.set(rampColor(stops, g.values[i] / full), i * 4);
    image.getContext("2d")!.putImageData(data, 0, 0);
    grounds.set(g, (cached = { full, image }));
  }
  return { image: cached.image, bounds: g.bounds, opacity };
}

function rampColor(stops: [number, Color][], t: number): Color {
  if (!(t > stops[0][0])) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      const f = (t - t0) / (t1 - t0);
      return c0.map((c, k) => c + (c1[k] - c) * f) as Color;
    }
  }
  return stops.at(-1)![1];
}

/** The legend's key: how many drops or puffs, from none to all at `full` (and `second`: the other colour's ramp beneath). */
function densityKey(color: RGB, full: number, gamma: number, second: RGB | null = null): LegendKey {
  const ramp = (c: RGB) => [0, 0.25, 0.5, 0.75, 1].map((t) => `rgba(${rgb(c)},${(t ** gamma).toFixed(3)}) ${t * 100}%`).join(", ");
  const gradient = second
    ? `linear-gradient(to right, ${ramp(color)}) top / 100% 50% no-repeat, linear-gradient(to right, ${ramp(second)}) bottom / 100% 50% no-repeat`
    : `linear-gradient(to right, ${ramp(color)})`;
  return { kind: "ramp", fixed: true, gradient, ticks: [0, 0.5, 1].map((at) => ({ value: full * at, at })) };
}
