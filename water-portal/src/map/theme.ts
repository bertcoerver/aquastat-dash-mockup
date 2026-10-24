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
  // (Opaque: the tiles overlap a little, and see-through fills would show the seams.)
  outline: Color; // the selected sub-basin (or country) when the map shows values
  border: Color;
  basinBorder: Color;
  water: Color; // lakes
  river: Color;
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
    outline: [19, 35, 43, 255],
    border: [120, 136, 143, 255],
    basinBorder: [150, 112, 70, 255],
    water: [62, 138, 189, 255],
    river: [0, 0, 138, 200],
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
    outline: [240, 244, 245, 255],
    border: [102, 124, 134, 255],
    basinBorder: [190, 150, 100, 255],
    water: [70, 150, 200, 255],
    river: [0, 0, 138, 200],
    marker: [230, 169, 76, 255],
    markerRing: [13, 22, 27, 255],
  },
};

/** Colour `a` blended towards `b` by `t` (0: a, 1: b), opaque. */
export function mixColor(a: Color, b: Color, t: number): Color {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).concat(255) as Color;
}
