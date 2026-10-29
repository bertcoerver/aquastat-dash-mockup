/*
 * The popup behind the range's length above the slider: type a length (days, or years
 * in Country) and the end follows, or snap the range to the nearest calendar dekad,
 * month or year (see setLength and snapToPeriod in range-rules.ts). Country only has
 * years. The popup closes after a change, on Escape, or on a press outside it.
 */
import {
  firstDay,
  lastDay,
  rangeLength,
  setLength,
  snapToPeriod,
  type DayRange,
  type Period,
  type View,
} from "./range-rules";

interface PickerState {
  view: View;
  range: DayRange;
}

export interface LengthPicker {
  /** Refresh after the view or range changed (closes the popup if the view did). */
  render(): void;
}

const HINT: Record<View, string> = {
  local: "Keeps the start date",
  basin: "Rounded to whole dekads",
  country: "Whole years",
};
const PERIODS: Period[] = ["dekad", "month", "year"];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const unit = (view: View) => (view === "country" ? "years" : "days");
/** The longest range a view can show, in its unit. */
function maxLength(view: View) {
  return rangeLength(view, { start: firstDay(view), end: lastDay(view) });
}
const same = (a: DayRange, b: DayRange) => a.start === b.start && a.end === b.end;

/**
 * Wire up the popup. `onPick` runs when a change of length changes the range: `how` is
 * whether a length was typed or the range snapped to a period.
 */
export function initLengthPicker(
  getState: () => PickerState,
  onPick: (next: DayRange, how: "length" | "period") => void,
): LengthPicker {
  const label = document.getElementById("range-len")!;

  const pop = document.createElement("div");
  pop.className = "date-picker length-picker";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Length");
  pop.hidden = true;
  pop.innerHTML = `
    <div class="dp-head"><span class="dp-title">Length</span><span class="dp-hint"></span></div>
    <form class="lp-form">
      <input class="lp-input" type="number" min="1" step="1" inputmode="numeric" required />
      <span class="lp-unit"></span>
      <button class="lp-apply" type="submit">Set</button>
    </form>
    <div class="lp-periods" role="group" aria-label="Snap to">
      ${PERIODS.map((p) => `<button class="lp-period" type="button" data-period="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}
    </div>`;
  document.body.append(pop);
  const q = <T extends HTMLElement>(sel: string) => pop.querySelector<T>(sel)!;
  const input = q<HTMLInputElement>(".lp-input");
  const periods = [...pop.querySelectorAll<HTMLButtonElement>(".lp-period")];

  let openView: View | null = null;

  function show() {
    const { view, range } = getState();
    openView = view;
    label.setAttribute("aria-expanded", "true");
    pop.hidden = false;
    q(".dp-hint").textContent = HINT[view];
    q(".lp-unit").textContent = unit(view);
    input.max = String(maxLength(view));
    input.value = String(rangeLength(view, range));
    input.setAttribute("aria-label", `Length in ${unit(view)}`);
    draw();
    place();
    input.select();
    input.focus();
  }

  function hide(refocus = false) {
    if (!openView) return;
    openView = null;
    pop.hidden = true;
    label.setAttribute("aria-expanded", "false");
    if (refocus) label.focus();
  }

  /** Below the length, or above it if there's no room below; kept on screen. */
  function place() {
    const l = label.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = pop;
    pop.style.left = `${clamp(l.right - w + 10, 8, innerWidth - w - 8)}px`;
    const below = innerHeight - l.bottom >= h + 14 || l.top < h + 14;
    pop.style.top = `${below ? l.bottom + 6 : l.top - h - 6}px`;
  }

  /** The period buttons: pressed if the range is exactly that period; Country has only years. */
  function draw() {
    const { view, range } = getState();
    for (const btn of periods) {
      const period = btn.dataset.period as Period;
      btn.disabled = view === "country" && period !== "year";
      btn.setAttribute("aria-pressed", String(!btn.disabled && same(snapToPeriod(view, range, period), range)));
    }
  }

  function apply(next: DayRange, how: "length" | "period") {
    const { range } = getState();
    hide(true);
    if (!same(next, range)) onPick(next, how);
  }

  // --- events -------------------------------------------------------------------

  label.addEventListener("click", () => (openView ? hide() : show()));

  q("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const { view, range } = getState();
    const n = clamp(Number(input.value), 1, maxLength(view));
    if (Number.isFinite(n)) apply(setLength(view, range, n), "length");
  });

  for (const btn of periods) {
    btn.addEventListener("click", () => {
      const { view, range } = getState();
      apply(snapToPeriod(view, range, btn.dataset.period as Period), "period");
    });
  }

  // (On the popup and its button, not the page: Escape elsewhere unpins the map.)
  for (const el of [pop, label]) {
    el.addEventListener("keydown", (e) => {
      if (!openView || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    });
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as Node;
      if (openView && !pop.contains(t) && !label.contains(t)) hide();
    },
    true,
  );
  pop.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !pop.contains(to) && to !== label) hide();
  });
  window.addEventListener("resize", () => hide());
  window.addEventListener("panes-moved", () => hide());

  return {
    render() {
      const { view, range } = getState();
      label.setAttribute("aria-label", `Length: ${rangeLength(view, range)} ${unit(view)}, change`);
      if (!openView) return;
      if (view !== openView) return hide();
      draw();
    },
  };
}
