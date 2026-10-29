/*
 * Graph panes that fold away when not in use. At rest a pane shows its heading only,
 * or its heading and the pinned chart (the body's .pinned element, see map-drivers.ts);
 * the pointer over it, keyboard focus in it, or one of its menus open unfolds it.
 * Moving in either direction is animated: the pane's height, the body's scroll (which
 * carries the pinned chart up under the heading, or back to where it was) and the rest
 * of the body fading out or in. Everything keeps its layout while folded (it is only
 * faded and hidden), so charts drawn meanwhile still measure their width.
 *
 * Classes on the pane: .folding while it has a height of its own (folded, or on the
 * way), .resting once fully folded; .has-kept with a pinned chart, whose element gets
 * .kept and its ancestors in the body .keep-path. --rest goes from 0 (open) to 1.
 */
import { reduceMotion } from "../lib/dom";


const OPEN_DELAY = 60; // ms; a pointer passing over doesn't unfold it
const CLOSE_DELAY = 250; // ms; nor does one slipping off the edge fold it
const DURATION = 280; // ms

/** One of its menus or pickers, open (not a tree item, which keeps it when hidden). */
const POPUP_OPEN = ':is([aria-haspopup], [role="combobox"])[aria-expanded="true"]';


export function makeFoldable(pane: HTMLElement) {
  const head = pane.querySelector<HTMLElement>(".wb-head")!;
  const body = pane.querySelector<HTMLElement>(".wb-body")!;

  let hovered = false;
  let touched = false; // opened by a tap: stays open until a tap elsewhere
  let open = false;
  let rest = 1; // 0 open … 1 folded
  let kept: HTMLElement | null = null;
  let openScroll = 0; // the body's scroll when it was last open
  let frame = 0;
  let timer = 0;

  /** Should it be open? */
  const wanted = () =>
    !pane.hidden && (hovered || touched || pane.matches(":has(:focus-visible)") || !!pane.querySelector(POPUP_OPEN));

  function update(delay = 0) {
    clearTimeout(timer);
    const want = wanted();
    if (want === open) return;
    timer = window.setTimeout(() => {
      if (wanted() === want) move(want);
    }, delay);
  }

  // --- The pinned chart --------------------------------------------------------------
  function markKept() {
    const next = body.querySelector<HTMLElement>(".pinned");
    if (next === kept) return;
    for (const el of pane.querySelectorAll(".keep-path, .kept")) el.classList.remove("keep-path", "kept");
    if (kept) sizes.unobserve(kept);
    kept = next;
    pane.classList.toggle("has-kept", !!kept);
    if (!kept) return;
    kept.classList.add("kept");
    for (let el = kept.parentElement; el && el !== body; el = el.parentElement) el.classList.add("keep-path");
    sizes.observe(kept);
  }

  // --- Where it goes ------------------------------------------------------------------
  /** Its height and the body's scroll when folded. */
  function restTarget() {
    const borders = pane.offsetHeight - pane.clientHeight;
    if (!kept) return { height: head.offsetHeight + borders, scroll: body.scrollTop };
    const style = getComputedStyle(body);
    const padTop = parseFloat(style.paddingTop);
    const top = kept.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    return {
      height: head.offsetHeight + borders + padTop + kept.offsetHeight + parseFloat(style.paddingBottom),
      scroll: top - padTop,
    };
  }

  /** Its height when open (as the stylesheet lays it out). */
  function openHeight() {
    const { height } = pane.style;
    pane.classList.remove("folding");
    pane.style.height = "";
    const h = pane.offsetHeight;
    pane.classList.add("folding");
    pane.style.height = height;
    return h;
  }

  function apply(height: number, scroll: number, r: number) {
    rest = r;
    pane.style.height = `${height}px`;
    pane.style.setProperty("--rest", String(r));
    body.scrollTop = scroll;
  }

  // --- Moving -------------------------------------------------------------------------
  function move(toOpen: boolean) {
    open = toOpen;
    cancelAnimationFrame(frame);
    markKept();
    const from = { height: pane.offsetHeight, scroll: body.scrollTop, rest };
    if (!pane.classList.contains("folding")) openScroll = body.scrollTop;
    pane.style.height = `${from.height}px`; // (before .folding lets it grow to its content)
    pane.classList.add("folding");
    pane.classList.remove("resting");
    const to = toOpen ? { height: openHeight(), scroll: openScroll, rest: 0 } : { ...restTarget(), rest: 1 };
    const duration = reduceMotion.matches || pane.hidden ? 0 : DURATION * Math.abs(to.rest - from.rest);
    const start = performance.now();
    const step = (now: number) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const e = ease(t);
      apply(lerp(from.height, to.height, e), lerp(from.scroll, to.scroll, e), lerp(from.rest, to.rest, e));
      if (t < 1) frame = requestAnimationFrame(step);
      else settle();
    };
    if (duration) frame = requestAnimationFrame(step);
    else step(start);
  }

  /** At the end of a move: open, back to the stylesheet's layout; folded, hidden. */
  function settle() {
    frame = 0;
    if (open) {
      pane.classList.remove("folding");
      pane.style.height = "";
      pane.style.removeProperty("--rest");
    } else {
      pane.classList.add("resting");
    }
  }

  /** Folded, follow changes (a new chart pinned, or redrawn) at once. */
  function refold() {
    if (open || frame) return;
    markKept();
    const { height, scroll } = restTarget();
    apply(height, scroll, 1);
  }

  // --- Triggers -----------------------------------------------------------------------
  pane.addEventListener("pointerenter", (e) => {
    hovered = e.pointerType !== "touch";
    if (e.pointerType === "touch") touched = true;
    update(touched ? 0 : OPEN_DELAY);
  });
  pane.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch") return; // (a tap leaves as soon as it lifts)
    hovered = false;
    update(CLOSE_DELAY);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!touched || pane.contains(e.target as Node)) return;
    touched = false;
    update();
  });
  // (focus moves after focusout: look once it has)
  pane.addEventListener("focusin", () => update());
  pane.addEventListener("focusout", () => setTimeout(() => update(CLOSE_DELAY)));

  // Switched away from, it folds at once (it gets no pointerleave when hidden).
  new MutationObserver((records) => {
    if (pane.hidden && records.some((r) => r.target === pane && r.attributeName === "hidden")) {
      hovered = touched = false;
      clearTimeout(timer);
      return move(false);
    }
    if (records.some((r) => r.attributeName === "aria-expanded")) update(open ? CLOSE_DELAY : 0);
    refold();
  }).observe(pane, { attributes: true, attributeFilter: ["hidden", "class", "aria-expanded"], childList: true, subtree: true });

  const sizes = new ResizeObserver(refold);
  sizes.observe(head);

  // It starts folded.
  pane.classList.add("folding", "resting");
  refold();
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
