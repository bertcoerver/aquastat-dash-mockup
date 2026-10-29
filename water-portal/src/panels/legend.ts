/*
 * The map legend of the Basin, Country and Local views: one or more layers at once. Its title
 * is a checklist of the maps (title-menu.ts), then the period (the same for all the
 * layers), and each layer on the map has a section below it. A layer goes in a slot, by how it's drawn (a fill, lines, circles, bars):
 * one layer per slot. A section has the layer's title (with a × to take it off the map:
 * the last one too, leaving the map empty), the attribute it shows (a vector map's: a
 * menu of its others, local/local-maps.ts), a note, and its key, with the unit to its
 * right (a menu of units where the view has one):
 *
 * - a colour ramp with ticks, also a menu of how much of the values it spans (ramp-menu.ts);
 * - classes, whose swatches switch them on and off on the map;
 * - sizes: three line widths, circles or bars, labelled with their values.
 *
 * Circles and bars have a key of sizes, in their colours (under their classes', if
 * any), which is a menu of how they look (shape-style.ts).
 *
 * The checklist has, to the right of each map, the icons of how it can be drawn (its
 * slot: shape-switch.ts); a click on one switches it, or adds it in that shape.
 *
 * The sections are in the order the maps are drawn, the top one on top (onOrder): a new
 * map goes on top, and a section's title drags it up or down, as do its arrows. The
 * colours stay at the bottom, as they are the land itself.
 *
 * A view can put its own controls in a section (extra: under the note; after: under
 * the key). While a range plays the ranges are locked (all of them at once): each map
 * keeps the colour range or sizes it has (hold), so the frames compare; the view draws
 * it again. Expects this markup (see index.html), the
 * period and sections are added after the title:
 *
 *   <aside class="legend">
 *     <div class="legend-title"><button class="title-menu" …>…</button></div>
 *   </aside>
 *
 * Also the ticks of a colour ramp, for the WaPOR legend and the water balance's (ticksHtml).
 */
import { drag } from "../lib/drag";
import type { WaporStretch } from "../map/layers/wapor";
import { fmtStop, initRampMenu, type RampMenu } from "./ramp-menu";
import { initTitleMenu, type MenuOption } from "./title-menu";
import { esc } from "../lib/html";

export interface Tick {
  value: number;
  /** Position along the ramp, 0–1. */
  at: number;
}

export type LegendKey =
  /** `fixed`: the range is set (a share): the ramp isn't a menu. `format`: the ticks' labels (else as fmtStop). */
  | { kind: "ramp"; gradient: string; ticks: Tick[]; fixed?: boolean; format?: (value: number) => string }
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
  /** The attribute it shows, under the title (a menu, with Options.attributes); none: no row. */
  attribute?: string;
  note: string;
  /** Shown once, above the sections (the first layer's that has one): "" while it has no key. */
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
  /** Show these layers (none: only the checklist; null: hide the legend). */
  show(layers: LegendLayer[] | null): void;
  /**
   * A map's range (its colours' domain, the value of its biggest size): `range` as it
   * is, or with the lock on, the one first given for `key` (the map, and its unit) since.
   */
  hold<T>(key: string, range: T): T;
  /** Changes as the lock is switched (for the map's cache keys). */
  lockKey(): number;
  /** Lock the ranges as they are (if not locked yet). */
  lock(): void;
  /** Let the ranges fit the values again (if locked). */
  unlock(): void;
  /**
   * A key of what the map shows for now in place of the colours (the colours' section
   * hidden meanwhile; the legend shown even if hidden); null: the maps' again.
   */
  overlay(key: OverlayKey | null): void;
}

/** A key shown for now (overlay): swatches, each with its label (`absent`: struck out, as a class none of the places fall in). */
export interface OverlayKey {
  title: string;
  note: string;
  items: { label: string; background: string; absent?: boolean }[];
}

