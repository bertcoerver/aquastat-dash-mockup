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
 * The globe (from above the centre, as MapLibre draws it) is `centred`: it moves with
 * the view's centre, so each viewport instance projects for its own centre (and zoom and
 * height: its perspective), and panning turns the globe rather than sliding the map.
 *
 * `resolution` is set, as GlobeViewport sets it: MVTLayer then decodes tiles to lon/lat
 * (not tile-local coordinates), and polygons, paths and bitmaps are subdivided every
 * `resolution` degrees, so long straight edges curve as the projection does.
 */
import { Viewport } from "@deck.gl/core";
import { altitudeToFovy, getProjectionParameters, getViewMatrix, pixelsToWorld } from "@math.gl/web-mercator";
import { globeDistance, globeRaw, globeScale, SCALE, type GlobeRaw, type Projection } from "./projections";

/** Degrees between the vertices deck.gl adds along long edges (GlobeViewport's: the globe bends lines more than any flat projection). */
export const RESOLUTION = 10;

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

/** How much of the blend is the globe (0: none of it). */
export const globeWeight = ({ from, to, t }: Blend) => (to.centred ? t : 0) + (from.centred ? 1 - t : 0);

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

/** The projection's functions for a blend seen from a centre. */
interface Fns {
  /** Degrees → common space (y up). */
  forward(lon: number, lat: number): [number, number];
  /** Common space → degrees, anywhere (off the map: a point off its sides, or on the globe's rim). */
  invert(x: number, y: number): [number, number];
  /** Common space → degrees, on the map only. */
  onMap(x: number, y: number): [number, number] | null;
  /** The lon/lat box a viewport covers (for the tile layers): [west, south, east, north]. */
  bounds(viewport: Viewport): [number, number, number, number];
  /** The centre that puts lon/lat `coords` at `pixel`. */
  pan(viewport: Viewport, center: number[], coords: number[], pixel: number[]): { longitude: number; latitude: number };
}

function makeFns({ from, to, t }: Blend, lon0: number, lat0: number, zoom: number, height: number): Fns {
  const [lambda0, phi0] = [lon0 * RAD, lat0 * RAD];
  const side = (p: Projection) => (p.centred ? globeRaw(lambda0, phi0, globeScale(lat0), globeDistance(height, zoom, lat0)) : p.raw);
  const [a, b] = [side(from), side(to)];

  /** d3's units, radians in. */
  function rawForward(lambda: number, phi: number): [number, number] {
    const pb = b(lambda, phi);
    if (t >= 1) return pb;
    const pa = a(lambda, phi);
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  }
  /** The inverse of the projection shown most (the blend's own inverse isn't worth it: it's shown for a moment). */
  const dominant = t < 0.5 ? from : to;
  const inverter = t < 0.5 ? a : b;
  function rawInvert(x: number, y: number): [number, number] | null {
    const p = inverter.invert?.(x, y);
    return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
  }

  if (dominant.centred) return globeFns();
  return flatFns();

  // --- The globe (orthographic): a disc round the centre. ------------------------------

  function globeFns(): Fns {
    const globe = inverter as GlobeRaw;
    const radius = globe.rim * SCALE;
    const forward = (lon: number, lat: number): [number, number] => {
      const [x, y] = rawForward(lon * RAD, Math.max(-90, Math.min(90, lat)) * RAD);
      return [x * SCALE, y * SCALE];
    };
    const onMap = (x: number, y: number): [number, number] | null => {
      const p = rawInvert(x / SCALE, y / SCALE);
      return p ? [p[0] * DEG, p[1] * DEG] : null;
    };
    // Off the globe: the nearest point on its rim (so a drag that starts there still turns it).
    const invert = (x: number, y: number): [number, number] => {
      const r = Math.hypot(x, y);
      if (r < radius) return onMap(x, y) ?? [lon0, lat0];
      const s = (radius * 0.9999) / r;
      return onMap(x * s, y * s) ?? [lon0, lat0];
    };
    return {
      forward,
      invert,
      onMap,
      bounds(viewport) {
        // The points on the globe under a grid of screen points, their longitudes
        // unwrapped round the centre's; a pole in front means every longitude.
        const { width, height } = viewport;
        let [west, east, south, north] = [Infinity, -Infinity, Infinity, -Infinity];
        const N = 12;
        for (let i = 0; i <= N; i++) {
          for (let j = 0; j <= N; j++) {
            const p = onMap(...(pixelsToWorld([(width * i) / N, (height * j) / N], viewport.pixelUnprojectionMatrix) as [number, number]));
            if (!p) continue;
            const lon = lon0 + ((((p[0] - lon0) % 360) + 540) % 360) - 180;
            [west, east, south, north] = [Math.min(west, lon), Math.max(east, lon), Math.min(south, p[1]), Math.max(north, p[1])];
          }
        }
        if (west > east) return [0, 0, 0, 0];
        const inView = (lat: number) => {
          if (globe.front(0, lat * RAD) <= 0) return false;
          const [x, y] = viewport.project([lon0, lat]);
          return x >= 0 && x <= width && y >= 0 && y <= height;
        };
        if (inView(90)) [west, east, north] = [lon0 - 180, lon0 + 180, 90];
        if (inView(-90)) [west, east, south] = [lon0 - 180, lon0 + 180, -90];
        return [Math.max(-180, west), Math.max(-MAX_TILE_LAT, south), Math.min(180, east), Math.min(MAX_TILE_LAT, north)];
      },
      pan(viewport, _center, coords, pixel) {
        // Turn the globe so the point comes under the pointer: by the difference in
        // lon/lat between the point and what's under the pointer now (deck.gl's
        // GlobeViewport does the same; exact at the centre, near enough elsewhere).
        const under = invert(...(pixelsToWorld(pixel, viewport.pixelUnprojectionMatrix) as [number, number]));
        return { longitude: lon0 + coords[0] - under[0], latitude: Math.max(-89.9, Math.min(89.9, lat0 + coords[1] - under[1])) };
      },
    };
  }

  // --- A flat map: the plane goes on past its edges. ------------------------------------

  function flatFns(): Fns {
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

    return {
      forward,
      invert,
      onMap(x, y) {
        const [lon, lat] = invert(x, y);
        return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
      },
      bounds(viewport) {
        const corners = [
          [0, 0],
          [viewport.width, 0],
          [0, viewport.height],
          [viewport.width, viewport.height],
        ].map((p) => pixelsToWorld(p, viewport.pixelUnprojectionMatrix));
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
      },
      pan(viewport, center, coords, pixel) {
        const fromCommon = pixelsToWorld(pixel, viewport.pixelUnprojectionMatrix);
        const toCommon = forward(coords[0], coords[1]);
        const [longitude, latitude] = invert(center[0] + toCommon[0] - fromCommon[0], center[1] + toCommon[1] - fromCommon[1]);
        return { longitude, latitude };
      },
    };
  }
}

