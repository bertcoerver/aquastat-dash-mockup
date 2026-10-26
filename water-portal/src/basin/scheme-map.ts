/*
 * Basin view: the selected major basin's discharge and storage change maps drawn as a
 * water balance scheme (scheme.ts) rather than as sub-basin fills:
 *
 * - discharge as a network of lines along the rivers, as wide as the discharge they
 *   carry (linear, so widths add up where rivers join), with a slider in the legend for
 *   how far the lines may stray from the rivers;
 * - or discharge as particles streaming down the real rivers (river-flow-poc's wind map),
 *   the rivers as wide as their discharge (each sub-basin's outflow shared over its
 *   arcs by upstream area), so big rivers carry more of the particles;
 * - storage change as a dot on each sub-basin's river, its area the change, green as
 *   storage rises and red as it falls.
 *
 * basin-stats.ts asks for it for the maps that allow it (BasinMapSpec.scheme: discharge
 * or storage change per sub-basin), and a switch in the legend picks between them and the fills.
 * The legend shows a key to the widths or sizes in place of the colour ramp. Sizes are
 * set per map: the widest line is the basin's largest outflow in the period, a dot of
 * DS_PX the 98th percentile of the sub-basins' |ΔS|.
 */
import type { SchemeArrow, SchemeDot, SchemeLineStyle, SchemeParticles } from "../map/layers/basin-scheme";
import type { WaterMap } from "../map/map";
import type { SubBasin } from "../map/sub-basin-network";
import type { Color } from "../map/theme";
import { LOADING } from "../panels/load-bar";
import { fmtStop } from "../panels/ramp-menu";
import { slideSelection } from "../panels/segmented";
import { loadMiddles, loadRivers, type RiverNetwork } from "./rivers";
import { buildScheme, lineQ, simplify, type Scheme } from "./scheme";

export type SchemeKind = "Q" | "dS";

interface Options {
  map: WaterMap;
  subBasins: SubBasin[];
  /** The legend (#bs-legend): the switch goes under its title. */
  legend: HTMLElement;
  /** Draw the map again: the rivers loaded, or the switch moved. */
  onChange(): void;
  /** The line or dot under the pointer changed (see hovered). */
  onHover(): void;
}

export interface SchemeMap {
  /**
   * Whether a map of `kind` (BasinMapSpec.scheme; undefined: not allowed) of major basin
   * `major` is drawn as the scheme, from `value` per sub-basin (`key` names that, for the
   * cache), and if so why it isn't drawn yet (the status: "" when it is). Null: draw the
   * fills. Shows the legend's switch when there's a choice.
   */
  prepare(kind: SchemeKind | undefined, major: number | null, value: (id: number) => number, key: string): { status: string } | null;
  /** Draw the scheme last prepared (false: none), with its key in the legend. */
  draw(on: boolean): void;
  /** The line or dot under the pointer: its sub-basin and value (null: none). */
  hovered(): { subBasin: number; value: number; kind: SchemeKind } | null;
}

type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; scheme: Scheme; net: RiverNetwork | null };
type Mode = "scheme" | "particles" | "fills";

/** Line width (px) of the largest outflow in the basin. */
const Q_PX = 12;
const Q_MIN_PX = 0.8;
/** Dot radius (px) of the 98th percentile of the sub-basins' |ΔS|. */
const DS_PX = 12;
const DS_MIN_PX = 2.5;
const DS_MAX_PX = 20;
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
    ["fills", "Sub-basins", "Discharge out of each sub-basin"],
  ],
  dS: [
    ["scheme", "Dots", "Storage change as a dot on each sub-basin's river"],
    ["fills", "Sub-basins", "Storage change of each sub-basin"],
  ],
};

const $ = (id: string) => document.getElementById(id)!;

