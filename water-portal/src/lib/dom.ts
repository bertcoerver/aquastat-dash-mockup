/** The element with an id (index.html): an error naming it if there's none, not a null that fails later. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`No element #${id} in the page`);
  return el as T;
}

/** Whether the reader asked for less motion: what would animate then doesn't. */
export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** A phone's screen (or a window as narrow): the compact layout, styles/compact.css. */
export const narrowLayout = window.matchMedia("(max-width: 640px)");
/** A finger rather than a mouse: bigger things to grab, and nothing happens on hover. */
export const coarsePointer = window.matchMedia("(pointer: coarse)");
