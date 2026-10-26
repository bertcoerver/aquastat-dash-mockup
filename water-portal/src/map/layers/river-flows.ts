import { PathLayer } from "@deck.gl/layers";
import type { Color } from "../theme";

/** A river arc of the Basin view's river discharge map, styled by its discharge. */
export interface RiverArc {
  /** Index into the network (for the tooltip). */
  id: number;
  /** lon, lat, flat. */
  path: Float32Array;
  color: Color;
  /** CSS pixels. */
  width: number;
}

export interface RiverFlows {
  /** Names the styling: the map only rebuilds the lines when it changes. */
  key: string;
  /** In drawing order: small rivers first, so the big ones run over them at confluences. */
  arcs: RiverArc[];
  /** Sub-basins whose rivers these replace: the river tiles leave them out there. */
  subBasins: Set<number>;
  /** The arc under the pointer (null: none). */
  onHover?(id: number | null): void;
}

/** Thinnest line the pointer picks, CSS pixels: the small rivers are thinner. */
const HIT_WIDTH = 8;

/**
 * Rivers drawn with their own colour and width (in pixels, so they read the same at
 * any zoom). Hovering uses a wider, invisible copy underneath, as the thin ones are
 * hard to hit.
 */
export function riverFlowsLayers(flows: RiverFlows | null) {
  if (!flows) return [];
  const common = {
    data: flows.arcs,
    getPath: (d: RiverArc) => d.path,
    positionFormat: "XY" as const,
    widthUnits: "pixels" as const,
    capRounded: true,
    jointRounded: true,
    parameters: { depthCompare: "always" as const },
  };
  return [
    new PathLayer<RiverArc>({
      ...common,
      id: "river-flows-hit",
      pickable: Boolean(flows.onHover),
      getColor: [0, 0, 0, 1],
      getWidth: (d) => Math.max(d.width, HIT_WIDTH),
      onHover: (info) => void flows.onHover?.(info.object?.id ?? null),
    }),
    new PathLayer<RiverArc>({
      ...common,
      id: "river-flows",
      getColor: (d) => d.color,
      getWidth: (d) => d.width,
    }),
  ];
}
