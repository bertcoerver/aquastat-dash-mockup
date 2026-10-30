/*
 * The projections the map can be drawn in. Each has the same forward formula twice: in
 * JavaScript (d3-geo's "raw" projections, for the camera, picking and tile selection)
 * and in GLSL (for the vertex shader, see reproject-extension.ts). Both take radians
 * and return the projected point in d3's units (the equator is 2π long).
 *
 * Common space (what deck.gl's camera looks at) is these units times SCALE, so the
 * world is about 512 units wide at zoom 0, like deck.gl's Web Mercator world; zoom
 * levels then mean roughly the same thing as on the globe.
 */
import { geoEqualEarthRaw, geoEquirectangularRaw, geoMercatorRaw, geoNaturalEarth1Raw, type GeoRawProjection } from "d3-geo";
import { geoMollweideRaw, geoRobinsonRaw, geoWinkel3Raw } from "d3-geo-projection";

export const SCALE = 512 / (2 * Math.PI);

/** Web Mercator cuts off at this latitude. */
export const MAX_MERCATOR_LAT = 85.051129;

export type ProjectionId = "mercator" | "robinson" | "equalEarth" | "naturalEarth" | "winkelTripel" | "mollweide" | "equirectangular";

export interface Projection {
  id: ProjectionId;
  name: string;
  /** What the shader's switch picks it by (0 is Web Mercator: deck.gl's own). */
  glslId: number;
  raw: GeoRawProjection;
  /** The pole is a line, not a point (the x factor at 90° is not 0). */
  flatPoles: boolean;
  note: string;
}

const clampedMercator: GeoRawProjection = Object.assign(
  (lambda: number, phi: number): [number, number] => {
    const max = (MAX_MERCATOR_LAT * Math.PI) / 180;
    return geoMercatorRaw(lambda, Math.max(-max, Math.min(max, phi)));
  },
  { invert: geoMercatorRaw.invert },
);

export const PROJECTIONS: Projection[] = [
  { id: "robinson", name: "Robinson", glslId: 1, raw: geoRobinsonRaw, flatPoles: true, note: "Compromise; FAO's and National Geographic's (1988–98) world map." },
  { id: "equalEarth", name: "Equal Earth", glslId: 2, raw: geoEqualEarthRaw, flatPoles: true, note: "Equal-area (2018); Mapbox has it, MapLibre doesn't." },
  { id: "naturalEarth", name: "Natural Earth", glslId: 3, raw: geoNaturalEarth1Raw, flatPoles: true, note: "Compromise, like Robinson with rounder corners." },
  { id: "winkelTripel", name: "Winkel Tripel", glslId: 4, raw: geoWinkel3Raw, flatPoles: true, note: "Compromise; National Geographic since 1998. Meridians curve, so x depends on both λ and φ." },
  { id: "mollweide", name: "Mollweide", glslId: 5, raw: geoMollweideRaw, flatPoles: false, note: "Equal-area; the poles are points." },
  { id: "equirectangular", name: "Equirectangular", glslId: 6, raw: geoEquirectangularRaw, flatPoles: true, note: "Plate carrée: the WaPOR and GAEZ rasters' own grid (EPSG:4326)." },
  { id: "mercator", name: "Web Mercator", glslId: 0, raw: clampedMercator, flatPoles: true, note: "deck.gl's own flat projection, for comparison; cut at ±85°." },
];

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

vec2 rp_raw(int id, vec2 lp) {
  if (id == 1) return rp_robinson(lp.x, lp.y);
  if (id == 2) return rp_equalEarth(lp.x, lp.y);
  if (id == 3) return rp_naturalEarth(lp.x, lp.y);
  if (id == 4) return rp_winkelTripel(lp.x, lp.y);
  if (id == 5) return rp_mollweide(lp.x, lp.y);
  if (id == 6) return lp;
  return rp_mercator(lp.x, lp.y);
}
`;
