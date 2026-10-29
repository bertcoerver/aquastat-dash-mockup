/*
 * The place pickers, one per view (markup in index.html):
 *   Country — a tree of regions and their countries (country-tree.ts), as the title of
 *             the country panel
 *   Basin   — a tree of major basins and their sub-basins (basin-tree.ts), as the title
 *             of the water balance panel
 *   Local   — the point as the Local panel's title, which opens longitude / latitude
 *             fields; with a dam picked (on the map), its point comes first and its name
 *             after ("12.345° N, 4.567° E · Kainji"), the point opening the fields, the
 *             name a search of the dams (dam-tree.ts) and the × going back to the point.
 *             The picker also shows the panel (its charts: local-panel.ts)
 * They show the current selection, whichever way it was made. A title reads as a
 * heading ("World", "Kenya") with a small ▾, and becomes a search field when clicked.
 * With a country or sub-basin selected, its parent comes first, "Eastern Africa · Kenya",
 * and clicking it, or the × after the title, selects the parent alone (the × again: nothing).
 */
import type { Dams } from "../local/vector-maps";
import type { Box } from "../map/fly-to";
import type { LngLat } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import type { SelectedFeature, Selection } from "../selection";
import { basinTree, majorKey, subKey, type BasinNode, type MajorBasin } from "./basin-tree";
import { countryKey, countryTree, regionKey, type Country, type CountryNode, type Region } from "./country-tree";
import { damKey, damTree } from "./dam-tree";
import { initTreeCombobox, type TreeCombobox } from "./tree-combobox";
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
  /** A dam picked by name, and where it is. */
  onFeature(feature: SelectedFeature, lngLat: LngLat): void;
  /** The dam's × : its point, without it. */
  onDropFeature(): void;
  /** A country picked in the dams' search: around its dams. */
  onDamCountry(box: Box): void;
}

export interface PlacePicker {
  setView(view: View): void;
  show(selection: Selection): void;
  /** The dams to search (once loaded). */
  setDams(dams: Dams): void;
}

export function initPlacePicker({ countries, regions, regionOf, basins, subBasins, onCountry, onBasin, onPoint, onFeature, onDropFeature, onDamCountry }: PlacePickerOptions): PlacePicker {
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

  // The point: the title opens a popup below it with either the coordinates' fields or,
  // when the title is a dam's name, the dams' search (whose list opens only once it's
  // clicked); the point before the name opens the fields. So the search is only there
  // once a dam was picked on the map. The form only submits when both are valid numbers
  // in range. Escape, or a press elsewhere, closes it.
  const popup = document.getElementById("lp-popup")!;
  const form = document.getElementById("coords") as HTMLFormElement;
  const lon = document.getElementById("lon-input") as HTMLInputElement;
  const lat = document.getElementById("lat-input") as HTMLInputElement;
  const clearPoint = document.getElementById("coords-clear") as HTMLButtonElement;
  const localTitle = document.getElementById("lp-title") as HTMLButtonElement;
  const pointTitle = document.getElementById("lp-coord") as HTMLButtonElement;
  const damInput = document.getElementById("dam-input") as HTMLInputElement;
  const damSearch = document.getElementById("dam-combobox")!;
  let shown: Selection | null = null;
  const setPopupOpen = (open: boolean, search = false) => {
    popup.hidden = !open;
    localTitle.setAttribute("aria-expanded", String(open));
    if (!open) return;
    form.hidden = search;
    damSearch.hidden = !search;
    (search ? damInput : lon).focus();
  };
  localTitle.addEventListener("click", () => setPopupOpen(popup.hidden, shown?.feature?.map === "dams"));
  pointTitle.addEventListener("click", () => setPopupOpen(true));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    setPopupOpen(false);
    onPoint([Number(lon.value), Number(lat.value)]);
  });
  popup.addEventListener("keydown", (e) => {
    // (Not when the search's list closes on it.)
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.stopPropagation();
    setPopupOpen(false);
    localTitle.focus();
  });
  // (By the path the press took: a tree row pressed is drawn again at once, so it's no
  // longer in the popup by the time the press gets here.)
  document.addEventListener("pointerdown", (e) => {
    const path = e.composedPath();
    if (!popup.hidden && ![popup, localTitle, pointTitle].some((el) => path.includes(el))) setPopupOpen(false);
  });
  clearPoint.addEventListener("click", () => (shown?.feature ? onDropFeature() : onPoint(null)));

  // The dams' search (once they're loaded): a dam selects it, a country flies to its dams.
  let dams: TreeCombobox | null = null;
  function setDams(data: Dams) {
    if (dams) return;
    damInput.disabled = false;
    damInput.placeholder = damInput.dataset.search!;
    dams = initTreeCombobox(damSearch, damTree(data), (option) => {
      if (!option) return;
      setPopupOpen(false);
      const d = option.data;
      if (d.kind === "country") return onDamCountry(d.box);
      onFeature({ map: "dams", index: d.index, name: option.label }, [data.lon[d.index], data.lat[d.index]]);
    });
    if (shown) dams.setValue(shown.feature?.map === "dams" ? damKey(shown.feature.index) : null);
  }

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
      shown = selection;
      const { feature } = selection;
      const point = p ? `${fmtLat(p[1])}, ${fmtLon(p[0])}` : "Pick a point";
      clearPoint.hidden = !p;
      clearPoint.title = feature ? "Show the point only" : "Clear point";
      clearPoint.setAttribute("aria-label", clearPoint.title);
      pointTitle.hidden = !feature;
      pointTitle.textContent = point;
      pointTitle.title = feature ? `${point}: type coordinates` : "";
      localTitle.querySelector(".title-menu-label")!.textContent = feature ? feature.name : point;
      dams?.setValue(feature?.map === "dams" ? damKey(feature.index) : null);
      fitTitles();
    },
    setDams,
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
