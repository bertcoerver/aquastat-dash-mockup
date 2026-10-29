import { ColumnLayer } from "@deck.gl/layers";
import type { Color } from "../theme";

/** A 3D bar on an area: its height as a share of the reference bar's (shape-switch.ts's shapeSizes). */
export interface Bar {
  /** Names it for its tooltip (the Local view's points). */
  id?: string;
  position: [number, number];
  height: number;
  color: Color;
}

/** The reference bar's height, and the bars' radius, in CSS pixels at any zoom. */
const BAR_PX = 110;
const RADIUS_PX = 5;
/** Metres per pixel at zoom 0 (512-pixel tiles, at the equator). */
const M_PER_PX = 40075016.7 / 512;

/**
 * Bars standing on the areas (the Country and Basin views' maps drawn as bars), or on
 * points (the Local view's vector maps: `pickable`, for their tooltips). Their
 * height is set in pixels, at the zoom they're drawn for, so they read the same at any
 * zoom (map.ts draws them again as the zoom changes). Unlike the other layers, they're
 * depth-tested, so near bars hide those behind.
 */
export function barsLayer({ bars, zoom, pickable = false }: { bars: { key: string; items: Bar[] } | null; zoom: number; pickable?: boolean }) {
  return new ColumnLayer<Bar>({
    id: "area-bars",
    data: bars?.items ?? [],
    visible: Boolean(bars),
    pickable,
    getPosition: (b) => b.position,
    getElevation: (b) => b.height,
    elevationScale: (BAR_PX * M_PER_PX) / 2 ** zoom,
    radius: RADIUS_PX,
    radiusUnits: "pixels",
    diskResolution: 12,
    extruded: true,
    flatShading: true,
    getFillColor: (b) => b.color,
    updateTriggers: { getElevation: bars?.key, getFillColor: bars?.key },
    parameters: { depthCompare: "less-equal" },
  });
}
