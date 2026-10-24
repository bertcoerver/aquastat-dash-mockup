/*
 * The time series of one variable at the selected sub-basin, as two charts:
 *
 * - an overview of the whole record, with the selected period as a band. Drag across
 *   it to choose another period, or drag the band to move it; the date range in the
 *   top bar follows.
 * - the selected period up close, with the long-term mean (dashed) for comparison.
 *   Hover it to read single dekads.
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
}

const OVERVIEW_H = 64;
const ZOOM_H = 190;
const M = { left: 46, right: 10, top: 10, bottom: 22 }; // zoomed chart margins

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
    const [lo, hi] = extent(values, 0);
    const y = (v: number) => 2 + (1 - (v - lo) / (hi - lo || 1)) * (plotH - 4);
    const line = path(dekads.map((dk, i) => [x(dk + 0.5), y(values[i])]));
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
  function drawZoom() {
    if (!data?.range) return void (zoom.innerHTML = "");
    const { dekads, values, range, color, unit } = data;
    const w = zoom.clientWidth;
    const h = ZOOM_H;
    const from = dekads.findIndex((dk) => dk >= range.start);
    let to = dekads.findIndex((dk) => dk > range.end);
    if (to < 0) to = dekads.length;
    const longTerm = mean(values);
    const [lo, hi] = niceExtent(extent(values.subarray(from, to), 0, longTerm));
    const x = (boundary: number) => M.left + ((boundary - range.start) / (range.end + 1 - range.start)) * (w - M.left - M.right);
    const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * (h - M.top - M.bottom);

    const yTicks = niceTicks(lo, hi, 4)
      .map((v) => `<line class="ts-grid" x1="${M.left}" x2="${w - M.right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="ts-label" x="${M.left - 5}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`)
      .join("");
    const xTicks = dekadTicks(range, (w - M.left - M.right) / 70)
      .map((t) => {
        // A label at the right end would run off the chart: end it at the tick instead.
        const anchor = x(t.dk) > w - M.right - 25 ? "end" : "middle";
        return `<line class="ts-tick" x1="${x(t.dk)}" x2="${x(t.dk)}" y1="${h - M.bottom}" y2="${h - M.bottom + 4}"/>` +
          `<text class="ts-label" x="${x(t.dk)}" y="${h - 6}" text-anchor="${anchor}">${t.label}</text>`;
      })
      .join("");
    const pts: [number, number][] = [];
    for (let i = from; i < to; i++) pts.push([x(dekads[i] + 0.5), y(values[i])]);
    const dots = to - from <= 40 ? pts.filter(([, py]) => Number.isFinite(py)).map(([px, py]) => `<circle cx="${px}" cy="${py}" r="2.2" fill="${color}"/>`).join("") : "";
    const meanLine = Number.isFinite(longTerm)
      ? `<line class="ts-mean" x1="${M.left}" x2="${w - M.right}" y1="${y(longTerm)}" y2="${y(longTerm)}"/>`
      : "";
    const zero = lo < 0 ? `<line class="ts-zero" x1="${M.left}" x2="${w - M.right}" y1="${y(0)}" y2="${y(0)}"/>` : "";

    let hover = "";
    if (hoverIndex !== null && hoverIndex >= from && hoverIndex < to) {
      const dk = dekads[hoverIndex];
      const v = values[hoverIndex];
      const hx = x(dk + 0.5);
      const label = `${fmtStart(dk)} – ${fmtEnd(dk)}: ${fmt(v)} ${unit}`;
      const right = hx > w / 2;
      hover = `<line class="ts-cursor" x1="${hx}" x2="${hx}" y1="${M.top}" y2="${h - M.bottom}"/>` +
        (Number.isFinite(v) ? `<circle cx="${hx}" cy="${y(v)}" r="3.5" fill="${color}" class="ts-dot"/>` : "") +
        `<text class="ts-readout" x="${right ? hx - 6 : hx + 6}" y="${M.top + 10}" text-anchor="${right ? "end" : "start"}">${label}</text>`;
    }

    zoom.innerHTML = `<svg width="${w}" height="${h}" class="ts-zoom">
      ${yTicks}${zero}${meanLine}
      <path d="${path(pts)}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
      ${dots}${xTicks}${hover}
    </svg>`;
  }

  zoom.addEventListener("pointermove", (e) => {
    if (!data?.range) return;
    const w = zoom.clientWidth;
    const px = e.clientX - zoom.getBoundingClientRect().left;
    const dk = Math.floor(data.range.start + ((px - M.left) / (w - M.left - M.right)) * (data.range.end + 1 - data.range.start));
    const i = data.dekads.indexOf(dk);
    const next = i < 0 ? null : i;
    if (next === hoverIndex) return;
    hoverIndex = next;
    drawZoom();
  });
  zoom.addEventListener("pointerleave", () => {
    hoverIndex = null;
    drawZoom();
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
