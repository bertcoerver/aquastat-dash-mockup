/*
 * The map's tooltips in every view, styled as the legend (legend.css): a box as high as
 * the date range, with one header (the place, or the raster; where it is or comes from)
 * and a tile per map: its value and unit, a band of its colour there, and its name.
 *
 * At first the tooltip is pinned: the box is fixed right of the date range, whichever
 * view's tooltip it shows (the range hidden, no map with time: in its place, centred). With nothing under the pointer it stays, just wide enough for
 * the key in its corner: P, which is also a button there. It releases the tooltip, and
 * each view's tooltip follows the pointer again, the same box, with the key: P pins it
 * back (and releases it too). And in the pinned box's place there's a zone, as big as
 * the empty box: moving the pointer onto it pins the tooltip there, with what it last
 * showed (once the pointer has been elsewhere: released with the box's key, it's on the
 * zone already). The empty box and the zone look the same, a dashed outline with the
 * key; a second after it shows it fades away, and back while the pointer is near it.
 *
 * The pinned box glides to its new width, and its content fades in when it gets some;
 * not with less motion asked for (legend.css too).
 */

import { PIN } from "../country/charts";

export interface MapTipRow {
  /** Its colour there, as CSS (a colour or a gradient); null: drawn without one (no swatch). */
  color: string | null;
  value: string;
  unit: string;
  /** The map's name (none: the title says it). */
  label?: string;
}

