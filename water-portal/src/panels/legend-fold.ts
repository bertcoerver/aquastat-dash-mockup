/*
 * The legend's fold, for phones: there it lies across the top of the map and the graph
 * pane is a sheet along the bottom (styles/compact.css), so the legend folds to its title
 * line while the sheet is open, or shows a pinned chart folded, to leave the map between
 * them. A button in the title opens it or folds it all the same; that choice holds until
 * the sheet next opens or folds. The three legends (one per view) fold as one. On a wider
 * screen the button is hidden and the legend never folds.
 */
import { narrowLayout } from "../lib/dom";

export function initLegendFold(legends: HTMLElement[], panes: HTMLElement[]) {
  /** The user's choice since the sheet last opened or folded (null: as the sheet says). */
  let chosen: boolean | null = null;
  /** Whether the sheet asks for it folded: one is open (not .folding), or folded with a pinned chart (.has-kept). */
  const asked = () => narrowLayout.matches && panes.some((p) => !p.hidden && (!p.classList.contains("folding") || p.classList.contains("has-kept")));
  const folded = () => chosen ?? asked();

  const buttons = legends.map((legend) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "legend-fold";
    button.innerHTML = '<span class="title-caret" aria-hidden="true"></span>';
    button.addEventListener("click", () => {
      chosen = !folded();
      apply();
    });
    legend.querySelector(".legend-title")!.append(button);
    return button;
  });

  function apply() {
    const on = folded();
    for (const legend of legends) legend.classList.toggle("folded", on);
    for (const button of buttons) {
      button.setAttribute("aria-expanded", String(!on));
      button.setAttribute("aria-label", on ? "Show the legend" : "Fold the legend");
      button.title = on ? "Show the legend" : "Fold the legend";
    }
  }

  // The sheet opened or folded: as it says again, the choice forgotten.
  let was = asked();
  const follow = () => {
    const now = asked();
    if (now !== was) {
      was = now;
      chosen = null;
    }
    apply();
  };
  const observer = new MutationObserver(follow);
  for (const pane of panes) observer.observe(pane, { attributes: true, attributeFilter: ["class", "hidden"] });
  narrowLayout.addEventListener("change", follow);
  apply();
}
