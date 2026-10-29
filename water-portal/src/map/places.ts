/*
 * What is at a point on the map: the country, major basin and sub-basin.
 *
 * Looked up in the vector tiles directly rather than through deck.gl picking, so it
 * works for layers that aren't shown (picking only sees visible layers). Uses each
 * tile set's most detailed zoom level; tiles are fetched once and kept.
 */
import { parse } from "@loaders.gl/core";
import { MVTLoader } from "@loaders.gl/mvt";
import type { Feature, Position } from "geojson";
import type { CountryProperties } from "./layers/countries";
import type { MajorBasinProperties, SubBasinProperties } from "./layers/basins";
import { FAO_TILES, localTiles } from "./layers/tile-urls";
import { quietFetch } from "../panels/load-bar";

export type LngLat = [number, number];

export interface Place {
  country: { m49: number; name: string } | null;
  majorBasin: { id: number; name: string } | null;
  subBasin: { id: number; name: string } | null;
}

const SOURCES = {
  country: { url: localTiles("m49"), zoom: 5 },
  majorBasin: { url: FAO_TILES.majorBasins, zoom: 8 },
  subBasin: { url: FAO_TILES.subBasins, zoom: 8 },
};

export async function placeAt(lngLat: LngLat): Promise<Place> {
  const [country, majorBasin, subBasin] = await Promise.all([
    featureAt(SOURCES.country, lngLat),
    featureAt(SOURCES.majorBasin, lngLat),
    featureAt(SOURCES.subBasin, lngLat),
  ]);
  const c = country?.properties as CountryProperties | undefined;
  const mb = majorBasin?.properties as MajorBasinProperties | undefined;
  const sb = subBasin?.properties as SubBasinProperties | undefined;
  return {
    country: c ? { m49: c.m49, name: c.name } : null,
    majorBasin: mb ? { id: mb.SDG6_MB_ID, name: mb.S6_MB_NAME } : null,
    subBasin: sb ? { id: sb.SDG6_SB_ID, name: sb.S6_SB_NAME } : null,
  };
}

// Decoded tiles by URL. A missing tile (404: nothing there) is an empty list. So is a
// page: the dev server answers a missing local tile with index.html.
const tiles = new Map<string, Promise<Feature[]>>();

async function featureAt({ url, zoom }: { url: string; zoom: number }, [lng, lat]: LngLat) {
  const { x, y } = tileIndex(lng, lat, zoom);
  const tileUrl = url.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
  let tile = tiles.get(tileUrl);
  if (!tile) {
    tile = loadTile(tileUrl, { x, y, z: zoom });
    tiles.set(tileUrl, tile);
    // (A failed read isn't kept: it's tried again next time.)
    tile.catch(() => tiles.get(tileUrl) === tile && tiles.delete(tileUrl));
  }
  const features = await tile;
  return features.find((f) => contains(f, [lng, lat])) ?? null;
}

async function loadTile(url: string, tileIndex: { x: number; y: number; z: number }): Promise<Feature[]> {
  const response = await quietFetch(url);
  if (!response.ok || response.headers.get("content-type")?.startsWith("text/html")) return [];
  return (await parse(await response.arrayBuffer(), MVTLoader, {
    mvt: { coordinates: "wgs84", tileIndex, shape: "geojson" },
  })) as Feature[];
}

/** The web map (slippy) tile at a zoom level that holds a point. */
function tileIndex(lng: number, lat: number, z: number) {
  const n = 2 ** z;
  const rad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  return {
    x: clamp(((lng + 180) / 360) * n),
    y: clamp(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

/** Whether a (multi)polygon contains a point (even-odd rule, so holes count). */
function contains({ geometry }: Feature, point: Position) {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.some((rings) => rings.filter((ring) => crossesRing(ring, point)).length % 2 === 1);
}

/** Ray casting: whether a ray from the point eastwards crosses the ring an odd number of times. */
function crossesRing(ring: Position[], [px, py]: Position) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
