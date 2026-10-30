/*
 * The page's state in the URL's hash, so a link opens where it was: the map's place
 * and zoom (MapLibre's form, `map=zoom/lat/lng`, written by map.ts as the map moves),
 * its projection if not the globe, the view, what is selected (a country or region, a
 * basin or sub-basin, a point and the dam at it), the date range, and the view's panel:
 * its topic or scope, the chart pinned and the maps checked.
 *
 *   #map=6/42.1/19.5&projection=robinson&view=basin&sub=4031009&days=2024-01-01..2024-12-31&scope=catchment&pin=Q-years&maps=t-pcp,monthly
 *
 * Written as the state changes, replacing the history entry (the back button isn't a
 * way back through every click), and read once on load (main.ts).
 */
import type { Driver } from "./panels/map-drivers";
import { isProjectionId, type MapProjection } from "./map/flat/projections";
import type { Camera } from "./map/host";
import type { LngLat } from "./map/places";
import { dayOf, ymd } from "./toolbar/dekads";
import type { DayRange, View } from "./toolbar/range-rules";

export interface UrlState {
  view?: View;
  /** The map's projection (none: the globe). */
  projection?: MapProjection;
  /** The selection: one of these (a sub-basin implies its major basin). */
  country?: number;
  region?: number;
  basin?: number;
  sub?: number;
  /** The Local view's point, and the dam there (its index in the dams' data). */
  point?: LngLat;
  dam?: number;
  days?: DayRange;
  /** The Country panel's topic, the Basin panel's scope. */
  topic?: string;
  scope?: string;
  /** The view's panel: the chart pinned and the maps checked. */
  pin?: Driver | null;
  maps?: string[];
}

const VIEWS: View[] = ["country", "basin", "local"];
const KEYS = ["view", "projection", "country", "region", "basin", "sub", "point", "dam", "days", "topic", "scope", "pin", "pinsub", "maps"];

const isoDay = (day: number) => {
  const { y, m, d } = ymd(day);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
const dayOfIso = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? dayOf(y, m - 1, d) : NaN;
};

/** The parameters in the hash (MapLibre's form: `key=value`, `&` between). */
const params = () => new URLSearchParams(window.location.hash.slice(1));

/** The state the URL opened with. */
export function readUrlState(): UrlState {
  const p = params();
  const out: UrlState = {};
  const int = (key: string) => {
    const v = Number(p.get(key));
    return p.has(key) && Number.isInteger(v) ? v : undefined;
  };
  const view = p.get("view");
  if (view && VIEWS.includes(view as View)) out.view = view as View;
  const projection = p.get("projection");
  if (projection && isProjectionId(projection)) out.projection = projection;
  out.country = int("country");
  out.region = int("region");
  out.basin = int("basin");
  out.sub = int("sub");
  out.dam = int("dam");
  const point = p.get("point")?.split(",").map(Number);
  if (point?.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90) out.point = [point[0], point[1]];
  const days = p.get("days")?.split("..").map(dayOfIso);
  if (days?.length === 2 && days.every(Number.isFinite) && days[0] <= days[1]) out.days = { start: days[0], end: days[1] };
  out.topic = p.get("topic") ?? undefined;
  out.scope = p.get("scope") ?? undefined;
  const pin = p.get("pin");
  if (pin) out.pin = { id: pin, sub: p.get("pinsub") };
  const maps = p.get("maps");
  if (maps !== null) out.maps = maps ? maps.split(",") : [];
  return out;
}

/** Write the state to the URL (keeping the map's place, see writeMapHash). */
export function writeUrlState(state: UrlState) {
  const p = params();
  for (const key of KEYS) p.delete(key);
  const set = (key: string, value: string | number | undefined | null) => value !== undefined && value !== null && value !== "" && p.set(key, String(value));
  set("view", state.view);
  set("projection", state.projection === "globe" ? undefined : state.projection);
  set("country", state.country);
  set("region", state.region);
  set("basin", state.basin);
  set("sub", state.sub);
  set("point", state.point && `${state.point[0].toFixed(4)},${state.point[1].toFixed(4)}`);
  set("dam", state.dam);
  set("days", state.days && `${isoDay(state.days.start)}..${isoDay(state.days.end)}`);
  set("topic", state.topic);
  set("scope", state.scope);
  set("pin", state.pin?.id);
  set("pinsub", state.pin?.sub);
  if (state.maps) p.set("maps", state.maps.join(","));
  // (Not encoded: the hash isn't sent to a server, and "/" and "," read better.)
  replaceHash(p);
}

/** The hash's parameters written back, as they are (not encoded: the hash isn't sent to a server, and "/" and "," read better). */
function replaceHash(p: URLSearchParams) {
  const hash = p.toString().replace(/%2F/g, "/").replace(/%2C/g, ",").replace(/%3A/g, ":").replace(/%7E/g, "~");
  if (`#${hash}` === window.location.hash) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${hash}`);
}

/** The map's place in the hash (`map=zoom/lat/lng`, MapLibre's form; a bearing and pitch after it are left to the map). */
export function readMapHash(): Pick<Camera, "center" | "zoom"> | null {
  const parts = params().get("map")?.split("/").map(Number);
  if (!parts || parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
  const [zoom, lat, lng] = parts;
  if (Math.abs(lat) > 90) return null;
  return { center: [lng, lat], zoom };
}

/** Write the map's place (as MapLibre does: the zoom to 2 decimals, the place to as many as the zoom needs; a tilt or turn after). */
export function writeMapHash({ center: [lng, lat], zoom, bearing, pitch }: Camera) {
  const decimals = Math.max(0, Math.ceil((zoom * Math.LN2 + Math.log(512 / 360 / 512)) / Math.LN10));
  // (The flat map's centre can lie a little off the map; kept where the globe can open it.)
  const place = `${Math.round(zoom * 100) / 100}/${Math.max(-90, Math.min(90, lat)).toFixed(decimals)}/${(((lng + 540) % 360) - 180).toFixed(decimals)}`;
  const turned = Math.round(bearing) !== 0 || Math.round(pitch) !== 0 ? `/${Math.round(bearing * 10) / 10}/${Math.round(pitch)}` : "";
  const p = params();
  p.set("map", place + turned);
  replaceHash(p);
}

/** MapLibre once kept the place as the whole hash (#zoom/lat/lng): now its `map` parameter, so the others fit. */
export function upgradeMapHash() {
  const hash = window.location.hash.slice(1);
  if (/^-?\d+(\.\d+)?\/-?\d/.test(hash)) window.history.replaceState(window.history.state, "", `#map=${hash}`);
}