/**
 * A viewport class for a blend of projections (a class, as deck.gl's View makes
 * viewports from a class: `new ViewportType(opts)`). Its statics project without a
 * viewport (the camera moves), for a centre where the projection has one.
 */
export function viewportClass(blend: Blend) {
  // (The base constructor asks for the centre's projection before the instance can hold its functions.)
  let making: Fns | null = null;
  const fallback = () => forCentre();
  const forCentre = (center: [number, number] = [0, 0], zoom = 0, height = 1) => makeFns(blend, center[0], center[1], zoom, height);

  class ProjectedViewport extends Viewport {
    static displayName = "ProjectedViewport";
    /** Degrees → common space, and back (as projectFlat / unprojectFlat, without a viewport). */
    static forward = (lon: number, lat: number, view?: { center: [number, number]; zoom: number; height: number }) => forCentre(view?.center, view?.zoom, view?.height).forward(lon, lat);
    static invert = (x: number, y: number, view?: { center: [number, number]; zoom: number; height: number }) => forCentre(view?.center, view?.zoom, view?.height).invert(x, y);

    /** Marks it among deck.gl's viewports (see isProjectedViewport). */
    readonly projected = true;
    fns!: Fns;
    longitude: number;
    latitude: number;
    pitch: number;
    bearing: number;
    altitude: number;

    constructor(opts: ProjectedViewportOptions = {}) {
      const { latitude = 0, longitude = 0, zoom = 0, pitch = 0, bearing = 0, altitude = 1.5 } = opts;
      const width = opts.width || 1;
      const height = opts.height || 1;
      const fns = makeFns(blend, longitude, latitude, zoom, height);
      making = fns;
      const scale = 2 ** zoom;
      const fovy = altitudeToFovy(altitude);
      const projectionParameters = getProjectionParameters({ width, height, scale, pitch, fovy, nearZMultiplier: 0.1, farZMultiplier: 1.01 });
      const viewMatrix = getViewMatrix({ height, pitch, bearing, scale, altitude });
      super({ ...opts, width, height, viewMatrix, longitude, latitude, zoom, ...projectionParameters, fovy, focalDistance: altitude });
      making = null;
      this.fns = fns;
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
      return (this.fns ?? making ?? fallback()).forward(xyz[0], xyz[1]);
    }

    unprojectFlat(xyz: number[]): [number, number] {
      return (this.fns ?? making ?? fallback()).invert(xyz[0], xyz[1]);
    }

    /** The point under a pixel if it's on the map (null off it: beyond a flat map's edges, off the globe). */
    unprojectOnMap(pixel: [number, number]): [number, number] | null {
      const [x, y] = pixelsToWorld(pixel, this.pixelUnprojectionMatrix);
      return this.fns.onMap(x, y);
    }

    /** The lon/lat box the view covers (for the tile layers), clipped to the map. */
    getBounds(): [number, number, number, number] {
      return this.fns.bounds(this);
    }

    /** Move so that lon/lat `coords` lands on `pixel` (dragging, zooming about the pointer). */
    panByPosition(coords: number[], pixel: number[]) {
      return this.fns.pan(this, this.center, coords, pixel);
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
