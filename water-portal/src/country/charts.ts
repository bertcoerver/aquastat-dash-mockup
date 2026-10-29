/*
 * The Country panel's charts, as HTML strings (a legend, when there is more than one
 * series, and an SVG), drawn from scratch on every update like the Basin view's.
 *
 * - bars:    horizontal bars, one row per area, one bar per series (e.g. 2015 and the
 *            selected year); also the rankings (one series)
 * - shares:  100 % stacked bars, one row per area (withdrawal by sector, …)
 * - lines:   values over the years, one line per series (country, region, World)
 * - columns: one value per step as bars, standing or hanging from the top (rain per dekad)
 * - bubbles: one dot per area, x against y (each its own unit, linear or log), sized by
 *            a third value, with arrows from where it was
 * - heatmap: a grid of values (months × years), coloured
 *
 * The panel makes them interactive through data attributes:
 * - data-tip:  the tooltip's HTML for the mark under the pointer
 * - data-sub:  what the mark stands for (an area, or a series' variable): the map
 *              follows it while the pointer is over it
 * - data-x:    a year (or month) of a line chart: clicking it selects it
 *
 * A column of a line chart, a column of `columns` and a heatmap's cell can carry a
 * data-sub too (`subOf`), so hovering a step shows that step on the map.
 *
 * Rows, points and legend keys carry a pin icon (.ch-pin), shown when the card is
 * pinned on that one (.pinned-sub, set by map-drivers.ts).
 *
 * Also used by the Basin view's statistics (rankings that run below zero, scatter).
 */
import { fmt } from "../basin/variables";

export interface Series {
  label: string;
  /** CSS colour (a var() from country.css). */
  color: string;
  /** What hovering the series in the legend shows on the map (see data-sub). */
  sub?: string;
}

export interface BarRow {
  sub: string;
  label: string;
  values: number[];
  /** The selected country: drawn in bold on a band. */
  emphasis?: boolean;
  /** A row standing for rows left out ("… 40 more"): only its label is drawn. */
  gap?: boolean;
}

export interface LineSeries extends Series {
  values: Map<number, number>;
  emphasis?: boolean;
}

const LABEL_W = 132;
const BAR_H = 8;
const BAR_GAP = 2;
const ROW_PAD = 10;
const AXIS_H = 18;
const TITLE_H = 14; // an axis title under the tick labels

/** An axis title: the quantity and its unit, e.g. "Water stress (%)". */
const axisTitle = (axis: string, unit: string) => esc(unit ? `${axis} (${unit})` : axis);
/** The title under a horizontal axis whose tick labels end at y `ticksY`, right-aligned at `right`. */
const xTitle = (axis: string | undefined, unit: string, right: number, ticksY: number) =>
  axis ? `<text class="ts-label ch-axis" x="${right}" y="${ticksY + TITLE_H}" text-anchor="end">${axisTitle(axis, unit)} →</text>` : "";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A thumbtack, 10 × 10. */
export const PIN = "M2.5 0H7.5V1L6.5 2V4.5L8.5 6.5V7.5H5.5V10H4.5V7.5H1.5V6.5L3.5 4.5V2L2.5 1Z";
/** The pin icon in an SVG chart, its top left at (x, y). */
const pinAt = (x: number, y: number) => `<path class="ch-pin" transform="translate(${x.toFixed(1)},${y.toFixed(1)})" d="${PIN}"/>`;

function legend(series: Series[]) {
  if (series.length < 2) return "";
  return `<div class="ch-legend">${series
    .map((s) => `<span class="ch-key"${s.sub ? ` data-sub="${esc(s.sub)}"` : ""}><i style="background:${s.color}"></i>${esc(s.label)}` +
      (s.sub ? `<svg class="ch-pin" viewBox="0 0 10 10" aria-hidden="true"><path d="${PIN}"/></svg>` : "") + "</span>")
    .join("")}</div>`;
}

/** A bar from the baseline at x0, `len` long (leftwards if negative), with a rounded data end. */
function hbar(x0: number, y: number, len: number, h: number) {
  if (!Number.isFinite(len) || Math.abs(len) < 0.5) return "";
  const s = Math.sign(len);
  const a = Math.abs(len);
  const r = Math.min(h / 2, 4, a);
  const sweep = s > 0 ? 1 : 0;
  return `M${x0.toFixed(1)},${y.toFixed(1)}h${(s * (a - r)).toFixed(1)}a${r},${r} 0 0 ${sweep} ${s * r},${r}v${(h - 2 * r).toFixed(1)}a${r},${r} 0 0 ${sweep} ${-s * r},${r}h${(-s * (a - r)).toFixed(1)}z`;
}