export interface MapTip {
  title: string;
  /** Under the title, small and in capitals as the legend's source line. */
  source?: string;
  rows: MapTipRow[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One header, and a tile per map. */
function html({ title, source, rows }: MapTip) {
  const tile = ({ color, value, unit, label }: MapTipRow) =>
    `<div class="mt-sq"${label ? ` title="${esc(label)}"` : ""}>` +
    `<div class="mt-sq-value">${esc(value)} <span class="mt-unit">${esc(unit)}</span></div>` +
    `<span class="mt-sq-band${color ? "" : " mt-none"}"${color ? ` style="background: ${esc(color)}"` : ""}></span>` +
    `<div class="mt-sq-label">${esc(label ?? "")}</div></div>`;
  return (
    `<div class="mt-sq-head" title="${esc([title, source].filter(Boolean).join(" · "))}"><span class="mt-sq-title">${esc(title)}</span>` +
    (source ? `<small class="mt-source">${esc(source)}</small>` : "") +
    `</div><div class="mt-squares">${rows.map(tile).join("")}</div>`
  );
}

const DOCK_KEY = "map-tip-docked";
let docked = true;
try {
  docked = localStorage.getItem(DOCK_KEY) !== "0";
} catch {
  // (No storage: pinned, as at first.)
}
/** The pinned box, and the view's tooltip it shows (null: none). */
let dock: { box: HTMLElement; body: HTMLElement; zone: HTMLElement; pane: HTMLElement } | null = null;
let owner: HTMLElement | null = null;
/**
 * The pointer is on the pinned box (not on the map): it keeps what it shows, as the map
 * says it has nothing under the pointer a frame late.
 */
let overDock = false;
/** Whether the pinned box shows a tooltip (to fade its content in when it gets one). */
let dockFull = false;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
/** Released: the tooltip shown (to pin it as it is); null: none. */
let following: { el: HTMLElement; tip: MapTip } | null = null;
/** Released: the last tooltip shown, hidden since or not (leaving the map for the zone hides it). */
let lastFollowing: { el: HTMLElement; tip: MapTip } | null = null;
const PIN_KEY = "p";
/** The pin in the corner (P pins and releases it too): pinned, a button that releases it. */
const KEY = `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="${PIN}"/></svg>`;
const FOLLOW_KEY = `<span class="mt-key" title="Press P to pin the tooltip">${KEY}</span>`;

/**
 * Show a view's tooltip (tiles for more than one map): pinned, in the box by the date
 * range; else in `el` (a .wb-tooltip, placed by its view). Null (or no rows)
 * hides it; pinned, the box empties instead (just its button), if it showed this view's.
 */
export function showMapTip(el: HTMLElement, tip: MapTip | null) {
  const has = !!tip?.rows.length;
  if (!dock || !docked) {
    if (has) {
      el.classList.add("map-tip");
      el.innerHTML = html(tip!) + (dock ? FOLLOW_KEY : "");
    }
    el.hidden = !has;
    following = has ? { el, tip: tip! } : following?.el === el ? null : following;
    if (has) lastFollowing = following;
    return;
  }
  el.hidden = true;
  if (!has && ((owner !== el && owner !== null) || overDock)) return;
  owner = has ? el : null;
  setDock(has ? html(tip!) : null);
}

/** Fill the pinned box (null: empty it), gliding from its width to the new one. */
function setDock(content: string | null) {
  if (!dock) return;
  const wasFull = dockFull;
  const { box, body } = dock;
  const animate = !reduceMotion.matches && !box.hidden;
  const from = animate ? box.getBoundingClientRect().width : 0;
  box.classList.toggle("mt-empty", content === null);
  body.innerHTML = content ?? "";
  outlineRect = null;
  if (content !== null && !dockFull && animate) {
    // (Restarted: off, a reflow, on.)
    body.classList.remove("mt-enter");
    void body.offsetWidth;
    body.classList.add("mt-enter");
  }
  dockFull = content !== null;
  if (dockFull || wasFull) wake();
  if (!animate) return;
  // Its own width, then from the old one to it (an auto width can't be transitioned).
  box.style.width = "";
  const to = box.getBoundingClientRect().width;
  if (Math.abs(to - from) < 1) return;
  box.style.width = `${from}px`;
  void box.offsetWidth;
  box.style.width = `${to}px`;
}

/** Forget what the pinned box shows (another view). */
export function clearMapTip() {
  owner = null;
  setDock(null);
}

/** Least room right of the date range; with less, the box goes above it. */
const MIN_ROOM = 220;

/**
 * Right of the date range, at its bottom and as high, up to the map's controls (main.ts
 * sets --range-right); it moves with the panes. Without room there, above it. With the
 * date range hidden (timeless, toolbar.css), in its place: centred on it, between the
 * graph pane and the map's controls (--range-left too).
 */
function placeDock() {
  if (!dock) return;
  outlineRect = null;
  const { pane } = dock;
  const r = pane.getBoundingClientRect();
  // (Its top and height without the sink of its fade, as offsets leave out transforms.)
  const top = pane.offsetTop;
  const height = pane.offsetHeight;
  const rootStyle = getComputedStyle(document.documentElement);
  const controls = Number.parseFloat(rootStyle.getPropertyValue("--range-right")) || 0;
  const graphs = Number.parseFloat(rootStyle.getPropertyValue("--range-left")) || 0;
  const timeless = pane.classList.contains("timeless");
  const room = window.innerWidth - controls - 12 - (r.right + 8);
  const beside = !timeless && room >= MIN_ROOM;
  const mid = r.left + r.width / 2;
  const half = Math.min(mid - graphs - 12, window.innerWidth - controls - 12 - mid);
  // (The zone where the empty box would be.)
  for (const { style } of [dock.box, dock.zone]) {
    style.left = `${Math.round(timeless ? mid : beside ? r.right + 8 : r.left)}px`;
    style.transform = timeless ? "translateX(-50%)" : "";
    style.bottom = `${Math.round(window.innerHeight - (timeless || beside ? top + height : top - 8))}px`;
    style.minHeight = `${height}px`;
  }
  dock.box.style.maxWidth = `${Math.round(timeless ? 2 * half : beside ? room : r.width)}px`;
  // (A square tile's side.)
  document.documentElement.style.setProperty("--tip-square", `${height}px`);
}

/** How long the dashed outline shows before it fades away, ms; how near the pointer brings it back, px. */
const QUIET_AFTER = 1000;
const NEAR = 80;
let quietTimer = 0;

/** The dashed outline shown: the empty pinned box, or the zone (null: neither). */
const outline = () => (!dock ? null : docked ? (dockFull ? null : dock.box) : dock.zone);
/** Where the outline is, measured once per placing (the pointer's distance to it is checked at every move). */
let outlineRect: { el: HTMLElement; r: DOMRect } | null = null;

/** Show the outline (or the full box) again, the outline fading away after a while. */
function wake() {
  if (!dock) return;
  clearTimeout(quietTimer);
  dock.box.classList.remove("mt-faded");
  dock.zone.classList.remove("mt-faded");
  const el = outline();
  if (el) quietTimer = window.setTimeout(() => outline() === el && el.classList.add("mt-faded"), QUIET_AFTER);
}

/** Pin or release the tooltip; `last`: pinned, with what it last showed, even if hidden since. */
function setDocked(on: boolean, last = false) {
  docked = on;
  try {
    localStorage.setItem(DOCK_KEY, on ? "1" : "0");
  } catch {
    // (Not kept, then.)
  }
  if (!dock) return;
  dock.box.hidden = !on;
  dock.zone.hidden = on;
  if (owner) owner.hidden = true;
  clearMapTip();
  placeDock();
  // Pinned: what the tooltip showed, in the box (released, it shows again once the pointer moves).
  const shown = last ? lastFollowing : following && !following.el.hidden ? following : null;
  following = lastFollowing = null;
  if (on && shown) showMapTip(shown.el, shown.tip);
  wake();
}

/** The pinned box, right of `pane` (the date range), with its button that releases it; P pins and releases it too. */
export function initMapTips(pane: HTMLElement) {
  const box = document.createElement("div");
  box.className = "map-tip map-tip-dock mt-empty";
  box.innerHTML =
    `<div class="mt-body"></div>` +
    `<button class="mt-key" type="button" aria-label="Let the tooltip follow the pointer (P)" title="Let the tooltip follow the pointer (P)">${KEY}</button>`;
  // Released: the zone that pins it, where the empty box would be.
  const zone = document.createElement("div");
  zone.className = "map-tip-zone";
  zone.title = "Move the pointer here to pin the tooltip (P)";
  zone.innerHTML = `<span class="mt-key">${KEY}</span>`;
  let armed = false;
  zone.addEventListener("pointerenter", () => {
    if (!armed) return;
    // (The box comes under the pointer: it may not hear it enter until it moves.)
    overDock = true;
    setDocked(true, true);
  });
  box.addEventListener("pointerenter", () => (overDock = true));
  box.addEventListener("pointerleave", () => (overDock = false));
  document.addEventListener("pointermove", (e) => {
    if (docked) armed = false;
    else if (!zone.contains(e.target as Node)) armed = true;
  });
  document.body.append(box, zone);
  dock = { box, body: box.querySelector<HTMLElement>(".mt-body")!, zone, pane };
  // Once it has glided there, its own width again (as its content changes).
  box.addEventListener("transitionend", (e) => {
    if (e.target === box && e.propertyName === "width") box.style.width = "";
  });
  box.querySelector("button")!.addEventListener("click", () => setDocked(false));
  // The pointer near the outline: it shows (and fades a while after the pointer goes).
  document.addEventListener("pointermove", (e) => {
    const el = outline();
    if (!el || el.hidden) return;
    if (outlineRect?.el !== el) outlineRect = { el, r: el.getBoundingClientRect() };
    const { r } = outlineRect;
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
    const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    if (Math.hypot(dx, dy) < NEAR) wake();
  });
  // P pins and releases it (not while typing, nor with a modifier: those are the browser's).
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== PIN_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable]")) return;
    setDocked(!docked);
  });
  window.addEventListener("resize", placeDock);
  new ResizeObserver(placeDock).observe(pane);
  // (Hidden or back: toolbar.ts setTimeless.)
  new MutationObserver(placeDock).observe(pane, { attributes: true, attributeFilter: ["class"] });
  setDocked(docked);
}
