/*
 * The Local panel's charts: for now the time series of the WaPOR variable picked in
 * the legend, at the selected point, over WaPOR's whole record (point-series.ts). It's
 * the Basin view's chart (basin/timeseries.ts): the record above, with the date range
 * as a band to drag, and the range up close below next to each dekad's average over
 * the years. The series fills in as it's read, the selected period first.
 */
import { initTimeseries } from "../basin/timeseries";
import { fmtArea, unitFactor, waporUnit, waporUnitsFor, waporVariable, type WaporUnits, type WaporVariable } from "../map/layers/wapor";
import type { LngLat } from "../map/places";
import type { Selection } from "../selection";
import { MAX_DAY, MAX_DK, WAPOR_MIN_YEAR, addYears, dayDk, dkFirstDay, dkLastDay, dkY, fmtDay, fmtEnd, fmtStart, mk } from "../toolbar/dekads";
import { coveringDekads, type DayRange, type DekadRange, type View } from "../toolbar/range-rules";
import { setProgress } from "../panels/load-bar";
import { loadPointSeries, waporPixelArea, type PointSeries } from "./point-series";
import { initYearBars, type YearBar } from "./year-bars";

interface LocalPanelOptions {
  variable: WaporVariable;
  /** A period chosen on the chart. */
  setRange(range: DekadRange): void;
  /** The same, in days (a bar of the year chart: the same days in another year). */
  setDays(days: DayRange): void;
  /** Other units picked on the chart (its y axis title goes through them). */
  onUnits(units: WaporUnits): void;
}