let measure: CanvasRenderingContext2D | null = null;
let labelFont = ""; // (the page's font stack, looked up once: it's asked for per row)
/** The width of a row label in pixels, set in bold (as when its row is pinned). */
function labelWidth(text: string) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * 6.5;
  measure.font = labelFont ||= `600 11px ${getComputedStyle(document.documentElement).getPropertyValue("--sans")}`;
  return measure.measureText(text).width;
}

/** A row's label at baseline y, and its pin after it. */
function rowLabel(label: string, y: number, emphasis = false) {
  const short = label.length > 22 ? `${label.slice(0, 21)}…` : label;
  return `<text class="ch-row-label${emphasis ? " em" : ""}" x="0" y="${y}">${esc(short)}</text>` +
    pinAt(Math.min(labelWidth(short) + 4, LABEL_W - 11), y - 9);
}

/**
 * Horizontal bars; `series` in drawing order (the last one gets the value label).
 * `axis` names the quantity, for a title under the axis.
 */
export function bars({ series, rows, unit, axis, width }: { series: Series[]; rows: BarRow[]; unit: string; axis?: string; width: number }) {
  if (!rows.length) return "";
  const n = series.length;
  const rowH = n * BAR_H + (n - 1) * BAR_GAP + ROW_PAD;
  const plotW = Math.max(60, width - LABEL_W - 44); // room for the value label
  const finite = rows.flatMap((r) => r.values.filter(Number.isFinite));
  const max = Math.max(...finite, 0);
  const min = Math.min(...finite, 0);
  const ticks = niceTicks(min, max || (min ? 0 : 1), Math.max(2, Math.floor(plotW / 70)));
  const [lo, top] = [ticks[0], ticks[ticks.length - 1]];
  const x = (v: number) => LABEL_W + ((v - lo) / (top - lo)) * plotW;
  const plotH = rows.length * rowH;
  const h = plotH + AXIS_H + (axis ? TITLE_H : 0);

  const grid = ticks
    .map((t) => `<line class="ts-grid" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${plotH}"/>` +
      `<text class="ts-label" x="${x(t)}" y="${plotH + AXIS_H - 5}" text-anchor="middle">${fmt(t)}</text>`)
    .join("") + xTitle(axis, unit, x(top), plotH + AXIS_H - 5);
  const body = rows
    .map((row, i) => {
      const y0 = i * rowH;
      if (row.gap) return `<text class="ch-row-label gap" x="0" y="${y0 + rowH / 2 + 4}">${esc(row.label)}</text>`;
      const marks = row.values
        .map((v, j) => `<path d="${hbar(x(0), y0 + ROW_PAD / 2 + j * (BAR_H + BAR_GAP), x(v) - x(0), BAR_H)}" style="fill:${series[j].color}"/>`)
        .join("");
      const last = row.values[n - 1];
      const value = Number.isFinite(last)
        ? `<text class="ch-value" x="${Math.max(x(last), x(0)) + 4}" y="${y0 + ROW_PAD / 2 + (n - 1) * (BAR_H + BAR_GAP) + BAR_H - 0.5}">${fmt(last)}</text>`
        : row.values.some(Number.isFinite)
          ? ""
          : `<text class="ch-value muted" x="${LABEL_W + 2}" y="${y0 + rowH / 2 + 4}">no data</text>`;
      const tip = `<b>${esc(row.label)}</b>` + row.values.map((v, j) => `<br>${n > 1 ? `${esc(series[j].label)}: ` : ""}${fmt(v)} ${esc(unit)}`).join("");
      return `<g class="ch-row" data-sub="${esc(row.sub)}" data-tip="${esc(tip)}">` +
        `<rect class="ch-hit${row.emphasis ? " em" : ""}" x="0" y="${y0}" width="${width}" height="${rowH}"/>` +
        rowLabel(row.label, y0 + rowH / 2 + 4, row.emphasis) + marks + value + "</g>";
    })
    .join("");
  const zero = lo < 0 ? `<line class="ts-zero" x1="${x(0)}" x2="${x(0)}" y1="0" y2="${plotH}"/>` : "";
  return legend(series) + `<svg class="ch" width="${width}" height="${h}">${grid}${zero}${body}</svg>`;
}

/**
 * 100 % stacked bars: each row's values are split into its parts' shares. `axis` names
 * the whole, for a title under the axis ("Share of <axis> (%)").
 */
