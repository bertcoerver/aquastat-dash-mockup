/*
 * Chart cards that drive the map (Country and Basin panels). Elements marked
 * data-driver="<id>" are drivers; the map follows one of them:
 *
 * - hovering a driver (or focusing it with the keyboard) previews its map, after a
 *   short delay so crossing it on the way elsewhere doesn't repaint the map;
 * - clicking it pins that map, so it stays while the pointer moves on: while a map
 *   is pinned, hovering only previews the rows and series of the pinned driver itself
 *   (clicking another driver re-pins); clicking the pinned one again, Escape, or its
 *   data-unpin button (shown while pinned) unpins it;
 * - inside a driver, the element under the pointer with data-sub (a chart row, a
 *   legend series) is passed along, so the map can pick out that area or series;
 * - data-tip on a chart mark is shown as a tooltip, data-x (a year or month on a
 *   line chart) and data-csv (a download button) are clicked through to the owner
 *   (data-x with its driver, so a chart can say what its steps are: years, months, dekads);
 * - the keyboard does the same: Tab to a driver previews it, Enter or Space pins it,
 *   the arrow keys step along its chart's marks (those with a tooltip: rows, steps,
 *   points), each shown as hovered, and Enter on a step selects it.
 *
 * Where the pins are kept (one per topic, say) is up to the owner.
 */

export interface Driver {
  id: string;
  sub: string | null;
}

interface Options {
  /** Whether the panel is on screen (Escape only unpins then). */
  enabled(): boolean;
  pinned(): Driver | null;
  setPinned(driver: Driver | null): void;
  /** The preview or pin changed: redraw the map and mark the drivers. */
  onChange(): void;
  onX?(x: number, driver: Driver | null): void;
  onCsv?(id: string): void;
  tooltip: HTMLElement;
}

export interface Drivers {
  preview(): Driver | null;
  /** Drop the preview without redrawing (when the panel's content is replaced). */
  clearPreview(): void;
}

const HOVER_DELAY = 120; // ms

const same = (a: Driver | null, b: Driver | null) => a?.id === b?.id && a?.sub === b?.sub;

