/*
 * The view tabs (Country / Basin / Local), the date range slider and the play button. Clicking a date above the slider picks it from a calendar
 * (date-picker.ts); clicking the length changes it (length-picker.ts). The arrows
 * either side of the dates move the range a year. The markup lives in index.html; this module keeps the range valid for the active view (see
 * range-rules.ts) and shows when the system, not the user, moved an end. The tabs sit
 * at the top of the view's own pane (its .tabs-slot): the statistics panel, or in the
 * Local view the point pane.
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

export interface ToolbarState {
  view: View;
  /** The range, in days: any day in Local, else on dekad boundaries. */
  days: DayRange;
  /** The dekads it lies in (in Basin and Country, exactly the range). */
  range: DekadRange;
}

/** Briefly highlight an element that the system (not the user) changed. */
export function flash(el: HTMLElement) {
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

  const play = document.getElementById("play-button")!;
  play.addEventListener("click", () => onPlay?.());

  const tabs = document.querySelector<HTMLElement>(".tabs")!;
  slideSelection(tabs);
  function render() {
    slider.render(state);
    picker.render();
    lengthPicker.render();
    for (const [btn, n] of shifts) btn.disabled = !shiftYears(state.view, state.range, n);
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
  return {
    state: current(),
    setRange(range) {
      this.setDays(daysOfDekads(range));
    },
    setDays(days) {
      if (days.start === state.range.start && days.end === state.range.end) return;
      update(days, {}); // the user chose it (elsewhere), so no highlight
    },
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
  };
}