export interface LocalPanel {
  setView(view: View): void;
  setSelection(selection: Selection): void;
  setVariable(variable: WaporVariable): void;
  setRange(days: DayRange): void;
  /** Show values per day, month, year or in total, per m² or over the pixel (as the legend). */
  setUnits(units: WaporUnits): void;
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export function initLocalPanel({ variable, setRange, setDays, onUnits }: LocalPanelOptions): LocalPanel {
  const $ = (id: string) => document.getElementById(id)!;
  const message = $("lp-message");
  const section = $("lp-series");
  const caption = $("lp-ts-caption");
  const empty = $("lp-ts-empty");
  const updateChart = initTimeseries($("lp-overview"), $("lp-zoom"), (range) => setRange(range));
  // A ratio (WP): its value over the selected days matters most, so first by year.
  const barsSection = $("lp-bars");
  const updateBars = initYearBars($("lp-bars-chart"), ({ start, end }) => setDays({ start, end: Math.min(end, MAX_DAY) }));

  // A card (the year bars, the series) pinned with a click stays when the panel folds,
  // as in the other views (foldable.ts keeps the .pinned one); it has no map to drive.
  const cards = [barsSection, section];
  let pinned: string | null = null;
  function markPinned() {
    for (const el of cards) {
      const on = el.dataset.pin === pinned && !el.hidden;
      el.classList.toggle("pinned", on);
      el.setAttribute("aria-pressed", String(on));
    }
  }
  function setPinned(next: string | null) {
    pinned = next;
    markPinned();
  }
  const body = $("lp-body");
  body.addEventListener("click", (e) => {
    const target = e.target as Element;
    const id = target.closest<HTMLElement>("[data-pin]")?.dataset.pin;
    if (!id) return;
    if (target.closest("[data-unpin]")) setPinned(null);
    // Using its chart pins it, but never unpins it (a drag on it ends in a click too).
    else if (target.closest("#lp-overview, #lp-zoom, #lp-bars-chart")) setPinned(id);
    else setPinned(pinned === id ? null : id);
  });
  body.addEventListener("keydown", (e) => {
    const id = (e.target as HTMLElement).dataset.pin;
    if (!id || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    setPinned(pinned === id ? null : id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.view === "local" && pinned) setPinned(null);
  });

  const state = {
    view: "country" as View,
    lngLat: null as LngLat | null,
    variable,
    days: null as DayRange | null,
    units: { per: "day", pixel: false } as WaporUnits,
  };
  /** The area of the point's pixel (m²; null: not known yet), for values over it. */
  let pixelArea: number | null = null;
  let status: Status = { kind: "idle" };
  let series: PointSeries | null = null;
  let loading: AbortController | null = null;
  let loadingKey = "";

  /** Read the series again if the point or variable changed (only in the Local view). */
  function sync() {
    const { lngLat, variable } = state;
    const key = state.view === "local" && lngLat ? `${variable.id} ${lngLat}` : "";
    if (key === loadingKey) return render();
    loadingKey = key;
    loading?.abort();
    series = null;
    pixelArea = null;
    if (!lngLat || !key) {
      status = { kind: "idle" };
      return render();
    }
    const controller = (loading = new AbortController());
    status = { kind: "loading" };
    render();
    waporPixelArea(variable, lngLat[1]).then((area) => {
      if (loading !== controller) return;
      pixelArea = area;
      render();
    });
    loadPointSeries(
      variable,
      lngLat,
      controller.signal,
      (next) => {
        series = next;
        scheduleRender();
      },
      () => state.days && coveringDekads(state.days),
    ).then(
      () => {
        status = { kind: "ready" };
        render();
      },
      (err: Error) => {
        if (controller.signal.aborted) return;
        controller.abort(); // the other dekads still being read
        status = { kind: "error", message: `Couldn't read ${variable.label.toLowerCase()} at this point: ${err.message}` };
        render();
      },
    );
  }

  // While it fills in, at most once a frame.
  let frame = 0;
  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function render() {
    cancelAnimationFrame(frame);
    frame = 0;
    const { variable } = state;
    message.classList.toggle("error", status.kind === "error");
    message.textContent = status.kind === "error" ? status.message : "";
    message.hidden = !message.textContent;
    // How many of the dekads have been read, on the load bar.
    setProgress("local-series", status.kind === "loading" && series ? series.loaded / series.dekads.length : null);

    // The series card is always there; until there's a point, just a word to pick one.
    empty.hidden = status.kind !== "idle";
    for (const el of [caption, $("lp-overview"), $("lp-zoom")]) el.hidden = !series;
    const ratio = series?.ratio && state.days ? yearBars(series, state.days) : null;
    barsSection.hidden = !ratio;
    markPinned(); // (only a card on show)
    $("lp-ts-title").textContent = ratio ? "Per dekad" : "Time series";
    if (ratio) {
      const [num, den] = variable.parts!.map((p) => waporVariable(p.id));
      // A part's total: its unit without the per day.
      const totalUnit = (v: WaporVariable) => v.unit.replace(/\/day$/, "");
      updateBars({
        bars: ratio,
        label: variable.label,
        unit: variable.unit,
        parts: [
          [num.short, totalUnit(num)],
          [den.short, totalUnit(den)],
        ],
        color: lineColor(variable),
      });
      $("lp-bars-caption").textContent =
        `Each bar is total ${num.short} over total ${den.short} for the same days in that year, in the ${variable.pixel} pixel at this point. ` +
        "The dashed line is the average of the years that are over, the band ± one standard deviation. " +
        (variable.ratioMin ? `None where ${den.short} averages under ${variable.ratioMin} ${den.unit}. ` : "") +
        "Hover a bar to read it, click it to select its days.";
    } else {
      updateBars(null);
    }
    if (!series) return updateChart(null);
    const { dekads } = series;
    const { units } = state;
    const unit = waporUnit(variable, units);
    const total = units.per === "total";
    // In total, the values stay per day: the chart adds up each dekad's days in the period.
    const k = unitFactor(variable, total ? { ...units, per: "day" } : units, 1, pixelArea ?? Number.NaN);
    const values = series.values.map((v) => v * k);
    const { days } = state;
    const daysIn = total && days ? (dk: number) => Math.max(0, Math.min(days.end, dkLastDay(dk)) - Math.max(days.start, dkFirstDay(dk)) + 1) : undefined;
    updateChart({
      dekads,
      values,
      range: periodIn(dekads),
      color: lineColor(variable),
      unit,
      yLabel: `${total ? "Total " : ""}${variable.short} (${unit})`,
      // Goes through the units, if there's more than one.
      ...(waporUnitsFor(variable).length > 1 ? { onYLabel: () => onUnits(nextUnits()), yLabelHint: `Click for ${waporUnit(variable, nextUnits())}.` } : {}),
      seasonal: true,
      daysIn,
      windows: total && days ? yearlyWindows(days) : undefined,
    });
    const record = `(${fmtStart(dekads[0])} – ${fmtEnd(dekads[dekads.length - 1])})`;
    const where = `in the ${variable.pixel} pixel at this point` + (units.pixel ? ` (${pixelArea ? fmtArea(pixelArea) : "area not known yet"})` : "");
    // A ratio's parts: "NPP over AETI".
    const [num, den] = (variable.parts ?? []).map((p) => waporVariable(p.id).short);
    caption.textContent =
      (total && days
        ? `${variable.label} (${unit}) added up since ${fmtDay(days.start)}, the start of the period, ${where}. ` +
          `The dashed line is the average of the same days' totals in every year of the record ${record}, the band ± one standard deviation. ` +
          (days.end - days.start <= 365 ? "The upper chart adds up the same days in every year, to compare. " : "")
        : `${variable.label} (${unit})${variable.ratio ? `, ${num} over ${den}` : ""} per dekad, ${where}. ` +
          `The dashed line is that dekad's average over the years of the record ${record}, e.g. of every 1–10 January, the band ± one standard deviation. `) +
      "Drag across the upper chart to choose the period, or drag the band to move it.";
  }

  /** The units after the current ones, in the legend's menu's order (of those the variable has). */
  function nextUnits() {
    const all = waporUnitsFor(state.variable);
    const i = all.findIndex((u) => u.per === state.units.per && u.pixel === state.units.pixel);
    return all[(i + 1) % all.length];
  }

  /** The date range's dekads, within the record (null: none of it is). */
  function periodIn(dekads: number[]): DekadRange | null {
    if (!state.days) return null;
    const { start, end } = coveringDekads(state.days);
    const [first, last] = [dekads[0], dekads[dekads.length - 1]];
    return end < first || start > last ? null : { start: Math.max(start, first), end: Math.min(end, last) };
  }

  return {
    setView(view) {
      // Opening the Local view pins the series card.
      if (view === "local" && state.view !== "local") setPinned("series");
      state.view = view;
      sync();
    },
    setSelection(selection) {
      state.lngLat = selection.lngLat;
      sync();
    },
    setVariable(variable) {
      state.variable = variable;
      sync();
    },
    setRange(days) {
      state.days = days;
      if (state.view === "local") render();
    },
    setUnits(units) {
      state.units = units;
      render();
    },
  };
}

/**
 * The period's days in every year of the record (the period moved by whole years,
 * keeping its length): for the overview's totals, each dekad's window (by year offset)
 * and its days in it, or null outside them. A window that starts before the record has
 * no total (its start is missing). A period longer than a year would overlap itself:
 * then only the period.
 */
function yearlyWindows(days: DayRange) {
  const windows = yearWindows(days);
  return (dk: number) => {
    const [first, last] = [dkFirstDay(dk), dkLastDay(dk)];
    let best: { window: number; days: number } | null = null;
    for (const { k, start, end } of windows) {
      const n = Math.min(end, last) - Math.max(start, first) + 1;
      if (n > 0 && (!best || n > best.days)) best = { window: k, days: n };
    }
    return best;
  };
}

/**
 * The period moved by whole years (k: by how many), keeping its length, in the record:
 * those that start in it. A period longer than a year would overlap itself: just it.
 */
function yearWindows(days: DayRange) {
  const length = days.end - days.start;
  // A year's days (or a leap year's): the windows just touch.
  const year = dkY(dayDk(days.start));
  const years = length <= 365 ? Array.from({ length: dkY(MAX_DK) - WAPOR_MIN_YEAR + 1 }, (_, i) => WAPOR_MIN_YEAR - year + i) : [0];
  const recordStart = dkFirstDay(mk(WAPOR_MIN_YEAR, 0, 0));
  return years
    .map((k) => {
      const start = addYears(days.start, k);
      return { k, start, end: start + length };
    })
    .filter((w) => w.start >= recordStart);
}

/**
 * A ratio's bars (series.ratio): over each year's window, the first part's total over
 * the second's, each dekad counted for its days in the window (none if the second
 * averages less than the variable's ratioMin a day). A window the record ends
 * in is partial (so far); one after it is left out.
 */
function yearBars(series: PointSeries, days: DayRange): YearBar[] {
  const { num, den } = series.ratio!;
  const least = series.variable.ratioMin ?? 0;
  const { dekads } = series;
  const recordEnd = dkLastDay(dekads[dekads.length - 1]);
  return yearWindows(days)
    .filter((w) => w.start <= recordEnd)
    .map(({ k, start, end }) => {
      const last = Math.min(end, recordEnd);
      let a = 0;
      let b = 0;
      for (let dk = dayDk(start); dk <= dayDk(last); dk++) {
        const i = dk - dekads[0];
        const n = Math.min(last, dkLastDay(dk)) - Math.max(start, dkFirstDay(dk)) + 1;
        a += num[i] * n;
        b += den[i] * n;
      }
      // (b is a total: its average per day must reach ratioMin.)
      const value = Number.isFinite(a) && b > 0 && b >= least * (last - start + 1) ? (series.variable.scale * a) / b : null;
      return { days: { start, end }, value, totals: [a, b] as [number, number], partial: end > recordEnd, selected: k === 0 };
    });
}

/** A strong colour of the variable's own ramp (the wet end of a diverging one). */
const lineColor = ({ ramp, signed }: WaporVariable) => ramp.colors[signed ? 4 : 3];
