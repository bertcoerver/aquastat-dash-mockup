/*
 * The map legend of the Basin and Country views: one or more layers at once. Its title
 * is a checklist of the maps (title-menu.ts), and each layer on the map has a section
 * below it. A layer goes in a slot, by how it's drawn (a fill, lines, circles, bars):
 * one layer per slot, and the sections in the slots' order. A section has the layer's
 * title (with more than one layer, and a × to take it off the map), a note, the period
 * and unit (a menu of units where the view has one), and its key:
 *
 * - a colour ramp with ticks, also a menu of how much of the values it spans (ramp-menu.ts);
 * - classes, whose swatches switch them on and off on the map;
 * - sizes: three line widths, circles or bars, labelled with their values.
 *
 * Circles and bars have a key of sizes too, under their colours' (if any), which is a
 * menu of how they look (shape-style.ts).
 *
 * A view can put its own controls in a section (extra: under the note; after: under
 * the key). A padlock in the title locks the ranges: each map keeps the colour range or
 * sizes it has (hold), so other periods and places compare; the view draws it again. Expects this markup (see index.html), the sections are added after the title:
 *
 *   <aside class="legend">
 *     <div class="legend-title"><button class="title-menu" …>…</button></div>
 *   </aside>
 *
 * Also the ticks of a colour ramp, for the WaPOR legend and the water balance's (ticksHtml),
 * and the padlock, for the WaPOR legend's (initLock).
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
  | { kind: "lines" | "circles" | "bars"; items: SizeItem[] };

/** A size in a key: `size` is the line's width, the circle's radius or the bar's height, px; `sign` goes before the value. */
export interface SizeItem {
  value: number;
  size: number;
  color: string;
  sign?: string;
}

/** Circles' or bars' sizes (shape-style.ts). */
export type SizesKey = { kind: "circles" | "bars"; items: SizeItem[] };

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
  /** Circles' or bars' sizes, under the key (a menu, with Options.sizes). */
  sizes?: SizesKey | null;
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
  /**
   * A map's range (its colours' domain, the value of its biggest size): `range` as it
   * is, or with the lock on, the one first given for `key` (the map, and its unit) since.
   */
  hold<T>(key: string, range: T): T;
  /** Changes as the lock is switched (for the map's cache keys). */
  lockKey(): number;
  /** Lock the ranges as they are, as the padlock does (if not locked yet). */
  lock(): void;
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
  /** The menu on the circles' and bars' sizes (shape-style.ts), of the map in `slot`, and its title. */
  sizes?: { options(slot: string): { options: MenuOption[]; current: string[] }; onPick(slot: string, id: string): void; title(slot: string): string };
  /** A class's swatch clicked. */
  onClass?(slot: string, index: number): void;
  /** The lock switched: draw the maps again. */
  onLock(): void;
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
export const SLOT_HINTS: Record<string, string> = { fill: "colours", lines: "lines", circles: "circles", bars: "3D bars", rain: "rain", vapour: "vapour" };

/** A round number at or below x (1, 2 or 5 × a power of ten), for a key's sizes. */
export function nice(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= x) ?? p;
}

const LOCK_SVG =
  `<svg viewBox="0 0 12 14" width="12" height="14" aria-hidden="true"><path class="lock-shackle" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5"/><rect x="1" y="6.5" width="10" height="7" rx="1.5" fill="currentColor"/></svg>`;

/** A padlock at the end of a legend's title; `onToggle` runs when it's clicked, with whether it's now locked. */
export function initLock(aside: HTMLElement, onToggle: (locked: boolean) => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "legend-lock";
  button.innerHTML = LOCK_SVG;
  aside.querySelector(".legend-title")!.append(button);
  let locked = false;
  function set(on: boolean) {
    locked = on;
    button.setAttribute("aria-pressed", String(on));
    // Open: the shackle raised, its right leg out of the body.
    button.querySelector(".lock-shackle")!.setAttribute("d", on ? "M3.5 6.5V4a2.5 2.5 0 0 1 5 0v2.5" : "M3.5 6.5V2.5a2.5 2.5 0 0 1 5 0V3.5");
    const what = "the colour ranges and sizes";
    button.title = on ? `Unlock ${what}: fit them to the values again` : `Lock ${what} as they are, so other periods and places compare`;
    button.setAttribute("aria-label", on ? "Unlock the ranges" : "Lock the ranges");
  }
  set(false);
  button.addEventListener("click", () => {
    set(!locked);
    onToggle(locked);
  });
  return {
    get locked() {
      return locked;
    },
    set,
  };
}

