/*
 * Panes whose width can be changed, from a grip on their right edge (the graph panes).
 * The width is remembered in this browser; "Reset layout" in the Layers menu forgets
 * it. Panes that share a key (the graph panes of the different views) share one width.
 * After a resize, "panes-moved" is dispatched on window.
 */

const STORAGE_KEY = "water-portal:widths";
/** Other layouts that "Reset layout" forgets (debug-panel.ts keeps its own). */
const OTHER_KEYS = ["water-portal:debug-panel", "water-portal:debug-closed"];

const panes = new Map<string, HTMLElement[]>();
const widths: Record<string, number> = load();

export function makeResizable(pane: HTMLElement, key: string) {
  pane.classList.add("pane");
  panes.set(key, [...(panes.get(key) ?? []), pane]);
  if (widths[key] !== undefined) pane.style.width = `${widths[key]}px`;

  const grip = document.createElement("div");
  grip.className = "pane-resize";
  grip.setAttribute("aria-hidden", "true");
  pane.append(grip);
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection
    resizeFrom(e, pane, key, grip);
  });
}

/** Forget every pane's width and lay the page out afresh. */
export function resetLayout() {
  try {
    for (const k of [STORAGE_KEY, ...OTHER_KEYS]) localStorage.removeItem(k);
  } catch {
    // Nothing was kept, then.
  }
  location.reload();
}

function resizeFrom(down: PointerEvent, pane: HTMLElement, key: string, grip: HTMLElement) {
  grip.setPointerCapture(down.pointerId);
  const start = pane.offsetWidth;
  pane.classList.add("resizing");
  const move = (e: PointerEvent) => {
    // (CSS keeps it between its min- and max-width)
    const width = Math.round(start + e.clientX - down.clientX);
    for (const p of panes.get(key) ?? []) p.style.width = `${width}px`;
  };
  const end = () => {
    grip.removeEventListener("pointermove", move);
    pane.classList.remove("resizing");
    widths[key] = pane.offsetWidth;
    for (const p of panes.get(key) ?? []) p.style.width = `${widths[key]}px`;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Storage can be unavailable (private browsing); the width just isn't kept.
    }
    window.dispatchEvent(new Event("panes-moved"));
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end, { once: true });
  grip.addEventListener("pointercancel", end, { once: true });
}

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
