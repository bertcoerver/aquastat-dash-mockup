/*
 * The time series of one variable at the selected sub-basin, as two charts:
 *
 * - an overview of the whole record, with the selected period as a band. Drag across
 *   it to choose another period, or drag the band to move it; the date range in the
 *   top bar follows.
 * - the selected period up close, with the long-term mean (dashed) for comparison, or
 *   with `seasonal`, each dekad's average over the years (the same dekad of the year),
 *   with a band of ± one standard deviation over the years. With `daysIn`, it's the
 *   total since the start of the period instead, from zero; the average and band are
 *   then those of the same days' totals in every year. Hover it to read single dekads.
 *
 * With `windows`, the overview shows totals too: over the same days of every year (the
 * period, moved by whole years), each from zero; nothing between them.
 *
 * Plain SVG, redrawn from scratch on every update (a few hundred points at most).
 */
import { MONTHS, dkD, dkM, dkY, fmtEnd, fmtStart } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import { mean } from "./model";
import { fmt } from "./variables";

export interface TimeseriesData {
  dekads: number[];
  values: Float64Array;
  /** The selected period (within the record), or null: none. */
  range: DekadRange | null;
  color: string;
  unit: string;
  /** The zoomed chart's y axis title (default: the unit). */
  yLabel?: string;
  /** Makes the y axis title a button, which runs this; `yLabelHint` is its tooltip. */
  onYLabel?: () => void;
  yLabelHint?: string;
  /** Compare with each dekad of the year's average over the record, instead of the overall mean. */
  seasonal?: boolean;
  /**
   * Show the total since the start of the period: a value is per day, and counts for
   * this many of each dekad's days (those in the period; 0 outside it).
   */
  daysIn?: (dk: number) => number;
  /**
   * The overview as totals over windows (the period in each year): the window a dekad
   * is in (any id) and how many of its days count; null outside them.
   */
  windows?: (dk: number) => { window: number; days: number } | null;
}

const OVERVIEW_H = 64;
const ZOOM_H = 190;
const M = { left: 58, right: 10, top: 10, bottom: 22 }; // zoomed chart margins (left: room for the y axis title)

/**
 * `onBrush` runs while a period is dragged on the overview (`done`: the drag ended).
 * Returns a function that redraws both charts (null: empty).
 */
