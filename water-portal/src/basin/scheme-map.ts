/*
 * Basin view: the selected major basin's discharge and storage change maps drawn as a
 * water balance scheme (scheme.ts) rather than as sub-basin fills:
 *
 * - discharge as a network of lines along the rivers, as wide as the discharge they
 *   carry (linear, so widths add up where rivers join), with a slider in the legend for
 *   how far the lines may stray from the rivers;
 * - storage change as a dot on each sub-basin's river, its area the change, green as
 *   storage rises and red as it falls.
 *
 * basin-stats.ts asks for it for the maps that allow it (BasinMapSpec.scheme: discharge
 * or storage change per sub-basin), and a switch in the legend goes back to the fills.
 * The legend shows a key to the widths or sizes in place of the colour ramp. Sizes are
 * set per map: the widest line is the basin's largest outflow in the period, a dot of
 * DS_PX the 98th percentile of the sub-basins' |ΔS|.
 */
import type { SchemeArrow, SchemeDot, SchemeLineStyle } from "../map/layers/basin-scheme";
import type { WaterMap } from "../map/map";
import type { SubBasin } from "../map/sub-basin-network";
import type { Color } from "../map/theme";
import { LOADING } from "../panels/load-bar";
import { fmtStop } from "../panels/ramp-menu";
import { slideSelection } from "../panels/segmented";
import { loadMiddles, loadRivers } from "./rivers";
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

type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; scheme: Scheme };

/** Line width (px) of the largest outflow in the basin. */
const Q_PX = 12;
const Q_MIN_PX = 0.8;
/** Dot radius (px) of the 98th percentile of the sub-basins' |ΔS|. */
const DS_PX = 12;
const DS_MIN_PX = 2.5;
const DS_MAX_PX = 20;

const LABELS: Record<SchemeKind, [string, string, string, string]> = {
  Q: ["Network", "Discharge along the rivers, from sub-basin to sub-basin", "Sub-basins", "Discharge out of each sub-basin"],
  dS: ["Dots", "Storage change as a dot on each sub-basin's river", "Sub-basins", "Storage change of each sub-basin"],
};

const $ = (id: string) => document.getElementById(id)!;

export function initSchemeMap({ map, subBasins, legend, onChange, onHover }: Options): SchemeMap {
  const schemes = new Map<number, Status>();
  const mode: Record<SchemeKind, "scheme" | "fills"> = { Q: "scheme", dS: "scheme" };
  let kind: SchemeKind | null = null;
  let prepared: { key: string; kind: SchemeKind; scheme: Scheme; value: (id: number) => number } | null = null;
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
  toggle.innerHTML =
    '<button type="button" role="radio" data-mode="scheme"></button><button type="button" role="radio" data-mode="fills"></button>';
  legend.querySelector(".legend-title")!.after(toggle);
  slideSelection(toggle);
  const [schemeButton, fillsButton] = toggle.querySelectorAll<HTMLElement>("[data-mode]");
  function showMode() {
    if (!kind) return;
    const [a, aTitle, b, bTitle] = LABELS[kind];
    schemeButton.textContent = a;
    schemeButton.title = aTitle;
    fillsButton.textContent = b;
    fillsButton.title = bTitle;
    toggle.setAttribute("aria-label", kind === "Q" ? "Discharge shown" : "Storage change shown");
    for (const button of [schemeButton, fillsButton]) button.setAttribute("aria-checked", String(button.dataset.mode === mode[kind]));
  }
  toggle.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-mode]");
    if (!button || !kind || button.dataset.mode === mode[kind]) return;
    mode[kind] = button.dataset.mode as "scheme" | "fills";
    showMode();
    onChange();
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
          schemes.set(major, { kind: "ready", scheme });
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
      if (!k || major === null || mode[k] !== "scheme") return off();
      // A failed load is tried again once another basin has been picked.
      if (major !== lastMajor) for (const [id, s] of schemes) if (s.kind === "error") schemes.delete(id);
      lastMajor = major;
      const s = status(major);
      if (s.kind !== "ready") {
        prepared = null;
        return { status: s.kind === "loading" ? LOADING : s.message };
      }
      prepared = { key: `${major}:${k}:${valueKey}`, kind: k, scheme: s.scheme, value };
      return { status: "" };
    },

    draw(on) {
      slider.hidden = !on || prepared?.kind !== "Q";
      key.toggleAttribute("hidden", !on || !prepared);
      if (!on || !prepared) {
        drawn = "";
        map.setBasinScheme(null);
        return;
      }
      const theme = map.theme;
      const { scheme, value, kind: k } = prepared;
      const mapKey = `${prepared.key}:${input.value}`;
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

      if (k === "Q") {
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
  function drawKey(ref: number, size: (v: number) => number, k: SchemeKind, color: Color, theme: WaterMap["theme"]) {
    const rgb = (c: Color) => `rgb(${c[0]},${c[1]},${c[2]})`;
    const top = nice(ref);
    const label = (x: number, v: number, sign = "") => `<text x="${x}" y="21">${sign}${fmtStop(v, top)}</text>`;
    const width = legend.clientWidth - 24 || 220;
    const step = width / 3;
    if (k === "Q") {
      key.innerHTML = [top / 10, top / 2, top]
        .map((q, i) => {
          const x = i * step;
          return `<line x1="${x + 1}" y1="16" x2="${x + 28}" y2="16" stroke="${rgb(color)}" stroke-width="${size(q)}" stroke-linecap="round"/>` +
            label(x + 34, q);
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
