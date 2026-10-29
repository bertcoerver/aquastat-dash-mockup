/*
 * The view tabs (Country / Basin / Local), the date range slider and the play button. Clicking a date above the slider picks it from a calendar
 * (date-picker.ts); clicking the length changes it (length-picker.ts). The arrows
 * either side of the dates move the range a year. The markup lives in index.html; this module keeps the range valid for the active view (see
 * range-rules.ts) and shows when the system, not the user, moved an end. The tabs sit
 * at the top of the view's own pane (its .tabs-slot): the statistics panel, or in the
 * Local view the point pane. Where no map on screen has time (the Local view with only
 * GAEZ's maps or the dams), the range is dimmed, then hidden if it stays so (setTimeless).
 */
import type { PlaybackState } from "../map/wapor-player";
import {
  coveringDekads,
  daysOfDekads,
  enterView,
  initialRange,
  limitBasinDekads,
  limitCountryYears,
  shiftYears,
  type DayRange,
  type DekadRange,
  type View,
} from "./range-rules";
import { initDatePicker } from "./date-picker";
import { initLengthPicker } from "./length-picker";
import { initRangeSlider, type Grip } from "./range-slider";
import { slideSelection } from "../panels/segmented";

/** How long the range stays dimmed, without time on the map, before it's hidden. */
const TIMELESS_HIDE_MS = 2000;

export interface ToolbarState {
  view: View;
  /** The range, in days: any day in Local, else on dekad boundaries. */
  days: DayRange;
  /** The dekads it lies in (in Basin and Country, exactly the range). */
  range: DekadRange;
}

/** Briefly highlight an element that the system (not the user) changed. */
const flashed = new WeakMap<HTMLElement, number>();
export function flash(el: HTMLElement) {
  // (Not again within a moment: a drag flashes the other end at every move, and
  // restarting the animation costs a layout.)
  const now = performance.now();
  if (now - (flashed.get(el) ?? -Infinity) < 100) return;
  flashed.set(el, now);
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
}

export interface Toolbar {
  state: ToolbarState;
  /** Set the range from elsewhere (the Basin view's time series); it must fit the view. */
  setRange(range: DekadRange): void;
  /** The same in days (playback in the Local view). */
  setDays(days: DayRange): void;
  /** Show the playback state: the play button and how far ahead the map has loaded. */
  setPlayback(playback: PlaybackState): void;
  /** Country view: the latest year with data; later years can't be selected. */
  setCountryLastYear(year: number): void;
  /** Basin view: the latest dekad with model output; later dekads can't be selected. */
  setBasinLastDekad(dk: number): void;
  /** No map on screen has time: hide the range (and its play button), and let nothing change it. */
  setTimeless(timeless: boolean): void;
}

/**
 * Wire up the top bar. `onChange` runs after every change of view or range; `onPlay`
 * when the play button is pressed.
 */
