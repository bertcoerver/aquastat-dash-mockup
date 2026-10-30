/*
 * The globe: a MapLibre map with deck.gl's layers drawn into it (interleaved), so
 * deck.gl uses a GlobeView that moves with MapLibre's camera. There is no basemap:
 * MapLibre only paints the ocean, and all data are deck.gl layers. MapLibre's own
 * controls aren't used (map.ts's work for both hosts); its spin button is this host's.
 */
import type { Deck } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { controlGroup, facing, whenLoaded, type Camera, type HostMarker, type HostOptions, type MapHost, type MarkerOptions } from "./host";
import type { LngLat } from "./places";
import { spinControl } from "./spin";

/** Let go mid-drag, the globe spins on for a while (MapLibre's own inertia stops short). */
const DRAG_PAN = {
  linearity: 0.6,
  easing: (t: number) => 1 - Math.pow(1 - t, 3),
  maxSpeed: 20000,
  deceleration: 60,
};

export function createGlobeHost({ container, theme, camera, onClick, onHover, onPointerLeave, onMove, onMoveEnd, onContextLost, cursor }: HostOptions): MapHost {
  const element = document.createElement("div");
  element.className = "map-host map-globe";
  container.append(element);

  const map = new maplibregl.Map({
    container: element,
    style: {
      version: 8,
      projection: { type: "globe" },
      sources: {},
      layers: [{ id: "ocean", type: "background", paint: { "background-color": theme.ocean } }],
    },
    center: camera.center,
    zoom: camera.zoom,
    pitch: camera.pitch,
    bearing: camera.bearing,
    attributionControl: false,
  });
  // MapLibre skips its ResizeObserver's first report, taking it for the size the map was
  // made at. Safari can lay the page out again in between (a tab opened in the
  // background, a window being restored), and the map then stays at that first size —
  // a small globe in the top-left — until reloaded. Catch it up whenever the two differ.
  const sizes = new ResizeObserver(() => {
    const canvas = map.getCanvas();
    if (canvas.clientWidth !== element.clientWidth || canvas.clientHeight !== element.clientHeight) map.resize();
  });
  sizes.observe(element);
  map.dragPan.enable(DRAG_PAN);

  const overlay = new MapboxOverlay({ interleaved: true, layers: [], onClick, onHover });
  map.addControl(overlay);
  map.on("move", onMove);
  map.on("moveend", onMoveEnd);
  map.on("webglcontextlost", onContextLost);
  const canvas = map.getCanvas();
  canvas.addEventListener("pointerleave", onPointerLeave);
  // The cursor: map.ts's while the marker is grabbed, else MapLibre's own (its classes).
  canvas.addEventListener("pointermove", () => (canvas.style.cursor = cursor() ?? ""));

  const getCamera = (): Camera => {
    const { lng, lat } = map.getCenter();
    return { center: [lng, lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  };

  // Drawing every frame (deck.gl draws on each of MapLibre's repaints).
  let animating = false;
  function frame() {
    if (!animating) return;
    map.triggerRepaint();
    requestAnimationFrame(frame);
  }

  const spin = spinControl(map);

  return {
    kind: "globe",
    element,
    canvas,
    camera: getCamera,
    project(lngLat) {
      const { lng, lat } = map.getCenter();
      if (facing(lngLat, [lng, lat]) <= 0) return null; // on the far side
      const p = map.project(lngLat);
      return [p.x, p.y];
    },
    unproject([x, y]) {
      // Off the globe, MapLibre gives the nearest point on the horizon instead; that
      // point doesn't project back onto the same pixel.
      const { lng, lat } = map.unproject([x, y]);
      const back = map.project([lng, lat]);
      return Math.hypot(back.x - x, back.y - y) < 1 ? [lng, lat] : null;
    },
    setLayers(layers) {
      overlay.setProps({ layers });
    },
    pickObject: (opts) => overlay.pickObject(opts),
    animate(on) {
      if (on === animating) return;
      animating = on;
      frame();
    },
    fitBounds([west, south, east, north], { padding, maxZoom, duration }) {
      // MapLibre takes a box across 180° as east beyond 180.
      map.fitBounds([west, south, east < west ? east + 360 : east, north], { padding, maxZoom, duration });
    },
    flyTo({ center, zoom, offset, duration }) {
      map.flyTo({ center, zoom, offset, duration });
    },
    easeTo(options) {
      // (Only what's given: MapLibre takes an `offset: undefined` for a point.)
      map.easeTo(Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)));
    },
    holdStill(hold) {
      if (hold) map.dragPan.disable();
      else map.dragPan.enable(DRAG_PAN);
    },
    marker(markerElement, { anchor, offset = [0, 0] }: MarkerOptions): HostMarker {
      // (Hidden, not faded, on the far side.)
      const marker = new maplibregl.Marker({ element: markerElement, anchor, offset, opacityWhenCovered: "0" });
      let shown = false;
      return {
        show(lngLat: LngLat, at = offset) {
          marker.setOffset(at).setLngLat(lngLat);
          if (!shown) marker.addTo(map);
          shown = true;
        },
        hide() {
          if (shown) marker.remove();
          shown = false;
        },
        remove() {
          marker.remove();
        },
      };
    },
    controls: [controlGroup(spin.element)],
    onReady(callback) {
      // (The overlay's deck: not in its typings.)
      const deck = () => (overlay as unknown as { _deck?: Deck })._deck ?? null;
      let check: (() => void) | null = null;
      const onRender = () => check?.();
      map.on("render", onRender);
      whenLoaded(
        deck,
        (c) => (check = c),
        () => {
          map.off("render", onRender);
          callback();
        },
      );
    },
    destroy() {
      animating = false;
      spin.destroy();
      sizes.disconnect();
      map.remove();
      element.remove();
    },
  };
}
