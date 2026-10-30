/*
 * A flat, geospatial deck.gl viewport in any of projections.ts's projections (or a
 * blend of two, while the map morphs from one to the other). It plays the part
 * WebMercatorViewport plays for a Mercator map: the camera (view and projection
 * matrices), picking (pixel → lon/lat), tile selection (getBounds) and panning.
 *
 * To deck.gl's shaders it still looks like a Web Mercator viewport: every layer's vertex
 * shader projects to Mercator, and ReprojectExtension moves the vertex to where this
 * projection puts it. Both agree on common space, so the camera's centre (projectFlat,
 * below) and the drawn geometry line up.
 *
 * `resolution` is set, as GlobeViewport sets it: MVTLayer then decodes tiles to lon/lat
 * (not tile-local coordinates), and polygons, paths and bitmaps are subdivided every
 * `resolution` degrees, so long straight edges curve as the projection does.
 */
import { Viewport } from "@deck.gl/core";
import { altitudeToFovy, getProjectionParameters, getViewMatrix, pixelsToWorld } from "@math.gl/web-mercator";
import { SCALE, type Projection } from "./projections";

/** Degrees between the vertices deck.gl adds along long edges. */
export const RESOLUTION = 4;

/** Web Mercator tiles stop at this latitude. */
const MAX_TILE_LAT = 85.05;

/** deck.gl's PROJECTION_MODE.WEB_MERCATOR (not exported). */
const WEB_MERCATOR = 1;

export interface Blend {
  from: Projection;
  to: Projection;
  /** 0: drawn in `from`, 1: in `to`. */
  t: number;
}

