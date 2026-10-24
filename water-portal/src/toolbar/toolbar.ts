/*
 * The top bar: view tabs (Country / Basin / Local) and the date range slider.
 * The markup lives in index.html; this module keeps the range valid for the active
 * view (see range-rules.ts) and shows when the system, not the user, moved an end.
 */
import { enterView, initialRange, type DekadRange, type View } from "./range-rules";
import { initRangeSlider } from "./range-slider";

export interface ToolbarState {
  view: View;
  range: DekadRange;
}

/** Briefly highlight an element that the system (not the user) changed. */
function flash(id: string) {
  const el = document.getElementById(id)!;
  el.classList.remove("flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("flash");
}

export interface Toolbar {
  state: ToolbarState;
  /** Set the range from elsewhere (the Basin view's time series); it must fit the view. */
  setRange(range: DekadRange): void;
}

/** Wire up the top bar. `onChange` runs after every change of view or range. */
export function initToolbar(onChange: (state: ToolbarState) => void): Toolbar {
  const state: ToolbarState = { view: "country", range: initialRange() };

  /** Apply a new range; `adjusted` names the ends the system changed. */
  function update(next: DekadRange, adjusted: { start?: boolean; end?: boolean }) {
    state.range = next;
    render();
    for (const end of ["start", "end"] as const) {
      if (!adjusted[end]) continue;
      flash(`${end}-handle`);
      flash(`${end}-label`);
    }
    onChange({ ...state });
  }

  const renderSlider = initRangeSlider(
    () => state,
    (next, grip) => {
      const prev = state.range;
      // Only flag the end the user didn't move; dragging the band only if its length changed.
      const lengthChanged = next.end - next.start !== prev.end - prev.start;
      update(next, {
        start: grip === "end" && next.start !== prev.start,
        end: grip === "band" ? lengthChanged : grip === "start" && next.end !== prev.end,
      });
    },
  );

  function render() {
    renderSlider(state);
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

  render();
  return {
    state: { ...state },
    setRange(range) {
      if (range.start === state.range.start && range.end === state.range.end) return;
      update(range, {}); // the user chose it (elsewhere), so no highlight
    },
  };
}
