/*
 * The date range slider: a track from 1 Jan 2016 to the end of the current dekad,
 * with a handle for each end of the range. The markup lives in index.html. The parts
 * the view can't select are hatched: before WaPOR's data in Basin and Local, after the
 * model's output in Basin, after the latest AQUASTAT year in Country.
 *
 * Positions on the track are day BOUNDARIES: boundary b is the start of day b, so a
 * range { start, end } (in days) runs from boundary `start` to boundary `end + 1`, and
 * even a single day has a width. Where an end may sit depends on the view (see
 * range-rules.ts): any day in Local, dekad boundaries in Basin, years in Country.
 *
 * Pointer: drag a handle, drag the band between them to move the whole range, or
 * press elsewhere on the track to bring the nearest handle there. Where the handles
 * overlap, the first movement decides: left moves the start, right the end.
 * Keyboard (handles): arrows step one day in Local, one dekad in Basin, one year in
 * Country; Page Up/Down one year, Home/End to the limits.
 *
 * While playing, a lighter part of the track after the range shows how far ahead the
 * map has loaded.
 */
import { MAX_DAY, MIN_YEAR, dayOf, fmtDay } from "./dekads";
import {
  changeEnd,
  changeStart,
  firstDay,
  lastDay,
  moveRange,
  rangeLength,
  stepBoundary,
  unavailable,
  type DayRange,
  type View,
} from "./range-rules";

/** What the slider shows: the view (whose rules apply) and the range, in days. */
interface SliderState {
  view: View;
  range: DayRange;
}

/** What the user moved. */
export type Grip = "start" | "end" | "band";

const BOUNDARIES = MAX_DAY + 1;
const HIT_PX = 12; // how close to a handle a press outside the band must be to grab it
const CORE_PX = 5; // same inside the band, at most (a narrow band leaves its middle draggable)
const pct = (b: number) => `${(b / BOUNDARIES) * 100}%`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const $ = (id: string) => document.getElementById(id)!;

/** The range's length: in years in Country (whole years), else in days. */
function lengthLabel(view: View, range: DayRange) {
  const n = rangeLength(view, range);
  return `${n} ${view === "country" ? "year" : "day"}${n === 1 ? "" : "s"}`;
}

export interface RangeSlider {
  /** Redraw the slider for a state. */
  render(state: SliderState): void;
  /** Show the track loaded up to a day boundary, after the range (null: none). */
  setBuffered(boundary: number | null): void;
}

