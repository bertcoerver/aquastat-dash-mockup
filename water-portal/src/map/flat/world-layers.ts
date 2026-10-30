/*
 * The flat map's own layers: the world's outline in the ocean colour (MapLibre paints
 * the globe's ocean; here it's a polygon), the last degrees of Antarctica, which Web
 * Mercator tiles don't reach, and the globe's disc while the map morphs to or from the
 * globe (flat-host.ts).
 */
import { PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Color } from "../theme";

const range = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

/**
 * The whole world as one ring (deck.gl subdivides it every few degrees, see
 * ProjectedViewport's resolution, so its edges curve as the projection's do).
 * Latitudes stop just short of the poles: at a pole that is a point, every meridian
 * maps to it.
 */
const WORLD_RING: [number, number][] = [
  ...range(-89.99, 89.99, 1).map((lat): [number, number] => [-180, lat]),
  ...range(-180, 180, 1).map((lon): [number, number] => [lon, 89.99]),
  ...range(89.99, -89.99, -1).map((lat): [number, number] => [180, lat]),
  ...range(180, -180, -1).map((lon): [number, number] => [lon, -89.99]),
];

/** Web Mercator tiles stop here; on a flat world map the band to the pole shows. */
const POLAR_CAP: [number, number][] = [
  ...range(-180, 180, 1).map((lon): [number, number] => [lon, -85.04]),
  ...range(180, -180, -1).map((lon): [number, number] => [lon, -89.99]),
];

/** The ocean: the map's outline, under everything. */
export function oceanLayer(color: Color) {
  return new PolygonLayer<[number, number][]>({
    id: "flat-ocean",
    data: [WORLD_RING],
    getPolygon: (d) => d,
    getFillColor: color,
    stroked: false,
    pickable: false,
    parameters: { depthCompare: "always" },
  });
}

/** Antarctica south of 85°, in the land colour (it's all land). */
export function polarCapLayer(color: Color, visible: boolean) {
  return new PolygonLayer<[number, number][]>({
    id: "flat-polar-cap",
    data: [POLAR_CAP],
    visible,
    getPolygon: (d) => d,
    getFillColor: color,
    stroked: false,
    pickable: false,
    parameters: { depthCompare: "always" },
  });
}

/**
 * The globe's disc, in the ocean colour, round the view's centre (where the globe stage
 * projects to the origin), as large as the globe's rim (`radius`, in common units): the
 * world ring only covers the near side, and its edge would show the subdivision. Faded in
 * with the globe as the map morphs to it (`opacity`).
 */
export function globeDiscLayer(center: [number, number], radius: number, color: Color, opacity: number) {
  return new ScatterplotLayer<[number, number]>({
    id: "flat-globe-disc",
    data: [center],
    getPosition: (d) => d,
    getRadius: radius,
    radiusUnits: "common",
    getFillColor: color,
    opacity,
    stroked: false,
    pickable: false,
    updateTriggers: { getRadius: radius },
    parameters: { depthCompare: "always" },
  });
}
