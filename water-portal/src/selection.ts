/*
 * The current selection (the "click state"): what the user picked, by clicking the
 * map, choosing a place in a panel title, or typing coordinates.
 *
 * Both views pick from a tree of two levels: a region and its countries, a major basin
 * and its sub-basins. Either level can be selected; a country comes with its region
 * (looked up from it), a sub-basin with its major basin. `region` is only set when a
 * region itself is selected.
 *
 * Picking by name selects only that: none of the other areas. Picking a point by
 * coordinates (or in the Local view) selects everything it lies in; a map click in the
 * Country or Basin view picks what the map shows (see main.ts). The point itself
 * (`lngLat`) is the Local view's: only picking there changes it, so in the Country and
 * Basin views it can lie outside what's selected. So is `feature`: a point of one of the
 * Local view's vector maps (a dam) picked on the map or by name, the point then being
 * its own.
 */
import type { LngLat, Place } from "./map/places";

export type SelectionSource = "map" | "country" | "basin" | "coordinates";

/** A point of a vector map (src/local/vector-maps.ts): the map's id, its index there, its name. */
export interface SelectedFeature {
  map: string;
  index: number;
  name: string;
}

export interface Selection extends Place {
  source: SelectionSource | null;
  lngLat: LngLat | null;
  feature: SelectedFeature | null;
  /** A region selected on its own (null with a country: its region is the country's). */
  region: { code: number; name: string } | null;
}

export const NOTHING: Selection = { source: null, lngLat: null, feature: null, region: null, country: null, majorBasin: null, subBasin: null };

type Listener = (selection: Selection) => void;

let current: Selection = NOTHING;
const listeners: Listener[] = [];

export const selection = {
  get: () => current,
  set(next: Selection) {
    current = next;
    for (const listener of listeners) listener(next);
  },
  /** Run `listener` on every change. */
  subscribe(listener: Listener) {
    listeners.push(listener);
  },
};