export function shares({ parts, rows, unit, axis, width }: { parts: (Series & { ink: "light" | "dark" })[]; rows: BarRow[]; unit: string; axis?: string; width: number }) {
  if (!rows.length) return "";
  const rowH = 16 + ROW_PAD;
  const plotW = Math.max(60, width - LABEL_W - 4);
  const plotH = rows.length * rowH;
  const h = plotH + AXIS_H + (axis ? TITLE_H : 0);
  const x = (f: number) => LABEL_W + f * plotW;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<line class="ts-grid" x1="${x(f)}" x2="${x(f)}" y1="0" y2="${plotH}"/>` +
      `<text class="ts-label" x="${x(f)}" y="${plotH + AXIS_H - 5}" text-anchor="${f === 1 ? "end" : f === 0 ? "start" : "middle"}">${f * 100}%</text>`)
    .join("") + xTitle(axis && `Share of ${axis}`, "%", x(1), plotH + AXIS_H - 5);
  const body = rows
    .map((row, i) => {
      const y0 = i * rowH + ROW_PAD / 2;
      const total = row.values.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
      let marks = "";
      if (total > 0) {
        let at = 0;
        row.values.forEach((v, j) => {
          if (!(Number.isFinite(v) && v > 0)) return;
          const f = v / total;
          // 2px surface gap between segments.
          const x0 = x(at) + (at > 0 ? 1 : 0);
          const x1 = x(at + f) - (at + f < 0.9999 ? 1 : 0);
          at += f;
          if (x1 - x0 < 0.5) return;
          marks += `<rect x="${x0.toFixed(1)}" y="${y0}" width="${(x1 - x0).toFixed(1)}" height="16" rx="1.5" style="fill:${parts[j].color}"/>`;
          const label = `${Math.round(f * 100)}%`;
          if (x1 - x0 >= label.length * 6.5 + 8) {
            marks += `<text class="ch-in ${parts[j].ink}" x="${((x0 + x1) / 2).toFixed(1)}" y="${y0 + 12}" text-anchor="middle">${label}</text>`;
          }
        });
      } else {
        marks = `<text class="ch-value muted" x="${LABEL_W + 2}" y="${y0 + 12}">no data</text>`;
      }
      const tip = `<b>${esc(row.label)}</b>` + row.values
        .map((v, j) => `<br>${esc(parts[j].label)}: ${total > 0 && Number.isFinite(v) ? `${Math.round((v / total) * 100)}% · ` : ""}${fmt(v)}${unit === "%" ? "%" : ` ${esc(unit)}`}`)
        .join("");
      return `<g class="ch-row" data-sub="${esc(row.sub)}" data-tip="${esc(tip)}">` +
        `<rect class="ch-hit${row.emphasis ? " em" : ""}" x="0" y="${i * rowH}" width="${width}" height="${rowH}"/>` +
        rowLabel(row.label, y0 + 12, row.emphasis) + marks + "</g>";
    })
    .join("");
  return legend(parts) + `<svg class="ch" width="${width}" height="${h}">${grid}${body}</svg>`;
}

const LINE_M = { left: 40, right: 12, top: 8, bottom: 20 };

/**
 * Lines over the years (or other steps: months) [from, to], named by `label`.
 * `selected` (the top bar's year) is marked, or with `selectedTo` the years from one to
 * the other are shaded; `clickable` steps can be clicked to select them. `axis` names
 * the quantity, for a title above the value axis.
 */
export function lines({
  series,
  from,
  to,
  selected,
  selectedTo = selected,
  unit,
  axis,
  width,
  height = 170,
  clickable,
  label = String,
  tipLabel = label,
  subOf,
}: {
  series: LineSeries[];
  from: number;
  to: number;
  selected: number;
  selectedTo?: number;
  unit: string;
  axis?: string;
  width: number;
  height?: number;
  clickable: (year: number) => boolean;
  label?: (x: number) => string;
  /** The tooltip's heading of a step (else its label). */
  tipLabel?: (x: number) => string;
  /** What hovering a step shows on the map (data-sub; null: nothing of its own). */
  subOf?: (x: number) => string | null;
}) {
  const all = series.flatMap((s) => [...s.values].filter(([y, v]) => y >= from && y <= to && Number.isFinite(v)).map(([, v]) => v));
  if (!all.length) return legend(series) + `<p class="ch-empty">No data</p>`;
  const lo = Math.min(0, ...all);
  const ticks = niceTicks(lo, Math.max(...all, lo + 1e-9), 4);
  const [y0, y1] = [ticks[0], ticks[ticks.length - 1]];
  const w = width;
  const LM = { ...LINE_M, top: LINE_M.top + (axis ? TITLE_H : 0) };
  const h = height + (axis ? TITLE_H : 0);
  const step = (w - LM.left - LM.right) / Math.max(1, to - from);
  const x = (year: number) => LM.left + (year - from) * step;
  const y = (v: number) => LM.top + (1 - (v - y0) / (y1 - y0 || 1)) * (h - LM.top - LM.bottom);

  const grid = ticks
    .map((t) => `<line class="ts-grid" x1="${LM.left}" x2="${w - LM.right}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="ts-label" x="${LM.left - 5}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`)
    .join("") +
    (axis ? `<text class="ts-label ch-axis" x="0" y="${LM.top - 8}">↑ ${axisTitle(axis, unit)}</text>` : "");
  const every = Math.ceil((to - from + 1) / Math.max(2, Math.floor((w - LM.left - LM.right) / 44)));
  const years: number[] = [];
  for (let yr = from; yr <= to; yr++) years.push(yr);
  const xTicks = years
    .filter((yr) => (to - yr) % every === 0)
    .map((yr) => `<text class="ts-label" x="${x(yr)}" y="${h - 5}" text-anchor="middle">${label(yr)}</text>`)
    .join("");
  const span = selectedTo > selected;
  const mark = span
    ? `<rect class="ch-selected-span" x="${x(Math.max(selected, from))}" y="${LM.top}" width="${Math.max(0, x(Math.min(selectedTo, to)) - x(Math.max(selected, from)))}" height="${h - LM.top - LM.bottom}"/>`
    : selected >= from && selected <= to
      ? `<line class="ch-selected" x1="${x(selected)}" x2="${x(selected)}" y1="${LM.top}" y2="${h - LM.bottom}"/>`
      : "";
  // Emphasised series last, so they are drawn on top.
  const order = [...series].sort((a, b) => Number(a.emphasis ?? false) - Number(b.emphasis ?? false));
  const paths = order
    .map((s) => {
      let d = "";
      let pen = false;
      for (const yr of years) {
        const v = s.values.get(yr);
        if (v === undefined || !Number.isFinite(v)) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${x(yr).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      const v = s.values.get(selected);
      const dot = !span && v !== undefined && Number.isFinite(v)
        ? `<circle class="ch-dot" cx="${x(selected)}" cy="${y(v)}" r="4" style="fill:${s.color}"/>`
        : "";
      return `<path class="ch-line${s.emphasis ? " em" : ""}" d="${d}" style="stroke:${s.color}"/>${dot}`;
    })
    .join("");
  // One column per year: hover to read all series, click to select the year.
  const cols = years
    .map((yr) => {
      const tip = `<b>${esc(tipLabel(yr))}</b>` + series.map((s) => `<br>${esc(s.label)}: ${fmt(s.values.get(yr) ?? NaN)} ${esc(unit)}`).join("") +
        (clickable(yr) && (span || yr !== selected) ? `<br><span class="tip-hint">Click to show ${esc(tipLabel(yr))} on the map</span>` : "");
      const sub = subOf?.(yr);
      const dots = series
        .map((s) => {
          const v = s.values.get(yr);
          return v !== undefined && Number.isFinite(v) ? `<circle class="ch-dot" cx="${x(yr)}" cy="${y(v)}" r="4" style="fill:${s.color}"/>` : "";
        })
        .join("");
      return `<g class="ch-col${clickable(yr) ? " clickable" : ""}"${clickable(yr) ? ` data-x="${yr}"` : ""}${sub ? ` data-sub="${esc(sub)}"` : ""} data-tip="${esc(tip)}">` +
        `<rect class="ch-hit" x="${x(yr) - step / 2}" y="${LM.top}" width="${step}" height="${h - LM.top - LM.bottom}"/>` +
        `<g class="ch-cursor"><line x1="${x(yr)}" x2="${x(yr)}" y1="${LM.top}" y2="${h - LM.bottom}"/>${dots}</g></g>`;
    })
    .join("");
  return legend(series) +
    `<svg class="ch" width="${w}" height="${h}">${grid}${mark}${paths}${xTicks}${cols}</svg>`;
}

/**
 * One value per step [from, to] as vertical bars on the same steps as `lines` (so the two
 * line up when stacked), standing on the bottom or hanging from the top (`hang`: rain
 * over a hydrograph). `ghost`: a second value per step drawn as an outline behind (the
 * other years' average).
 */
export function columns({
  values,
  ghost,
  ghostLabel = "",
  from,
  to,
  unit,
  axis,
  label,
  color,
  width,
  height = 90,
  hang = false,
  clickable,
  subOf,
}: {
  values: Map<number, number>;
  ghost?: Map<number, number>;
  ghostLabel?: string;
  from: number;
  to: number;
  unit: string;
  axis: string;
  label: (x: number) => string;
  color: string;
  width: number;
  height?: number;
  hang?: boolean;
  clickable: (x: number) => boolean;
  subOf?: (x: number) => string | null;
}) {
  const all = [...values.values(), ...(ghost?.values() ?? [])].filter(Number.isFinite);
  if (!all.length) return `<p class="ch-empty">No data</p>`;
  const ticks = niceTicks(0, Math.max(...all, 1e-9), 2);
  const top = ticks[ticks.length - 1];
  const LM = { ...LINE_M, top: LINE_M.top + TITLE_H, bottom: hang ? 6 : LINE_M.bottom };
  const h = height + TITLE_H;
  const plotH = h - LM.top - LM.bottom;
  const step = (width - LM.left - LM.right) / Math.max(1, to - from);
  const x = (v: number) => LM.left + (v - from) * step;
  // Hanging: zero at the top, growing down.
  const y = (v: number) => (hang ? LM.top + (v / top) * plotH : LM.top + (1 - v / top) * plotH);
  const base = y(0);
  const bw = Math.max(1, Math.min(10, step - 2));
  const bar = (v: number, xc: number) => {
    const y1 = y(v);
    return { x: xc - bw / 2, y: Math.min(base, y1), h: Math.abs(y1 - base) };
  };
  const grid = ticks
    .map((t) => `<line class="ts-grid" x1="${LM.left}" x2="${width - LM.right}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="ts-label" x="${LM.left - 5}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`)
    .join("") + `<text class="ts-label ch-axis" x="0" y="${LM.top - 8}">${hang ? "↓" : "↑"} ${axisTitle(axis, unit)}</text>`;
  let marks = "";
  let cols = "";
  for (let i = from; i <= to; i++) {
    const v = values.get(i);
    const g = ghost?.get(i);
    if (g !== undefined && Number.isFinite(g)) {
      const b = bar(g, x(i));
      marks += `<rect class="ch-ghost" x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${bw.toFixed(1)}" height="${b.h.toFixed(1)}"/>`;
    }
    if (v !== undefined && Number.isFinite(v) && v > 0) {
      const b = bar(v, x(i));
      marks += `<rect x="${(b.x + 1).toFixed(1)}" y="${b.y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${b.h.toFixed(1)}" rx="1" style="fill:${color}"/>`;
    }
    const tip = `<b>${esc(label(i))}</b><br>${esc(axis)}: ${fmt(v ?? NaN)} ${esc(unit)}` +
      (ghost ? `<br>${esc(ghostLabel)}: ${fmt(g ?? NaN)} ${esc(unit)}` : "") +
      (clickable(i) ? `<br><span class="tip-hint">Click to select ${esc(label(i))}</span>` : "");
    const sub = subOf?.(i);
    cols += `<g class="ch-col${clickable(i) ? " clickable" : ""}"${clickable(i) ? ` data-x="${i}"` : ""}${sub ? ` data-sub="${esc(sub)}"` : ""} data-tip="${esc(tip)}">` +
      `<rect class="ch-hit" x="${x(i) - step / 2}" y="${LM.top}" width="${step}" height="${plotH}"/>` +
      `<g class="ch-cursor"><line x1="${x(i)}" x2="${x(i)}" y1="${LM.top}" y2="${LM.top + plotH}"/></g></g>`;
  }
  return `<svg class="ch" width="${width}" height="${h}">${grid}${marks}${cols}</svg>`;
}

