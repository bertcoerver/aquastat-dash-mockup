/*
 * The projections the flat map can be drawn in (the globe is MapLibre's: map.ts). Each
 * has the same forward formula twice: in JavaScript (d3-geo's "raw" projections, for
 * the camera, picking and tile selection) and in GLSL (for the vertex shaders, see
 * reproject-extension.ts). Both take radians and return the point in d3's units (the
 * equator is 2π long).
 *
 * Common space (what deck.gl's camera looks at) is these units times SCALE, so the
 * world is about 512 units wide at zoom 0, like deck.gl's Web Mercator world; zoom
 * levels then mean roughly the same as on the globe.
 */
import { geoEqualEarthRaw, geoEquirectangularRaw, geoMercatorRaw, geoNaturalEarth1Raw, type GeoRawProjection } from "d3-geo";
import { geoMollweideRaw, geoRobinsonRaw, geoWinkel3Raw } from "d3-geo-projection";

export const SCALE = 512 / (2 * Math.PI);

/** Web Mercator cuts off at this latitude. */
export const MAX_MERCATOR_LAT = 85.051129;

export type ProjectionId = "robinson" | "equalEarth" | "naturalEarth" | "winkelTripel" | "mollweide" | "equirectangular" | "mercator" | "orthographic";

/** What the map is drawn as: MapLibre's globe, or flat in one of the projections (not the globe's stand-in). */
export type MapProjection = "globe" | ProjectionId;

export interface Projection {
  id: ProjectionId;
  name: string;
  /** What the shader's switch picks it by (0 is Web Mercator: deck.gl's own). */
  glslId: number;
  /** (A `centred` projection's is unused: see globeRaw.) */
  raw: GeoRawProjection;
  /**
   * The globe seen from above the view's centre, as MapLibre draws it (globeRaw): the
   * projection moves with the centre, and the far side is hidden (reproject-extension.ts
   * fades it). Not a map to pick: the stage a morph to or from the globe passes through.
   */
  centred?: boolean;
  /** One line about it, for the picker. */
  description: string;
}

const clampedMercator: GeoRawProjection = Object.assign(
  (lambda: number, phi: number): [number, number] => {
    const max = (MAX_MERCATOR_LAT * Math.PI) / 180;
    return geoMercatorRaw(lambda, Math.max(-max, Math.min(max, phi)));
  },
  { invert: geoMercatorRaw.invert },
);

export const PROJECTIONS: Projection[] = [
  { id: "robinson", name: "Robinson", glslId: 1, raw: geoRobinsonRaw, description: "Compromise projection; FAO's world maps, National Geographic's 1988–98." },
  { id: "equalEarth", name: "Equal Earth", glslId: 2, raw: geoEqualEarthRaw, description: "Equal-area (2018): countries keep their relative sizes." },
  { id: "naturalEarth", name: "Natural Earth", glslId: 3, raw: geoNaturalEarth1Raw, description: "Compromise projection, like Robinson with rounder corners." },
  { id: "winkelTripel", name: "Winkel Tripel", glslId: 4, raw: geoWinkel3Raw, description: "Compromise projection; National Geographic since 1998." },
  { id: "mollweide", name: "Mollweide", glslId: 5, raw: geoMollweideRaw, description: "Equal-area; the poles are points, the map an ellipse." },
  { id: "equirectangular", name: "Equirectangular", glslId: 6, raw: geoEquirectangularRaw, description: "Plate carrée: the WaPOR and GAEZ rasters' own grid." },
  { id: "mercator", name: "Web Mercator", glslId: 0, raw: clampedMercator, description: "Web maps' usual projection, cut at ±85°; the poles are far away." },
  { id: "orthographic", name: "Globe", glslId: 7, raw: geoEquirectangularRaw, centred: true, description: "The globe seen from above the map's centre, as MapLibre draws it at the same zoom." },
];

/** The projections a flat map can be drawn in (the picker's). */
export const FLAT_PROJECTIONS = PROJECTIONS.filter((p) => !p.centred);
export const isFlatProjectionId = (id: string): id is ProjectionId => FLAT_PROJECTIONS.some((p) => p.id === id);

/**
 * MapLibre's globe, in numbers. Its radius is set so that the scale at the middle of the
 * view matches Web Mercator's at that latitude: the Mercator world's radius (1 in d3's
 * units) over the cosine of the centre's latitude. Its camera stands 1.5 times the view's
 * height above the surface (MapLibre's field of view), so the globe is seen in
 * perspective: `globeDistance` is the camera's distance from the globe's centre, in
 * radii, and the rim is the circle of points the camera just sees past.
 */
