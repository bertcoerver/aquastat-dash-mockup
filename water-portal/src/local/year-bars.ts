/*
 * A ratio of totals over the selected days (water productivity: total NPP over total
 * AETI), the same days in every year side by side: one bar per year.
 *
 * - The headline is the value for the selected days, with the average over the years
 *   (± one standard deviation) and the two totals it's made of: a ratio can change
 *   through either.
 * - Bars: the selected year in full colour, the others lighter; the average as a dashed
 *   line over them, in a band of ± one standard deviation behind them. A year that isn't over yet is outlined
 *   ("so far") and left out of the average.
 * - Hover a bar to read its year in the headline; click it to select its days.
 *
 * Plain SVG and HTML, redrawn from scratch on every update (a dozen bars at most).
 */
import { fmt } from "../basin/variables";
import { fmtDay } from "../toolbar/dekads";
import type { DayRange } from "../toolbar/range-rules";
import { niceMax } from "../lib/scale";

export interface YearBar {
  days: DayRange;
  /** The first total over the second; null where there's a gap in either (or not read yet). */
  value: number | null;
  /** The two totals. */
  totals: [number, number];
  /** Not over yet (the record ends within it): the value so far. */
  partial: boolean;
  selected: boolean;
}

export interface YearBarsData {
  bars: YearBar[];
  label: string; // "Water productivity"
  unit: string;
  /** The totals' names and units: [["NPP", "gC/m²"], ["AETI", "mm"]]. */
  parts: [[string, string], [string, string]];
  color: string;
}

const H = 150;
const M = { left: 40, right: 8, top: 10, bottom: 20 };