/** An axis of a bubble chart: its quantity and unit, log or linear, and a line across at `at` (a threshold). */
export interface BubbleAxis {
  name: string;
  unit: string;
  log?: boolean;
  at?: number;
}

export interface Bubble {
  sub: string;
  label: string;
  x: number;
  y: number;
  /** The dot's area (its largest is full size). */
  size: number;
  /** A CSS colour (else the World's grey). */
  color?: string;
  emphasis?: boolean;
  /** Where it was (a base year): an arrow comes from there. */
  from?: { x: number; y: number };
}

const BM = { left: 46, right: 12, top: 22, bottom: 36 };
const BUBBLE_R = 15;

/** An axis's scale: from value to pixels [a, b], with its ticks (powers of ten when log). */
function axisScale(axis: BubbleAxis, values: number[], a: number, b: number) {
  const ok = values.filter((v) => Number.isFinite(v) && (!axis.log || v > 0));
  // (The line across may have no value: `??` would let NaN through.)
  const at = Number.isFinite(axis.at) && (!axis.log || axis.at! > 0) ? axis.at : undefined;
  if (!ok.length && at === undefined) return { ticks: [] as number[], at: () => NaN, ok: () => false };
  if (axis.log) {
    const lo = Math.floor(Math.log10(Math.min(...ok, at ?? Infinity)));
    const hi = Math.ceil(Math.log10(Math.max(...ok, at ?? 0)));
    const [l0, l1] = [lo, Math.max(hi, lo + 1)];
    const ticks: number[] = [];
    for (let k = l0; k <= l1; k++) ticks.push(10 ** k);
    return { ticks, at: (v: number) => a + ((Math.log10(v) - l0) / (l1 - l0)) * (b - a), ok: (v: number) => Number.isFinite(v) && v > 0 };
  }
  const ticks = niceTicks(Math.min(0, ...ok, at ?? 0), Math.max(...ok, at ?? 0, 1e-9), 4);
  const [t0, t1] = [ticks[0], ticks[ticks.length - 1]];
  return { ticks, at: (v: number) => a + ((v - t0) / (t1 - t0 || 1)) * (b - a), ok: Number.isFinite };
}