export function initSchemeMap({ map, subBasins, legend, onChange, onHover }: Options): SchemeMap {
  const schemes = new Map<number, Status>();
  const mode: Record<SchemeKind, Mode> = { Q: "scheme", dS: "scheme" };
  let kind: SchemeKind | null = null;
  let prepared: { key: string; kind: SchemeKind; mode: Mode; major: number; scheme: Scheme; net: RiverNetwork | null; value: (id: number) => number } | null = null;
  let hover: { subBasin: number; value: number } | null = null;
  let lastMajor: number | null = null;
  const key = document.getElementById("bs-scheme-key") as unknown as SVGSVGElement;
  const slider = $("bs-simplify");
  const input = $("bs-simplify-input") as HTMLInputElement;

  // --- The switch, under the legend's title ----------------------------------------------
  const toggle = document.createElement("div");
  toggle.className = "wb-vars";
  toggle.setAttribute("role", "radiogroup");
  toggle.style.margin = "8px 0 2px";
  toggle.hidden = true;
  legend.querySelector(".legend-title")!.after(toggle);
  slideSelection(toggle);
  let shownKind: SchemeKind | null = null;
  function showMode() {
    if (!kind) return;
    if (kind !== shownKind) {
      shownKind = kind;
      toggle.innerHTML = MODES[kind]
        .map(([m, label, title]) => `<button type="button" role="radio" data-mode="${m}" title="${title}">${label}</button>`)
        .join("");
    }
    toggle.setAttribute("aria-label", kind === "Q" ? "Discharge shown" : "Storage change shown");
    for (const button of toggle.querySelectorAll<HTMLElement>("[data-mode]")) button.setAttribute("aria-checked", String(button.dataset.mode === mode[kind]));
  }
  toggle.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-mode]");
    if (!button || !kind || button.dataset.mode === mode[kind]) return;
    mode[kind] = button.dataset.mode as Mode;
    showMode();
    onChange();
  });

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
    const km = prepared ? share() * prepared.scheme.extent * 111 : 0;
    const text = share() === 0 ? "The rivers as mapped" : `Within ${km < 10 ? km.toFixed(1) : Math.round(km)} km of the rivers`;
    $("bs-simplify-value").textContent = text;
    input.setAttribute("aria-valuetext", text);
  }
  input.addEventListener("input", () => {
    if (!prepared) return;
    simplify(prepared.scheme.lines, share() * prepared.scheme.extent);
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
        .then(onChange);
    }
    return s;
  }

  function off() {
    prepared = null;
    if (hover) {
      hover = null;
      onHover();
    }
    return null;
  }

  let drawn = "";

  return {
    prepare(k, major, value, valueKey) {
      kind = k ?? null;
      toggle.hidden = !k || major === null;
      showMode();
      if (!k || major === null || mode[k] === "fills") return off();
      // A failed load is tried again once another basin has been picked.
      if (major !== lastMajor) for (const [id, s] of schemes) if (s.kind === "error") schemes.delete(id);
      lastMajor = major;
      const s = status(major);
      if (s.kind !== "ready") {
        prepared = null;
        return { status: s.kind === "loading" ? LOADING : s.message };
      }
      prepared = { key: `${major}:${k}:${mode[k]}:${valueKey}`, kind: k, mode: mode[k], major, scheme: s.scheme, net: s.net, value };
      return { status: "" };
    },

    draw(on) {
      slider.hidden = !on || prepared?.kind !== "Q" || prepared.mode !== "scheme";
      tuning.hidden = !on || prepared?.mode !== "particles";
      key.toggleAttribute("hidden", !on || !prepared);
      if (!on || !prepared) {
        drawn = "";
        map.setBasinScheme(null);
        return;
      }
      const theme = map.theme;
      const { scheme, net, value, kind: k } = prepared;
      const mapKey = `${prepared.key}:${prepared.mode === "particles" ? Object.values(tune).join() : input.value}`;
      if (mapKey === drawn) return;
      drawn = mapKey;
      showSimplify();
      const ids = [...scheme.nodes.keys()];
      const onHoverItem = (item: { subBasin: number; value: number } | null) => {
        if (item?.subBasin === hover?.subBasin && item?.value === hover?.value) return;
        hover = item;
        onHover();
      };
      const common = { key: mapKey, color: theme.scheme, casing: theme.schemeCasing, onHover: onHoverItem };

      if (prepared.mode === "particles") {
        const particles = riverParticles(prepared.major, net, scheme, value, theme, tune);
        map.setBasinScheme({ ...common, lines: [], arrows: [], dots: [], particles: particles.layer ?? undefined, subBasins: new Set(ids) });
        drawKey(particles.ref, particles.width, "Q", theme.particleRiver, theme, tune.decades >= 2 ? [100, 10, 1] : [10, 3, 1]);
      } else if (k === "Q") {
        const ref = Math.max(0, ...ids.map(value).filter(Number.isFinite)) || 1;
        const width = (q: number) => (q > 0 ? Math.max(Q_MIN_PX, (q / ref) * Q_PX) : 0);
        const lines: SchemeLineStyle[] = [];
        const arrows: SchemeArrow[] = [];
        for (const line of scheme.lines) {
          const q = lineQ(line, value, scheme);
          lines.push({ path: line.path, width: width(q), subBasin: line.in, value: q });
          if (line.kind !== "mouth") continue;
          const [[x0, y0], [x1, y1]] = line.path;
          const angle = (Math.atan2(y1 - y0, (x1 - x0) * Math.cos((y0 * Math.PI) / 180)) * 180) / Math.PI;
          arrows.push({ position: [x1, y1], angle, size: Math.min(36, 10 + width(q)), subBasin: line.in, value: q });
        }
        // Thin lines first, so the big rivers run over them at confluences.
        lines.sort((a, b) => a.width - b.width);
        map.setBasinScheme({ ...common, lines, arrows, dots: [], subBasins: new Set(ids) });
        drawKey(ref, (q) => width(q), "Q", theme.scheme, theme);
      } else {
        const values = ids.map(value).filter(Number.isFinite);
        const ref = quantile(values.map(Math.abs), 0.98) || 1;
        const radius = (ds: number) => Math.min(DS_MAX_PX, Math.max(DS_MIN_PX, Math.sqrt(Math.abs(ds) / ref) * DS_PX));
        const dots: SchemeDot[] = ids
          .map((id) => ({ id, v: value(id) }))
          .filter(({ v }) => Number.isFinite(v))
          .map(({ id, v }) => ({
            position: scheme.dots.get(id)!,
            radius: radius(v),
            color: v >= 0 ? theme.storageRise : theme.storageFall,
            subBasin: id,
            value: v,
          }))
          // Big dots first, so small ones beside them stay visible.
          .sort((a, b) => b.radius - a.radius);
        map.setBasinScheme({ ...common, lines: [], arrows: [], dots, subBasins: new Set() });
        drawKey(ref, radius, "dS", theme.storageRise, theme);
      }
    },

    hovered() {
      return hover && prepared ? { ...hover, kind: prepared.kind } : null;
    },
  };

  /** The legend's key: three line widths (discharge), or dot sizes rising and falling (storage change). */
  function drawKey(ref: number, size: (v: number) => number, k: SchemeKind, color: Color, theme: WaterMap["theme"], fractions = [10, 2, 1]) {
    const rgb = (c: Color) => `rgb(${c[0]},${c[1]},${c[2]})`;
    const top = nice(ref);
    const label = (x: number, v: number, sign = "") => `<text x="${x}" y="21">${sign}${fmtStop(v, top)}</text>`;
    const width = legend.clientWidth - 24 || 220;
    const step = width / 3;
    if (k === "Q") {
      key.innerHTML = fractions.map((f) => top / f)
        .map((q, i) => {
          const x = i * step;
          return `<line x1="${x + 1}" y1="16" x2="${x + 28}" y2="16" stroke="${rgb(color)}" stroke-width="${size(q)}" stroke-linecap="round"/>` +
            label(x + 32 + size(q) / 2, q);
        })
        .join("");
    } else {
      key.innerHTML = ([[top / 4, theme.storageRise, "+"], [top, theme.storageRise, "+"], [top, theme.storageFall, "−"]] as const)
        .map(([v, c, sign], i) => {
          const x = i * step + DS_MAX_PX / 2;
          return `<circle cx="${x}" cy="16" r="${size(v)}" fill="${rgb(c)}" stroke="${rgb(theme.schemeCasing)}"/>` + label(x + size(v) + 5, v, sign);
        })
        .join("");
    }
    key.setAttribute("viewBox", `0 0 ${width} 34`);
    key.setAttribute("width", String(width));
  }
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
  const ref = q.reduce((m, v) => Math.max(m, v), 0) || 1;
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

/** A round number at or below x (1, 2 or 5 × a power of ten). */
function nice(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= x) ?? p;
}

/** The p-th quantile (0–1) of the values. */
function quantile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] : NaN;
}
