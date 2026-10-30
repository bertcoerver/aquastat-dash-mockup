/*
 * A button among the map's controls that sets the globe turning slowly, as the Earth
 * does (west to east: the camera goes west), until it's clicked again or anything
 * else moves the map (a drag, a zoom, a fly to a place). The globe's own (globe-host.ts):
 * a flat map has edges.
 */
import type maplibregl from "maplibre-gl";

/** Degrees of longitude a second: a turn a minute. */
const SPEED = 6;
/** Turned in steps of this many degrees, each its own ease (see below). */
const STEP = 30;

export function spinControl(map: maplibregl.Map): { element: HTMLButtonElement; destroy(): void } {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "spin-button";
  button.setAttribute("aria-pressed", "false");
  button.setAttribute("aria-label", "Spin the globe");
  button.title = "Spin the globe";
  button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M20 12a8 8 0 1 1-2.34-5.66 M20 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

  // Each step eases to a longitude further on; when it ends, the next starts. A step
  // stopped short of its longitude was stopped by something else moving the map
  // (MapLibre stops an ease for a drag, a zoom or another ease): the spin ends there.
  let target: number | null = null;
  function step() {
    const { lng, lat } = map.getCenter();
    target = lng - STEP;
    // (Essential: asked for, so it turns with reduced motion too, rather than jumping.)
    map.easeTo({ center: [target, lat], duration: (STEP / SPEED) * 1000, easing: (t) => t, essential: true });
  }
  function onMoveEnd() {
    if (target === null) return;
    const off = Math.abs(((map.getCenter().lng - target + 540) % 360) - 180);
    if (off < 0.01) step();
    else stop();
  }
  function start() {
    button.setAttribute("aria-pressed", "true");
    map.on("moveend", onMoveEnd);
    step();
  }
  function stop() {
    target = null;
    button.setAttribute("aria-pressed", "false");
    map.off("moveend", onMoveEnd);
  }
  button.addEventListener("click", () => {
    if (target === null) start();
    else {
      stop();
      map.stop();
    }
  });

  return { element: button, destroy: stop };
}