/**
 * One dot per area: x against y, its area by `size`, in its colour (else grey); those
 * with `from` get an arrow from where they were. `corners` label the quadrants the
 * axes' `at` lines make (top left, top right, bottom left, bottom right).
 */
export function bubbles({
  points,
  x: xAxis,
  y: yAxis,
  size,
  series = [],
  corners,
  width,
  height = 280,
}: {
  points: Bubble[];
  x: BubbleAxis;
  y: BubbleAxis;
  size: { name: string; unit: string };
  /** The legend: what the colours stand for. */
  series?: Series[];
  corners?: [string, string, string, string];
  width: number;
  height?: number;
}) {
  const sx = axisScale(xAxis, points.flatMap((p) => [p.x, p.from?.x ?? NaN]), BM.left, width - BM.right);
  const sy = axisScale(yAxis, points.flatMap((p) => [p.y, p.from?.y ?? NaN]), height - BM.bottom, BM.top);
  const ok = points.filter((p) => sx.ok(p.x) && sy.ok(p.y));
  if (!ok.length) return legend(series) + `<p class="ch-empty">No data</p>`;
  const biggest = Math.max(...ok.map((p) => p.size).filter((v) => Number.isFinite(v) && v > 0), 1e-9);
  const r = (p: Bubble) => (Number.isFinite(p.size) && p.size > 0 ? Math.max(2.5, BUBBLE_R * Math.sqrt(p.size / biggest)) : 2.5);
  const [x0, x1, y0, y1] = [BM.left, width - BM.right, BM.top, height - BM.bottom];
  const grid =
    // (The ends' labels inside the plot's width, below the lowest of the value axis.)
    sx.ticks.map((t, i) => `<line class="ts-grid" x1="${sx.at(t)}" x2="${sx.at(t)}" y1="${y0}" y2="${y1}"/>` +
      `<text class="ts-label" x="${sx.at(t)}" y="${y1 + 16}" text-anchor="${i === 0 ? "start" : i === sx.ticks.length - 1 ? "end" : "middle"}">${fmt(t)}</text>`).join("") +
    sy.ticks.map((t) => `<line class="ts-grid" x1="${x0}" x2="${x1}" y1="${sy.at(t)}" y2="${sy.at(t)}"/>` +
      `<text class="ts-label" x="${x0 - 5}" y="${sy.at(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`).join("") +
    `<text class="ts-label ch-axis" x="${x1}" y="${height - 1}" text-anchor="end">${axisTitle(xAxis.name + (xAxis.log ? ", log" : ""), xAxis.unit)} →</text>` +
    `<text class="ts-label ch-axis" x="0" y="${BM.top - 10}">↑ ${axisTitle(yAxis.name + (yAxis.log ? ", log" : ""), yAxis.unit)}</text>`;
  const lines =
    (xAxis.at !== undefined && sx.ok(xAxis.at) ? `<line class="ch-equal" x1="${sx.at(xAxis.at)}" x2="${sx.at(xAxis.at)}" y1="${y0}" y2="${y1}"/>` : "") +
    (yAxis.at !== undefined && sy.ok(yAxis.at) ? `<line class="ch-equal" x1="${x0}" x2="${x1}" y1="${sy.at(yAxis.at)}" y2="${sy.at(yAxis.at)}"/>` : "");
  const quadrants = corners
    ? [
        [x0 + 4, y0 + 10, "start"],
        [x1 - 4, y0 + 10, "end"],
        [x0 + 4, y1 - 5, "start"],
        [x1 - 4, y1 - 5, "end"],
      ].map(([x, y, anchor], i) => (corners[i] ? `<text class="ts-label ch-corner" x="${x}" y="${y}" text-anchor="${anchor}">${esc(corners[i])}</text>` : "")).join("")
    : "";
  const tipOf = (p: Bubble) =>
    `<b>${esc(p.label)}</b><br>${esc(xAxis.name)}: ${fmt(p.x)} ${esc(xAxis.unit)}<br>${esc(yAxis.name)}: ${fmt(p.y)} ${esc(yAxis.unit)}` +
    `<br>${esc(size.name)}: ${fmt(p.size)} ${esc(size.unit)}` +
    (p.from ? `<br><span class="tip-hint">Was ${fmt(p.from.x)} ${esc(xAxis.unit)}, ${fmt(p.from.y)} ${esc(yAxis.unit)}</span>` : "");
  // Big dots first (under), the emphasised last (on top).
  const order = [...ok].sort((a, b) => Number(a.emphasis ?? false) - Number(b.emphasis ?? false) || b.size - a.size);
  const arrows = order
    .filter((p) => p.from && sx.ok(p.from.x) && sy.ok(p.from.y))
    .map((p) => `<line class="ch-arrow${p.emphasis ? " em" : ""}" x1="${sx.at(p.from!.x).toFixed(1)}" y1="${sy.at(p.from!.y).toFixed(1)}" x2="${sx.at(p.x).toFixed(1)}" y2="${sy.at(p.y).toFixed(1)}"/>`)
    .join("");
  const dots = order
    .map((p) => {
      const [cx, cy, rr] = [sx.at(p.x), sy.at(p.y), r(p)];
      return `<g class="ch-point ch-bubble${p.emphasis ? " em" : ""}" data-sub="${esc(p.sub)}" data-tip="${esc(tipOf(p))}">` +
        `<circle class="ch-hit" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${Math.max(8, rr).toFixed(1)}"/>` +
        `<circle class="ch-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}" style="fill:${p.color ?? "var(--c-world)"}"/>` +
        pinAt(cx - 5, cy - rr - 12) + "</g>";
    })
    .join("");
  return legend(series) + `<svg class="ch" width="${width}" height="${height}">${grid}${lines}${quadrants}${arrows}${dots}</svg>`;
}