export function initTimeseries(
  overview: HTMLElement,
  zoom: HTMLElement,
  onBrush: (range: DekadRange, done: boolean) => void,
): (data: TimeseriesData | null) => void {
  let data: TimeseriesData | null = null;
  let hoverIndex: number | null = null;

  // The zoomed chart is redrawn on every hover, so its y axis title, when it's a button,
  // lives next to it: it keeps focus when clicked.
  const plot = document.createElement("div");
  const yButton = document.createElement("button");
  yButton.type = "button";
  yButton.className = "ts-axis-button";
  yButton.hidden = true;
  yButton.addEventListener("click", () => data?.onYLabel?.());
  zoom.append(plot, yButton);

  // --- Overview: whole record, brushable ---------------------------------------
  function overviewScale() {
    const { dekads } = data!;
    const w = overview.clientWidth;
    const first = dekads[0];
    const span = dekads[dekads.length - 1] + 1 - first;
    return {
      w,
      x: (boundary: number) => M.left + ((boundary - first) / span) * (w - M.left - M.right),
      dekadAt: (px: number) =>
        Math.max(first, Math.min(first + span - 1, Math.floor(first + ((px - M.left) / (w - M.left - M.right)) * span))),
    };
  }

  function drawOverview() {
    if (!data || !data.dekads.length) return void (overview.innerHTML = "");
    const { dekads, values, range, color } = data;
    const { w, x } = overviewScale();
    const h = OVERVIEW_H;
    const plotH = h - 16;
    // Each dekad's value at its middle, or its window's total at its end, from zero at
    // the window's start (a gap leaves the rest of that window's total unknown).
    const pts: { at: number; v: number }[] = [];
    if (data.windows) {
      let total = totaller(values);
      let current: number | null = null;
      dekads.forEach((dk, i) => {
        const w = data!.windows!(dk);
        if (!w) {
          current = null;
          return pts.push({ at: dk + 1, v: Number.NaN });
        }
        if (w.window !== current) {
          if (current !== null) pts.push({ at: dk, v: Number.NaN }); // windows that touch
          pts.push({ at: dk, v: 0 });
          current = w.window;
          total = totaller(values);
        }
        pts.push({ at: dk + 1, v: total.add(i, w.days) });
      });
    } else {
      dekads.forEach((dk, i) => pts.push({ at: dk + 0.5, v: values[i] }));
    }
    const [lo, hi] = extent(Float64Array.from(pts, (p) => p.v), 0);
    const y = (v: number) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (plotH - 4);
    const line = path(pts.map((p) => [x(p.at), y(p.v)]));
    const years = [];
    for (let yr = dkY(dekads[0]); yr <= dkY(dekads[dekads.length - 1]); yr++) {
      const b = Math.max((yr - dkY(0)) * 36, dekads[0]);
      years.push(`<line class="ts-grid" x1="${x(b)}" x2="${x(b)}" y1="0" y2="${plotH}"/>` +
        `<text class="ts-label" x="${x(b) + 3}" y="${h - 3}">${yr}</text>`);
    }
    const band = range
      ? `<rect class="ts-band" x="${x(range.start)}" y="0" width="${Math.max(2, x(range.end + 1) - x(range.start))}" height="${plotH}"/>`
      : "";
    overview.innerHTML = `<svg width="${w}" height="${h}" class="ts-overview">
      ${years.join("")}${band}
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.2"/>
      <rect class="ts-frame" x="${M.left}" y="0" width="${w - M.left - M.right}" height="${plotH}"/>
    </svg>`;
  }

  // Drag: inside the band moves it, elsewhere draws a new one.
  overview.addEventListener("pointerdown", (e) => {
    if (!data?.dekads.length || e.button !== 0) return;
    const { dekadAt } = overviewScale();
    const px = (ev: PointerEvent) => ev.clientX - overview.getBoundingClientRect().left;
    const first = data.dekads[0];
    const last = data.dekads[data.dekads.length - 1];
    const startDk = dekadAt(px(e));
    const band = data.range;
    const moving = band && startDk >= band.start && startDk <= band.end ? band : null;
    overview.setPointerCapture(e.pointerId);
    e.preventDefault();

    let current: DekadRange = moving ?? { start: startDk, end: startDk };
    if (!moving) onBrush(current, false);
    const move = (ev: PointerEvent) => {
      const dk = dekadAt(px(ev));
      let next: DekadRange;
      if (moving) {
        const len = moving.end - moving.start;
        const start = Math.max(first, Math.min(last - len, moving.start + dk - startDk));
        next = { start, end: start + len };
      } else {
        next = { start: Math.min(startDk, dk), end: Math.max(startDk, dk) };
      }
      if (next.start === current.start && next.end === current.end) return;
      current = next;
      onBrush(current, false);
    };
    const up = () => {
      overview.removeEventListener("pointermove", move);
      overview.removeEventListener("pointerup", up);
      overview.removeEventListener("pointercancel", up);
      onBrush(current, true);
    };
    overview.addEventListener("pointermove", move);
    overview.addEventListener("pointerup", up);
    overview.addEventListener("pointercancel", up);
  });

  // --- Zoomed: the selected period ----------------------------------------------
  /** The zoomed chart as drawn (its scales and series), for the hover to draw into. */
  let zoomed: {
    from: number;
    to: number;
    series: Float64Array;
    reference: Float64Array | number[] | null;
    std: Float64Array | number[] | null;
    x: (boundary: number) => number;
    y: (v: number) => number;
    at: (dk: number) => number;
    w: number;
    h: number;
    hoverEl: SVGGElement;
  } | null = null;
  function drawZoom() {
    zoomed = null;
    yButton.hidden = !data?.range || !data.onYLabel;
    if (!data?.range) return void (plot.innerHTML = "");
    const { dekads, values, range, color, unit } = data;
    const w = zoom.clientWidth;
    const h = ZOOM_H;
    const from = dekads.findIndex((dk) => dk >= range.start);
    let to = dekads.findIndex((dk) => dk > range.end);
    if (to < 0) to = dekads.length;
    const longTerm = mean(values);
    const { daysIn } = data;
    // What's drawn for each dekad of the period: its value at its middle, or the total
    // up to its end (a gap leaves the rest of the total unknown).
    const at = (dk: number) => (daysIn ? dk + 1 : dk + 0.5);
    const series = new Float64Array(to - from);
    const total = totaller(values);
    for (let i = from; i < to; i++) series[i - from] = daysIn ? total.add(i, daysIn(dekads[i])) : values[i];
    // A total starts from zero at the start of the period.
    const fromZero = !!daysIn;
    // The average over the years and its spread, for each dekad of the period.
    const stats = daysIn ? yearlyTotals(dekads, values, from, to, daysIn) : data.seasonal ? dekadOfYearStats(dekads, values, from, to) : null;
    const reference = stats?.mean ?? null;
    const spread = stats ? Array.from(stats.mean, (m, j) => [m - stats.std[j], m + stats.std[j]]).flat() : [];
    const [lo, hi] = niceExtent(extent(series, 0, ...(reference ?? [longTerm]), ...spread));
    const x = (boundary: number) => M.left + ((boundary - range.start) / (range.end + 1 - range.start)) * (w - M.left - M.right);
    const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * (h - M.top - M.bottom);

    const yTicks = niceTicks(lo, hi, 4)
      .map((v) => `<line class="ts-grid" x1="${M.left}" x2="${w - M.right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="ts-label" x="${M.left - 5}" y="${y(v) + 3.5}" text-anchor="end">${fmtTick(v)}</text>`)
      .join("");
    const xTicks = dekadTicks(range, (w - M.left - M.right) / 70)
      .map((t) => {
        // A label at the right end would run off the chart: end it at the tick instead.
        const anchor = x(t.dk) > w - M.right - 25 ? "end" : "middle";
        return `<line class="ts-tick" x1="${x(t.dk)}" x2="${x(t.dk)}" y1="${h - M.bottom}" y2="${h - M.bottom + 4}"/>` +
          `<text class="ts-label" x="${x(t.dk)}" y="${h - 6}" text-anchor="${anchor}">${t.label}</text>`;
      })
      .join("");
    // A total starts from zero at the start of the period.
    const points = (vs: Float64Array) => {
      const pts: [number, number][] = fromZero ? [[x(range.start), y(0)]] : [];
      vs.forEach((v, k) => pts.push([x(at(dekads[from + k])), y(v)]));
      return pts;
    };
    const pts = points(series);
    const dots = to - from <= 40 ? pts.filter(([, py]) => Number.isFinite(py)).map(([px, py]) => `<circle cx="${px}" cy="${py}" r="2.2" fill="${color}"/>`).join("") : "";
    // ± one standard deviation, behind the average (from zero for a total).
    const bandPts: [number, number, number][] = fromZero ? [[x(range.start), y(0), y(0)]] : [];
    if (stats) stats.mean.forEach((m, j) => bandPts.push([x(at(dekads[from + j])), y(m - stats.std[j]), y(m + stats.std[j])]));
    const spreadBand = stats ? `<path class="ts-spread" d="${areaPath(bandPts)}"/>` : "";
    const meanLine = reference
      ? `<path class="ts-mean" fill="none" d="${path(points(reference))}"/>`
      : Number.isFinite(longTerm)
        ? `<line class="ts-mean" x1="${M.left}" x2="${w - M.right}" y1="${y(longTerm)}" y2="${y(longTerm)}"/>`
        : "";
    const zero = lo < 0 ? `<line class="ts-zero" x1="${M.left}" x2="${w - M.right}" y1="${y(0)}" y2="${y(0)}"/>` : "";

    const yLabel = data.yLabel ?? unit;
    let yTitle = "";
    if (data.onYLabel) {
      yButton.textContent = yLabel;
      yButton.title = data.yLabelHint ?? "";
      Object.assign(yButton.style, { top: `${M.top}px`, height: `${h - M.top - M.bottom}px` });
    } else {
      yTitle = `<text class="ts-axis" transform="translate(11 ${(M.top + h - M.bottom) / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>`;
    }
    plot.innerHTML = `<svg width="${w}" height="${h}" class="ts-zoom">
      ${yTitle}${yTicks}${zero}${spreadBand}${meanLine}
      <path d="${path(pts)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
      ${dots}${xTicks}<g class="ts-hover"></g>
    </svg>`;
    zoomed = { from, to, series, reference, std: stats?.std ?? null, x, y, at, w, h, hoverEl: plot.querySelector<SVGGElement>(".ts-hover")! };
    drawHover();
  }

  /** The hovered dekad's cursor and readout, into the chart as drawn (not the whole chart again at every move). */
  function drawHover() {
    if (!data?.range || !zoomed) return;
    const { from, to, series, reference, std, x, y, at, w, h, hoverEl } = zoomed;
    const { dekads, color, unit, daysIn } = data;
    let hover = "";
    if (hoverIndex !== null && hoverIndex >= from && hoverIndex < to) {
      const dk = dekads[hoverIndex];
      const v = series[hoverIndex - from];
      const hx = x(at(dk));
      const label = `${daysIn ? `Up to ${fmtEnd(dk)}` : `${fmtStart(dk)} – ${fmtEnd(dk)}`}: ${fmt(v)} ${unit}`;
      const right = hx > w / 2;
      const tx = right ? hx - 6 : hx + 6;
      // The average on a line of its own.
      const sd = std?.[hoverIndex - from] ?? Number.NaN;
      const average = reference
        ? `<tspan x="${tx}" dy="14">average: ${fmt(reference[hoverIndex - from])}${Number.isFinite(sd) ? ` ± ${fmt(sd)}` : ""} ${unit}</tspan>`
        : "";
      hover = `<line class="ts-cursor" x1="${hx}" x2="${hx}" y1="${M.top}" y2="${h - M.bottom}"/>` +
        (Number.isFinite(v) ? `<circle cx="${hx}" cy="${y(v)}" r="3.5" fill="${color}" class="ts-dot"/>` : "") +
        `<text class="ts-readout" x="${tx}" y="${M.top + 10}" text-anchor="${right ? "end" : "start"}">${label}${average}</text>`;
    }
    hoverEl.innerHTML = hover;
  }

  zoom.addEventListener("pointermove", (e) => {
    if (!data?.range) return;
    const w = zoom.clientWidth;
    const px = e.clientX - zoom.getBoundingClientRect().left;
    const dk = Math.floor(data.range.start + ((px - M.left) / (w - M.left - M.right)) * (data.range.end + 1 - data.range.start));
    // (The dekads run on without gaps, so the first's number gives any one's index; if not, it's looked for.)
    const guess = dk - data.dekads[0];
    const i = guess >= 0 && guess < data.dekads.length && data.dekads[guess] === dk ? guess : data.dekads.indexOf(dk);
    const next = i < 0 ? null : i;
    if (next === hoverIndex) return;
    hoverIndex = next;
    drawHover();
  });
  zoom.addEventListener("pointerleave", () => {
    hoverIndex = null;
    drawHover();
  });

  new ResizeObserver(() => {
    drawOverview();
    drawZoom();
  }).observe(overview);

  return (next) => {
    data = next;
    drawOverview();
    drawZoom();
  };
}

