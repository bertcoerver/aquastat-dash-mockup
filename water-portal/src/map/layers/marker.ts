import { ScatterplotLayer } from "@deck.gl/layers";
import type { LngLat } from "../places";
import type { Color } from "../theme";

/**
 * A small ring where the user last clicked on a country or basin, with a thin dark line
 * inside it (no fill). Around a picked point of a map (a dam: `around`, its circle's
 * radius in pixels), wider and just outside it, with a dark line outside too: a target.
 */
export function markerLayer({
  position,
  ring,
  around = null,
}: {
  position: LngLat | null;
  ring: Color;
  around?: number | null;
}) {
  const data = position ? [position] : [];
  const target = around !== null;
  const radius = target ? Math.max(RADIUS, around + TARGET_GAP + TARGET_RING / 2) : RADIUS;
  const width = target ? TARGET_RING : RING;
  return [
    new ScatterplotLayer<LngLat>({
      id: "click-marker",
      data,
      getPosition: (p) => p,
      radiusUnits: "pixels",
      getRadius: radius,
      stroked: true,
      filled: false,
      getLineColor: ring,
      lineWidthUnits: "pixels",
      getLineWidth: width,
      parameters: { depthCompare: "always" },
      updateTriggers: { getRadius: radius, getLineWidth: width },
    }),
    // Just inside the ring.
    new ScatterplotLayer<LngLat>({
      id: "click-marker-line",
      data,
      getPosition: (p) => p,
      radiusUnits: "pixels",
      getRadius: radius - width / 2 - LINE / 2,
      stroked: true,
      filled: false,
      getLineColor: [0, 0, 0, 255],
      lineWidthUnits: "pixels",
      getLineWidth: target ? TARGET_LINE : LINE,
      parameters: { depthCompare: "always" },
      updateTriggers: { getRadius: radius, getLineWidth: target },
    }),
    // (A target's, just outside the ring: it stands out on light and dark alike.)
    new ScatterplotLayer<LngLat>({
      id: "click-marker-outer",
      data: target ? data : [],
      getPosition: (p) => p,
      radiusUnits: "pixels",
      getRadius: radius + width / 2 + TARGET_LINE / 2,
      stroked: true,
      filled: false,
      getLineColor: [0, 0, 0, 255],
      lineWidthUnits: "pixels",
      getLineWidth: TARGET_LINE,
      parameters: { depthCompare: "always" },
      updateTriggers: { getRadius: radius },
    }),
  ];
}

/** The dot's radius and its ring's and line's widths, in pixels (a line is centred on its radius). */
const RADIUS = 5;
const RING = 2;
const LINE = 0.75;
/** A target's: the gap between the point's circle and the ring, the ring's and its lines' widths. */
const TARGET_GAP = 3;
const TARGET_RING = 3.5;
const TARGET_LINE = 1.25;
