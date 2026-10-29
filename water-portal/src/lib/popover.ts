/*
 * What closes a popup once it's open: Escape on it or its openers (closing it puts the
 * focus back on the opener), a press anywhere else, the focus leaving it, and the window
 * resizing or the panes moving (it would be out of place).
 */
export function closesLikePopover(
  pop: HTMLElement,
  openers: HTMLElement[],
  isOpen: () => boolean,
  /** `refocus`: put the focus back on the opener. */
  close: (refocus: boolean) => void,
) {
  for (const el of [pop, ...openers]) {
    el.addEventListener("keydown", (e) => {
      if (!isOpen() || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation(); // (Escape elsewhere unpins the map)
      close(true);
    });
  }
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as Node;
      if (isOpen() && !pop.contains(t) && !openers.some((el) => el.contains(t))) close(false);
    },
    true,
  );
  pop.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !pop.contains(to) && !openers.includes(to as HTMLElement)) close(false);
  });
  window.addEventListener("resize", () => close(false));
  window.addEventListener("panes-moved", () => close(false));
}