/**
 * A grid of values: a row per item of `rows` (years, say), a column per item of `cols`
 * (months), each cell in `color(value)`. A cell's `sub` is what hovering it shows on the
 * map; with `x`, clicking it selects that (data-x).
 */
export function heatmap({
  rows,
  cols,
  value,
  color,
  unit,
  name,
  sub,
  x,
  width,
}: {
  rows: { key: number; label: string }[];
  cols: { key: number; label: string }[];
  value: (row: number, col: number) => number;
  color: (v: number) => string | null;
  unit: string;
  name: string;
  sub?: (row: number, col: number) => string | null;
  x?: (row: number, col: number) => number | null;
  width: number;
}) {
  if (!rows.length || !cols.length) return `<p class="ch-empty">No data</p>`;
  const left = 36;
  const cw = Math.max(8, (width - left - 2) / cols.length);
  const ch = Math.min(22, Math.max(12, cw * 0.8));
  const top = 14;
  const h = top + rows.length * ch + 2;
  const head = cols.map((c, j) => `<text class="ts-label" x="${(left + (j + 0.5) * cw).toFixed(1)}" y="${top - 4}" text-anchor="middle">${esc(c.label)}</text>`).join("");
  let cells = "";
  rows.forEach((r, i) => {
    cells += `<text class="ts-label" x="${left - 5}" y="${(top + (i + 0.5) * ch + 3.5).toFixed(1)}" text-anchor="end">${esc(r.label)}</text>`;
    cols.forEach((c, j) => {
      const v = value(r.key, c.key);
      const fill = Number.isFinite(v) ? color(v) : null;
      const s = sub?.(r.key, c.key) ?? null;
      const click = x?.(r.key, c.key) ?? null;
      const tip = `<b>${esc(c.label)} ${esc(r.label)}</b><br>${esc(name)}: ${fmt(v)} ${esc(unit)}` +
        (click !== null && fill ? `<br><span class="tip-hint">Click to select ${esc(c.label)} ${esc(r.label)}</span>` : "");
      const attrs = (s && fill ? ` data-sub="${esc(s)}"` : "") + (click !== null && fill ? ` data-x="${click}"` : "") + ` data-tip="${esc(tip)}"`;
      cells += `<g class="ch-cell${click !== null && fill ? " clickable" : ""}"${attrs}>` +
        `<rect x="${(left + j * cw + 1).toFixed(1)}" y="${(top + i * ch + 1).toFixed(1)}" width="${(cw - 2).toFixed(1)}" height="${(ch - 2).toFixed(1)}" rx="2" ` +
        `style="fill:${fill ?? "transparent"}"${fill ? "" : ` class="ch-cell-none"`}/></g>`;
    });
  });
  return `<svg class="ch" width="${width}" height="${h}">${head}${cells}</svg>`;
}

