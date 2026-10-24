/*
 * The date range slider: a track from 1 Jan 2018 to the end of the current dekad,
 * with a handle for each end of the range. The markup lives in index.html.
 *
 * Positions on the track are dekad BOUNDARIES: boundary b is the start of dekad b,
 * so a range { start, end } runs from boundary `start` to boundary `end + 1`, and
 * even a single dekad has a width.
 *
 * Pointer: drag a handle, drag the band between them to move the whole range, or
 * press elsewhere on the track to bring the nearest handle there. Where the handles
 * overlap, the first movement decides: left moves the start, right the end.
 * Keyboard (handles): arrows step one dekad (one year in Country), Page Up/Down one
 * year, Home/End to the limits.
 */
import { COUNTRY_MAX_YEAR, MAX_DK, MIN_YEAR, dkY, fmtEnd, fmtStart, mk } from "./dekads";
import { changeEnd, changeStart, moveRange, type DekadRange } from "./range-rules";
import type { ToolbarState } from "./toolbar";

/** What the user moved. */
export type Grip = "start" | "end" | "band";

const BOUNDARIES = MAX_DK + 1;
const HIT_PX = 12; // how close to a handle a press outside the band must be to grab it
const CORE_PX = 5; // same inside the band, at most (a narrow band leaves its middle draggable)
const pct = (b: number) => `${(b / BOUNDARIES) * 100}%`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const $ = (id: string) => document.getElementById(id)!;

function lengthLabel({ start, end }: DekadRange) {
  const n = end - start + 1;
  const [count, unit] = n % 36 === 0 ? [n / 36, "year"] : n % 3 === 0 ? [n / 3, "month"] : [n, "dekad"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Wire up the slider. `onInput` runs whenever the user's action changes the range.
 * Returns a function that redraws the slider for a state.
 */
export function initRangeSlider(
  getState: () => ToolbarState,
  onInput: (next: DekadRange, grip: Grip) => void,
): (state: ToolbarState) => void {
  const slider = $("slider");
  const track = $("slider-track");
  const handles = { start: $("start-handle"), end: $("end-handle") };

  // Year ticks, labelled in the middle of each year (if there's room for the label).
  $("slider-years").innerHTML = Array.from({ length: dkY(MAX_DK) - MIN_YEAR + 1 }, (_, i) => {
    const a = mk(MIN_YEAR + i, 0, 0);
    const b = Math.min(a + 36, BOUNDARIES);
    return `<span style="left:${pct(a)};width:${pct(b - a)}">${b - a >= 18 ? MIN_YEAR + i : ""}</span>`;
  }).join("");

  /** Move `grip` to track position `p` (in boundaries; `from` is the range when the drag began). */
  function moveTo(grip: Grip, p: number, from: { p: number; range: DekadRange }) {
    const { view, range } = getState();
    const next =
      grip === "start"
        ? changeStart(view, range, Math.round(p))
        : grip === "end"
          ? changeEnd(view, range, Math.round(p) - 1)
          : moveRange(view, from.range, from.range.start + p - from.p);
    if (next.start !== range.start || next.end !== range.end) onInput(next, grip);
  }

  // --- pointer ------------------------------------------------------------------

  let drag: { grip: Grip | null; p: number; range: DekadRange } | null = null;

  const posAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return { p: clamp((clientX - r.left) / r.width, 0, 1) * BOUNDARIES, pxPerDk: r.width / BOUNDARIES };
  };

  slider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection; focus is set below
    const { range } = getState();
    const { p, pxPerDk } = posAt(e.clientX);
    const inBand = p > range.start && p < range.end + 1;
    const reach = inBand ? Math.min(CORE_PX, ((range.end + 1 - range.start) * pxPerDk) / 4) : HIT_PX;
    const toStart = Math.abs(p - range.start) * pxPerDk;
    const toEnd = Math.abs(p - (range.end + 1)) * pxPerDk;

    let grip: Grip | null;
    if (toStart <= reach && toEnd <= reach) grip = null;
    else if (toStart <= reach || toEnd <= reach) grip = toStart <= toEnd ? "start" : "end";
    else if (inBand) grip = "band";
    else grip = p < range.start ? "start" : "end";

    drag = { grip, p, range };
    slider.setPointerCapture(e.pointerId);
    slider.classList.add("dragging");
    if (grip === "start" || grip === "end") {
      handles[grip].focus({ preventScroll: true });
      // A press on the bare track brings the handle there straight away.
      if (Math.min(toStart, toEnd) > HIT_PX) moveTo(grip, p, drag);
    }
  });

  slider.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const { p, pxPerDk } = posAt(e.clientX);
    if (!drag.grip) {
      if (Math.abs(p - drag.p) * pxPerDk < 3) return;
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

  // --- keyboard -----------------------------------------------------------------

  for (const grip of ["start", "end"] as const) {
    handles[grip].addEventListener("keydown", (e) => {
      const { view, range } = getState();
      const current = grip === "start" ? range.start : range.end;
      const step = view === "country" ? 36 : 1;
      const delta: Record<string, number> = {
        ArrowLeft: -step,
        ArrowDown: -step,
        ArrowRight: step,
        ArrowUp: step,
        PageDown: -36,
        PageUp: 36,
        Home: -Infinity,
        End: Infinity,
      };
      if (!(e.key in delta)) return;
      e.preventDefault();

      const wanted = clamp(current + delta[e.key], 0, MAX_DK);
      const next = grip === "start" ? changeStart(view, range, wanted) : changeEnd(view, range, wanted);
      if (next.start !== range.start || next.end !== range.end) onInput(next, grip);
    });
  }

  // --- render -------------------------------------------------------------------

  return ({ view, range }) => {
    const { start, end } = range;
    slider.dataset.view = view;
    handles.start.style.left = pct(start);
    handles.end.style.left = pct(end + 1);
    Object.assign($("slider-band").style, { left: pct(start), width: pct(end + 1 - start) });

    for (const [el, value, text] of [
      [handles.start, start, fmtStart(start)],
      [handles.end, end, fmtEnd(end)],
    ] as const) {
      el.setAttribute("aria-valuemin", "0");
      el.setAttribute("aria-valuemax", String(MAX_DK));
      el.setAttribute("aria-valuenow", String(value));
      el.setAttribute("aria-valuetext", text);
    }

    // Country: the current, incomplete year can't be selected.
    const unavailable = $("slider-unavailable");
    const firstMissing = mk(COUNTRY_MAX_YEAR + 1, 0, 0);
    unavailable.hidden = view !== "country" || firstMissing >= BOUNDARIES;
    Object.assign(unavailable.style, { left: pct(firstMissing), right: "0" });

    $("start-label").textContent = fmtStart(start);
    $("end-label").textContent = fmtEnd(end);
    $("range-len").textContent = lengthLabel(range);
  };
}
