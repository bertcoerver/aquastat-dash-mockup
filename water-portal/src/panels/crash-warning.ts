/*
 * A warning in the corner (corner-warning.ts) for what nothing else reports: an error
 * thrown outside any handler, a promise rejected with nothing to catch it, and the
 * map's WebGL context lost (the browser took the graphics away: the map stays blank
 * until the page is reloaded, so a button offers to). One line each, the details on
 * hover, and each message once, so a fault that repeats every frame doesn't pile up.
 */
import type maplibregl from "maplibre-gl";
import { cornerWarning } from "./corner-warning";

export function initCrashWarning(map: maplibregl.Map) {
  const shown = new Set<string>();
  function warn(text: string, details: string, reload = false) {
    if (shown.has(text)) return;
    shown.add(text);
    const warning = cornerWarning();
    warning.textContent = `⚠ ${text}`;
    warning.title = details;
    if (reload) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Reload";
      button.addEventListener("click", () => window.location.reload());
      warning.append(" ", button);
    }
    warning.hidden = false;
  }
  const text = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
  const stack = (reason: unknown) => (reason instanceof Error ? (reason.stack ?? "") : "");

  window.addEventListener("error", (e) => {
    // (Chrome reports a layout that settled late as an error; nothing is wrong.)
    if (e.message.startsWith("ResizeObserver loop")) return;
    warn(`Something went wrong: ${e.message}`, stack(e.error));
  });
  window.addEventListener("unhandledrejection", (e) => {
    // (A request cut short on purpose, as the view moved on.)
    if (e.reason instanceof Error && e.reason.name === "AbortError") return;
    warn(`Something went wrong: ${text(e.reason)}`, stack(e.reason));
  });
  map.on("webglcontextlost", () => warn("The map stopped drawing: its graphics context was lost.", "", true));
}