/** The ticks under a colour ramp, with as many decimals as their range needs. */
export function ticksHtml(ticks: Tick[]) {
  const values = ticks.map((t) => t.value).filter(Number.isFinite);
  const span = values.length ? Math.max(...values) - Math.min(...values) : 0;
  return ticks.map((t) => `<span style="left:${t.at * 100}%">${Number.isFinite(t.value) ? fmtStop(t.value, span) : "–"}</span>`).join("");
}

export function initLayerLegend(aside: HTMLElement, { slots, options, onToggle, ramp, units, sizes, onClass, onLock }: Options): LayerLegend {
  const menuButton = aside.querySelector<HTMLButtonElement>(".legend-title .title-menu")!;
  const menu = initTitleMenu(menuButton, options, onToggle, { multi: true });
  // The ranges held while locked, by map and unit (null: unlocked).
  let held: Map<string, unknown> | null = null;
  let lockKey = 0;
  const onToggleLock = (locked: boolean) => {
    held = locked ? new Map() : null;
    lockKey++;
    onLock();
  };
  const padlock = initLock(aside, onToggleLock);

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
    shapeSizes: HTMLButtonElement;
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
      `<button class="legend-sizes ramp-menu" id="${id}-sizes" type="button" aria-haspopup="listbox" aria-expanded="false" ` +
      `aria-label="How the circles or bars look"><svg class="scheme-key" aria-hidden="true"></svg><span class="title-menu-label" hidden></span></button>` +
      `<div class="legend-after"></div>` +
      `<div class="legend-status" role="status"></div>`;
    after.after(el);
    after = el;
    const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
    const unit = q<HTMLButtonElement>(".unit-menu");
    const rampButton = q<HTMLButtonElement>(".legend-ramp");
    const sizesButton = q<HTMLButtonElement>(".legend-sizes");
    if (sizes) initTitleMenu(sizesButton, () => sizes.options(slot), (option) => sizes.onPick(slot, option));
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
      sizes: q<SVGSVGElement>(":scope > .scheme-key"),
      shapeSizes: sizesButton,
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
    p.sizes.toggleAttribute("hidden", key?.kind !== "lines" && key?.kind !== "circles" && key?.kind !== "bars");
    p.shapeSizes.hidden = !layer.sizes;
    if (layer.sizes) {
      drawSizes(p.shapeSizes.querySelector("svg")!, layer.sizes);
      p.shapeSizes.disabled = !sizes;
      p.shapeSizes.title = sizes?.title(p.el.dataset.slot!) ?? "";
    }
    p.status.textContent = layer.status ?? "";
    if (key?.kind === "ramp") {
      // Locked, there's nothing to pick either.
      p.rampMenu?.setEnabled(!key.fixed && !held);
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

  /** Three line widths, circles or bars side by side, each labelled with its value. */
  function drawSizes(svg: SVGSVGElement, key: Extract<LegendKey, { kind: "lines" | "circles" | "bars" }>) {
    const width = aside.clientWidth - 24 || 220;
    const step = width / key.items.length;
    const top = Math.max(...key.items.map((k) => Math.abs(k.value)));
    const biggest = Math.max(...key.items.map((k) => k.size));
    const height = key.kind === "circles" ? Math.max(34, 2 * biggest + 6) : key.kind === "bars" ? Math.max(34, biggest + 6) : 34;
    // (Bars stand on the bottom, labelled at their middle.)
    const y = key.kind === "bars" ? height - 3 - biggest / 2 : height / 2;
    const label = (x: number, v: number, sign = "") => `<text x="${x}" y="${y + 5}">${sign}${fmtStop(v, top)}</text>`;
    svg.innerHTML = key.items
      .map((k, i) => {
        const x = i * step;
        if (key.kind === "lines") {
          return `<line x1="${x + 1}" y1="${y}" x2="${x + 28}" y2="${y}" stroke="${k.color}" stroke-width="${k.size}" stroke-linecap="round"/>` +
            label(x + 34, k.value, k.sign);
        }
        if (key.kind === "bars") {
          return `<rect x="${x + 1}" y="${height - 3 - k.size}" width="9" height="${k.size}" rx="1" fill="${k.color}"/>` + label(x + 16, k.value, k.sign);
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
    hold(key, range) {
      if (!held) return range;
      if (!held.has(key)) held.set(key, range);
      return held.get(key) as typeof range;
    },
    lockKey: () => lockKey,
    lock() {
      if (padlock.locked) return;
      padlock.set(true);
      onToggleLock(true);
    },
  };
}