interface Options {
  slots: string[];
  /** The maps, and the ids of those checked. */
  options(): { options: MenuOption[]; current: string[] };
  /** Check or uncheck a map. */
  onToggle(id: string): void;
  /** The slots on the map, top first: the order to draw them in. */
  onOrder?(slots: string[]): void;
  /** One of a map's icons picked: draw it so (adding it if it isn't on the map). */
  onShape?(id: string, shape: string): void;
  /** The ramp's menu (of the fill slot): `of` is what the colours span, "the basins' values". */
  ramp: { of: string; initial: WaporStretch; onPick(cut: WaporStretch): void };
  /** The attributes' menu of the map in `slot`, where its layer has an `attribute`. */
  attributes?: { options(slot: string): { options: MenuOption[]; current: string | null }; onPick(slot: string, id: string): void; title(slot: string): string };
  /** The units' menu of the map in `slot`, where its layer has `units`. */
  units?: { options(slot: string): { options: MenuOption[]; current: string | null }; onPick(slot: string, id: string): void; title(slot: string): string };
  /** The menu on the circles' and bars' sizes (shape-style.ts), of the map in `slot`, and its title. */
  sizes?: { options(slot: string): { options: MenuOption[]; current: string[] }; onPick(slot: string, id: string): void; title(slot: string): string };
  /** A class's swatch clicked. */
  onClass?(slot: string, index: number): void;
  /** The lock switched: draw the maps again. */
  onLock(): void;
}

