/*
 * How a map of values per area is drawn: the areas' colours, a circle on each (its area
 * by the value) or a 3D bar on each (its height by the value). Picked in the legend's
 * checklist, by the icons to the right of the map (shape-icons.ts), like the discharge
 * map's network or particles (basin/scheme-map.ts), and each map keeps its own. Each
 * shape is a slot of the legend: switched into a slot another map is in, the map takes
 * it, and the other moves to the slot it left (or another free one it can be drawn in);
 * only with none free is it replaced (the view moves the switched map last in its
 * checklist). A map not on the map is offered in a free slot, so checking it adds it.
 * How the circles and bars look (their colours, their full size) is a menu on their
 * key (shape-style.ts).
 */
import type { ShapeIcon } from "./shape-icons";

export type Shape = "fill" | "circles" | "bars";

/** All three, for a map of values: in the switch's order. */
export const SHAPES: Shape[] = ["fill", "circles", "bars"];

/** Each shape's name and description (also in the maps with their own: scheme-map.ts, effects-map.ts). */
export const SHAPE_LABELS: Record<Shape, [string, string]> = {
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

/**
 * A circle's radius at the reference value, px: on countries and major basins, and on
 * small areas (sub-basins: many, close together). Above it, circles and bars grow to at
 * most OVER times its size.
 */
const REF_R = 26;
const SMALL_REF_R = 12;
const OVER = 1.6;

/**
 * How big a value's circle (radius, px) and bar (height, a share of the reference bar)
 * are: the reference value at full size, the `p` quantile of the absolute values (1:
 * the largest; lower, so a few outliers don't shrink the rest, which then grow up to
 * OVER × as big). `hold`: the reference as it is, or as locked (LayerLegend.hold).
 * `small`: the areas are small (SMALL_REF_R).
 */
export function shapeSizes(values: number[], p: number, hold: (ref: number) => number, small = false) {
  const abs = values.map(Math.abs).filter((v) => v > 0 && Number.isFinite(v)).sort((a, b) => a - b);
  const ref = hold(abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] || 1);
  const share = (v: number) => Math.min(OVER, Math.abs(v) / ref);
  const r = small ? SMALL_REF_R : REF_R;
  return { ref, radius: (v: number) => Math.max(1.5, r * Math.sqrt(share(v))), height: share };
}

/** One way a map can be drawn: its id, the legend slot it takes, its icon, and its name and description. */
export interface ShapeOption {
  id: string;
  slot: string;
  icon: ShapeIcon;
  label: string;
  title: string;
}

export const shapeOptions = (shapes: Shape[]): ShapeOption[] =>
  shapes.map((s) => ({ id: s, slot: s, icon: s, label: SHAPE_LABELS[s][0], title: SHAPE_LABELS[s][1] }));

/** A map's ways of being drawn, the one it is in (`current`), and how to switch it. */
export interface MapShapes {
  title: string;
  options: ShapeOption[];
  current: string;
  set(id: string): void;
}

const slotOf = (m: MapShapes, id = m.current) => m.options.find((o) => o.id === id)?.slot;

/**
 * How a map not on the map is offered (and added): as it is if its slot is free, else
 * in the first free one it can take (none: as it is, replacing the map there).
 * `taken`: the slots of the maps on the map.
 */
export function freeShape(m: MapShapes, taken: Set<string>): string {
  if (!taken.has(slotOf(m)!)) return m.current;
  return m.options.find((o) => !taken.has(o.slot))?.id ?? m.current;
}

/**
 * Switch map `m` to `to`, among the maps `onMap` (it may be one of them, or be added):
 * the map in the slot it takes moves out of the way, preferably to the slot it left.
 */
export function switchShape(onMap: MapShapes[], m: MapShapes, to: string) {
  const from = onMap.some((x) => x.title === m.title) ? slotOf(m) : undefined;
  const at = slotOf(m, to);
  const other = onMap.find((x) => x.title !== m.title && slotOf(x) === at);
  if (other) {
    const taken = new Set([at, ...onMap.filter((x) => x !== other && x.title !== m.title).map((x) => slotOf(x))]);
    const free = other.options.filter((o) => !taken.has(o.slot));
    const move = free.find((o) => o.slot === from) ?? free[0];
    if (move) other.set(move.id);
  }
  m.set(to);
}

/** Each map's shape, by its title. */
export interface ShapePicks {
  /** How the map titled `title` is drawn: as it was switched, else `initial` (the first of `shapes`). */
  shape(title: string, shapes: Shape[], initial?: Shape): Shape;
  set(title: string, shape: Shape): void;
}

export function initShapePicks(): ShapePicks {
  const picked = new Map<string, Shape>();
  return {
    shape(title, shapes, initial = shapes[0]) {
      const s = picked.get(title);
      return s && shapes.includes(s) ? s : initial;
    },
    set(title, shape) {
      picked.set(title, shape);
    },
  };
}
