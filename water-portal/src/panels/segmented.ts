/*
 * Segmented switches (the view tabs, the Country view's topics): the selection is one
 * highlight that slides to the picked button rather than jumping. It is the switch's
 * ::before (base.css), placed by the --seg-* variables set here whenever the selected
 * button (aria-selected or aria-checked) or the switch's size changes.
 */
const SELECTED = '[aria-selected="true"], [aria-checked="true"]';

export function slideSelection(el: HTMLElement) {
  el.classList.add("segmented");
  // Hidden (the view tabs move to the next view's pane before that pane shows): try
  // again for a few frames. The ResizeObserver can't be relied on for this, as the
  // switch often comes back at the size it had.
  let retry = 0;
  let tries = 0;
  function place() {
    cancelAnimationFrame(retry);
    const button = el.querySelector<HTMLElement>(SELECTED);
    if (!button) return;
    if (!el.offsetWidth) {
      if (++tries <= 30) retry = requestAnimationFrame(place);
      return;
    }
    tries = 0;
    el.style.setProperty("--seg-x", `${button.offsetLeft}px`);
    el.style.setProperty("--seg-y", `${button.offsetTop}px`);
    el.style.setProperty("--seg-w", `${button.offsetWidth}px`);
    el.style.setProperty("--seg-h", `${button.offsetHeight}px`);
    // The first time it just appears there; from then on it slides.
    if (!el.classList.contains("placed")) {
      el.classList.add("placed");
      requestAnimationFrame(() => el.classList.add("sliding"));
    }
  }
  const update = () => {
    tries = 0;
    place();
  };
  new MutationObserver(update).observe(el, { subtree: true, childList: true, attributeFilter: ["aria-selected", "aria-checked"] });
  new ResizeObserver(update).observe(el);
  update();
}