export interface ProjectedViewportOptions {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  longitude?: number;
  latitude?: number;
  zoom?: number;
  pitch?: number;
  bearing?: number;
  altitude?: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const EPS = 1e-4;

/**
 * A viewport class for a blend of projections (a class, as deck.gl's View makes
 * viewports from a class: `new ViewportType(opts)`). Its statics project without a
 * viewport (the camera moves, map.ts).
 */
export function viewportClass(blend: Blend) {
  const { from, to, t } = blend;

  /** d3's units, radians in. */
  function rawForward(lambda: number, phi: number): [number, number] {
    const b = to.raw(lambda, phi);
    if (t >= 1) return b;
    const a = from.raw(lambda, phi);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  /** The inverse of the projection shown most (the blend's own inverse isn't worth it: it's shown for a moment). */
  const inverter = t < 0.5 ? from : to;
  function rawInvert(x: number, y: number): [number, number] | null {
    const p = inverter.raw.invert?.(x, y);
    return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
  }

  // Beyond the poles the plane goes on: linearly, at the slope the projection has at
  // the pole. So a drag that starts above the map still pans, and the camera can be
  // centred off the map (a point past the pole has a latitude beyond ±90°).
  const yPole = rawForward(0, Math.PI / 2)[1] * SCALE;
  /** Common units per degree of latitude, at the pole. */
  const slope = Math.max(1e-6, yPole - rawForward(0, 89 * RAD)[1] * SCALE);
  /** x at 180° on the equator: the map's half width, for all but Mercator (where every parallel is as wide). */
  const xEquator = rawForward(Math.PI, 0)[0] * SCALE;

  /** Degrees → common space (y up). Off the map's sides (|lon| > 180°) the formulas run on. */
  function forward(lon: number, lat: number): [number, number] {
    if (Math.abs(lat) <= 90) {
      const [x, y] = rawForward(lon * RAD, lat * RAD);
      return [x * SCALE, y * SCALE];
    }
    const s = Math.sign(lat);
    const [x, y] = rawForward(lon * RAD, s * (Math.PI / 2 - EPS * RAD));
    return [x * SCALE, y * SCALE + (Math.abs(lat) - 90) * slope * s];
  }

  /** Common space → degrees (longitude beyond ±180° off the map's sides, latitude beyond ±90° past the poles). */
  function invert(x: number, y: number): [number, number] {
    const s = Math.sign(y) || 1;
    if (Math.abs(y) < yPole - EPS) {
      const p = rawInvert(x / SCALE, y / SCALE);
      if (p) return [p[0] * DEG, p[1] * DEG];
      // The inverse gave up (outside a map whose poles are points, say): the latitude
      // from the central meridian, the longitude by the map's width there.
      const lat = (rawInvert(0, y / SCALE)?.[1] ?? 0) * DEG;
      return [offLongitude(x, lat), lat];
    }
    // Past a pole.
    return [offLongitude(x, s * 89.9), s * (90 + (Math.abs(y) - yPole) / slope)];
  }
  /** A longitude for x off the map, by the map's width at `lat` (at least a quarter of the equator's: the poles can be points). */
  function offLongitude(x: number, lat: number): number {
    const xAt180 = Math.max(forward(180, lat)[0], xEquator / 4);
    return (x / xAt180) * 180;
  }

  /** The map's extent in common space: its widest (the equator's ends, or the poles' for Mercator) and its poles. */
  const xMax = Math.max(xEquator, forward(180, 89.9)[0]);

  class ProjectedViewport extends Viewport {
    static displayName = "ProjectedViewport";
    /** Degrees → common space, and back (as projectFlat / unprojectFlat, without a viewport). */
    static forward = forward;
    static invert = invert;
    /** The common-space box the map fills: [xMin, yMin, xMax, yMax]. */
    static extent: [number, number, number, number] = [-xMax, -yPole, xMax, yPole];

    /** Marks it among deck.gl's viewports (see isProjectedViewport). */
    readonly projected = true;
    longitude: number;
    latitude: number;
    pitch: number;
    bearing: number;
    altitude: number;

    constructor(opts: ProjectedViewportOptions = {}) {
      const { latitude = 0, longitude = 0, zoom = 0, pitch = 0, bearing = 0, altitude = 1.5 } = opts;
      const width = opts.width || 1;
      const height = opts.height || 1;
      const scale = 2 ** zoom;
      const fovy = altitudeToFovy(altitude);
      const projectionParameters = getProjectionParameters({ width, height, scale, pitch, fovy, nearZMultiplier: 0.1, farZMultiplier: 1.01 });
      const viewMatrix = getViewMatrix({ height, pitch, bearing, scale, altitude });
      super({ ...opts, width, height, viewMatrix, longitude, latitude, zoom, ...projectionParameters, fovy, focalDistance: altitude });
      this.longitude = longitude;
      this.latitude = latitude;
      this.pitch = pitch;
      this.bearing = bearing;
      this.altitude = altitude;
      this.resolution = RESOLUTION;
    }

    get projectionMode() {
      // Web Mercator to the shaders; zoomed in, deck.gl's offset mode (positions
      // relative to the view's centre, for precision), which the extension follows.
      return this.zoom < 12 ? WEB_MERCATOR : WEB_MERCATOR + 1;
    }

    projectFlat(xyz: number[]): [number, number] {
      return forward(xyz[0], xyz[1]);
    }

    unprojectFlat(xyz: number[]): [number, number] {
      return invert(xyz[0], xyz[1]);
    }

    /** The lon/lat box the view covers (for the tile layers): the view's corners, clipped to the map. */
    getBounds(): [number, number, number, number] {
      const corners = [
        [0, 0],
        [this.width, 0],
        [0, this.height],
        [this.width, this.height],
      ].map((p) => pixelsToWorld(p, this.pixelUnprojectionMatrix));
      // (A corner above the horizon of a tilted map is infinitely far: the map's edge then.)
      const finite = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
      const x0 = Math.max(-xMax, Math.min(...corners.map((c) => finite(c[0], -xMax))));
      const x1 = Math.min(xMax, Math.max(...corners.map((c) => finite(c[0], xMax))));
      const y0 = Math.max(-yPole + EPS, Math.min(...corners.map((c) => finite(c[1], -yPole))));
      const y1 = Math.min(yPole - EPS, Math.max(...corners.map((c) => finite(c[1], yPole))));
      if (x0 >= x1 || y0 >= y1) return [0, 0, 0, 0];
      // The meridians curve: the westernmost longitude of the box's left side is at
      // whichever of its latitudes the map is narrowest.
      let west = 180;
      let east = -180;
      const ROWS = 24;
      for (let i = 0; i <= ROWS; i++) {
        const y = y0 + ((y1 - y0) * i) / ROWS;
        west = Math.min(west, Math.max(-180, invert(x0, y)[0]));
        east = Math.max(east, Math.min(180, invert(x1, y)[0]));
      }
      // (Within Web Mercator's reach: deck.gl turns the box into tile indices through
      // Mercator, and a pole is infinitely far in it.)
      const south = Math.max(-MAX_TILE_LAT, invert(0, y0)[1]);
      const north = Math.min(MAX_TILE_LAT, invert(0, y1)[1]);
      return [west, south, east, north];
    }

    /** Move so that lon/lat `coords` lands on `pixel` (dragging, zooming about the pointer). */
    panByPosition(coords: number[], pixel: number[]) {
      const fromCommon = pixelsToWorld(pixel, this.pixelUnprojectionMatrix);
      const toCommon = forward(coords[0], coords[1]);
      const [longitude, latitude] = invert(this.center[0] + toCommon[0] - fromCommon[0], this.center[1] + toCommon[1] - fromCommon[1]);
      return { longitude, latitude };
    }

    equals(viewport: Viewport): boolean {
      return viewport instanceof ProjectedViewport && super.equals(viewport);
    }
  }
  return ProjectedViewport;
}

export type ProjectedViewportClass = ReturnType<typeof viewportClass>;
export type ProjectedViewport = InstanceType<ProjectedViewportClass>;

/** Whether a deck.gl viewport is the flat map's (not MapLibre's globe or Mercator). */
export const isProjectedViewport = (viewport: Viewport): viewport is ProjectedViewport => (viewport as { projected?: boolean }).projected === true;
