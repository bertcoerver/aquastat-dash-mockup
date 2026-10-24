import { ScatterplotLayer } from "@deck.gl/layers";
import type { LngLat } from "../places";
import type { Color } from "../theme";

/** A small dot where the user last clicked on a country or basin. */
export function markerLayer({
  position,
  fill,
  ring,
}: {
  position: LngLat | null;
  fill: Color;
  ring: Color;
}) {
  return new ScatterplotLayer<LngLat>({
    id: "click-marker",
    data: position ? [position] : [],
    getPosition: (p) => p,
    radiusUnits: "pixels",
    getRadius: 5,
    stroked: true,
    getFillColor: fill,
    getLineColor: ring,
    lineWidthUnits: "pixels",
    getLineWidth: 2,
    parameters: { depthCompare: "always" },
  });
}
