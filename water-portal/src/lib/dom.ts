/** The element with an id (index.html): an error naming it if there's none, not a null that fails later. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`No element #${id} in the page`);
  return el as T;
}

/** Whether the reader asked for less motion: what would animate then doesn't. */
export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** A finger rather than a mouse: bigger things to grab (styles/touch.css too). */
export const coarsePointer = window.matchMedia("(pointer: coarse)");
