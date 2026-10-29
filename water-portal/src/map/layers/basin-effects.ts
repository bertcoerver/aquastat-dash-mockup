import { COORDINATE_SYSTEM } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { HazeLayer, type HazeLayerProps } from "./haze";
import type { EffectGrid } from "./effects-common";
import { RainLayer, type RainLayerProps } from "./rain";
import { VapourLayer, type VapourLayerProps } from "./vapour";

/** A grid drawn on the ground in its own colours, under an effect. */
export interface EffectGround {
  image: HTMLCanvasElement;
  bounds: [number, number, number, number];
  opacity: number;
}

/**
 * Basin view: precipitation as rain and evapotranspiration as vapour rising through a
 * heat shimmer, over a major basin (basin/effects-map.ts).
 */
export interface BasinEffects {
  /** Names the drawing: the map only rebuilds the layers when it changes. */
  key: string;
  rain?: { ground: EffectGround | null } & Omit<RainLayerProps, "grid"> & { grid: EffectGrid };
  vapour?: { ground: EffectGround | null; haze: Omit<HazeLayerProps, "grid"> } & Omit<VapourLayerProps, "grid"> & { grid: EffectGrid };
}

/** Ids of the layers that move (map.ts leaves them out of its extensions: they hide the far side themselves). */
export const EFFECTS_ID = "basin-fx";

/** The grounds under the effects (beneath the rivers). */
export function effectGroundLayers(fx: BasinEffects | null) {
  const ground = (id: string, g: EffectGround | null | undefined) =>
    g && g.opacity > 0
      ? [
          new BitmapLayer({
            id,
            image: g.image,
            bounds: g.bounds,
            _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            opacity: g.opacity,
            parameters: { depthCompare: "always" },
          }),
        ]
      : [];
  return [...ground("basin-ground-vapour", fx?.vapour?.ground), ...ground("basin-ground-rain", fx?.rain?.ground)];
}

/** The shimmer, vapour and rain (on top of everything else of the basin's). */
export function effectLayers(fx: BasinEffects | null) {
  if (!fx) return [];
  const { rain, vapour } = fx;
  return [
    ...(vapour && vapour.haze.strength > 0 ? [new HazeLayer({ id: `${EFFECTS_ID}-haze`, grid: vapour.grid, ...vapour.haze })] : []),
    ...(vapour ? [new VapourLayer({ ...vapour, id: `${EFFECTS_ID}-vapour` })] : []),
    ...(rain ? [new RainLayer({ ...rain, id: `${EFFECTS_ID}-rain` })] : []),
  ];
}