export interface ScatterPoint {
  sub: string;
  label: string;
  x: number;
  y: number;
  emphasis?: boolean;
}

const SM = { left: 44, right: 12, top: 8, bottom: 32 };

/**
 * One dot per item, x against y on the same scale (both in `unit`), with the line
 * where they are equal: above it y is larger.
 */
export function scatter({
  points,
  xName,
  yName,
  unit,
  color,
  width,
  height = 240,
}: {
  points: ScatterPoint[];
  xName: string;
  yName: string;
  unit: string;
  color: string;
  width: number;
  height?: number;
}) {
  const ok = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!ok.length) return `<p class="ch-empty">No data</p>`;
  const ticks = niceTicks(0, Math.max(...ok.flatMap((p) => [p.x, p.y]), 1e-9), 4);
  const top = ticks[ticks.length - 1];
  const w = width;
  const h = height;
  const x = (v: number) => SM.left + (v / top) * (w - SM.left - SM.right);
  const y = (v: number) => SM.top + (1 - v / top) * (h - SM.top - SM.bottom);
  const grid = ticks
    .map((t) => `<line class="ts-grid" x1="${SM.left}" x2="${w - SM.right}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="ts-label" x="${SM.left - 5}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>` +
      `<text class="ts-label" x="${x(t)}" y="${h - SM.bottom + 13}" text-anchor="middle">${fmt(t)}</text>`)
    .join("");
  const axes = `<text class="ts-label" x="${w - SM.right}" y="${h - 3}" text-anchor="end">${esc(xName)} (${esc(unit)}) →</text>` +
    `<text class="ts-label" x="${SM.left + 4}" y="${SM.top + 10}">↑ ${esc(yName)}</text>`;
  const diagonal = `<line class="ch-equal" x1="${x(0)}" y1="${y(0)}" x2="${x(top)}" y2="${y(top)}"/>` +
    `<text class="ts-label" x="${x(top) - 4}" y="${y(top) + 12}" text-anchor="end">equal</text>`;
  // Emphasised dots last, so they are drawn on top.
  const order = [...ok].sort((a, b) => Number(a.emphasis ?? false) - Number(b.emphasis ?? false));
  const dots = order
    .map((p) => {
      const tip = `<b>${esc(p.label)}</b><br>${esc(xName)}: ${fmt(p.x)} ${esc(unit)}<br>${esc(yName)}: ${fmt(p.y)} ${esc(unit)}`;
      return `<g class="ch-point${p.emphasis ? " em" : ""}" data-sub="${esc(p.sub)}" data-tip="${esc(tip)}">` +
        `<circle class="ch-hit" cx="${x(p.x)}" cy="${y(p.y)}" r="8"/>` +
        `<circle class="ch-dot" cx="${x(p.x)}" cy="${y(p.y)}" r="${p.emphasis ? 5 : 4}" style="fill:${color}"/>${pinAt(x(p.x) - 5, y(p.y) - 17)}</g>`;
    })
    .join("");
  return `<svg class="ch" width="${w}" height="${h}">${grid}${diagonal}${axes}${dots}</svg>`;
}

function niceStep(span: number, count: number) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

/** Round ticks covering [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number) {
  const step = niceStep(hi - lo || 1, count);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) ticks.push(Math.round(v / step) * step);
  if (ticks.length < 2) ticks.push(ticks[0] + step);
  return ticks;
}
