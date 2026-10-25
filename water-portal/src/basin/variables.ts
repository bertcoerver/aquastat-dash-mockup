/*
 * How each model variable is labelled and coloured: on the map, in the legend, in the
 * charts and the Sankey diagram.
 *
 * Map colours run over the 1st–99th percentile of the sub-basins' values (or as picked
 * in the legend's ramp menu: panels/ramp-menu.ts), so one extreme sub-basin doesn't
 * wash out the rest. Discharge uses a log scale: it grows
 * by orders of magnitude from headwaters to the outlet. Storage change is centred on
 * zero (red: storage falls, blue: it rises).
 */
import type { WaporStretch } from "../map/layers/wapor";
import type { Color } from "../map/theme";
import { DEFAULT_STRETCH } from "../panels/ramp-menu";
import type { Variable } from "./model";

interface VariableStyle {
  label: string;
  short: string;
  unit: string;
  /** Colour ramp, low to high (ColorBrewer). */
  ramp: string[];
  scale: "linear" | "log" | "diverging";
  /** The variable's colour in charts and the Sankey diagram. */
  color: string;
}

export const STYLES: Record<Variable, VariableStyle> = {
  PCP: {
    label: "Precipitation",
    short: "PCP",
    unit: "mm/day",
    ramp: ["#e5f5e0", "#c7e9c0", "#a1d99b", "#74c476", "#41ab5d", "#238b45", "#006d2c", "#00441b"],
    scale: "linear",
    color: "#27ae60",
  },
  AETI: {
    label: "Actual evapotranspiration",
    short: "AETI",
    unit: "mm/day",
    ramp: ["#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a", "#ef3b2c", "#cb181d", "#a50f15", "#67000d"],
    scale: "linear",
    color: "#e74c3c",
  },
  Q: {
    label: "Discharge",
    short: "Q",
    unit: "m³/s",
    ramp: ["#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"],
    scale: "log",
    color: "#3498db",
  },
  dS: {
    label: "Storage change",
    short: "ΔS",
    unit: "m³/s",
    ramp: ["#a50026", "#d73027", "#f46d43", "#fdae61", "#fee090", "#ffffbf", "#e0f3f8", "#abd9e9", "#74add1", "#4575b4", "#313695"],
    scale: "diverging",
    color: "#8e6bbf",
  },
};

export interface ColorScale {
  /** The colour for a value (null: no value). */
  color(value: number): Color | null;
  /** CSS gradient for the legend, left to right. */
  gradient: string;
  /** Legend ticks: value and position along the ramp (0–1). */
  ticks: { value: number; at: number }[];
}

/** A colour scale fitted to `values` (the sub-basins' period means). */
export function colorScale(variable: Variable, values: number[]): ColorScale {
  return rampScale(STYLES[variable], values);
}

/**
 * A colour scale for any ramp and scale type (also the Country view's maps), fitted to
 * `values` without `cut`% at either end, or spanning `domain` ([low, high]) when given.
 */
export function rampScale(
  style: Pick<VariableStyle, "ramp" | "scale">,
  values: number[],
  domain?: [number, number],
  cut: WaporStretch = DEFAULT_STRETCH,
): ColorScale {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  const stops = style.ramp.map(hexToColor);
  const gradient = `linear-gradient(to right, ${style.ramp.join(", ")})`;
  const at = (t: number) => {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    return stops[i].map((c, k) => (k === 3 ? 255 : Math.round(c + (stops[i + 1][k] - c) * f))) as Color;
  };

  if (!finite.length) return { color: () => null, gradient, ticks: [] };
  const q = cut / 100;
  const lo = domain ? domain[0] : quantile(finite, q);
  const hi = domain ? domain[1] : quantile(finite, 1 - q);

  if (style.scale === "diverging") {
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    return {
      color: (v) => (Number.isFinite(v) ? at((v / m + 1) / 2) : null),
      gradient,
      ticks: [-m, -m / 2, 0, m / 2, m].map((value) => ({ value, at: (value / m + 1) / 2 })),
    };
  }

  if (style.scale === "log") {
    // Values at or below zero (dry sub-basins) get the lowest colour.
    const positive = finite.filter((v) => v > 0);
    const a = Math.log10(positive.length ? Math.max(quantile(positive, q), 1e-3) : 1e-3);
    const b = Math.max(Math.log10(positive.length ? quantile(positive, 1 - q) : 1), a + 1);
    const t = (v: number) => (Math.log10(Math.max(v, 10 ** a)) - a) / (b - a);
    // Ticks at 1, 2 and 5 × powers of ten; only the powers of ten if that's too many.
    let values: number[] = [];
    for (let e = Math.floor(a); e <= Math.ceil(b); e++) values.push(10 ** e, 2 * 10 ** e, 5 * 10 ** e);
    values = values.filter((v) => Math.log10(v) >= a - 1e-9 && Math.log10(v) <= b + 1e-9);
    if (values.length > 6) values = values.filter((v) => Number.isInteger(Math.log10(v)));
    if (values.length < 2) values = [10 ** a, 10 ** b];
    const ticks = values.map((value) => ({ value, at: t(value) }));
    return { color: (v) => (Number.isFinite(v) ? at(t(v)) : null), gradient, ticks };
  }

  const span = hi - lo || 1;
  return {
    color: (v) => (Number.isFinite(v) ? at((v - lo) / span) : null),
    gradient,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ value: lo + f * span, at: f })),
  };
}

function quantile(sorted: number[], q: number) {
  const x = (sorted.length - 1) * q;
  const i = Math.floor(x);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (x - i);
}

export function hexToColor(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/** A number for display: about three significant digits, no exponent below a million. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toPrecision(2);
}
