/* Map colours ([r, g, b, alpha], 0–255), for the light and dark page themes. */

export type Color = [number, number, number, number];

export interface MapTheme {
  ocean: string; // CSS colour: MapLibre paints the globe with it
  land: Color;
  noData: Color; // Country view: a country without a value on the map
  selected: Color; // the selected country or basin
  selectedSubBasin: Color; // the selected sub-basin (darker: it is small on the map)
  hovered: Color; // the sub-basin under the pointer (Basin view)
  upstream: Color; // the sub-basins upstream of it
  upstreamVeil: Color; // hovering a sub-basin: the fill of those upstream of it…
  downstreamVeil: Color; // …and of those downstream
  // (Opaque: the tiles overlap a little, and see-through fills would show the seams.)
  outline: Color; // the selected sub-basin (or country) when the map shows values
  border: Color;
  basinBorder: Color;
  river: Color; // rivers and lakes
  graticule: Color; // the equator and prime meridian (other lines fainter)
  /** The water balance scheme (Basin view): discharge lines, their edge, storage rising and falling. */
  scheme: Color;
  schemeCasing: Color;
  storageRise: Color;
  storageFall: Color;
  /** Discharge as particles: the rivers under them, and the particles. */
  particleRiver: Color;
  particle: Color;
  /** Precipitation as rain, evapotranspiration as vapour (Basin view): the drops, transpiration's and evaporation's puffs, and both. */
  rain: Color;
  transpiration: Color;
  evaporation: Color;
  vapour: Color;
  marker: Color;
  markerRing: Color;
}

export const THEMES: Record<"light" | "dark", MapTheme> = {
  light: {
    ocean: "#d4e1e7",
    land: [250, 250, 247, 255],
    noData: [222, 226, 228, 255],
    selected: [215, 228, 230, 255],
    selectedSubBasin: [168, 199, 206, 255],
    hovered: [139, 184, 214, 255],
    upstream: [204, 222, 233, 255],
    upstreamVeil: [46, 170, 90, 255],
    downstreamVeil: [214, 64, 52, 255],
    outline: [19, 35, 43, 255],
    border: [120, 136, 143, 255],
    basinBorder: [150, 112, 70, 255],
    river: [0, 0, 138, 255],
    graticule: [70, 90, 100, 170],
    scheme: [33, 113, 181, 255],
    schemeCasing: [255, 255, 255, 220],
    storageRise: [38, 166, 91, 255],
    storageFall: [215, 48, 39, 255],
    particleRiver: [33, 113, 181, 255],
    particle: [255, 255, 255, 255],
    rain: [30, 80, 160, 255],
    transpiration: [35, 130, 60, 255],
    evaporation: [40, 100, 190, 255],
    vapour: [90, 100, 115, 255],
    marker: [178, 111, 18, 255],
    markerRing: [255, 255, 255, 255],
  },
  dark: {
    ocean: "#0a1317",
    land: [29, 43, 50, 255],
    noData: [44, 58, 65, 255],
    selected: [41, 77, 90, 255],
    selectedSubBasin: [60, 112, 130, 255],
    hovered: [70, 125, 160, 255],
    upstream: [43, 70, 88, 255],
    upstreamVeil: [70, 200, 120, 255],
    downstreamVeil: [236, 96, 84, 255],
    outline: [240, 244, 245, 255],
    border: [102, 124, 134, 255],
    basinBorder: [190, 150, 100, 255],
    river: [0, 0, 138, 255],
    graticule: [170, 190, 200, 150],
    scheme: [214, 236, 250, 255],
    schemeCasing: [10, 18, 22, 220],
    storageRise: [52, 199, 104, 255],
    storageFall: [235, 64, 70, 255],
    particleRiver: [38, 92, 135, 255],
    particle: [235, 248, 255, 255],
    rain: [200, 220, 255, 255],
    transpiration: [120, 235, 140, 255],
    evaporation: [150, 205, 255, 255],
    vapour: [215, 230, 240, 255],
    marker: [230, 169, 76, 255],
    markerRing: [13, 22, 27, 255],
  },
};

/** Colour `a` blended towards `b` by `t` (0: a, 1: b), opaque. */
export function mixColor(a: Color, b: Color, t: number): Color {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).concat(255) as Color;
}
