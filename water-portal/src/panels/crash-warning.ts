/*
 * A warning in the corner (corner-warning.ts) for what nothing else reports: an error
 * thrown outside any handler, a promise rejected with nothing to catch it, and the
 * map's WebGL context lost (the browser took the graphics away: the map stays blank
 * until the page is reloaded, so a button offers to). One line each, the details on
 * hover, and each message once, so a fault that repeats every frame doesn't pile up.
 */
import type { WaterMap } from "../map/map";
import { cornerWarning } from "./corner-warning";

export function initCrashWarning(map: Pick<WaterMap, "onContextLost">) {
  const shown = new Set<string>();
  function warn(text: string, details: string, reload = false) {
    if (shown.has(text)) return;
    shown.add(text);
    let button: HTMLButtonElement | undefined;
    if (reload) {
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "Reload";
      button.addEventListener("click", () => window.location.reload());
    }
    cornerWarning().show(text, details, button);
  }
  const text = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
  /** All an error tells: its name and message, where it was thrown, its stack (which starts with the name and message in some browsers). */
  function about(reason: unknown, where = "") {
    const head = reason instanceof Error ? `${reason.name}: ${reason.message}` : `Reason: ${String(reason)}`;
    const stack = reason instanceof Error ? (reason.stack ?? "") : "";
    return [stack.startsWith(head) ? "" : head, where, stack].filter(Boolean).join("\n");
  }

  window.addEventListener("error", (e) => {
    // (Chrome reports a layout that settled late as an error; nothing is wrong.)
    if (e.message.startsWith("ResizeObserver loop")) return;
    warn(`Something went wrong: ${e.message}`, about(e.error ?? e.message, e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : ""));
  });
  window.addEventListener("unhandledrejection", (e) => {
    // (A request cut short on purpose, as the view moved on.)
    if (e.reason instanceof Error && e.reason.name === "AbortError") return;
    warn(`Something went wrong: ${text(e.reason)}`, about(e.reason));
  });
  map.onContextLost(() => warn("The map stopped drawing: its graphics context was lost.", "The browser took the map's WebGL context away (too many contexts, a driver fault, or memory). Reloading the page gets a new one.", true));
}
