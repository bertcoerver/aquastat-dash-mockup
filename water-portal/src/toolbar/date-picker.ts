/*
 * The calendar behind the dates above the slider: click the start or end date to pick
 * that end exactly. What can be picked follows the view's rules (see range-rules.ts):
 * any day in Local, a whole dekad in Basin (hovering a day shows its dekad), a year in
 * Country. What the view can't select is greyed out. A pick past the other end moves
 * that end along. The popup closes after a pick, on Escape, or on a press outside it.
 *
 * Keyboard (in the grid): arrows move a day (a year in Country), Page Up/Down a month
 * (with Shift a year), Enter or Space picks.
 */
import { MAX_DAY, MIN_YEAR, MONTHS, dayDk, dayOf, daysInMonth, fmtDay, ymd } from "./dekads";
import { firstDay, isCountryYear, lastDay, pickDay, type DayRange, type View } from "./range-rules";
import { byId as $ } from "../lib/dom";
import { clamp } from "../lib/math";
import { closesLikePopover } from "../lib/popover";

type End = "start" | "end";

interface PickerState {
  view: View;
  range: DayRange;
}

export interface DatePicker {
  /** Refresh after the view or range changed (closes the popup if the view did). */
  render(): void;
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const HINT: Record<View, string> = {
  local: "Picks a day",
  basin: "Picks a whole dekad",
  country: "Picks a whole year",
};

/** The same date `n` months later (or earlier), on the month's last day if it has fewer. */
function addMonths(day: number, n: number) {
  const { y, m, d } = ymd(day);
  return dayOf(y, m + n, Math.min(d, daysInMonth(y, m + n)));
}
const LAST_YEAR = ymd(MAX_DAY).y;

/** Wire up the calendar. `onPick` runs when a pick changes the range. */
export function initDatePicker(getState: () => PickerState, onPick: (next: DayRange, end: End) => void): DatePicker {
  const labels = { start: $("start-label"), end: $("end-label") };

  const pop = document.createElement("div");
  pop.className = "date-picker";
  pop.setAttribute("role", "dialog");
  pop.hidden = true;
  pop.innerHTML = `
    <div class="dp-head"><span class="dp-title"></span><span class="dp-hint"></span></div>
    <div class="dp-nav">
      <button type="button" class="dp-step" data-step="-1" aria-label="Previous month">‹</button>
      <select class="dp-month" aria-label="Month">${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("")}</select>
      <select class="dp-year" aria-label="Year"></select>
      <button type="button" class="dp-step" data-step="1" aria-label="Next month">›</button>
    </div>
    <div class="dp-grid"></div>`;
  document.body.append(pop);
  const q = <T extends HTMLElement>(sel: string) => pop.querySelector<T>(sel)!;
  const nav = q(".dp-nav");
  const grid = q(".dp-grid");
  const monthSel = q<HTMLSelectElement>(".dp-month");
  const yearSel = q<HTMLSelectElement>(".dp-year");

  let open: End | null = null;
  let openView: View | null = null;
  /** The day with keyboard focus; its month is the one shown. In Country, 1 Jan of a year. */
  let focusDay = 0;

  // (Country: the year grid greys out the years without data.)
  const limits = (view: View) => ({ lo: firstDay(view), hi: view === "country" ? MAX_DAY : lastDay(view) });

  function show(end: End) {
    const { view, range } = getState();
    open = end;
    openView = view;
    const day = end === "start" ? range.start : range.end;
    focusDay = view === "country" ? dayOf(ymd(day).y, 0, 1) : day;
    labels.start.setAttribute("aria-expanded", String(end === "start"));
    labels.end.setAttribute("aria-expanded", String(end === "end"));
    pop.setAttribute("aria-label", end === "start" ? "Start date" : "End date");
    pop.hidden = false;
    draw();
    place();
    focusCell();
  }

  function hide(refocus = false) {
    if (!open) return;
    const end = open;
    open = openView = null;
    pop.hidden = true;
    labels.start.setAttribute("aria-expanded", "false");
    labels.end.setAttribute("aria-expanded", "false");
    if (refocus) labels[end].focus();
  }

  /** Below the date clicked, or above it if there's no room below; kept on screen. */
  function place() {
    const l = labels[open!].getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = pop;
    pop.style.left = `${clamp(l.left - 10, 8, innerWidth - w - 8)}px`;
    const below = innerHeight - l.bottom >= h + 14 || l.top < h + 14;
    pop.style.top = `${below ? l.bottom + 6 : l.top - h - 6}px`;
  }

  const focusCell = () => grid.querySelector<HTMLElement>('[tabindex="0"]')?.focus();

  function draw() {
    const { view, range } = getState();
    q(".dp-title").textContent = open === "start" ? "Start date" : "End date";
    q(".dp-hint").textContent = HINT[view];
    grid.dataset.view = view;
    nav.hidden = view === "country";
    grid.innerHTML = view === "country" ? yearCells(range) : dayCells(view, range);
  }

  /** A cell: classes for the range and the end being picked. */
  const cell = (day: number, text: string, label: string, disabled: boolean, classes: string[], dk = "") =>
    `<button type="button" class="dp-cell ${classes.join(" ")}" data-day="${day}"${dk}` +
    ` aria-label="${label}" tabindex="${day === focusDay ? 0 : -1}"${disabled ? " disabled" : ""}>${text}</button>`;

  function dayCells(view: View, range: DayRange) {
    const { lo, hi } = limits(view);
    const { y, m } = ymd(focusDay);
    const first = dayOf(y, m, 1);
    const n = daysInMonth(y, m);
    const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // weeks start on Monday

    // Month and year choices, and the steps, within the view's limits.
    const [a, b] = [ymd(lo), ymd(hi)];
    const ym = y * 12 + m;
    yearSel.innerHTML = Array.from({ length: b.y - a.y + 1 }, (_, i) => `<option>${a.y + i}</option>`).join("");
    yearSel.value = String(y);
    monthSel.value = String(m);
    for (const opt of monthSel.options) opt.disabled = y * 12 + opt.index < a.y * 12 + a.m || y * 12 + opt.index > b.y * 12 + b.m;
    q<HTMLButtonElement>('[data-step="-1"]').disabled = ym <= a.y * 12 + a.m;
    q<HTMLButtonElement>('[data-step="1"]').disabled = ym >= b.y * 12 + b.m;

    const picked = open === "start" ? range.start : range.end;
    let html = WEEKDAYS.map((d) => `<span class="dp-wd" aria-hidden="true">${d}</span>`).join("");
    html += `<span></span>`.repeat(lead);
    for (let i = 0; i < n; i++) {
      const day = first + i;
      const classes = [];
      if (day >= range.start && day <= range.end) classes.push("in-range");
      if (day === range.start) classes.push("is-start");
      if (day === range.end) classes.push("is-end");
      if (day === picked) classes.push("is-picked");
      const dk = view === "basin" ? ` data-dk="${dayDk(day)}"` : "";
      html += cell(day, String(i + 1), fmtDay(day), day < lo || day > hi, classes, dk);
    }
    return html;
  }

  function yearCells(range: DayRange) {
    const [from, to] = [ymd(range.start).y, ymd(range.end).y];
    const picked = open === "start" ? from : to;
    return Array.from({ length: LAST_YEAR - MIN_YEAR + 1 }, (_, i) => {
      const y = MIN_YEAR + i;
      const classes = [];
      if (y >= from && y <= to) classes.push("in-range");
      if (y === picked) classes.push("is-picked");
      return cell(dayOf(y, 0, 1), String(y), String(y), !isCountryYear(y), classes);
    }).join("");
  }

  /** Show the month (or year) of `day`, kept within the view's limits. */
  function moveFocus(day: number, focus = true) {
    const { view } = getState();
    const { lo, hi } = limits(view);
    focusDay = clamp(day, lo, hi);
    draw();
    if (focus) focusCell();
  }

  function pick(day: number) {
    const { view, range } = getState();
    const end = open!;
    const next = pickDay(view, range, end, day);
    hide(true);
    if (next.start !== range.start || next.end !== range.end) onPick(next, end);
  }

  // --- events -------------------------------------------------------------------

  for (const end of ["start", "end"] as const) {
    labels[end].addEventListener("click", () => (open === end ? hide() : show(end)));
  }

  pop.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const day = target.closest<HTMLButtonElement>("[data-day]");
    if (day && !day.disabled) return pick(Number(day.dataset.day));
    const step = target.closest<HTMLElement>("[data-step]");
    if (step) moveFocus(addMonths(focusDay, Number(step.dataset.step)), false);
  });

  for (const sel of [monthSel, yearSel]) {
    sel.addEventListener("change", () => {
      const { d } = ymd(focusDay);
      const [y, m] = [Number(yearSel.value), Number(monthSel.value)];
      moveFocus(dayOf(y, m, Math.min(d, daysInMonth(y, m))), false);
    });
  }

  grid.addEventListener("keydown", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (!target) return;
    const day = Number(target.dataset.day);
    const country = getState().view === "country";
    const moves: Record<string, () => number> = country
      ? {
          ArrowLeft: () => dayOf(ymd(day).y - 1, 0, 1),
          ArrowRight: () => dayOf(ymd(day).y + 1, 0, 1),
          ArrowUp: () => dayOf(ymd(day).y - 4, 0, 1),
          ArrowDown: () => dayOf(ymd(day).y + 4, 0, 1),
        }
      : {
          ArrowLeft: () => day - 1,
          ArrowRight: () => day + 1,
          ArrowUp: () => day - 7,
          ArrowDown: () => day + 7,
          PageUp: () => addMonths(day, e.shiftKey ? -12 : -1),
          PageDown: () => addMonths(day, e.shiftKey ? 12 : 1),
        };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = moves[e.key]();
    // Country: stay put rather than land on a year without data.
    if (country && !isCountryYear(ymd(next).y)) return;
    moveFocus(next);
  });

  // Basin: hovering a day shows the dekad a pick would select.
  grid.addEventListener("pointerover", (e) => {
    const dk = (e.target as HTMLElement).closest<HTMLElement>("[data-dk]:not(:disabled)")?.dataset.dk;
    for (const el of grid.querySelectorAll<HTMLElement>("[data-dk]")) el.classList.toggle("dk-hover", el.dataset.dk === dk);
  });
  grid.addEventListener("pointerleave", () => {
    for (const el of grid.querySelectorAll(".dk-hover")) el.classList.remove("dk-hover");
  });

  closesLikePopover(pop, [labels.start, labels.end], () => open !== null, hide);

  return {
    render() {
      const { view, range } = getState();
      for (const end of ["start", "end"] as const) {
        const day = end === "start" ? range.start : range.end;
        labels[end].setAttribute("aria-label", `${end === "start" ? "Start" : "End"} date: ${fmtDay(day)}, pick from calendar`);
      }
      if (!open) return;
      if (view !== openView) return hide();
      const hadFocus = grid.contains(document.activeElement);
      draw();
      if (hadFocus) focusCell();
    },
  };
}
