/*
 * The legend for the WaPOR raster (Local view): the variable as its title, a menu of
 * the others, period, colour ramp and whether the raster is loading or not published
 * yet, a menu for the unit (per day, month or year, or the period's total; per m² or
 * over a pixel: only the numbers change), and on the ramp itself, one for how much of
 * the values in view the colours span. For a dekad of a 300 m variable it also has the quality slider,
 * which hides pixels whose NDVI input is gap-filled over more dekads. A padlock in the
 * title locks the colours' range as it is (until it's unlocked or another variable is
 * picked). The markup lives in index.html.
 */
import { initLock, ticksHtml } from "../panels/legend";
import { DEFAULT_STRETCH, initRampMenu } from "../panels/ramp-menu";
import { initTitleMenu } from "../panels/title-menu";
import { fmtDay } from "../toolbar/dekads";
import { flash } from "../toolbar/toolbar";
import {
  PER_DAYS,
  WAPOR_UNITS,
  fitUnits,
  waporUnitsFor,
  WAPOR_VARIABLES,
  fmtArea,
  unitFactor,
  waporUnit,
  waporPixel,
  waporVariable,
  type WaporLevel,
  type WaporPeriod,
  type WaporStretch,
  type WaporUnits,
  type WaporVariable,
} from "./layers/wapor";
import type { WaporRamp } from "./layers/wapor-shader";

export type WaporStatus = "checking" | "loading" | "ready" | "missing" | "error";
export type QualityStatus = "checking" | "ready" | "missing";

const STATUS_TEXT: Record<WaporStatus, string> = {
  // (the load bar says these)
  checking: "",
  loading: "",
  ready: "",
  missing: "Not published yet for this period.",
  error: "Couldn't reach WaPOR's storage.",
};

const QUALITY_TEXT: Record<Exclude<QualityStatus, "ready">, string> = {
  checking: "", // (the load bar says it)
  missing: "Quality layer not published yet for this dekad.",
};

/**
 * Slider positions, from showing everything (0) to only pixels observed this dekad
 * (MAX_GAP + 1). In between, the longest gap shown goes down one dekad per step. WaPOR's
 * own legend for the layer stops at "more than 12 dekads".
 */
const MAX_GAP = 12;
const maxGapAt = (position: number) => (position === 0 ? null : MAX_GAP + 1 - position);

function describe(maxGap: number | null) {
  if (maxGap === null) return "All pixels shown";
  if (maxGap === 0) return "Observed this dekad only";
  return `Hiding gaps over ${maxGap} dekad${maxGap === 1 ? "" : "s"}`;
}

const $ = (id: string) => document.getElementById(id)!;

/** What each raster in an equation is, e.g. A[2025]: WaPOR's annual raster for 2025. */
const BLOCK_KINDS: Record<string, string> = {
  D: "D[…]: a dekadal raster, per day (n·D: n of its days)",
  M: "M[…]: a monthly raster, the month's total",
  A: "A[…]: an annual raster, the year's total",
};

/** The period's tooltip: how the map is made from WaPOR's rasters, and what they are. */
function describeEquation(equation: string) {
  const kinds = Object.keys(BLOCK_KINDS).filter((k) => equation.includes(`${k}[`));
  return [`How this map is made:`, equation, "", ...kinds.map((k) => BLOCK_KINDS[k])].join("\n");
}


export interface WaporLegend {
  /** Show the legend for a period (null hides it). */
  show(period: WaporPeriod | null, status?: WaporStatus): void;
  /** Show the colour map the raster is drawn with. */
  ramp(ramp: WaporRamp): void;
  /** The quality slider: shown for a dekad, disabled while there's no quality layer. */
  quality(status: QualityStatus | null): void;
  /**
   * The area of a pixel at the centre of the view (m², null: not known), for values over
   * a pixel. It changes with latitude, so it's only right near there.
   */
  pixelArea(area: number | null, lat: number): void;
  /** The level the map shows (L2 when zoomed in where it has it): its pixel size. */
  level(level: WaporLevel): void;
  /** Show these units (picked elsewhere: the Local panel's chart). */
  setUnits(units: WaporUnits): void;
}

