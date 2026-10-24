/*
 * The Layers button and its small menu of on/off switches, the theme and the layout.
 * The markup lives in index.html; each layer checkbox names its layer in data-layer.
 * main.ts puts it among the map's controls.
 */
import type { ToggleableLayer } from "../map/map";
import { resetLayout } from "./floating";

export function initLayersMenu(onToggle: (layer: ToggleableLayer, visible: boolean) => void) {
  const menu = document.getElementById("layers-menu")!;
  const button = document.getElementById("layers-button")!;
  const panel = document.getElementById("layers-panel")!;

  function setOpen(open: boolean) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }

  button.addEventListener("click", () => setOpen(panel.hidden));
  // Close on a click elsewhere, or Escape.
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) {
      setOpen(false);
      button.focus();
    }
  });

  for (const input of panel.querySelectorAll<HTMLInputElement>("input[data-layer]")) {
    input.addEventListener("change", () => onToggle(input.dataset.layer as ToggleableLayer, input.checked));
  }
  document.getElementById("reset-layout")!.addEventListener("click", resetLayout);
}
