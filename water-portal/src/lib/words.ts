/*
 * The words for what the pointer does. A finger can't hover: where a caption says to
 * hover a row to see something, it taps it (which also pins it: panels/map-drivers.ts),
 * and where it says to click, it taps. Read when the caption is written, not once.
 */

/** No pointer that hovers (a finger). */
export const noHover = window.matchMedia("(hover: none)");

/** `mouse` for a pointer that hovers, `touch` for a finger. */
export const byPointer = (mouse: string, touch: string) => (noHover.matches ? touch : mouse);

/** The verb for seeing something on the map without choosing it: "Hover" a row, or "Tap" it. */
export const Hover = () => byPointer("Hover", "Tap");
export const hover = () => byPointer("hover", "tap");
/** The verb for choosing: "click" a year, or "tap" it. */
export const click = () => byPointer("click", "tap");