/** A y axis label: large ones as "3.6M", to fit next to the axis title. */
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const fmtTick = (v: number) => (Math.abs(v) >= 1e5 ? compact.format(v) : fmt(v));

/** Mean and sample standard deviation of the finite values (std NaN with fewer than 2). */
function meanStd(vs: number[]): [number, number] {
  const ok = vs.filter(Number.isFinite);
  if (!ok.length) return [Number.NaN, Number.NaN];
  const m = ok.reduce((a, b) => a + b, 0) / ok.length;
  const sd = ok.length < 2 ? Number.NaN : Math.sqrt(ok.reduce((a, v) => a + (v - m) ** 2, 0) / (ok.length - 1));
  return [m, sd];
}

/** For dekads[from..to): the same dekad of the year's mean and spread over the years. */
function dekadOfYearStats(dekads: number[], values: Float64Array, from: number, to: number) {
  const byDekad: number[][] = Array.from({ length: 36 }, () => []);
  dekads.forEach((dk, i) => byDekad[dk % 36].push(values[i]));
  const stats = byDekad.map(meanStd);
  const mean = new Float64Array(to - from);
  const std = new Float64Array(to - from);
  for (let i = from; i < to; i++) [mean[i - from], std[i - from]] = stats[dekads[i] % 36];
  return { mean, std };
}

