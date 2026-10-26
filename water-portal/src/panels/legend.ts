/*
 * The map legend of the Basin and Country views: one or more layers at once. Its title
 * is a checklist of the maps (title-menu.ts), and each layer on the map has a section
 * below it. A layer goes in a slot, by how it's drawn (a fill, lines, dots, circles):
 * one layer per slot, and the sections in the slots' order. A section has the layer's
 * title (with more than one layer, and a × to take it off the map), a note, the period
 * and unit (a menu of units where the view has one), and its key:
 *
 * - a colour ramp with ticks, also a menu of how much of the values it spans (ramp-menu.ts);
 * - classes, whose swatches switch them on and off on the map;
 * - sizes: three line widths or circles, labelled with their values.
 *
 * A view can put its own controls in a section (extra: under the note; after: under
 * the key). Expects this markup (see index.html), the sections are added after the title:
 *
 *   <aside class="legend">
 *     <div class="legend-title"><button class="title-menu" …>…</button></div>
 *   </aside>
 *
 * Also the ticks of a colour ramp, for the WaPOR legend and the water balance's (ticksHtml).
 */
import type { WaporStretch } from "../map/layers/wapor";
import { fmtStop, initRampMenu, type RampMenu } from "./ramp-menu";
import { initTitleMenu, type MenuOption } from "./title-menu";

export interface Tick {
  value: number;
  /** Position along the ramp, 0–1. */
  at: number;
}

export type LegendKey =
  /** `fixed`: the range is set (a share): the ramp isn't a menu. */
  | { kind: "ramp"; gradient: string; ticks: Tick[]; fixed?: boolean }
  /** `state`: shown on the map, switched off, or none of the picked places fall in it. */
  | { kind: "classes"; items: { label: string; background: string; state: "on" | "off" | "absent" }[] }
  /** `size`: the line's width or the circle's radius, px; `sign` goes before the value. */
  | { kind: "lines" | "circles"; items: { value: number; size: number; color: string; sign?: string }[] };

export interface LegendLayer {
  slot: string;
  /** Its option in the checklist (the × unchecks it). */
  id: string;
  title: string;
  note: string;
  period: string;
  unit: string;
  /** Whether the unit is a menu. */
  units?: boolean;
  /** Null: no key (no values yet: see status). */
  key: LegendKey | null;
  status?: string;
}

export interface LegendSection {
  el: HTMLElement;
  /** For the view's own controls: under the note, and under the key. */
  extra: HTMLElement;
  after: HTMLElement;
}

export interface LayerLegend {
  section(slot: string): LegendSection;
  /** Show these layers (null: hide the legend). */
  show(layers: LegendLayer[] | null): void;
}

interface Options {
  slots: string[];
  /** The maps, and the ids of those checked. */
  options(): { options: MenuOption[]; current: string[] };
  /** Check or uncheck a map. */
  onToggle(id: string): void;
  /** The ramp's menu (of the fill slot): `of` is what the colours span, "the basins' values". */
  ramp: { of: string; initial: WaporStretch; onPick(cut: WaporStretch): void };
  /** The units' menu, where a layer has `units`. */
  units?: { options(): { options: MenuOption[]; current: string | null }; onPick(id: string): void; title(): string };
  /** A class's swatch clicked. */
  onClass?(slot: string, index: number): void;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One layer per slot, the last of `layers` (the latest checked) in its slot winning, in the slots' order. */
export function onePerSlot<T extends { slot: string }>(layers: T[], slots: string[]): T[] {
  return layers
    .filter((l, i) => !layers.slice(i + 1).some((m) => m.slot === l.slot))
    .sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
}

/** The checklist's ids after `id` is checked or unchecked (the last one can't be). */
export function toggled(ids: string[], id: string): string[] {
  if (!ids.includes(id)) return [...ids, id];
  return ids.length > 1 ? ids.filter((x) => x !== id) : ids;
}

/** How a slot reads in the checklist, to the right of a map. */
export const SLOT_HINTS: Record<string, string> = { fill: "colours", lines: "lines", dots: "dots", circles: "circles" };

/** A round number at or below x (1, 2 or 5 × a power of ten), for a key's sizes. */
export function nice(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= x) ?? p;
}

