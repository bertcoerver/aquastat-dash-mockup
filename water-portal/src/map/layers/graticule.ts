import { PathStyleExtension, type PathStyleExtensionProps } from "@deck.gl/extensions";
import { PathLayer } from "@deck.gl/layers";
import maplibregl from "maplibre-gl";
import type { Color } from "../theme";

/** Meridians every this many degrees of longitude. */
const EVERY = 30;
/** Points this many degrees apart: deck.gl joins them straight, through the globe. */
const DENSITY = 2;
/** The Earth's tilt (2026), and so the latitude of the tropics; the polar circles at 90° less it. */
const TILT = 23.436;

interface Line {
  path: [number, number][];
  /** The equator and the prime meridian: drawn stronger. */
  main: boolean;
  /** The tropics and polar circles: dashed. */
  dashed: boolean;
}

interface Label {
  position: [number, number];
  text: string;
}

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);

/** The Arctic Circle, the tropics of Cancer and Capricorn, the equator and the Antarctic Circle. */
const PARALLELS = [90 - TILT, TILT, 0, -TILT, TILT - 90];
const MERIDIANS = range(-180 + EVERY, 180, EVERY);

const LINES: Line[] = [
  ...PARALLELS.map((lat) => ({
    path: range(-180, 180, DENSITY).map((lng): [number, number] => [lng, lat]),
    main: lat === 0,
    dashed: lat !== 0,
  })),
  ...MERIDIANS.map((lng) => ({
    path: range(-90, 90, DENSITY).map((lat): [number, number] => [lng, lat]),
    main: lng === 0,
    dashed: false,
  })),
];

const degrees = (lng: number) => (lng === 0 || lng === 180 ? `${lng}°` : `${Math.abs(lng)}° ${lng < 0 ? "W" : "E"}`);

/** The meridians' longitudes, just north of the equator. */
const LABELS: Label[] = MERIDIANS.map((lng) => ({ position: [lng, 0], text: degrees(lng) }));

/** The equator, tropics, polar circles and meridians, the prime meridian among them. */
export function graticuleLayer({ color, visible }: { color: Color; visible: boolean }) {
  const faint: Color = [color[0], color[1], color[2], Math.round(color[3] * 0.55)];
  return new PathLayer<Line, PathStyleExtensionProps<Line>>({
    id: "graticule",
    data: LINES,
    visible,
    getPath: (d) => d.path,
    getColor: (d) => (d.main ? color : faint),
    getWidth: (d) => (d.main ? 1.5 : 1),
    widthUnits: "pixels",
    extensions: [new PathStyleExtension({ dash: true })],
    getDashArray: (d) => (d.dashed ? [4, 3] : [0, 0]),
    // On the globe surface, as the borders (borders.ts).
    parameters: { depthCompare: "always" },
  });
}

/**
 * The meridians' longitudes, as MapLibre markers (HTML, styled in map.css): deck.gl's
 * TextLayer draws nothing on this globe (deck.gl inside MapLibre's), and MapLibre knows
 * when a marker is on the far side.
 */
export function graticuleLabels(map: maplibregl.Map) {
  const markers = LABELS.map(({ position, text }) => {
    const element = document.createElement("div");
    element.className = "graticule-label";
    element.textContent = text;
    // Beside the line, above it.
    // (Hidden, not faded, on the far side.)
    return new maplibregl.Marker({ element, anchor: "bottom-left", offset: [3, -1], opacityWhenCovered: "0" }).setLngLat(position);
  });
  let shown = false;
  return {
    show(visible: boolean) {
      if (visible === shown) return;
      shown = visible;
      for (const marker of markers) {
        if (visible) marker.addTo(map);
        else marker.remove();
      }
    },
  };
}
