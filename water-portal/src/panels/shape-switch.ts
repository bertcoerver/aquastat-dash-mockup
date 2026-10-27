/*
 * How a map of values per area is drawn: the areas' colours, a circle on each (its area
 * by the value) or a 3D bar on each (its height by the value). A switch in the map's
 * legend section picks it, like the discharge map's (basin/scheme-map.ts), and each map
 * keeps its own. Each shape is a slot of the legend: switched into a slot another map
 * is in, the map takes it, and the other moves to the slot it left (or another free one
 * it can be drawn in); only with none free is it replaced (the view moves the switched
 * map last in its checklist).
 */
import type { LayerLegend } from "./legend";
import { slideSelection } from "./segmented";

export type Shape = "fill" | "circles" | "bars";

/** All three, for a map of values: in the switch's order. */
export const SHAPES: Shape[] = ["fill", "circles", "bars"];

const LABELS: Record<Shape, [string, string]> = {
  fill: ["Colours", "Colour each area by its value"],
  circles: ["Circles", "A circle on each area, its area by the value"],
  bars: ["3D bars", "A bar on each area, its height by the value (tilts the map)"],
};

/** What the note adds for a map drawn in a shape it isn't made for. */
export const SHAPE_NOTES: Record<Shape, string> = {
  fill: "",
  circles: "Circle area shows the value",
  bars: "Bar height shows the value",
};

/** A circle's radius at the reference value, px; above it, circles and bars grow to at most this many times its size. */
const REF_R = 26;
const OVER = 1.6;

/**
 * How big a value's circle (radius, px) and bar (height, a share of the reference bar)
 * are: the reference value at full size, the `p` quantile of the absolute values (1:
 * the largest; lower, so a few outliers don't shrink the rest, which then grow up to
 * OVER × as big). `hold`: the reference as it is, or as locked (LayerLegend.hold).
 */
export function shapeSizes(values: number[], p: number, hold: (ref: number) => number) {
  const abs = values.map(Math.abs).filter((v) => v > 0 && Number.isFinite(v)).sort((a, b) => a - b);
  const ref = hold(abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] || 1);
  const share = (v: number) => Math.min(OVER, Math.abs(v) / ref);
  return { ref, radius: (v: number) => Math.max(1.5, REF_R * Math.sqrt(share(v))), height: share };
}

export interface ShapeSwitch {
  /** How the map titled `title` is drawn: as it was switched, else the first of `shapes`. */
  shape(title: string, shapes: Shape[]): Shape;
  /**
   * Each map on the map that has more than one shape gets its switch, in its section.
   * `shown`: all the maps on the map (those without shapes take their slot all the same).
   */
  show(shown: { title: string; slot: string; shapes: Shape[] }[]): void;
}

/** `onChange`: a map was switched (by its title); draw the map again. */
export function initShapeSwitch(legend: LayerLegend, onChange: (title: string) => void): ShapeSwitch {
  const picked = new Map<string, Shape>();
  let onMap: { title: string; slot: string; shapes: Shape[] }[] = [];
  // One switch per map, which goes with it from section to section, so its highlight
  // slides from the shape it was to the one it's switched to.
  const switches = new Map<string, { el: HTMLElement; shapes: string }>();

  function switchOf(title: string) {
    let s = switches.get(title);
    if (s) return s;
    const el = document.createElement("div");
    el.className = "wb-vars";
    el.setAttribute("role", "radiogroup");
    el.setAttribute("aria-label", "Drawn as");
    el.style.margin = "6px 0 2px";
    slideSelection(el);
    el.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-shape]");
      if (!button || button.getAttribute("aria-checked") === "true") return;
      const to = button.dataset.shape as Shape;
      const from = onMap.find((m) => m.title === title)?.slot;
      // The map in that slot moves out of the way: preferably to the one this left.
      const other = onMap.find((m) => m.slot === to && m.title !== title);
      if (other) {
        const taken = new Set([to, ...onMap.filter((m) => m !== other && m.title !== title).map((m) => m.slot)]);
        const free = other.shapes.filter((x) => !taken.has(x));
        const move = free.find((x) => x === from) ?? free[0];
        if (move) picked.set(other.title, move);
      }
      picked.set(title, to);
      onChange(title);
    });
    switches.set(title, (s = { el, shapes: "" }));
    return s;
  }

  return {
    shape(title, shapes) {
      const s = picked.get(title);
      return s && shapes.includes(s) ? s : shapes[0];
    },
    show(shown) {
      onMap = shown;
      for (const [title, s] of switches) if (!shown.some((m) => m.title === title && m.shapes.length > 1)) s.el.remove();
      for (const map of shown) {
        if (map.shapes.length < 2) continue;
        const s = switchOf(map.title);
        if (s.shapes !== map.shapes.join()) {
          s.shapes = map.shapes.join();
          s.el.innerHTML = map.shapes
            .map((shape) => `<button type="button" role="radio" data-shape="${shape}" title="${LABELS[shape][1]}">${LABELS[shape][0]}</button>`)
            .join("");
        }
        const extra = legend.section(map.slot).extra;
        if (s.el.parentElement !== extra) {
          extra.prepend(s.el);
          // Laid out where it is now (as it was) first, so the change below slides.
          void s.el.offsetWidth;
        }
        for (const button of s.el.querySelectorAll<HTMLElement>("[data-shape]")) {
          button.setAttribute("aria-checked", String(button.dataset.shape === map.slot));
        }
      }
    },
  };
}
