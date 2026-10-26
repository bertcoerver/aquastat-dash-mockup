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
 * Both at once, over another map's fills (the legend's layers, panels/legend.ts).
 * basin-stats.ts asks for it for the maps that allow it (BasinMapSpec.scheme: discharge
 * or storage change per sub-basin), and a switch in each one's legend section goes back
 * to the fills. The legend shows a key to the widths or sizes in place of the colour
 * ramp. Sizes are set per map: the widest line is the basin's largest outflow in the
 * period, a dot of DS_PX the 98th percentile of the sub-basins' |ΔS|.
 */
import type { SchemeArrow, SchemeDot, SchemeLineStyle } from "../map/layers/basin-scheme";
import type { WaterMap } from "../map/map";
import type { SubBasin } from "../map/sub-basin-network";
import type { Color } from "../map/theme";
import { nice, type LayerLegend, type LegendKey } from "../panels/legend";
import { slideSelection } from "../panels/segmented";
import { loadMiddles, loadRivers } from "./rivers";
import { buildScheme, lineQ, simplify, type Scheme } from "./scheme";

export type SchemeKind = "Q" | "dS";
/** The legend's slot of each kind drawn as the scheme. */
export const SCHEME_SLOT: Record<SchemeKind, "lines" | "dots"> = { Q: "lines", dS: "dots" };

/** A map to draw as the scheme: its value per sub-basin, and `key` names those (for the cache). */
export interface SchemeLayer {
  kind: SchemeKind;
  value(id: number): number;
  key: string;
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
   * `major` is drawn as the scheme (true) or as fills.
   */
  isScheme(kind: SchemeKind | undefined, major: number | null): boolean;
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
const rgb = (c: Color) => `rgb(${c[0]},${c[1]},${c[2]})`;

export function initSchemeMap({ map, subBasins, legend, onChange, onHover }: Options): SchemeMap {
  const schemes = new Map<number, Status>();
  const mode: Record<SchemeKind, "scheme" | "fills"> = { Q: "scheme", dS: "scheme" };
  let hover: { subBasin: number; value: number; kind: SchemeKind } | null = null;
  let lastMajor: number | null = null;
  const slider = $("bs-simplify");
  const input = $("bs-simplify-input") as HTMLInputElement;
  /** The basin's scheme last drawn (for the slider). */
  let drawnScheme: Scheme | null = null;

  // --- The switches, one per kind, in their layers' sections --------------------------------
  const toggles = {} as Record<SchemeKind, HTMLElement>;
  for (const kind of ["Q", "dS"] as SchemeKind[]) {
    const [a, aTitle, b, bTitle] = LABELS[kind];
    const toggle = document.createElement("div");
    toggle.className = "wb-vars";
    toggle.setAttribute("role", "radiogroup");
    toggle.setAttribute("aria-label", kind === "Q" ? "Discharge shown" : "Storage change shown");
    toggle.style.margin = "6px 0 2px";
    toggle.hidden = true;
    toggle.innerHTML =
      `<button type="button" role="radio" data-mode="scheme" title="${aTitle}">${a}</button>` +
      `<button type="button" role="radio" data-mode="fills" title="${bTitle}">${b}</button>`;
    slideSelection(toggle);
    toggle.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-mode]");
      if (!button || button.dataset.mode === mode[kind]) return;
      mode[kind] = button.dataset.mode as "scheme" | "fills";
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
          schemes.set(major, { kind: "ready", scheme });
        })
        .catch((err: Error) => schemes.set(major, { kind: "error", message: err.message }))
        .then(() => onChange());
    }
    return s;
  }

  function clear() {
    drawn = "";
    drawnScheme = null;
    slider.hidden = true;
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
      return !!kind && major !== null && mode[kind] === "scheme";
    },

    showSwitches(shown, major) {
      for (const kind of ["Q", "dS"] as SchemeKind[]) {
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
        const message = s.kind === "loading" ? "Loading the rivers…" : s.message;
        for (const l of layers) out.set(l.kind, { status: message, key: null });
        return out;
      }
      const scheme = s.scheme;
      const q = layers.find((l) => l.kind === "Q");
      slider.hidden = !q;
      if (q) legend.section(SCHEME_SLOT.Q).after.append(slider);
      drawnScheme = scheme;
      const mapKey = `${major}:${layers.map((l) => `${l.kind}:${l.key}`).join("|")}:${input.value}`;
      if (mapKey === drawn) return drawnKeys;
      drawn = mapKey;
      showSimplify();

      const theme = map.theme;
      const ids = [...scheme.nodes.keys()];
      const lines: SchemeLineStyle[] = [];
      const arrows: SchemeArrow[] = [];
      let dots: SchemeDot[] = [];

      if (q) {
        const ref = Math.max(0, ...ids.map(q.value).filter(Number.isFinite)) || 1;
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

      const ds = layers.find((l) => l.kind === "dS");
      if (ds) {
        const values = ids.map(ds.value).filter(Number.isFinite);
        const ref = quantile(values.map(Math.abs), 0.98) || 1;
        const radius = (v: number) => Math.min(DS_MAX_PX, Math.max(DS_MIN_PX, Math.sqrt(Math.abs(v) / ref) * DS_PX));
        dots = ids
          .map((id) => ({ id, v: ds.value(id) }))
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
        const top = nice(ref);
        const items = ([[top / 4, theme.storageRise, "+"], [top, theme.storageRise, "+"], [top, theme.storageFall, "−"]] as const)
          .map(([v, c, sign]) => ({ value: v, size: radius(v), color: rgb(c), sign }));
        out.set("dS", { status: "", key: { kind: "circles", items } });
      }

      // The tooltip's: a dot (as given by the map: its sub-basin and value) or a line.
      const isDot = (item: { subBasin: number; value: number }) => dots.some((d) => d.subBasin === item.subBasin && d.value === item.value);
      map.setBasinScheme({
        key: mapKey,
        color: theme.scheme,
        casing: theme.schemeCasing,
        lines,
        arrows,
        dots,
        subBasins: new Set(q ? ids : []),
        onHover(item) {
          const next = item && { ...item, kind: (isDot(item) ? "dS" : "Q") as SchemeKind };
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
  };
}

/** The p-th quantile (0–1) of the values. */
function quantile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] : NaN;
}
