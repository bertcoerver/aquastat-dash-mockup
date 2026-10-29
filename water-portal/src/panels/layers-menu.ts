/*
 * The Layers button and its small menu of on/off switches and the theme.
 * The markup lives in index.html; each layer checkbox names its layer in data-layer.
 * main.ts puts it among the map's controls.
 *
 * Each view keeps its own switches: rivers and lakes start off in the Local view (they'd
 * cover the WaPOR raster), on in the others. The graticule starts off everywhere. The
 * Basin view also has what hovering a sub-basin picks out: those upstream and
 * downstream of it (both on); switches inside a data-views element show in those views only.
 * The outlines of countries, basins and sub-basins: the view's own (FIXED) stay on and
 * can't be switched; the others start as they were drawn before there were switches.
 */
import type { ToggleableLayer } from "../map/map";
import type { View } from "../toolbar/range-rules";

const DEFAULTS: Record<View, Record<ToggleableLayer, boolean>> = {
  country: { rivers: true, lakes: true, graticule: false, upstream: true, downstream: true, countries: true, basins: false, subBasins: false },
  basin: { rivers: true, lakes: true, graticule: false, upstream: true, downstream: true, countries: false, basins: true, subBasins: true },
  local: { rivers: false, lakes: false, graticule: false, upstream: true, downstream: true, countries: true, basins: false, subBasins: false },
};

/** The switches a view keeps on (shown ticked, disabled); the map draws those its own way. */
const FIXED: Record<View, ToggleableLayer[]> = {
  country: ["countries"],
  basin: ["basins", "subBasins"],
  local: [],
};

export interface LayersMenu {
  /** Show a view's switches, and its layers on the map. */
  setView(view: View): void;
}

export function initLayersMenu(onToggle: (layer: ToggleableLayer, visible: boolean) => void): LayersMenu {
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

  const visible = structuredClone(DEFAULTS);
  let view: View | null = null;
  const inputs = [...panel.querySelectorAll<HTMLInputElement>("input[data-layer]")];
  for (const input of inputs) {
    input.addEventListener("change", () => {
      const layer = input.dataset.layer as ToggleableLayer;
      if (view) visible[view][layer] = input.checked;
      onToggle(layer, input.checked);
    });
  }

  return {
    setView(next) {
      if (next === view) return;
      view = next;
      for (const input of inputs) {
        const layer = input.dataset.layer as ToggleableLayer;
        input.disabled = FIXED[next].includes(layer);
        input.checked = input.disabled || visible[next][layer];
        onToggle(layer, input.checked);
        const only = input.closest<HTMLElement>("[data-views]");
        if (only) only.hidden = !only.dataset.views!.split(" ").includes(next);
      }
    },
  };
}
