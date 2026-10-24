/*
 * The Country panel's charts, as HTML strings (a legend, when there is more than one
 * series, and an SVG), drawn from scratch on every update like the Basin view's.
 *
 * - bars:    horizontal bars, one row per area, one bar per series (e.g. 2015 and the
 *            selected year); also the rankings (one series)
 * - shares:  100 % stacked bars, one row per area (withdrawal by sector, …)
 * - lines:   values over the years, one line per series (country, region, World)
 *
 * The panel makes them interactive through data attributes:
 * - data-tip:  the tooltip's HTML for the mark under the pointer
 * - data-sub:  what the mark stands for (an area, or a series' variable): the map
 *              follows it while the pointer is over it
 * - data-x:    a year (or month) of a line chart: clicking it selects it
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function legend(series: Series[]) {
  if (series.length < 2) return "";
  return `<div class="ch-legend">${series
    .map((s) => `<span class="ch-key"${s.sub ? ` data-sub="${esc(s.sub)}"` : ""}><i style="background:${s.color}"></i>${esc(s.label)}</span>`)
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

function rowLabel(label: string, y: number, emphasis = false) {
  const short = label.length > 22 ? `${label.slice(0, 21)}…` : label;
  return `<text class="ch-row-label${emphasis ? " em" : ""}" x="0" y="${y}">${esc(short)}</text>`;
}

/** Horizontal bars; `series` in drawing order (the last one gets the value label). */
export function bars({ series, rows, unit, width }: { series: Series[]; rows: BarRow[]; unit: string; width: number }) {
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
  const h = rows.length * rowH + AXIS_H;

  const grid = ticks
    .map((t) => `<line class="ts-grid" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${h - AXIS_H}"/>` +
      `<text class="ts-label" x="${x(t)}" y="${h - 5}" text-anchor="middle">${fmt(t)}</text>`)
    .join("");
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
  const zero = lo < 0 ? `<line class="ts-zero" x1="${x(0)}" x2="${x(0)}" y1="0" y2="${h - AXIS_H}"/>` : "";
  return legend(series) + `<svg class="ch" width="${width}" height="${h}">${grid}${zero}${body}</svg>`;
}

/** 100 % stacked bars: each row's values are split into its parts' shares. */
export function shares({ parts, rows, unit, width }: { parts: (Series & { ink: "light" | "dark" })[]; rows: BarRow[]; unit: string; width: number }) {
  if (!rows.length) return "";
  const rowH = 16 + ROW_PAD;
  const plotW = Math.max(60, width - LABEL_W - 4);
  const h = rows.length * rowH + AXIS_H;
  const x = (f: number) => LABEL_W + f * plotW;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<line class="ts-grid" x1="${x(f)}" x2="${x(f)}" y1="0" y2="${h - AXIS_H}"/>` +
      `<text class="ts-label" x="${x(f)}" y="${h - 5}" text-anchor="${f === 1 ? "end" : f === 0 ? "start" : "middle"}">${f * 100}%</text>`)
    .join("");
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

const LM = { left: 40, right: 12, top: 8, bottom: 20 };

/**
 * Lines over the years (or other steps: months) [from, to], named by `label`.
 * `selected` (the top bar's year) is marked; `clickable` steps can be clicked to
 * select them.
 */
export function lines({
  series,
  from,
  to,
  selected,
  unit,
  width,
  height = 170,
  clickable,
  label = String,
}: {
  series: LineSeries[];
  from: number;
  to: number;
  selected: number;
  unit: string;
  width: number;
  height?: number;
  clickable: (year: number) => boolean;
  label?: (x: number) => string;
}) {
  const all = series.flatMap((s) => [...s.values].filter(([y, v]) => y >= from && y <= to && Number.isFinite(v)).map(([, v]) => v));
  if (!all.length) return legend(series) + `<p class="ch-empty">No data</p>`;
  const lo = Math.min(0, ...all);
  const ticks = niceTicks(lo, Math.max(...all, lo + 1e-9), 4);
  const [y0, y1] = [ticks[0], ticks[ticks.length - 1]];
  const w = width;
  const h = height;
  const step = (w - LM.left - LM.right) / Math.max(1, to - from);
  const x = (year: number) => LM.left + (year - from) * step;
  const y = (v: number) => LM.top + (1 - (v - y0) / (y1 - y0 || 1)) * (h - LM.top - LM.bottom);

  const grid = ticks
    .map((t) => `<line class="ts-grid" x1="${LM.left}" x2="${w - LM.right}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="ts-label" x="${LM.left - 5}" y="${y(t) + 3.5}" text-anchor="end">${fmt(t)}</text>`)
    .join("");
  const every = Math.ceil((to - from + 1) / Math.max(2, Math.floor((w - LM.left - LM.right) / 44)));
  const years: number[] = [];
  for (let yr = from; yr <= to; yr++) years.push(yr);
  const xTicks = years
    .filter((yr) => (to - yr) % every === 0)
    .map((yr) => `<text class="ts-label" x="${x(yr)}" y="${h - 5}" text-anchor="middle">${label(yr)}</text>`)
    .join("");
  const mark = selected >= from && selected <= to
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
      const dot = v !== undefined && Number.isFinite(v)
        ? `<circle class="ch-dot" cx="${x(selected)}" cy="${y(v)}" r="4" style="fill:${s.color}"/>`
        : "";
      return `<path class="ch-line${s.emphasis ? " em" : ""}" d="${d}" style="stroke:${s.color}"/>${dot}`;
    })
    .join("");
  // One column per year: hover to read all series, click to select the year.
  const cols = years
    .map((yr) => {
      const tip = `<b>${label(yr)}</b>` + series.map((s) => `<br>${esc(s.label)}: ${fmt(s.values.get(yr) ?? NaN)} ${esc(unit)}`).join("") +
        (clickable(yr) && yr !== selected ? `<br><span class="tip-hint">Click to show ${label(yr)} on the map</span>` : "");
      const dots = series
        .map((s) => {
          const v = s.values.get(yr);
          return v !== undefined && Number.isFinite(v) ? `<circle class="ch-dot" cx="${x(yr)}" cy="${y(v)}" r="4" style="fill:${s.color}"/>` : "";
        })
        .join("");
      return `<g class="ch-col${clickable(yr) ? " clickable" : ""}"${clickable(yr) ? ` data-x="${yr}"` : ""} data-tip="${esc(tip)}">` +
        `<rect class="ch-hit" x="${x(yr) - step / 2}" y="${LM.top}" width="${step}" height="${h - LM.top - LM.bottom}"/>` +
        `<g class="ch-cursor"><line x1="${x(yr)}" x2="${x(yr)}" y1="${LM.top}" y2="${h - LM.bottom}"/>${dots}</g></g>`;
    })
    .join("");
  return legend(series) +
    `<svg class="ch" width="${w}" height="${h}">${grid}${mark}${paths}${xTicks}${cols}</svg>`;
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
        `<circle class="ch-dot" cx="${x(p.x)}" cy="${y(p.y)}" r="${p.emphasis ? 5 : 4}" style="fill:${color}"/></g>`;
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
