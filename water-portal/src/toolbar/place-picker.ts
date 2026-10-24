/*
 * The place picker in the top bar, between the view tabs and the date range. One
 * widget per view (markup in index.html, marked with data-view):
 *   Country — a country combobox
 *   Basin   — a tree of major basins and their sub-basins (basin-tree.ts)
 *   Local   — longitude / latitude fields
 * The widgets show the current selection, whichever way it was made.
 */
import type { LngLat } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import type { Selection } from "../selection";
import { basinTree, majorKey, subKey, type BasinNode, type MajorBasin } from "./basin-tree";
import { initCombobox } from "./combobox";
import { initTreeCombobox } from "./tree-combobox";
import type { View } from "./range-rules";

export type { BasinNode, MajorBasin };

/** An entry of public/data/countries.json (scripts/build-lists.mjs). */
export interface Country {
  m49: number;
  name: string;
  bbox: [number, number, number, number];
}

interface PlacePickerOptions {
  countries: Country[];
  basins: MajorBasin[];
  subBasins: SubBasin[];
  onCountry(country: Country | null): void;
  /** A major basin or a sub-basin (see BasinNode's data), or none. */
  onBasin(basin: BasinNode["data"] | null): void;
  onPoint(lngLat: LngLat | null): void;
}

export interface PlacePicker {
  setView(view: View): void;
  show(selection: Selection): void;
}

export function initPlacePicker({ countries, basins, subBasins, onCountry, onBasin, onPoint }: PlacePickerOptions): PlacePicker {
  const countryById = new Map(countries.map((c) => [c.m49, c]));

  const country = initCombobox(
    document.getElementById("country-combobox")!,
    countries.map((c) => ({ id: c.m49, label: c.name, hint: String(c.m49) })),
    (option) => onCountry(option ? countryById.get(option.id)! : null),
  );
  const basin = initTreeCombobox(
    document.getElementById("basin-combobox")!,
    basinTree(basins, subBasins),
    (option) => onBasin(option?.data ?? null),
  );

  // Coordinates: the form only submits when both fields are valid numbers in range.
  const form = document.getElementById("coords") as HTMLFormElement;
  const lon = document.getElementById("lon-input") as HTMLInputElement;
  const lat = document.getElementById("lat-input") as HTMLInputElement;
  const clearPoint = document.getElementById("coords-clear") as HTMLButtonElement;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onPoint([Number(lon.value), Number(lat.value)]);
  });
  clearPoint.addEventListener("click", () => onPoint(null));

  const widgets = document.querySelectorAll<HTMLElement>(".place-widget");

  return {
    setView(view) {
      for (const w of widgets) w.hidden = w.dataset.view !== view;
    },
    show(selection) {
      country.setValue(selection.country?.m49 ?? null);
      // The most precise basin: a map click selects both.
      const { majorBasin, subBasin } = selection;
      basin.setValue(subBasin ? subKey(subBasin.id) : majorBasin ? majorKey(majorBasin.id) : null);
      const p = selection.lngLat;
      lon.value = p ? String(round(p[0])) : "";
      lat.value = p ? String(round(p[1])) : "";
      clearPoint.hidden = !p;
    },
  };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
