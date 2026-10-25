/*
 * The place pickers, one per view (markup in index.html):
 *   Country — a country combobox, as the title of the country panel
 *   Basin   — a tree of major basins and their sub-basins (basin-tree.ts), as the title
 *             of the water balance panel
 *   Local   — the point as the Local panel's title, which opens longitude / latitude
 *             fields; the picker also shows and collapses the panel (its charts: local-panel.ts)
 * They show the current selection, whichever way it was made. A title reads as a
 * heading ("World", "Kenya") with a small ▾, and becomes a search field when clicked.
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
    (option) => {
      onCountry(option ? countryById.get(option.id)! : null);
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
  const collapse = document.getElementById("lp-collapse")!;
  collapse.addEventListener("click", () => {
    const collapsed = localPanel.classList.toggle("collapsed");
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.textContent = collapsed ? "+" : "–";
  });
  const titles = [...document.querySelectorAll<HTMLElement>(".title-field")].map(titleField);
  const fitTitles = () => titles.forEach((fit) => fit());

  return {
    setView(view) {
      localPanel.hidden = view !== "local";
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
