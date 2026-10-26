import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Color } from "../theme";
import { RiverParticlesLayer, type ParticleNetwork } from "./river-particles";

/** A line of the Basin view's discharge network (basin/scheme.ts), styled by its discharge. */
export interface SchemeLineStyle {
  /** lon, lat. */
  path: [number, number][];
  /** CSS pixels (0: not drawn). */
  width: number;
  /** The sub-basin it lies in, and its discharge (for the tooltip). */
  subBasin: number;
  value: number;
}

/** An arrow where the basin's water leaves the scheme. */
export interface SchemeArrow {
  position: [number, number];
  /** Degrees anticlockwise from east. */
  angle: number;
  /** CSS pixels. */
  size: number;
  subBasin: number;
  value: number;
}

/** A sub-basin's storage change dot. */
export interface SchemeDot {
  position: [number, number];
  /** CSS pixels. */
  radius: number;
  color: Color;
  subBasin: number;
  /** Its storage change (for the tooltip). */
  value: number;
}

/** Discharge as particles streaming down the rivers (RiverParticlesLayer). */
export interface SchemeParticles {
  /** Names the network: a new one gets new layers. */
  id: string;
  network: ParticleNetwork;
  /** Per arc: width (CSS px, 0: not drawn), the particles' spawn weight and speed (0–1), spare; their colour (0–1), spare. */
  arcs: Float32Array;
  /** Per arc: the river's colour under the particles, and its discharge and sub-basin (for the tooltip). */
  colors: Color[];
  q: Float32Array;
  subBasin: Int32Array;
  /** Particles alive at once; CSS px per frame on the fastest river; share of a trail kept each frame; particle size (CSS px). */
  count: number;
  speed: number;
  fade: number;
  pointSize: number;
}

export interface BasinScheme {
  /** Names the drawing: the map only rebuilds the layers when it changes. */
  key: string;
  lines: SchemeLineStyle[];
  arrows: SchemeArrow[];
  dots: SchemeDot[];
  particles?: SchemeParticles;
  /** The lines' colour, and the edge around lines and dots (so they read over any fill). */
  color: Color;
  casing: Color;
  /** Sub-basins whose rivers the lines replace: the river tiles leave them out there. */
  subBasins: Set<number>;
  /** The line, arrow or dot under the pointer: its sub-basin and value (null: none). */
  onHover?(hovered: { subBasin: number; value: number } | null): void;
}

const ARROW = {
  url:
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M4 8 L62 32 L4 56 L18 32 Z" fill="#fff"/></svg>'),
  width: 64,
  height: 64,
  anchorX: 18,
  anchorY: 32,
  mask: true,
};

/** Thinnest line the pointer picks, CSS pixels. */
const HIT_WIDTH = 8;

/**
 * The discharge network (lines as wide as their discharge, arrows at the mouths) and the
 * storage change dots, in pixels so they read the same at any zoom. Hovering the lines
 * uses a wider, invisible copy underneath, as the thin ones are hard to hit. Or, with
 * particles, the rivers they stream down in place of the lines (the dots still on top).
 */
export function basinSchemeLayers(scheme: BasinScheme | null) {
  if (!scheme) return [];
  const hover = (info: { object?: { subBasin: number; value: number } | null }) =>
    void scheme.onHover?.(info.object ? { subBasin: info.object.subBasin, value: info.object.value } : null);
  if (scheme.particles) return [...particleLayers(scheme, scheme.particles), dotsLayer(scheme, hover)];
  const common = {
    data: scheme.lines,
    getPath: (d: SchemeLineStyle) => d.path,
    widthUnits: "pixels" as const,
    capRounded: true,
    jointRounded: true,
    parameters: { depthCompare: "always" as const },
  };
  return [
    new PathLayer<SchemeLineStyle>({
      ...common,
      id: "scheme-hit",
      pickable: Boolean(scheme.onHover),
      getColor: [0, 0, 0, 1],
      getWidth: (d) => (d.width ? Math.max(d.width, HIT_WIDTH) : 0),
      onHover: hover,
    }),
    new PathLayer<SchemeLineStyle>({
      ...common,
      id: "scheme-casing",
      getColor: scheme.casing,
      getWidth: (d) => (d.width ? d.width + 2 : 0),
    }),
    new PathLayer<SchemeLineStyle>({ ...common, id: "scheme-lines", getColor: scheme.color, getWidth: (d) => d.width }),
    new IconLayer<SchemeArrow>({
      id: "scheme-arrows",
      data: scheme.arrows,
      getIcon: () => ARROW,
      getPosition: (d) => d.position,
      getAngle: (d) => d.angle,
      getSize: (d) => d.size,
      getColor: scheme.color,
      sizeUnits: "pixels",
      pickable: Boolean(scheme.onHover),
      onHover: hover,
      parameters: { depthCompare: "always" },
    }),
    dotsLayer(scheme, hover),
  ];
}

function dotsLayer(scheme: BasinScheme, hover: (info: { object?: { subBasin: number; value: number } | null }) => void) {
  return new ScatterplotLayer<SchemeDot>({
    id: "scheme-dots",
    data: scheme.dots,
    getPosition: (d) => d.position,
    getRadius: (d) => d.radius,
    getFillColor: (d) => d.color,
    getLineColor: scheme.casing,
    radiusUnits: "pixels",
    stroked: true,
    lineWidthUnits: "pixels",
    getLineWidth: 1,
    pickable: Boolean(scheme.onHover),
    onHover: hover,
    parameters: { depthCompare: "always" },
  });
}

const pathData = new WeakMap<ParticleNetwork, object>();

/** Id of the particle layer (map.ts leaves it out of its extensions). */
export const PARTICLES_ID = "scheme-particles";

/**
 * The rivers, as wide as their discharge, with particles streaming down them. Hovering
 * picks the rivers (the particles are drawn off screen and then pasted on).
 */
function particleLayers(scheme: BasinScheme, p: SchemeParticles) {
  const { network: net, arcs } = p;
  // One object per network, so deck.gl tessellates the rivers once.
  let data = pathData.get(net);
  if (!data) {
    data = { length: net.n, startIndices: net.starts.subarray(0, net.n), attributes: { getPath: { value: net.coords, size: 2 } } };
    pathData.set(net, data);
  }
  return [
    new PathLayer({
      id: `scheme-rivers-${p.id}`,
      data: data as never,
      _pathType: "open",
      positionFormat: "XY",
      getColor: (_: unknown, { index }: { index: number }) => p.colors[index],
      getWidth: (_: unknown, { index }: { index: number }) => arcs[index * 8],
      widthUnits: "pixels",
      widthMinPixels: 0,
      jointRounded: true,
      capRounded: true,
      pickable: Boolean(scheme.onHover),
      onHover: ({ index }: { index: number }) =>
        void scheme.onHover?.(index >= 0 && arcs[index * 8] > 0 ? { subBasin: p.subBasin[index], value: p.q[index] } : null),
      updateTriggers: { getColor: scheme.key, getWidth: scheme.key },
      parameters: { depthCompare: "always" },
    }),
    new RiverParticlesLayer({
      id: `${PARTICLES_ID}-${p.id}`,
      network: net,
      arcs,
      count: p.count,
      speed: p.speed,
      fade: p.fade,
      pointSize: p.pointSize,
    }),
  ];
}