export const globeScale = (lat0: number) => 1 / Math.max(0.1, Math.cos((Math.max(-85, Math.min(85, lat0)) * Math.PI) / 180));
export function globeDistance(height: number, zoom: number, lat0: number) {
  const radiusPixels = ((512 * 2 ** zoom) / (2 * Math.PI)) * globeScale(lat0);
  return 1 + (1.5 * Math.max(1, height)) / radiusPixels;
}

export interface GlobeRaw extends GeoRawProjection {
  /** Which side of the globe a point is on: the cosine of its angle from the centre, less what the camera sees past (> 0: in view). */
  front(lambda: number, phi: number): number;
  /** The rim's radius, in the projection's units. */
  rim: number;
}

/**
 * The globe as seen from above a centre (λ0, φ0 in radians) by a camera `distance` radii
 * from its middle (the vertical perspective projection): the point is taken to its place
 * on the sphere as seen with the centre in front, then projected towards the camera onto
 * the plane through the centre; at the centre the scale is 1, as orthographic's. `scale`
 * sizes the globe (globeScale).
 */
export function globeRaw(lambda0: number, phi0: number, scale: number, distance: number): GlobeRaw {
  const P = Math.max(1.0001, distance);
  const [cosPhi0, sinPhi0] = [Math.cos(phi0), Math.sin(phi0)];
  /** The point's unit vector with the centre at (1, 0, 0): x towards the viewer, y east, z north. */
  const turned = (lambda: number, phi: number): [number, number, number] => {
    const cosPhi = Math.cos(phi);
    const x = cosPhi * Math.cos(lambda - lambda0);
    const y = cosPhi * Math.sin(lambda - lambda0);
    const z = Math.sin(phi);
    return [x * cosPhi0 + z * sinPhi0, y, -x * sinPhi0 + z * cosPhi0];
  };
  const forward = (lambda: number, phi: number): [number, number] => {
    const [x, y, z] = turned(lambda, phi);
    const k = ((P - 1) / (P - x)) * scale;
    return [k * y, k * z];
  };
  // The inverse (d3-geo-projection's satellite's), then turned back; off the globe: not a number.
  const invert = (x: number, y: number): [number, number] => {
    const [px, py] = [x / scale, y / scale];
    const rho2 = px * px + py * py;
    const rho = Math.sqrt(rho2);
    const under = 1 - (rho2 * (P + 1)) / (P - 1);
    if (under < 0) return [NaN, NaN];
    const sinc = rho === 0 ? 0 : (P - Math.sqrt(under)) / ((P - 1) / rho + rho / (P - 1));
    const cosc = Math.sqrt(Math.max(0, 1 - sinc * sinc));
    // (The point's unit vector in the turned frame: x = cos c towards the viewer.)
    const [tx, ty, tz] = rho === 0 ? [1, 0, 0] : [cosc, (px / rho) * sinc, (py / rho) * sinc];
    const ux = tx * cosPhi0 - tz * sinPhi0;
    const uz = tx * sinPhi0 + tz * cosPhi0;
    return [lambda0 + Math.atan2(ty, ux), Math.asin(Math.max(-1, Math.min(1, uz)))];
  };
  return Object.assign(forward, {
    invert,
    front: (lambda: number, phi: number) => turned(lambda, phi)[0] - 1 / P,
    rim: Math.sqrt((P - 1) / (P + 1)) * scale,
  });
}

export const isProjectionId = (id: string): id is ProjectionId => PROJECTIONS.some((p) => p.id === id);
export const projectionById = (id: ProjectionId) => PROJECTIONS.find((p) => p.id === id)!;

/** Robinson's table (d3-geo-projection's, y already times 1.5934…), for the GLSL copy. */
const ROBINSON_K: [number, number][] = [
  [0.9986, -0.062], [1.0, 0.0], [0.9986, 0.062], [0.9954, 0.124], [0.99, 0.186], [0.9822, 0.248], [0.973, 0.31], [0.96, 0.372],
  [0.9427, 0.434], [0.9216, 0.4958], [0.8962, 0.5571], [0.8679, 0.6176], [0.835, 0.6769], [0.7986, 0.7346], [0.7597, 0.7903],
  [0.7186, 0.8435], [0.6732, 0.8936], [0.6213, 0.9394], [0.5722, 0.9761], [0.5322, 1.0],
].map(([x, y]) => [x, y * 1.593415793900743] as [number, number]);

/**
 * The forward formulas in GLSL: rp_raw(id, lambdaPhi) in d3's units, ported from
 * d3-geo and d3-geo-projection (the same code the JavaScript side runs).
 */