/** Wire up the slider. `onInput` runs whenever the user's action changes the range. */
export function initRangeSlider(
  getState: () => SliderState,
  onInput: (next: DayRange, grip: Grip) => void,
): RangeSlider {
  const slider = $("slider");
  const track = $("slider-track");
  const handles = { start: $("start-handle"), end: $("end-handle") };

  // Year ticks, labelled in the middle of each year (if there's room for the label).
  const lastYear = new Date(Date.UTC(MIN_YEAR, 0, 1 + MAX_DAY)).getUTCFullYear();
  $("slider-years").innerHTML = Array.from({ length: lastYear - MIN_YEAR + 1 }, (_, i) => {
    const a = dayOf(MIN_YEAR + i, 0, 1);
    const b = Math.min(dayOf(MIN_YEAR + i + 1, 0, 1), BOUNDARIES);
    return `<span style="left:${pct(a)};width:${pct(b - a)}">${b - a >= 180 ? MIN_YEAR + i : ""}</span>`;
  }).join("");

  /** Move `grip` to track position `p` (in boundaries; `from` is the range when the drag began). */
  function moveTo(grip: Grip, p: number, from: { p: number; range: DayRange }) {
    const { view, range } = getState();
    const next =
      grip === "start"
        ? changeStart(view, range, p)
        : grip === "end"
          ? changeEnd(view, range, p)
          : moveRange(view, from.range, from.range.start + p - from.p);
    if (next.start !== range.start || next.end !== range.end) onInput(next, grip);
  }

  // --- pointer ------------------------------------------------------------------

  let drag: { grip: Grip | null; p: number; range: DayRange } | null = null;

  const posAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return { p: clamp((clientX - r.left) / r.width, 0, 1) * BOUNDARIES, pxPerDay: r.width / BOUNDARIES };
  };

  /** What a press at `clientX` would grab (null: the start or end, by the first movement). */
  function gripAt(clientX: number) {
    const { range } = getState();
    const { p, pxPerDay } = posAt(clientX);
    const inBand = p > range.start && p < range.end + 1;
    const reach = inBand ? Math.min(CORE_PX, ((range.end + 1 - range.start) * pxPerDay) / 4) : HIT_PX;
    const toStart = Math.abs(p - range.start) * pxPerDay;
    const toEnd = Math.abs(p - (range.end + 1)) * pxPerDay;

    let grip: Grip | null;
    if (toStart <= reach && toEnd <= reach) grip = null;
    else if (toStart <= reach || toEnd <= reach) grip = toStart <= toEnd ? "start" : "end";
    else if (inBand) grip = "band";
    else grip = p < range.start ? "start" : "end";
    return { grip, p, range, onTrack: Math.min(toStart, toEnd) > HIT_PX && grip !== "band" };
  }

  // The cursor shows what a press would grab: "resize" for a handle, "move" for the band.
  const setHover = (hover: "resize" | "move" | null) => {
    if (hover) slider.dataset.hover = hover;
    else delete slider.dataset.hover;
  };

  slider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection; focus is set below
    const { grip, p, range, onTrack } = gripAt(e.clientX);

    drag = { grip, p, range };
    slider.setPointerCapture(e.pointerId);
    slider.classList.add("dragging");
    setHover(grip === "band" ? "move" : "resize");
    if (grip === "start" || grip === "end") {
      handles[grip].focus({ preventScroll: true });
      // A press on the bare track brings the handle there straight away.
      if (onTrack) moveTo(grip, p, drag);
    }
  });

  slider.addEventListener("pointermove", (e) => {
    if (!drag) {
      const { grip, onTrack } = gripAt(e.clientX);
      setHover(grip === "band" ? "move" : onTrack ? null : "resize");
      return;
    }
    const { p, pxPerDay } = posAt(e.clientX);
    if (!drag.grip) {
      if (Math.abs(p - drag.p) * pxPerDay < 3) return;
      drag.grip = p < drag.p ? "start" : "end";
      handles[drag.grip].focus({ preventScroll: true });
    }
    moveTo(drag.grip, p, drag);
  });

  const endDrag = () => {
    drag = null;
    slider.classList.remove("dragging");
  };
  slider.addEventListener("pointerup", endDrag);
  slider.addEventListener("pointercancel", endDrag);
  slider.addEventListener("pointerleave", () => drag || setHover(null));

  // --- keyboard -----------------------------------------------------------------

  for (const grip of ["start", "end"] as const) {
    handles[grip].addEventListener("keydown", (e) => {
      const { view, range } = getState();
      const b = grip === "start" ? range.start : range.end + 1; // the handle's boundary
      const year = view === "country";
      const wanted: Record<string, () => number> = {
        ArrowLeft: () => stepBoundary(view, b, -1, year),
        ArrowDown: () => stepBoundary(view, b, -1, year),
        ArrowRight: () => stepBoundary(view, b, 1, year),
        ArrowUp: () => stepBoundary(view, b, 1, year),
        PageDown: () => stepBoundary(view, b, -1, true),
        PageUp: () => stepBoundary(view, b, 1, true),
        Home: () => 0,
        End: () => BOUNDARIES,
      };
      if (!(e.key in wanted)) return;
      e.preventDefault();

      const p = clamp(wanted[e.key](), 0, BOUNDARIES);
      const next = grip === "start" ? changeStart(view, range, p) : changeEnd(view, range, p);
      if (next.start !== range.start || next.end !== range.end) onInput(next, grip);
    });
  }

  // --- render -------------------------------------------------------------------

  let buffered: number | null = null;
  function renderBuffered() {
    const el = $("slider-buffered");
    const from = getState().range.end + 1;
    el.hidden = buffered === null || buffered <= from;
    if (!el.hidden) Object.assign(el.style, { left: pct(from), width: pct(buffered! - from) });
  }

  function render({ view, range }: SliderState) {
    const { start, end } = range;
    slider.dataset.view = view;
    handles.start.style.left = pct(start);
    handles.end.style.left = pct(end + 1);
    Object.assign($("slider-band").style, { left: pct(start), width: pct(end + 1 - start) });

    for (const [el, value, text] of [
      [handles.start, start, fmtDay(start)],
      [handles.end, end, fmtDay(end)],
    ] as const) {
      el.setAttribute("aria-valuemin", String(firstDay(view)));
      el.setAttribute("aria-valuemax", String(lastDay(view)));
      el.setAttribute("aria-valuenow", String(value));
      el.setAttribute("aria-valuetext", text);
    }

    const gaps = unavailable(view);
    for (const [id, gap] of [
      ["slider-unavailable-before", gaps.find((g) => g.from === 0)],
      ["slider-unavailable-after", gaps.find((g) => g.from > 0)],
    ] as const) {
      const hatched = $(id);
      hatched.hidden = !gap;
      if (gap) Object.assign(hatched.style, { left: pct(gap.from), width: pct(gap.to - gap.from) });
    }

    $("start-label").textContent = fmtDay(start);
    $("end-label").textContent = fmtDay(end);
    $("range-len").textContent = lengthLabel(view, range);
    renderBuffered();
  }

  return {
    render,
    setBuffered(boundary) {
      buffered = boundary;
      renderBuffered();
    },
  };
}