/**
 * For dekads[from..to): the total up to each dekad's end over the same days of every
 * year in the record (the period moved by whole years, so by 36 dekads), and the spread
 * of those totals. A year counts as far as its total can be made (no gaps, in the record).
 */
function yearlyTotals(dekads: number[], values: Float64Array, from: number, to: number, daysIn: (dk: number) => number) {
  const index = new Map(dekads.map((dk, i) => [dk, i]));
  const n = to - from;
  const totals: number[][] = Array.from({ length: n }, () => []);
  const years = Math.ceil(dekads.length / 36) + 1;
  for (let k = -years; k <= years; k++) {
    const total = totaller(values);
    for (let j = 0; j < n; j++) {
      const i = index.get(dekads[from + j] + 36 * k);
      if (i === undefined) break;
      const v = total.add(i, daysIn(dekads[from + j]));
      if (total.gap) break;
      totals[j].push(v);
    }
  }
  const mean = new Float64Array(n);
  const std = new Float64Array(n);
  totals.forEach((t, j) => ([mean[j], std[j]] = meanStd(t)));
  return { mean, std };
}

/** A running total of dekads' values, each for some days. After a gap (no value) it stays unknown: `gap`. */
function totaller(values: Float64Array) {
  let sum = 0;
  return {
    get gap() {
      return Number.isNaN(sum);
    },
    add: (i: number, days: number) => (sum += values[i] * days),
  };
}