/**
 * `onMaxGap` runs when the quality slider moves: the longest gap to show, or null.
 * `onStretch` runs when a colour range is picked from the ramp's menu, and once at the start.
 * `onVariable` runs when another variable is picked from the title's menu.
 * `onUnits` runs when the unit button is pressed.
 * `onLock` runs when the colours' range is locked or unlocked.
 */
export function initWaporLegend({
  variable: initial,
  onMaxGap,
  onStretch,
  onVariable,
  onUnits,
  onLock,
}: {
  variable: WaporVariable;
  onMaxGap: (maxGap: number | null) => void;
  onStretch: (cut: WaporStretch) => void;
  onVariable: (variable: WaporVariable) => void;
  onUnits: (units: WaporUnits) => void;
  onLock: (locked: boolean) => void;
}): WaporLegend {
  const legend = $("wapor-legend");
  const lock = initLock(legend, (locked) => lockRamp(locked));

  let variable = initial;
  let level: WaporLevel = "L1";
  const menu = initTitleMenu(
    $("wapor-variable") as HTMLButtonElement,
    () => ({ options: WAPOR_VARIABLES.map((v) => ({ id: v.id, label: v.label })), current: variable.id }),
    (id) => {
      if (id === variable.id) return;
      // Another variable's values: its own range.
      if (lock.locked) {
        lock.set(false);
        lockRamp(false);
      }
      showVariable(waporVariable(id));
      onVariable(variable);
      // Not every variable has every unit (a ratio has no per month, year or pixel).
      const fit = fitUnits(variable, units);
      if (fit !== units) {
        units = fit;
        showPer();
        if (lastRamp) showRamp(lastRamp);
        onUnits(units);
      }
    },
  );
  function showVariable(v: WaporVariable) {
    variable = v;
    menu.setLabel(v.label);
    // The pixel size in its own span, so it alone lights up when the level changes.
    const pixel = document.createElement("span");
    pixel.id = "wapor-pixel";
    pixel.textContent = waporPixel(v, level);
    $("wapor-source").replaceChildren(`WaPOR v3 · ${v.short} · `, pixel);
    showPer();
  }

  // The unit, from a menu: the map's colours stay, the legend's numbers are per day,
  // month or year, or the total over the period; per m², or over a pixel at the centre
  // of the view.
  const unitButton = $("wapor-unit") as HTMLButtonElement;
  let units: WaporUnits = WAPOR_UNITS[0];
  let lastRamp: WaporRamp | null = null;
  let periodDays = 1;
  let area: { m2: number | null; lat: number } = { m2: null, lat: 0 };
  const describeUnits = ({ per, pixel }: WaporUnits) =>
    variable.ratio
      ? "the ratio of the period's totals"
      : `${per === "total" ? "in total over the period" : per === "day" ? "per day" : `per ${per} (${PER_DAYS[per]} days)`}` +
        (pixel ? ", over a pixel" : "");
  const unitMenu = initTitleMenu(
    unitButton,
    () => {
      const all = waporUnitsFor(variable);
      return {
        options: all.map((u, i) => ({ id: String(i), label: waporUnit(variable, u) })),
        current: String(all.indexOf(units)),
      };
    },
    (id) => {
      const picked = waporUnitsFor(variable)[Number(id)];
      if (picked === units) return;
      units = picked;
      showPer();
      if (lastRamp) showRamp(lastRamp);
      onUnits(units);
    },
  );
  // The period, or in total what the total is: "Accumulated AETI at 13 Oct 2023, since 26 Feb 2023".
  let lastPeriod: WaporPeriod | null = null;
  function showPeriod() {
    if (!lastPeriod) return;
    const { range, variable: v, label } = lastPeriod;
    const el = $("wapor-period");
    el.textContent =
      units.per === "total" ? `Accumulated ${v.short} at ${fmtDay(range.end)}, since ${fmtDay(range.start)}` : label;
    el.title = describeEquation(lastPeriod.equation);
  }
  function showPer() {
    showPeriod();
    const lat = `${Math.abs(area.lat).toFixed(1)}° ${area.lat < 0 ? "S" : "N"}`;
    unitMenu.setLabel(waporUnit(variable, units));
    // Nothing to pick from (a ratio): plain text.
    unitButton.disabled = waporUnitsFor(variable).length < 2;
    unitButton.title =
      `Values ${describeUnits(units)}.` +
      (units.pixel
        ? area.m2
          ? ` A pixel's area depends on its latitude: these are for one of ${fmtArea(area.m2)}, at ${lat}, the centre of the view.`
          : " (The pixel's area isn't known yet.)"
        : "");
  }
  showVariable(initial);
  const section = $("wapor-quality");
  const input = $("wapor-quality-input") as HTMLInputElement;
  const value = $("wapor-quality-value");
  const status = $("wapor-quality-status");
  input.max = String(MAX_GAP + 1);

  function update() {
    const maxGap = maxGapAt(Number(input.value));
    value.textContent = describe(maxGap);
    input.setAttribute("aria-valuetext", describe(maxGap));
    section.classList.toggle("filtering", maxGap !== null);
    return maxGap;
  }
  input.addEventListener("input", () => onMaxGap(update()));
  update(); // starts at "all", as the map does

  // How much of the values in view the colours span: a menu on the ramp (none while locked).
  const rampMenu = initRampMenu($("wapor-ramp") as HTMLButtonElement, "the values in view", DEFAULT_STRETCH, onStretch);
  onStretch(DEFAULT_STRETCH);
  function lockRamp(locked: boolean) {
    rampMenu.setEnabled(!locked);
    onLock(locked);
  }

  function showRamp(ramp: WaporRamp) {
    lastRamp = ramp;
    const { quantities: q, colors } = ramp;
    // Stops sit where their value falls between the first and the last.
    const span = q[4] - q[0];
    const at = (v: number) => ((v - q[0]) / span) * 100;
    $("wapor-ramp").style.background =
      `linear-gradient(to right, ${colors.map((c, i) => `${c} ${at(q[i])}%`).join(", ")})`;
    // The ramp is per day and m², as the rasters.
    const k = unitFactor(variable, units, periodDays, area.m2 ?? Number.NaN);
    $("wapor-ticks").innerHTML = ticksHtml(q.map((v) => ({ value: v * k, at: at(v) / 100 })));
  }

  return {
    show(period, status = "ready") {
      legend.hidden = !period;
      if (!period) return;
      legend.dataset.status = status;
      lastPeriod = period;
      showPeriod();
      if (period.days !== periodDays) {
        periodDays = period.days;
        if (lastRamp) showRamp(lastRamp);
      }
      $("wapor-status").textContent = STATUS_TEXT[status];
      $("wapor-note").textContent = period.note ?? "";
    },
    ramp: showRamp,
    setUnits(picked) {
      units = fitUnits(variable, picked);
      showPer();
      if (lastRamp) showRamp(lastRamp);
    },
    level(shown) {
      if (shown === level) return;
      level = shown;
      showVariable(variable);
      // The system, not the user, changed the resolution (zooming in or out): show it.
      if (waporPixel(variable, "L1") !== waporPixel(variable, "L2")) flash($("wapor-pixel"));
    },
    pixelArea(m2, lat) {
      area = { m2, lat };
      showPer();
      if (lastRamp) showRamp(lastRamp);
    },
    quality(state) {
      section.hidden = !state;
      if (!state) return;
      // The position is kept while it's disabled, and applies again on the next dekad.
      input.disabled = state !== "ready";
      section.dataset.status = state;
      status.textContent = state === "ready" ? "" : QUALITY_TEXT[state];
    },
  };
}
