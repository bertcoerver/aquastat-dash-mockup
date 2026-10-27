/*
 * How a map's circles and bars look (shape-switch.ts), the same in the Country and Basin
 * views: their colours, the map's own (its ramp, classes or colour) or, for a map of
 * values either side of zero (a diverging ramp), green above zero and red below; and
 * which value is at full size, the 98th percentile (so a few outliers don't shrink the
 * rest) or the largest. A menu on their key of sizes in the legend (legend.ts) picks
 * them, and each map keeps its own (by its title). Also that key: sizes in their colours,
 * labelled with their values, in place of a colour ramp.
 */
import type { Color } from "../map/theme";
import { nice, type SizesKey } from "./legend";
import type { Shape } from "./shape-switch";
import type { MenuOption } from "./title-menu";

export type ShapeColours = "map" | "sign";

export interface ShapeStyle {
  colours: ShapeColours;
  /** The quantile of the values at full size (1: the largest). */
  full: number;
}

const FULLS = [0.98, 1];
const COLOURS: Record<ShapeColours, string> = { map: "The map's colours", sign: "Green above zero, red below" };
const fullLabel = (full: number) => (full === 1 ? "Full size at the largest value" : `Full size at the ${Math.round(full * 100)}th percentile`);

/** The reference bar's height in the key, px. */
const BAR_KEY_PX = 24;

export interface ShapeStyles {
  /** A map's style: as picked in its menu, else `initial`. `signed`: whether it can be coloured by sign. */
  get(title: string, initial: ShapeStyle, signed: boolean): ShapeStyle;
  /** Its menu: the colours (sign only when `signed`) and the full size, the style's checked. */
  menu(title: string, initial: ShapeStyle, signed: boolean): { options: MenuOption[]; current: string[] };
  /** An option of its menu picked. */
  pick(title: string, id: string): void;
}

export function initShapeStyles(): ShapeStyles {
  const picked = new Map<string, Partial<ShapeStyle>>();
  const get = (title: string, initial: ShapeStyle, signed: boolean): ShapeStyle => {
    const style = { ...initial, ...picked.get(title) };
    return signed ? style : { ...style, colours: "map" };
  };
  return {
    get,
    menu(title, initial, signed) {
      const style = get(title, initial, signed);
      const colours: ShapeColours[] = signed ? ["map", "sign"] : ["map"];
      return {
        options: [
          ...colours.map((c) => ({ id: `colours:${c}`, label: COLOURS[c], hint: "Colours" })),
          ...FULLS.map((f) => ({ id: `full:${f}`, label: fullLabel(f), hint: "Size" })),
        ],
        current: [`colours:${style.colours}`, `full:${style.full}`],
      };
    },
    pick(title, id) {
      const [what, value] = id.split(":");
      const style = { ...picked.get(title) };
      if (what === "colours") style.colours = value as ShapeColours;
      else style.full = Number(value);
      picked.set(title, style);
    },
  };
}

/** The menu button's title: "Circles in the map's colours, full size at the largest value. Click to change." */
export function describeStyle(style: ShapeStyle, slot: Shape) {
  const what = slot === "bars" ? "Bars" : "Circles";
  const colours = style.colours === "sign" ? "green above zero, red below" : "in the map's colours";
  return `${what} ${colours}, ${fullLabel(style.full).toLowerCase()}. Click to change.`;
}

/** A value's colour by its sign. */
export const signColor = (v: number, rise: Color, fall: Color) => (v >= 0 ? rise : fall);

/**
 * The key of a map's circles or bars (`size`: shapeSizes's), round values up to the
 * reference, each in the colour it has on the map (`color`): three sizes, or for values
 * either side of zero (`signed`) big to small below zero, then small to big above it.
 */
export function sizeKey(
  slot: "circles" | "bars",
  size: { ref: number; radius(v: number): number; height(v: number): number },
  color: (v: number) => string,
  signed: boolean,
): SizesKey {
  const top = nice(size.ref);
  const px = (v: number) => (slot === "circles" ? size.radius(v) : BAR_KEY_PX * size.height(v));
  const values = signed ? [-top, -top / 4, top / 4, top] : [top / 10, top / 2, top];
  const items = values.map((v) => ({ value: Math.abs(v), size: px(v), color: color(v), sign: signed ? (v < 0 ? "−" : "+") : undefined }));
  return { kind: slot, items };
}