/** `onPick` runs when a bar is clicked, with its days. Returns a function that redraws it (null: empty). */
export function initYearBars(el: HTMLElement, onPick: (days: DayRange) => void): (data: YearBarsData | null) => void {
  const head = document.createElement("div");
  head.className = "yb-head";
  const chart = document.createElement("div");
  chart.className = "yb-chart";
  el.append(head, chart);

  let data: YearBarsData | null = null;
  let hover: number | null = null;
  let width = 0; // the chart's (see the ResizeObserver)

  // While the series is read it's redrawn every frame, mostly the same: only what
  // changed is put in (new markup lays the panel out again).
  const markup = new Map<HTMLElement, string>();
  const put = (target: HTMLElement, html: string) => {
    if (markup.get(target) === html) return;
    markup.set(target, html);
    target.innerHTML = html;
  };

  function draw() {
    if (!data || !data.bars.length) {
      put(head, "");
      put(chart, "");
      return;
    }
    const { bars, unit, parts, color } = data;
    // The average and spread of the years that are over.
    const done = bars.filter((b) => !b.partial && b.value !== null).map((b) => b.value!);
    const mean = done.length ? done.reduce((a, b) => a + b, 0) / done.length : Number.NaN;
    const sd = done.length > 1 ? Math.sqrt(done.reduce((a, v) => a + (v - mean) ** 2, 0) / (done.length - 1)) : Number.NaN;

    // Headline: the hovered bar, else the selected one.
    const shown = bars[hover ?? bars.findIndex((b) => b.selected)] ?? bars[bars.length - 1];
    const number = shown.value === null ? "–" : fmt(shown.value);
    const vs = Number.isFinite(mean)
      ? `average ${fmt(mean)}${Number.isFinite(sd) ? ` ± ${fmt(sd)}` : ""} over ${done.length} year${done.length === 1 ? "" : "s"}`
      : "";
    put(head, `
      <div class="yb-period">${data.label}, ${fmtRange(shown.days)}${shown.partial ? " (so far)" : ""}</div>
      <div class="yb-value"><span class="yb-number">${number}</span> <span class="yb-unit">${unit}</span>
        <span class="yb-vs">${vs}</span></div>
      <div class="yb-parts">${parts[0][0]} ${fmt(shown.totals[0])} ${parts[0][1]} · ${parts[1][0]} ${fmt(shown.totals[1])} ${parts[1][1]}</div>`);

    // Bars.
    const w = width;
    const plotW = w - M.left - M.right;
    const plotH = H - M.top - M.bottom;
    const top = Math.max(...bars.map((b) => b.value ?? 0), Number.isFinite(sd) ? mean + sd : mean, 0);
    const [hi, step] = niceMax(top || 1);
    const y = (v: number) => M.top + (1 - v / hi) * plotH;
    const band = plotW / bars.length;
    const bw = Math.max(4, Math.min(32, band - 6));
    const x = (i: number) => M.left + band * (i + 0.5);

    const grid = [];
    for (let v = 0; v <= hi + step * 1e-9; v += step) {
      grid.push(`<line class="ts-grid" x1="${M.left}" x2="${w - M.right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="ts-label" x="${M.left - 5}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`);
    }
    const spread = Number.isFinite(sd)
      ? `<rect class="ts-spread" x="${M.left}" y="${y(mean + sd)}" width="${plotW}" height="${Math.max(0, y(mean - sd) - y(mean + sd))}"/>`
      : "";
    const average = Number.isFinite(mean) ? `<line class="ts-mean" x1="${M.left}" x2="${w - M.right}" y1="${y(mean)}" y2="${y(mean)}"/>` : "";
    // Label every year if there's room, else every other one (the selected always).
    const every = band < 30 ? 2 : 1;
    const marks = bars
      .map((b, i) => {
        const cx = x(i);
        const label = i % every === 0 || b.selected ? `<text class="ts-label${b.selected ? " yb-selected" : ""}" x="${cx}" y="${H - 6}" text-anchor="middle">${yearLabel(b.days)}</text>` : "";
        // The whole column is the target.
        const target = `<rect class="yb-target" x="${cx - band / 2}" y="${M.top}" width="${band}" height="${plotH + M.bottom}"/>`;
        if (b.value === null) return label + target;
        // The selected year in full; the hovered one a step lighter, so it isn't taken for it.
        const opacity = b.selected ? 1 : hover === i ? 0.75 : 0.45;
        const bar = b.partial
          ? `<path d="${roundedBar(cx - bw / 2, y(b.value), bw, y(0) - y(b.value))}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="1.5" stroke-dasharray="3 2"/>` +
            `<text class="ts-label" x="${cx}" y="${y(b.value) - 4}" text-anchor="middle">so far</text>`
          : `<path d="${roundedBar(cx - bw / 2, y(b.value), bw, y(0) - y(b.value))}" fill="${color}" fill-opacity="${opacity}"/>`;
        return bar + label + target;
      })
      .join("");
    put(chart, `<svg width="${w}" height="${H}" class="yb-svg" role="img"
        aria-label="${data.label} for the same days in every year">
      ${grid.join("")}${spread}${marks}${average}
      <line class="yb-base" x1="${M.left}" x2="${w - M.right}" y1="${y(0)}" y2="${y(0)}"/>
    </svg>`);
  }

  // By the pointer's position, not the element under it: a hover redraws them.
  function barAt(e: MouseEvent) {
    if (!data?.bars.length) return null;
    const r = chart.getBoundingClientRect();
    const [px, py] = [e.clientX - r.left, e.clientY - r.top];
    const i = Math.floor(((px - M.left) / (r.width - M.left - M.right)) * data.bars.length);
    return i >= 0 && i < data.bars.length && py >= M.top && py <= H ? i : null;
  }
  chart.addEventListener("pointermove", (e) => {
    const next = barAt(e);
    if (next === hover) return;
    hover = next;
    draw();
  });
  chart.addEventListener("pointerleave", () => {
    hover = null;
    draw();
  });
  chart.addEventListener("click", (e) => {
    const i = barAt(e);
    if (i !== null) onPick(data!.bars[i].days);
  });

  // Its width from here, not read in draw: that would lay the panel out again each time.
  new ResizeObserver(([entry]) => {
    width = Math.round(entry.contentRect.width);
    draw();
  }).observe(chart);

  return (next) => {
    data = next;
    if (hover !== null && (!next || hover >= next.bars.length)) hover = null;
    draw();
  };
}

/** A bar with 4 px rounded top corners, square on the baseline. */
function roundedBar(x: number, y: number, w: number, h: number) {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}


/** "26 Feb – 13 Oct 2023", or with both years when it runs over the new year. */
function fmtRange({ start, end }: DayRange) {
  const [a, b] = [fmtDay(start), fmtDay(end)];
  return a.slice(-4) === b.slice(-4) ? `${a.slice(0, -5)} – ${b}` : `${a} – ${b}`;
}

/** "2023", or "2022–23" for days over the new year. */
function yearLabel({ start, end }: DayRange) {
  const [a, b] = [fmtDay(start).slice(-4), fmtDay(end).slice(-4)];
  return a === b ? a : `${a}–${b.slice(-2)}`;
}
