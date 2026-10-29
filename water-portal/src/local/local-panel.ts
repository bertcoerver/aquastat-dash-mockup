/*
 * The Local panel's charts: the time series of the WaPOR variable on the map, at the
 * selected point, over WaPOR's whole record (point-series.ts). It's the Basin view's
 * chart (basin/timeseries.ts): the record above, with the date range as a band to drag,
 * and the range up close below next to each dekad's average over the years. The series
 * fills in as it's read, the selected period first. Without a map with time on the map
 * (only GAEZ's, or vector maps), the card says so and nothing is read.
 *
 * A GAEZ map on the map has its own card above it, the harvested area by crop at the
 * point (crop-card.ts).
 *
 * Below it the dams' cards (dam-card.ts): all of them, and the one selected, a card per
 * attribute. As a card of the Country and Basin panels does, hovering one shows its map
 * (the dams, by its attribute) and pinning it checks that in the legend. A card is only
 * ever pinned by a click.
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
import { initDamCards } from "./dam-card";
import { initCropCard, type CropMap } from "./crop-card";
import type { GaezMap } from "../map/layers/gaez";
import type { Dams } from "./vector-maps";

interface LocalPanelOptions {
  /** The WaPOR variable on the map (null: none, no map with time). */
  variable: WaporVariable | null;
  /** A period chosen on the chart. */
  setRange(range: DekadRange): void;
  /** The same, in days (a bar of the year chart: the same days in another year). */
  setDays(days: DayRange): void;
  /** Other units picked on the chart (its y axis title goes through them). */
  onUnits(units: WaporUnits): void;
  /** A card's vector map (by id) and attribute (none: as it is), previewed on the map while the card is hovered (null: none). */
  previewMap(id: string | null, attribute?: string): void;
  /** …and checked in the legend, so, the card pinned. */
  addMap(id: string, attribute?: string): void;
}