/** A chevron up (the down one is turned in legend.css). */
const ARROW_SVG =
  `<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 6.5L5 3.5L8 6.5" fill="none" ` +
  `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;


/** One layer per slot, the last of `layers` (the latest checked) in its slot winning, in the slots' order. */
export function onePerSlot<T extends { slot: string }>(layers: T[], slots: string[]): T[] {
  return layers
    .filter((l, i) => !layers.slice(i + 1).some((m) => m.slot === l.slot))
    .sort((a, b) => slots.indexOf(a.slot) - slots.indexOf(b.slot));
}

/** The checklist's ids after `id` is checked or unchecked. */
export function toggled(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** A round number at or below x (1, 2 or 5 × a power of ten), for a key's sizes. */
export function nice(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [5, 2, 1].map((m) => m * p).find((v) => v <= x) ?? p;
}

/** The ticks under a colour ramp, with as many decimals as their range needs. */
export function ticksHtml(ticks: Tick[], format?: (value: number) => string) {
  const values = ticks.map((t) => t.value).filter(Number.isFinite);
  const span = values.length ? Math.max(...values) - Math.min(...values) : 0;
  const label = format ?? ((v: number) => fmtStop(v, span));
  return ticks.map((t) => `<span style="left:${t.at * 100}%">${Number.isFinite(t.value) ? esc(label(t.value)) : "–"}</span>`).join("");
}

export function initLayerLegend(aside: HTMLElement, { slots, options, onToggle, onShape, onOrder, ramp, attributes, units, sizes, onClass, onLock }: Options): LayerLegend {
  const menuButton = aside.querySelector<HTMLButtonElement>(".legend-title .title-menu")!;
  const menu = initTitleMenu(menuButton, options, onToggle, { multi: true, onIcon: onShape });
  const titleRow = aside.querySelector<HTMLElement>(".legend-title")!;
  // The period of all the layers, between the checklist and the sections.
  const periodRow = document.createElement("div");
  periodRow.className = "legend-period legend-range";
  periodRow.hidden = true;
  titleRow.after(periodRow);
  // The ranges held while locked, by map and unit (null: unlocked).
  let held: Map<string, unknown> | null = null;
  let lockKey = 0;
  function setLock(on: boolean) {
    held = on ? new Map() : null;
    lockKey++;
    onLock();
  }

  interface Parts extends LegendSection {
    title: HTMLElement;
    remove: HTMLButtonElement;
    attributeRow: HTMLElement;
    attribute: HTMLButtonElement;
    attributeMenu: { setLabel(label: string): void } | null;
    note: HTMLElement;
    unit: HTMLButtonElement;
    unitMenu: { setLabel(label: string): void };
    key: HTMLElement;
    ramp: HTMLButtonElement;
    rampMenu: RampMenu | null;
    ticks: HTMLElement;
    classes: HTMLElement;
    sizes: SVGSVGElement;
    shapeSizes: HTMLButtonElement;
    status: HTMLElement;
    layer: LegendLayer | null;
    /** What the key shows, as last written (drawn again at every frame while playing). */
    keyShown: string;
  }

  // The overlay's section: on top, without a × or arrows (it isn't a map to take off or move).
  const overlayEl = document.createElement("section");
  overlayEl.className = "legend-layer legend-overlay";
  overlayEl.hidden = true;
  overlayEl.innerHTML =
    `<div class="legend-layer-head"><span class="legend-layer-title"></span></div>` +
    `<small class="legend-layer-note"></small><ul class="cp-classes"></ul>`;
  periodRow.after(overlayEl);
  let overlaid: OverlayKey | null = null;
  let shown: LegendLayer[] | null = null; // (as last given to show)
  /** The legend shown with maps or an overlay; with the overlay alone, without the checklist. */
  function frame() {
    aside.hidden = !shown && !overlaid;
    titleRow.hidden = !shown;
  }

  const sections = new Map<string, Parts>();
  let after: Element = overlayEl;
  for (const slot of slots) {
    const el = document.createElement("section");
    el.className = "legend-layer";
    el.dataset.slot = slot;
    el.hidden = true;
    const id = `${aside.id}-${slot}`;
    el.innerHTML =
      `<div class="legend-layer-head"><span class="legend-layer-title"></span><span class="legend-layer-actions">` +
      `<button type="button" class="legend-move" data-by="-1" title="Draw above the map over it" aria-label="Move up">${ARROW_SVG}</button>` +
      `<button type="button" class="legend-move" data-by="1" title="Draw under the map below it" aria-label="Move down">${ARROW_SVG}</button>` +
      `<button type="button" class="legend-remove" title="Take off the map" aria-label="Take off the map">×</button></span></div>` +
      `<div class="legend-attribute" hidden><button class="title-menu" id="${id}-attribute" type="button" aria-haspopup="listbox" ` +
      `aria-expanded="false" aria-label="Attribute shown"><span class="title-menu-label"></span><span class="title-caret" aria-hidden="true"></span></button></div>` +
      `<small class="legend-layer-note"></small>` +
      `<div class="legend-extra"></div>` +
      `<div class="legend-key"><div class="legend-key-body">` +
      `<button class="legend-ramp ramp-menu" id="${id}-ramp" type="button" aria-haspopup="listbox" aria-expanded="false" ` +
      `aria-label="Colour range"><span class="title-menu-label" hidden></span></button>` +
      `<div class="legend-ticks" aria-hidden="true"></div>` +
      `<ul class="cp-classes"></ul>` +
      `<svg class="scheme-key" aria-hidden="true"></svg>` +
      `<button class="legend-sizes ramp-menu" id="${id}-sizes" type="button" aria-haspopup="listbox" aria-expanded="false" ` +
      `aria-label="How the circles or bars look"><svg class="scheme-key" aria-hidden="true"></svg><span class="title-menu-label" hidden></span></button>` +
      `</div><div class="legend-period legend-unit"><button class="title-menu unit-menu" id="${id}-unit" type="button" ` +
      `aria-haspopup="listbox" aria-expanded="false" aria-label="Unit"><span class="title-menu-label"></span>` +
      `<span class="title-caret" aria-hidden="true"></span></button></div></div>` +
      `<div class="legend-after"></div>` +
      `<div class="legend-status" role="status"></div>`;
    after.after(el);
    after = el;
    const q = <T extends Element>(selector: string) => el.querySelector<T>(selector)!;
    const unit = q<HTMLButtonElement>(".unit-menu");
    const rampButton = q<HTMLButtonElement>(".legend-ramp");
    const sizesButton = q<HTMLButtonElement>(".legend-sizes");
    const attribute = q<HTMLButtonElement>(".legend-attribute .title-menu");
    if (sizes) initTitleMenu(sizesButton, () => sizes.options(slot), (option) => sizes.onPick(slot, option));
    const parts: Parts = {
      el,
      extra: q(".legend-extra"),
      after: q(".legend-after"),
      title: q(".legend-layer-title"),
      remove: q(".legend-remove"),
      attributeRow: q(".legend-attribute"),
      attribute,
      attributeMenu: attributes ? initTitleMenu(attribute, () => attributes.options(slot), (id) => attributes.onPick(slot, id)) : null,
      note: q(".legend-layer-note"),
      unit,
      unitMenu: units
        ? initTitleMenu(unit, () => (parts.layer?.units ? units.options(slot) : { options: [], current: null }), (id) => units.onPick(slot, id))
        : { setLabel: (label: string) => void (unit.querySelector(".title-menu-label")!.textContent = label) },
      key: q(".legend-key"),
      ramp: rampButton,
      // How much of the values the colours span: a menu on the fill's ramp.
      rampMenu: slot === slots[0] ? initRampMenu(rampButton, ramp.of, ramp.initial, ramp.onPick) : null,
      ticks: q(".legend-ticks"),
      classes: q(".cp-classes"),
      sizes: q<SVGSVGElement>(".legend-key-body > .scheme-key"),
      shapeSizes: sizesButton,
      status: q(".legend-status"),
      layer: null,
      keyShown: "",
    };
    parts.remove.addEventListener("click", () => parts.layer && onToggle(parts.layer.id));
    for (const button of el.querySelectorAll<HTMLButtonElement>(".legend-move")) {
      button.addEventListener("click", () => moveBy(parts, Number(button.dataset.by)));
    }
    q<HTMLElement>(".legend-layer-head").addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !el.classList.contains("draggable") || (e.target as Element).closest("button")) return;
      e.preventDefault(); // no text selection
      startDrag(parts, e);
    });
    // Clicking a class's swatch hides that class on the map, or shows it again.
    parts.classes.addEventListener("click", (e) => {
      const swatch = (e.target as Element).closest<HTMLElement>("[data-class]");
      if (swatch) onClass?.(slot, Number(swatch.dataset.class));
    });
    sections.set(slot, parts);
  }

  // The sections in the order the maps are drawn, top first, not by slot: a map switched
  // to another shape keeps its place, one that takes another's slot takes its place, a
  // new one goes on top, and the colours at the bottom.
  let order: string[] = [];
  let lastIn = new Map<string, string>(); // (slot → the map last in it)
  let drawn = ""; // (the slots' order last given to onOrder)
  const fill = slots[0];
  function arrange(layers: LegendLayer[]) {
    const ids = layers.map((l) => l.id);
    for (const l of layers) {
      if (order.includes(l.id)) continue;
      const was = lastIn.get(l.slot);
      const at = was && !ids.includes(was) ? order.indexOf(was) : -1;
      if (at >= 0) order[at] = l.id;
      else order.unshift(l.id);
    }
    const slotOf = (id: string) => layers.find((l) => l.id === id)?.slot;
    order = order.filter((id) => ids.includes(id)).sort((a, b) => Number(slotOf(a) === fill) - Number(slotOf(b) === fill));
    lastIn = new Map(layers.map((l) => [l.slot, l.id]));
    place(order.map((id) => sections.get(slotOf(id)!)!));
  }
  /** Put the sections in this order (only when out of it: moving a section ends a drag or a slide in it), and draw them so. */
  function place(parts: Parts[]) {
    parts.forEach((p, i) => p.el.classList.toggle("below", i > 0));
    const movable = parts.filter((q) => q.el.dataset.slot !== fill);
    for (const p of parts) {
      const at = movable.indexOf(p);
      p.el.classList.toggle("draggable", at >= 0 && movable.length > 1);
      const [up, down] = p.el.querySelectorAll<HTMLButtonElement>(".legend-move");
      up.disabled = at <= 0;
      down.disabled = at < 0 || at === movable.length - 1;
    }
    const now = [...sections.values()].filter((p) => parts.includes(p));
    now.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (!now.every((p, i) => p === parts[i])) {
      let after: Element = overlayEl;
      for (const p of parts) {
        after.after(p.el);
        after = p.el;
      }
    }
    const slotsNow = parts.map((p) => p.el.dataset.slot!);
    if (slotsNow.join() !== drawn) {
      drawn = slotsNow.join();
      onOrder?.(slotsNow);
    }
  }

  /** Move a section up (-1) or down (1) a place, above the colours'. */
  function moveBy(p: Parts, by: number) {
    const parts = order.map((id) => [...sections.values()].find((q) => q.layer?.id === id)!);
    const at = parts.indexOf(p);
    const to = at + by;
    if (at < 0 || to < 0 || to >= parts.length || parts[to].el.dataset.slot === fill) return;
    [parts[at], parts[to]] = [parts[to], parts[at]];
    order = parts.map((q) => q.layer!.id);
    place(parts);
    // (The focus stays on the arrow, or goes to the other one where it's now disabled.)
    const button = p.el.querySelector<HTMLButtonElement>(`.legend-move[data-by="${by}"]`)!;
    (button.disabled ? p.el.querySelector<HTMLButtonElement>(`.legend-move[data-by="${-by}"]`)! : button).focus();
  }

  // Dragging a section by its title: it follows the pointer, and the others make way as
  // it passes their middles (the colours' stays at the bottom).
  function startDrag(p: Parts, e: PointerEvent) {
    const startY = e.clientY;
    const grab = e.clientY - p.el.getBoundingClientRect().top;
    let dragging = false;
    const shown = () => order.map((id) => [...sections.values()].find((q) => q.layer?.id === id)!);
    // (On the window, not captured: the section moving in the page would lose the capture.)
    drag(window, e, move, () => {
      p.el.classList.remove("dragging");
      p.el.style.transform = "";
    });
    function move(ev: PointerEvent) {
      if (!dragging && Math.abs(ev.clientY - startY) < 4) return;
      dragging = true;
      p.el.classList.add("dragging");
      const others = shown().filter((q) => q !== p && q.el.dataset.slot !== fill);
      const at = others.filter((q) => {
        const r = q.el.getBoundingClientRect();
        return r.top + r.height / 2 < ev.clientY;
      }).length;
      const parts = [...others];
      parts.splice(at, 0, p);
      const bottom = shown().find((q) => q.el.dataset.slot === fill);
      if (bottom) parts.push(bottom);
      p.el.style.transform = "";
      const next = parts.map((q) => q.layer!.id);
      if (next.join() !== order.join()) {
        order = next;
        place(parts);
      }
      p.el.style.transform = `translateY(${ev.clientY - grab - p.el.getBoundingClientRect().top}px)`;
    }
  }

  function showSection(p: Parts, layer: LegendLayer | null) {
    p.layer = layer;
    p.el.hidden = !layer || (!!overlaid && p.el.dataset.slot === fill);
    if (!layer) return;
    p.title.textContent = layer.title;
    p.attributeRow.hidden = layer.attribute === undefined;
    if (layer.attribute !== undefined) {
      p.attributeMenu?.setLabel(layer.attribute);
      p.attribute.title = attributes?.title(p.el.dataset.slot!) ?? "";
    }
    p.note.textContent = layer.note;
    p.unitMenu.setLabel(layer.unit);
    // Nothing to pick from: plain text.
    p.unit.disabled = !layer.units;
    p.unit.title = layer.units && units ? units.title(p.el.dataset.slot!) : "";
    const key = layer.key;
    p.key.hidden = !key && !layer.sizes;
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
      const ticks = ticksHtml(key.ticks, key.format);
      if (ticks !== p.keyShown) p.ticks.innerHTML = p.keyShown = ticks;
    } else if (key?.kind === "classes") {
      const classes = key.items.map((k, i) => classItem(i, k.label, k.background, k.state)).join("");
      if (classes !== p.keyShown) p.classes.innerHTML = p.keyShown = classes;
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
  const sizesShown = new WeakMap<SVGSVGElement, string>(); // (as last drawn: drawn again at every frame while playing)
  function drawSizes(svg: SVGSVGElement, key: Extract<LegendKey, { kind: "lines" | "circles" | "bars" }>) {
    // (The key's width, beside the unit.)
    const width = svg.closest(".legend-key-body")!.clientWidth || 220;
    const shown = `${width}:${JSON.stringify(key)}`;
    if (shown === sizesShown.get(svg)) return;
    sizesShown.set(svg, shown);
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
      shown = layers;
      frame();
      if (!layers) {
        // (Under the overlay: only the checklist.)
        for (const p of sections.values()) showSection(p, null);
        periodRow.hidden = true;
        return;
      }
      menu.setLabel(layers.length > 1 ? `${layers.length} layers on the map` : layers.length ? "1 layer on the map" : "No layers on the map");
      const period = layers.find((l) => l.period)?.period ?? "";
      periodRow.textContent = period;
      periodRow.hidden = !period;
      for (const [slot, p] of sections) showSection(p, layers.find((l) => l.slot === slot) ?? null);
      arrange(layers);
    },
    hold(key, range) {
      if (!held) return range;
      if (!held.has(key)) held.set(key, range);
      return held.get(key) as typeof range;
    },
    lockKey: () => lockKey,
    lock() {
      if (!held) setLock(true);
    },
    unlock() {
      if (held) setLock(false);
    },
    overlay(key) {
      if (JSON.stringify(key) === JSON.stringify(overlaid)) return;
      overlaid = key;
      overlayEl.hidden = !key;
      if (key) {
        overlayEl.querySelector(".legend-layer-title")!.textContent = key.title;
        overlayEl.querySelector(".legend-layer-note")!.textContent = key.note;
        overlayEl.querySelector(".cp-classes")!.innerHTML = key.items
          .map((k) => `<li${k.absent ? ` class="off"` : ""}><span class="cp-swatch" style="background:${k.background}"></span>${esc(k.label)}</li>`)
          .join("");
      }
      frame();
      const p = sections.get(fill)!;
      showSection(p, p.layer);
    },
  };
}