/** The ticks under a colour ramp, with as many decimals as their range needs. */
export function ticksHtml(ticks: Tick[]) {
  const values = ticks.map((t) => t.value).filter(Number.isFinite);
  const span = values.length ? Math.max(...values) - Math.min(...values) : 0;
  return ticks.map((t) => `<span style="left:${t.at * 100}%">${Number.isFinite(t.value) ? fmtStop(t.value, span) : "–"}</span>`).join("");
}

export function initLayerLegend(aside: HTMLElement, { slots, options, onToggle, ramp, units, onClass }: Options): LayerLegend {
  const menuButton = aside.querySelector<HTMLButtonElement>(".legend-title .title-menu")!;
  const menu = initTitleMenu(menuButton, options, onToggle, { multi: true });

  interface Parts extends LegendSection {
    title: HTMLElement;
    remove: HTMLButtonElement;
    note: HTMLElement;
    periodRow: HTMLElement;
    period: HTMLElement;
    unit: HTMLButtonElement;
    unitMenu: { setLabel(label: string): void };
    ramp: HTMLButtonElement;
    rampMenu: RampMenu | null;
    ticks: HTMLElement;
    classes: HTMLElement;
    sizes: SVGSVGElement;
    status: HTMLElement;
    layer: LegendLayer | null;
  }

  const sections = new Map<string, Parts>();
  let after: Element = aside.querySelector(".legend-title")!;
  for (const slot of slots) {
    const el = document.createElement("section");
    el.className = "legend-layer";
    el.dataset.slot = slot;
    el.hidden = true;
    const id = `${aside.id}-${slot}`;
    el.innerHTML =
      `<div class="legend-layer-head"><span class="legend-layer-title"></span>` +
      `<button type="button" class="legend-remove" title="Take off the map" aria-label="Take off the map">×</button></div>` +
      `<small class="legend-layer-note"></small>` +
      `<div class="legend-extra"></div>` +
      `<div class="legend-period"><span></span><button class="title-menu unit-menu" id="${id}-unit" type="button" ` +
      `aria-haspopup="listbox" aria-expanded="false" aria-label="Unit"><span class="title-menu-label"></span>` +
      `<span class="title-caret" aria-hidden="true"></span></button></div>` +
      `<button class="legend-ramp ramp-menu" id="${id}-ramp" type="button" aria-haspopup="listbox" aria-expanded="false" ` +
      `aria-label="Colour range"><span class="title-menu-label" hidden></span></button>` +
      `<div class="legend-ticks" aria-hidden="true"></div>` +
      `<ul class="cp-classes"></ul>` +
      `<svg class="scheme-key" aria-hidden="true"></svg>` +
      `<div class="legend-after"></div>` +
      `<div class="legend-status" role="status"></div>`;
    after.after(el);
    after = el;
    const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
    const unit = q<HTMLButtonElement>(".unit-menu");
    const rampButton = q<HTMLButtonElement>(".legend-ramp");
    const parts: Parts = {
      el,
      extra: q(".legend-extra"),
      after: q(".legend-after"),
      title: q(".legend-layer-title"),
      remove: q(".legend-remove"),
      note: q(".legend-layer-note"),
      periodRow: q(".legend-period"),
      period: q(".legend-period > span"),
      unit,
      unitMenu: units
        ? initTitleMenu(unit, () => (parts.layer?.units ? units.options() : { options: [], current: null }), units.onPick)
        : { setLabel: (label: string) => void (unit.querySelector(".title-menu-label")!.textContent = label) },
      ramp: rampButton,
      // How much of the values the colours span: a menu on the fill's ramp.
      rampMenu: slot === slots[0] ? initRampMenu(rampButton, ramp.of, ramp.initial, ramp.onPick) : null,
      ticks: q(".legend-ticks"),
      classes: q(".cp-classes"),
      sizes: q<SVGSVGElement>(".scheme-key"),
      status: q(".legend-status"),
      layer: null,
    };
    parts.remove.addEventListener("click", () => parts.layer && onToggle(parts.layer.id));
    // Clicking a class's swatch hides that class on the map, or shows it again.
    parts.classes.addEventListener("click", (e) => {
      const swatch = (e.target as Element).closest<HTMLElement>("[data-class]");
      if (swatch) onClass?.(slot, Number(swatch.dataset.class));
    });
    sections.set(slot, parts);
  }

  function showSection(p: Parts, layer: LegendLayer | null, several: boolean) {
    p.layer = layer;
    p.el.hidden = !layer;
    if (!layer) return;
    p.el.classList.toggle("titled", several);
    p.title.textContent = layer.title;
    p.note.textContent = layer.note;
    p.period.textContent = layer.period;
    p.unitMenu.setLabel(layer.unit);
    // Nothing to pick from: plain text.
    p.unit.disabled = !layer.units;
    p.unit.title = layer.units && units ? units.title() : "";
    const key = layer.key;
    p.periodRow.hidden = !key && !layer.period;
    p.ramp.hidden = p.ticks.hidden = key?.kind !== "ramp";
    p.classes.hidden = key?.kind !== "classes";
    p.sizes.toggleAttribute("hidden", key?.kind !== "lines" && key?.kind !== "circles");
    p.status.textContent = layer.status ?? "";
    if (key?.kind === "ramp") {
      p.rampMenu?.setEnabled(!key.fixed);
      p.ramp.style.background = key.gradient;
      p.ticks.innerHTML = ticksHtml(key.ticks);
    } else if (key?.kind === "classes") {
      p.classes.innerHTML = key.items.map((k, i) => classItem(i, k.label, k.background, k.state)).join("");
    } else if (key) {
      drawSizes(p.sizes, key);
    }
  }

  /** A row whose swatch switches its class on and off on the map. */
  function classItem(index: number, label: string, background: string, state: "on" | "off" | "absent") {
    if (state === "absent") {
      return `<li class="off"><button type="button" class="cp-swatch" disabled title="None of the picked places" ` +
        `style="background:${background}"></button>${esc(label)}</li>`;
    }
    const off = state === "off";
    return `<li${off ? ` class="off"` : ""}><button type="button" class="cp-swatch" data-class="${index}" aria-pressed="${!off}" ` +
      `title="${off ? "Show" : "Hide"} on the map" style="background:${background}"></button>${esc(label)}</li>`;
  }

  /** Three line widths or circles side by side, each labelled with its value. */
  function drawSizes(svg: SVGSVGElement, key: Extract<LegendKey, { kind: "lines" | "circles" }>) {
    const width = aside.clientWidth - 24 || 220;
    const step = width / key.items.length;
    const top = Math.max(...key.items.map((k) => Math.abs(k.value)));
    const biggest = Math.max(...key.items.map((k) => k.size));
    const height = key.kind === "circles" ? Math.max(34, 2 * biggest + 6) : 34;
    const y = height / 2;
    const label = (x: number, v: number, sign = "") => `<text x="${x}" y="${y + 5}">${sign}${fmtStop(v, top)}</text>`;
    svg.innerHTML = key.items
      .map((k, i) => {
        const x = i * step;
        if (key.kind === "lines") {
          return `<line x1="${x + 1}" y1="${y}" x2="${x + 28}" y2="${y}" stroke="${k.color}" stroke-width="${k.size}" stroke-linecap="round"/>` +
            label(x + 34, k.value, k.sign);
        }
        const cx = x + Math.min(biggest, step / 3);
        return `<circle cx="${cx}" cy="${y}" r="${k.size}" fill="${k.color}" class="key-dot"/>` + label(cx + k.size + 5, k.value, k.sign);
      })
      .join("");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
  }

  return {
    section(slot) {
      return sections.get(slot)!;
    },
    show(layers) {
      aside.hidden = !layers?.length;
      if (!layers?.length) return;
      const several = layers.length > 1;
      menu.setLabel(several ? `${layers.length} layers on the map` : layers[0].title);
      for (const [slot, p] of sections) showSection(p, layers.find((l) => l.slot === slot) ?? null, several);
    },
  };
}
