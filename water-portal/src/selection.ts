/*
 * The current selection (the "click state"): what the user picked, by clicking the
 * map, choosing a country or basin in a panel title, or typing coordinates.
 *
 * Picking a country or basin by name selects only that: no point, and none of the
 * other areas. Picking a point (map click or coordinates) selects the point and
 * everything it lies in.
 */
import type { LngLat, Place } from "./map/places";

export type SelectionSource = "map" | "country" | "basin" | "coordinates";

export interface Selection extends Place {
  source: SelectionSource | null;
  lngLat: LngLat | null;
}

export const NOTHING: Selection = { source: null, lngLat: null, country: null, majorBasin: null, subBasin: null };

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