export function initToolbar(onChange: (state: ToolbarState) => void, onPlay?: () => void): Toolbar {
  const state: { view: View; range: DayRange } = { view: "country", range: initialRange() };
  const current = (): ToolbarState => ({ view: state.view, days: state.range, range: coveringDekads(state.range) });

  /** Apply a new range; `adjusted` names the ends the system changed. */
  function update(next: DayRange, adjusted: { start?: boolean; end?: boolean }) {
    state.range = next;
    render();
    for (const end of ["start", "end"] as const) {
      if (!adjusted[end]) continue;
      flash(document.getElementById(`${end}-handle`)!);
      flash(document.getElementById(`${end}-label`)!);
    }
    onChange(current());
  }

  /** The user moved `grip` on the slider, or picked that end in the calendar. */
  function onInput(next: DayRange, grip: Grip) {
    const prev = state.range;
    // Only flag the end the user didn't move; dragging the band only if its length changed.
    const lengthChanged = next.end - next.start !== prev.end - prev.start;
    update(next, {
      start: grip === "end" && next.start !== prev.start,
      end: grip === "band" ? lengthChanged : grip === "start" && next.end !== prev.end,
    });
  }
  const slider = initRangeSlider(() => state, onInput);
  const picker = initDatePicker(() => state, onInput);
  // A typed length moves the end; flag the start if it had to move too (to fit).
  const lengthPicker = initLengthPicker(
    () => state,
    (next, how) => update(next, { start: how === "length" && next.start !== state.range.start }),
  );

  // The arrows: the same dates a year earlier or later.
  const shifts = [
    [document.getElementById("shift-back") as HTMLButtonElement, -1],
    [document.getElementById("shift-ahead") as HTMLButtonElement, 1],
  ] as const;
  for (const [btn, n] of shifts) {
    btn.addEventListener("click", () => {
      const next = shiftYears(state.view, state.range, n);
      if (next) update(next, {});
    });
  }

  const pane = document.getElementById("pane-range")!;
  let hideTimer: ReturnType<typeof setTimeout> | undefined; // (setTimeless)
  const play = document.getElementById("play-button")!;
  play.addEventListener("click", () => onPlay?.());

  const tabs = document.querySelector<HTMLElement>(".tabs")!;
  slideSelection(tabs);
  function render() {
    slider.render(state);
    picker.render();
    lengthPicker.render();
    for (const [btn, n] of shifts) btn.disabled = !shiftYears(state.view, state.range, n);
  }
  // (Only as the view changes: setting the attribute, even to what it is, has the tabs'
  // highlight measure them again.)
  function renderTabs() {
    const slot = document.querySelector<HTMLElement>(`.tabs-slot[data-view="${state.view}"]`)!;
    if (tabs.parentElement !== slot) {
      const focused = tabs.contains(document.activeElement); // (moving it drops the focus)
      slot.append(tabs);
      if (focused) tabs.querySelector<HTMLElement>(`[data-view="${state.view}"]`)!.focus();
    }
    for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
      tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    }
  }

  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
    tab.addEventListener("click", () => {
      const view = tab.dataset.view as View;
      if (view === state.view) return;
      state.view = view;
      renderTabs();
      const prev = state.range;
      const next = enterView(view, prev);
      update(next, { start: next.start !== prev.start, end: next.end !== prev.end });
    });
  }

  /** After `view`'s limits changed: keep its range within them. */
  function fitLimit(view: View) {
    const prev = state.range;
    const next = state.view === view ? enterView(view, prev) : prev;
    if (next.start === prev.start && next.end === prev.end) return render();
    update(next, { start: next.start !== prev.start, end: next.end !== prev.end });
  }

  render();
  renderTabs();
  function setDays(days: DayRange) {
    if (days.start === state.range.start && days.end === state.range.end) return;
    update(days, {}); // the user chose it (elsewhere), so no highlight
  }
  return {
    get state() {
      return current();
    },
    setRange: (range) => setDays(daysOfDekads(range)),
    setDays,
    setPlayback({ status, bufferedTo }) {
      play.dataset.status = status;
      play.setAttribute("aria-label", status === "stopped" ? "Play" : "Pause");
      play.title = status === "buffering" ? "Loading the next frames…" : "";
      slider.setBuffered(bufferedTo);
    },
    setCountryLastYear(year) {
      limitCountryYears(year);
      fitLimit("country");
    },
    setBasinLastDekad(dk) {
      limitBasinDekads(dk);
      fitLimit("basin");
    },
    setTimeless(timeless) {
      // Dimmed first, and hidden only if still so a moment later (see toolbar.css): a
      // quick switch between layers doesn't make it flicker. Inert: no clicks, drags or
      // keys meanwhile, and its calendars close as they lose the focus.
      if (timeless === pane.inert) return;
      pane.inert = timeless;
      pane.classList.toggle("dimmed", timeless);
      clearTimeout(hideTimer);
      if (timeless) hideTimer = setTimeout(() => pane.classList.add("timeless"), TIMELESS_HIDE_MS);
      else pane.classList.remove("timeless");
    },
  };
}