export interface LocalPanel {
  setView(view: View): void;
  setSelection(selection: Selection): void;
  /** The WaPOR variable on the map (null: none, no map with time). */
  setVariable(variable: WaporVariable | null): void;
  /** The GAEZ map checked (null: none), and the crop of those by crop. */
  setGaez(gaez: GaezMap | null, crop: string): void;
  setRange(days: DayRange): void;
  /** Show values per day, month, year or in total, per m² or over the pixel (as the legend). */
  setUnits(units: WaporUnits): void;
  /** The dams, once loaded (their card). */
  setDams(dams: Dams): void;
  /** The vector maps on the map, by id, each with its attribute (their cards are marked). */
  setMapped(mapped: Map<string, string>): void;
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export function initLocalPanel({ variable, setRange, setDays, onUnits, previewMap, addMap }: LocalPanelOptions): LocalPanel {
  const $ = (id: string) => document.getElementById(id)!;
  const message = $("lp-message");
  const section = $("lp-series");
  const caption = $("lp-ts-caption");
  const empty = $("lp-ts-empty");
  const key = $("lp-ts-key");
  const updateChart = initTimeseries($("lp-overview"), $("lp-zoom"), (range) => setRange(range));
  // A ratio (WP): its value over the selected days matters most, so first by year.
  const barsSection = $("lp-bars");
  const updateBars = initYearBars($("lp-bars-chart"), ({ start, end }) => setDays({ start, end: Math.min(end, MAX_DAY) }));
  // GAEZ's crops: as a dams' card, hovered it previews its map ("gaez:<id>:<crop>"), and a
  // bar clicked or the card pinned checks it.
  const cropsSection = $("lp-crops");
  const cropPin = ({ map, crop }: CropMap) => `gaez:${map.id}:${crop}`;
  const cropCard = initCropCard(
    cropsSection,
    (shown) => preview(shown && cropPin(shown)),
    (shown) => addMap(mapOf(cropPin(shown)).id, shown.crop),
  );
  let gaez: { map: GaezMap | null; crop: string } = { map: null, crop: "" };
  function syncCrops() {
    cropCard.set(gaez.map, gaez.crop, state.lngLat, state.view === "local");
    markPinned(); // (only a card on show)
  }

  // The dams' cards ("dams", "dams:<attribute>"): hovered (after a moment, as
  // map-drivers.ts's cards; moving on to another at once), the map shows the dams so.
  const damsEl = $("lp-dams");
  const damCards = initDamCards(damsEl, $("lp-tooltip"));
  /** A card's map and attribute (a GAEZ map's: its crop). */
  function mapOf(pin: string) {
    const parts = pin.split(":");
    const [id, attribute] = parts[0] === "gaez" ? [`gaez:${parts[1]}`, parts[2]] : parts;
    return { id, attribute: attribute as string | undefined };
  }
  let hoverTimer = 0;
  let previewing: string | null = null;
  function preview(pin: string | null) {
    clearTimeout(hoverTimer);
    if (pin === previewing) return;
    const apply = () => {
      previewing = pin;
      if (!pin) return previewMap(null);
      const { id, attribute } = mapOf(pin);
      previewMap(id, attribute);
    };
    if (pin && previewing) apply();
    else hoverTimer = window.setTimeout(apply, 120);
  }
  damsEl.addEventListener("pointerover", (e) => preview((e.target as Element).closest<HTMLElement>("[data-pin]")?.dataset.pin ?? null));
  damsEl.addEventListener("pointerleave", () => preview(null));

  // A card (the crops, the year bars, the series, the dams') pinned with a click stays when the panel
  // folds, as in the other views (foldable.ts keeps the .pinned one); a dam card's checks
  // the dams in the legend, by its attribute.
  const cards = [cropsSection, barsSection, section, ...damsEl.querySelectorAll<HTMLElement>("[data-pin]")];
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
    if (next?.startsWith("dams")) addMap(mapOf(next).id, mapOf(next).attribute);
    if (next === "crops") {
      const { id, attribute } = mapOf(cropPin(cropCard.selection()));
      addMap(id, attribute);
    }
    markPinned();
  }
  const body = $("lp-body");
  body.addEventListener("click", (e) => {
    const target = e.target as Element;
    const id = target.closest<HTMLElement>("[data-pin]")?.dataset.pin;
    if (!id) return;
    if (target.closest("[data-unpin]")) setPinned(null);
    // Using its chart pins it, but never unpins it (a drag on it ends in a click too).
    else if (target.closest("#lp-overview, #lp-zoom, #lp-bars-chart, #lp-crops .cc-chart")) setPinned(id);
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

  /** Read the series again if the point or variable changed (only in the Local view, with a variable on the map). */
  function sync() {
    const { lngLat, variable } = state;
    const key = state.view === "local" && lngLat && variable ? `${variable.id} ${lngLat}` : "";
    if (key === loadingKey) return render();
    loadingKey = key;
    loading?.abort();
    series = null;
    pixelArea = null;
    if (!lngLat || !variable || !key) {
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

  // While it fills in, at most every 200 ms: each render lays the panel out again,
  // which every frame takes much of the time the map has to move.
  let timer = 0;
  function scheduleRender() {
    if (!timer) timer = window.setTimeout(render, 200);
  }

  function render() {
    clearTimeout(timer);
    timer = 0;
    message.classList.toggle("error", status.kind === "error");
    message.textContent = status.kind === "error" ? status.message : "";
    message.hidden = !message.textContent;
    // How many of the dekads have been read, on the load bar.
    setProgress("local-series", status.kind === "loading" && series ? series.loaded / series.dekads.length : null);

    // The series card is always there; without a map with time, or until there's a point, just a word.
    empty.hidden = status.kind !== "idle";
    empty.textContent = state.variable
      ? "Click the map, or the title to type coordinates, to see the time series there."
      : "None of the maps on the map has time. Check one that has in the legend, such as one of WaPOR's, to see its time series here.";
    for (const el of [caption, $("lp-overview"), $("lp-zoom"), key]) el.hidden = !series;
    const ratio = series?.ratio && state.days ? yearBars(series, state.days) : null;
    barsSection.hidden = !ratio;
    markPinned(); // (only a card on show)
    $("lp-ts-title").textContent = ratio ? "Per dekad" : "Time series";
    if (ratio) {
      const { variable } = series!;
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
    const { dekads, variable } = series;
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
    // A key to the lower chart: the series, the dashed average and its band.
    const swatch = (svg: string, label: string) => `<span class="ts-key-item"><svg width="18" height="10" aria-hidden="true">${svg}</svg>${label}</span>`;
    key.innerHTML =
      swatch(`<line x1="1" x2="17" y1="5" y2="5" stroke="${lineColor(variable)}" stroke-width="2"/>`, total ? `${variable.short}, added up` : variable.short) +
      swatch(`<line class="ts-mean" x1="1" x2="17" y1="5" y2="5"/>`, total ? "Average, same days of every year" : "Average of that dekad, all years") +
      swatch(`<rect class="ts-spread" x="1" y="0" width="16" height="10"/>`, "± 1 standard deviation");
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
    const all = waporUnitsFor(state.variable!);
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
      if (view === state.view) return; // (told at every change of the range too)
      state.view = view;
      sync();
      syncCrops();
    },
    setSelection(selection) {
      state.lngLat = selection.lngLat;
      const { feature } = selection;
      const dam = feature?.map === "dams" ? feature.index : null;
      damCards.setSelected(dam);
      sync();
      syncCrops();
    },
    setDams: (dams) => damCards.setData(dams),
    setMapped(mapped) {
      // The overview with the dams on the map at all, an attribute's card with them by it.
      for (const el of damsEl.querySelectorAll<HTMLElement>("[data-pin]")) {
        const { id, attribute } = mapOf(el.dataset.pin!);
        el.classList.toggle("mapped", mapped.has(id) && (!attribute || mapped.get(id) === attribute));
      }
    },
    setVariable(variable) {
      state.variable = variable;
      sync();
    },
    setGaez(map, crop) {
      gaez = { map, crop };
      syncCrops();
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