/** SVG area between two lines ([x, y1, y2] points); gaps (NaN) break it. */
function areaPath(points: [number, number, number][]) {
  let d = "";
  let run: [number, number, number][] = [];
  const flush = () => {
    if (run.length > 1) {
      d += run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
      d += run.reverse().map(([x, , y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("") + "Z";
    }
    run = [];
  };
  for (const p of points) {
    if (Number.isFinite(p[1]) && Number.isFinite(p[2])) run.push(p);
    else flush();
  }
  flush();
  return d;
}

/** SVG path through the points; gaps (NaN) break the line. */
function path(points: [number, number][]) {
  let d = "";
  let pen = false;
  for (const [x, y] of points) {
    if (!Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Min and max of the finite values and any extra values. */
function extent(values: Float64Array, ...extra: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of [...values, ...extra]) {
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

function niceStep(span: number, count: number) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

function niceExtent([lo, hi]: [number, number]): [number, number] {
  if (hi === lo) return [lo - 1, hi + 1];
  const step = niceStep(hi - lo, 4);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

function niceTicks(lo: number, hi: number, count: number) {
  const step = niceStep(hi - lo, count);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** Date ticks for a period: at most `max`, on dekad, month or year starts. */
function dekadTicks(range: DekadRange, max: number) {
  const len = range.end + 1 - range.start;
  const step = [1, 3, 6, 9, 18, 36, 72, 108].find((s) => len / s <= max) ?? 144;
  const ticks = [];
  for (let dk = Math.ceil(range.start / step) * step; dk <= range.end + 1; dk += step) {
    const label =
      step >= 36 ? String(dkY(dk)) : dkD(dk) === 0 ? `${MONTHS[dkM(dk)]}${dkM(dk) === 0 || step < 3 ? ` ${dkY(dk)}` : ""}` : fmtStart(dk).replace(/ \d{4}$/, "");
    ticks.push({ dk, label });
  }
  return ticks;
}