export function initDrivers(root: HTMLElement, { enabled, pinned, setPinned, onChange, onX, onCsv, tooltip }: Options): Drivers {
  let preview: Driver | null = null;
  let timer = 0;
  let pending = false; // a preview waits for its delay

  function setPreview(next: Driver | null, delay = 0) {
    clearTimeout(timer);
    pending = false;
    // A pinned map stays put, except to show the pinned driver's own rows and series.
    const pin = pinned();
    if (pin && !(next?.sub && next.id === pin.id)) next = null;
    const apply = () => {
      pending = false;
      if (same(next, preview)) return;
      preview = next;
      onChange();
    };
    if (delay) {
      pending = true;
      timer = window.setTimeout(apply, delay);
    } else apply();
  }

  function pin(driver: Driver) {
    // Clicking the pinned card again unpins it (a click on another row or series re-pins).
    const next = same(pinned(), driver) ? null : driver;
    setPinned(next);
    // Unpinned, the driver under the pointer is previewed again.
    clearTimeout(timer);
    preview = next ? null : driver;
    onChange();
  }

  const driverAt = (target: EventTarget | null): Driver | null => {
    const el = (target as Element | null)?.closest?.<HTMLElement>("[data-driver]");
    if (!el || !root.contains(el)) return null;
    const sub = (target as Element).closest<HTMLElement>("[data-sub]")?.dataset.sub ?? null;
    return { id: el.dataset.driver!, sub };
  };

  root.addEventListener("pointerover", (e) => {
    const d = driverAt(e.target);
    if (!d) return;
    // Moving within the previewed or pinned card (to another row) follows at once.
    setPreview(d, preview?.id === d.id || pinned()?.id === d.id ? 0 : HOVER_DELAY);
  });
  root.addEventListener("pointerleave", () => {
    setPreview(null, HOVER_DELAY);
    tooltip.hidden = true;
  });
  root.addEventListener("pointermove", (e) => {
    if (!driverAt(e.target) && (preview || pending)) setPreview(null, HOVER_DELAY);
    const tip = (e.target as Element).closest<HTMLElement>("[data-tip]")?.dataset.tip;
    showTip(tip ?? null, e);
  });
  root.addEventListener("click", (e) => {
    const target = e.target as Element;
    const csv = target.closest<HTMLElement>("[data-csv]");
    if (csv && onCsv) return onCsv(csv.dataset.csv!);
    if (target.closest("[data-unpin]")) {
      setPinned(null);
      // The pointer is on the card: preview it, as after unpinning by clicking it.
      preview = driverAt(target);
      return onChange();
    }
    const x = target.closest<HTMLElement>("[data-x]")?.dataset.x;
    const d = driverAt(target);
    if (x !== undefined && onX) onX(Number(x), d);
    if (d) pin(d);
  });
  root.addEventListener("focusin", (e) => {
    const d = driverAt(e.target);
    if (d) setPreview(d);
  });
  root.addEventListener("focusout", () => {
    clearCursor();
    setPreview(null);
  });

  // The keyboard's place along a focused driver's chart: one of its marks, shown as
  // hovered (.ch-focus, its tooltip, what it stands for on the map).
  let cursor: { card: HTMLElement; marks: HTMLElement[]; at: number } | null = null;
  function moveCursor(card: HTMLElement, step: 1 | -1) {
    const marks = [...card.querySelectorAll<HTMLElement>("[data-tip]")];
    if (!marks.length) return;
    const at = cursor?.card === card ? cursor.at : step > 0 ? -1 : marks.length;
    clearCursor();
    cursor = { card, marks, at: (at + step + marks.length) % marks.length };
    const mark = marks[cursor.at];
    mark.classList.add("ch-focus");
    const box = mark.getBoundingClientRect();
    showTip(mark.dataset.tip ?? null, { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    const sub = mark.closest<HTMLElement>("[data-sub]")?.dataset.sub ?? null;
    setPreview({ id: card.dataset.driver!, sub });
  }
  function clearCursor() {
    cursor?.marks[cursor.at]?.classList.remove("ch-focus");
    cursor = null;
    tooltip.hidden = true;
  }

  root.addEventListener("keydown", (e) => {
    const d = driverAt(e.target);
    const card = e.target as HTMLElement;
    if (!d || !card.matches("[data-driver]")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      return moveCursor(card, e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    // On a step of the chart: select it (as clicking it does); else the driver is pinned.
    const mark = cursor?.card === card ? cursor.marks[cursor.at] : null;
    const x = mark?.closest<HTMLElement>("[data-x]")?.dataset.x;
    if (x !== undefined && onX) return onX(Number(x), d);
    pin(mark ? { id: d.id, sub: mark.closest<HTMLElement>("[data-sub]")?.dataset.sub ?? null } : d);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !enabled() || !pinned()) return;
    setPinned(null);
    onChange();
  });

  // (The same tooltip as shown, moved along, isn't written again: the panels share
  // theirs with the map's, so what was written is checked by its first node.)
  let tipWritten: { html: string; node: ChildNode | null } | null = null;
  function showTip(html: string | null, e: { clientX: number; clientY: number }) {
    if (!html) return void (tooltip.hidden = true);
    if (html !== tipWritten?.html || tooltip.firstChild !== tipWritten.node) {
      tooltip.innerHTML = html;
      tipWritten = { html, node: tooltip.firstChild };
    }
    tooltip.hidden = false;
    // Left of the pointer: the panels are on the right edge of the screen.
    const w = tooltip.offsetWidth;
    tooltip.style.left = `${Math.max(8, e.clientX - w - 14)}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  }

  return {
    preview: () => preview,
    clearPreview() {
      clearTimeout(timer);
      preview = null;
    },
  };
}

/**
 * Mark the drivers under `root`: the one the map shows, the previewed and the pinned
 * one, and within the pinned one the row or series it was pinned on (if any).
 */
export function markDrivers(root: HTMLElement, shown: Driver | null, preview: Driver | null, pinned: Driver | null) {
  for (const el of root.querySelectorAll<HTMLElement>("[data-driver]")) {
    const id = el.dataset.driver;
    el.classList.toggle("previewing", preview?.id === id);
    el.classList.toggle("pinned", pinned?.id === id);
    el.classList.toggle("mapped", shown?.id === id);
    el.setAttribute("aria-pressed", String(pinned?.id === id));
  }
  for (const el of root.querySelectorAll("[data-sub]")) {
    const on = !!pinned?.sub && el.getAttribute("data-sub") === pinned.sub && el.closest<HTMLElement>("[data-driver]")?.dataset.driver === pinned.id;
    el.classList.toggle("pinned-sub", on);
  }
}
