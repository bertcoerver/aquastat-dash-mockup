/*
 * The place pickers, one per view (markup in index.html):
 *   Country — a tree of regions and their countries (country-tree.ts), as the title of
 *             the country panel
 *   Basin   — a tree of major basins and their sub-basins (basin-tree.ts), as the title
 *             of the water balance panel
 *   Local   — the point as the Local panel's title, which opens longitude / latitude
 *             fields; the picker also shows the panel (its charts: local-panel.ts)
 * They show the current selection, whichever way it was made. A title reads as a
 * heading ("World", "Kenya") with a small ▾, and becomes a search field when clicked.
 * With a country or sub-basin selected, its parent comes first, "Eastern Africa · Kenya",
 * and clicking it, or the × after the title, selects the parent alone (the × again: nothing).
 */
import type { LngLat } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import type { Selection } from "../selection";
import { basinTree, majorKey, subKey, type BasinNode, type MajorBasin } from "./basin-tree";
import { countryKey, countryTree, regionKey, type Country, type CountryNode, type Region } from "./country-tree";
import { initTreeCombobox } from "./tree-combobox";
import type { View } from "./range-rules";

export type { BasinNode, Country, CountryNode, MajorBasin, Region };

interface PlacePickerOptions {
  countries: Country[];
  regions: Region[];
  /** Each country's region (M49 → region code; none: in no region). */
  regionOf: Map<number, number>;
  basins: MajorBasin[];
  subBasins: SubBasin[];
  /** A region or a country (see CountryNode's data), or none. */
  onCountry(picked: CountryNode["data"] | null): void;
  /** A major basin or a sub-basin (see BasinNode's data), or none. */
  onBasin(basin: BasinNode["data"] | null): void;
  onPoint(lngLat: LngLat | null): void;
}

export interface PlacePicker {
  setView(view: View): void;
  show(selection: Selection): void;
}

export function initPlacePicker({ countries, regions, regionOf, basins, subBasins, onCountry, onBasin, onPoint }: PlacePickerOptions): PlacePicker {
  const regionByCode = new Map(regions.map((r) => [r.code, r]));
  const basinById = new Map(basins.map((b) => [b.id, b]));

  const country = initTreeCombobox(
    document.getElementById("country-combobox")!,
    countryTree(regions, countries, regionOf),
    (option) => {
      onCountry(option?.data ?? null);
      done("country-input");
    },
  );
  const basin = initTreeCombobox(
    document.getElementById("basin-combobox")!,
    basinTree(basins, subBasins),
    (option) => {
      onBasin(option?.data ?? null);
      done("basin-input");
    },
  );

  // The parents in the titles: what they select is set as the selection is shown.
  const countryParent = document.getElementById("country-parent") as HTMLButtonElement;
  const basinParent = document.getElementById("basin-parent") as HTMLButtonElement;
  let parentRegion: Region | null = null;
  let parentBasin: MajorBasin | null = null;
  countryParent.addEventListener("click", () => parentRegion && onCountry({ kind: "region", region: parentRegion }));
  basinParent.addEventListener("click", () => parentBasin && onBasin({ kind: "major", basin: parentBasin }));
  const countryClear = document.querySelector<HTMLButtonElement>("#country-combobox .combobox-clear")!;
  const basinClear = document.querySelector<HTMLButtonElement>("#basin-combobox .combobox-clear")!;
  /** The parent's button, and the ×: up to the parent, or (`all`) to none. */
  const showParent = (button: HTMLButtonElement, clear: HTMLButtonElement, name: string | null, what: string, all: string) => {
    button.hidden = !name;
    button.textContent = name ?? "";
    button.title = name ? `Show all of ${name}` : "";
    button.setAttribute("aria-label", name ? `${what}: ${name}. Show all of it` : "");
    clear.title = name ? `Show all of ${name}` : all;
    clear.setAttribute("aria-label", clear.title);
  };

  // Coordinates: the title opens the fields below it; the form only submits when both
  // are valid numbers in range. Escape, or a press elsewhere, closes them.
  const form = document.getElementById("coords") as HTMLFormElement;
  const lon = document.getElementById("lon-input") as HTMLInputElement;
  const lat = document.getElementById("lat-input") as HTMLInputElement;
  const clearPoint = document.getElementById("coords-clear") as HTMLButtonElement;
  const localTitle = document.getElementById("lp-title") as HTMLButtonElement;
  const setFieldsOpen = (open: boolean) => {
    form.hidden = !open;
    localTitle.setAttribute("aria-expanded", String(open));
    if (open) lon.focus();
  };
  localTitle.addEventListener("click", () => setFieldsOpen(form.hidden));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setFieldsOpen(false);
    onPoint([Number(lon.value), Number(lat.value)]);
  });
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setFieldsOpen(false);
    localTitle.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    const target = e.target as Node;
    if (!form.hidden && !form.contains(target) && !localTitle.contains(target)) setFieldsOpen(false);
  });
  clearPoint.addEventListener("click", () => onPoint(null));

  const localPanel = document.getElementById("lp-panel")!;
  const titles = [...document.querySelectorAll<HTMLElement>(".title-field")].map(titleField);
  const fitTitles = () => titles.forEach((fit) => fit());

  return {
    setView(view) {
      localPanel.hidden = view !== "local";
    },
    show(selection) {
      // The most precise: a country comes with its region, a sub-basin with its major basin.
      const { region, country: c, majorBasin, subBasin } = selection;
      country.setValue(c ? countryKey(c.m49) : region ? regionKey(region.code) : null);
      parentRegion = c ? regionByCode.get(regionOf.get(c.m49) ?? NaN) ?? null : null;
      showParent(countryParent, countryClear, parentRegion?.name ?? null, "Region", "Show the world");
      basin.setValue(subBasin ? subKey(subBasin.id) : majorBasin ? majorKey(majorBasin.id) : null);
      parentBasin = subBasin && majorBasin ? basinById.get(majorBasin.id) ?? null : null;
      showParent(basinParent, basinClear, parentBasin?.name ?? null, "Major basin", "Show all basins");
      const p = selection.lngLat;
      lon.value = p ? String(round(p[0])) : "";
      lat.value = p ? String(round(p[1])) : "";
      clearPoint.hidden = !p;
      localTitle.querySelector(".title-menu-label")!.textContent = p ? `${fmtLat(p[1])}, ${fmtLon(p[0])}` : "Pick a point";
      fitTitles();
    },
  };
}

/**
 * A combobox as a title: it says what's chosen, or `data-empty` ("World") when nothing
 * is, and asks to search (`data-search`) while it has focus. It is as wide as its text
 * (the field's ::after, in CSS, holds a copy), so the ▾ follows the name. Returns a
 * function that refits it after its value was set from outside.
 */
function titleField(field: HTMLElement) {
  const input = field.querySelector("input")!;
  const fit = () => {
    input.placeholder = document.activeElement === input ? field.dataset.search! : field.dataset.empty!;
    field.dataset.value = input.value || input.placeholder;
  };
  // (after the combobox's own handlers, which set the value on blur)
  for (const type of ["input", "focus", "blur"]) input.addEventListener(type, fit);
  fit();
  return fit;
}

/** After a pick, a title goes back to reading as text. */
const done = (inputId: string) => document.getElementById(inputId)!.blur();

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const fmtLat = (v: number) => `${Math.abs(v).toFixed(3)}° ${v < 0 ? "S" : "N"}`;
const fmtLon = (v: number) => `${Math.abs(v).toFixed(3)}° ${v < 0 ? "W" : "E"}`;