export const PROJECTIONS_GLSL = /* glsl */ `
const float RP_PI = 3.14159265358979;
const float RP_SCALE = ${SCALE.toFixed(10)};
const vec2 RP_ROBINSON_K[20] = vec2[20](
  ${ROBINSON_K.map(([x, y]) => `vec2(${x.toFixed(6)}, ${y.toFixed(6)})`).join(",\n  ")}
);

vec2 rp_mercator(float lambda, float phi) {
  phi = clamp(phi, -${((MAX_MERCATOR_LAT * Math.PI) / 180).toFixed(8)}, ${((MAX_MERCATOR_LAT * Math.PI) / 180).toFixed(8)});
  return vec2(lambda, log(tan((RP_PI / 2.0 + phi) / 2.0)));
}

vec2 rp_robinson(float lambda, float phi) {
  float i = min(18.0, abs(phi) * 36.0 / RP_PI);
  int i0 = int(floor(i));
  float di = i - float(i0);
  vec2 a = RP_ROBINSON_K[i0];
  vec2 b = RP_ROBINSON_K[i0 + 1];
  vec2 c = RP_ROBINSON_K[min(19, i0 + 2)];
  vec2 f = b + di * (c - a) / 2.0 + di * di * (c - 2.0 * b + a) / 2.0;
  return vec2(lambda * f.x, sign(phi) * f.y);
}

vec2 rp_equalEarth(float lambda, float phi) {
  const float A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = 0.8660254037844386;
  float l = asin(M * sin(phi));
  float l2 = l * l;
  float l6 = l2 * l2 * l2;
  return vec2(
    lambda * cos(l) / (M * (A1 + 3.0 * A2 * l2 + l6 * (7.0 * A3 + 9.0 * A4 * l2))),
    l * (A1 + A2 * l2 + l6 * (A3 + A4 * l2))
  );
}

vec2 rp_naturalEarth(float lambda, float phi) {
  float phi2 = phi * phi;
  float phi4 = phi2 * phi2;
  return vec2(
    lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))),
    phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
  );
}

vec2 rp_winkelTripel(float lambda, float phi) {
  float cosy = cos(phi);
  float x2 = lambda / 2.0;
  float alpha = acos(clamp(cosy * cos(x2), -1.0, 1.0));
  float sinci = alpha > 1e-6 ? alpha / sin(alpha) : 1.0;
  vec2 aitoff = vec2(2.0 * cosy * sin(x2) * sinci, sin(phi) * sinci);
  return vec2((aitoff.x + lambda / (RP_PI / 2.0)) / 2.0, (aitoff.y + phi) / 2.0);
}

vec2 rp_mollweide(float lambda, float phi) {
  const float cx = 1.4142135623730951 / (RP_PI / 2.0), cy = 1.4142135623730951;
  float target = RP_PI * sin(phi);
  float t = phi;
  for (int i = 0; i < 30; i++) {
    float denom = 1.0 + cos(t);
    if (denom < 1e-7) break;
    float d = (t + sin(t) - target) / denom;
    t -= d;
    if (abs(d) < 1e-6) break;
  }
  t *= 0.5;
  return vec2(cx * lambda * cos(t), cy * sin(t));
}

// The globe from above the centre (reproject.center, radians), seen by a camera
// reproject.globeDistance radii from its middle, sized by reproject.globeScale (MapLibre's):
// the point turned so the centre faces the viewer (x towards the viewer, y east, z north),
// then projected towards the camera (globeRaw above).
vec3 rp_turned(vec2 lp, vec2 center) {
  float cosPhi = cos(lp.y);
  float x = cosPhi * cos(lp.x - center.x);
  float y = cosPhi * sin(lp.x - center.x);
  float z = sin(lp.y);
  float cosPhi0 = cos(center.y);
  float sinPhi0 = sin(center.y);
  return vec3(x * cosPhi0 + z * sinPhi0, y, -x * sinPhi0 + z * cosPhi0);
}
vec2 rp_globe(vec2 lp, vec2 center, float scale, float distance) {
  vec3 t = rp_turned(lp, center);
  return t.yz * ((distance - 1.0) / (distance - t.x)) * scale;
}

vec2 rp_raw(int id, vec2 lp) {
  if (id == 1) return rp_robinson(lp.x, lp.y);
  if (id == 2) return rp_equalEarth(lp.x, lp.y);
  if (id == 3) return rp_naturalEarth(lp.x, lp.y);
  if (id == 4) return rp_winkelTripel(lp.x, lp.y);
  if (id == 5) return rp_mollweide(lp.x, lp.y);
  if (id == 6) return lp;
  if (id == 7) return rp_globe(lp, reproject.center, reproject.globeScale, reproject.globeDistance);
  return rp_mercator(lp.x, lp.y);
}
`;
