/*
 * What the map is drawn with: MapLibre's globe (globe-host.ts) or deck.gl alone, flat,
 * in a chosen projection (flat/flat-host.ts). map.ts builds the layers and keeps the
 * state; a host draws them, moves the camera, picks what's under the pointer and
 * places HTML labels. Only one host at a time; switching the projection makes a new one
 * at the same place (map.ts).
 */
import type { Layer, PickingInfo } from "@deck.gl/core";
import type { LngLat } from "./places";
import type { MapTheme } from "./theme";

export interface Camera {
  center: LngLat;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** An HTML element kept at a lon/lat (a label): the globe hides it on the far side. */
export interface HostMarker {
  /** Show it at a point, its anchor `offset` pixels away. */
  show(lngLat: LngLat, offset?: [number, number]): void;
  hide(): void;
  remove(): void;
}

export interface MarkerOptions {
  /** Which point of the element sits on the lon/lat. */
  anchor: "left" | "bottom-left";
  offset?: [number, number];
}

export interface HostOptions {
  /** The map's element (#map): the host puts its own element in it. */
  container: HTMLElement;
  theme: MapTheme;
  camera: Camera;
  /** deck.gl's picking info for a click or the pointer moving over the map. */
  onClick(info: PickingInfo): void;
  onHover(info: PickingInfo): void;
  onPointerLeave(): void;
  /** The camera moved (every frame of a move), and stopped. */
  onMove(): void;
  onMoveEnd(): void;
  onContextLost(): void;
  /** The cursor to show instead of the host's own (null: the host's). */
  cursor(): string | null;
}

export interface MapHost {
  readonly kind: "globe" | "flat";
  /** Its root in the container. */
  readonly element: HTMLElement;
  /** What the pointer events come from. */
  readonly canvas: HTMLCanvasElement;
  camera(): Camera;
  /** A point's place on the screen, in pixels from the canvas's top left (null: on the far side of the globe). */
  project(lngLat: LngLat): [number, number] | null;
  /** The point under a pixel (null: off the globe, or off the map). */
  unproject(pixel: [number, number]): LngLat | null;
  setLayers(layers: (Layer | null)[]): void;
  pickObject(opts: { x: number; y: number; layerIds?: string[] }): PickingInfo | null;
  /** Draw every frame (layers that move) until told otherwise. */
  animate(on: boolean): void;
  /** Move the camera to show a box: [west, south, east, north], west > east across 180°. */
  fitBounds(bounds: [number, number, number, number], options: { padding: Padding; maxZoom: number; duration: number }): void;
  /** Fly (far) to a point at a zoom, `offset` pixels from the middle of the view. */
  flyTo(options: { center: LngLat; zoom: number; offset: [number, number]; duration: number }): void;
  /** Ease (near) to a camera (what's given changes). */
  easeTo(options: Partial<Camera> & { offset?: [number, number]; duration?: number }): void;
  /** Hold the map still while something else is dragged on it. */
  holdStill(hold: boolean): void;
  marker(element: HTMLElement, options: MarkerOptions): HostMarker;
  /** Its own control groups for the map's controls (the globe's spin button). */
  readonly controls: HTMLElement[];
  /** Runs once it has drawn, with the tiles in view loaded (or after a while: a slow one shouldn't hold a switch). */
  onReady(callback: () => void): void;
  destroy(): void;
}

/** Cosine of the angle between two points on the globe (1: same point, < 0: opposite sides). */
export function facing([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]) {
  const r = Math.PI / 180;
  return Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng1 - lng2) * r);
}

/** A pixel's place on the canvas, from a pointer event. */
export function canvasPoint(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/** MapLibre's default easing (also the flat map's, so both feel the same). */
export const easeOutQuad = (t: number) => t * (2 - t);

/** A control group, as MapLibre's: its CSS does the rest (map.css colours it). */
export function controlGroup(...children: HTMLElement[]) {
  const group = document.createElement("div");
  group.className = "maplibregl-ctrl maplibregl-ctrl-group";
  group.append(...children);
  return group;
}

/** How long at most a host's layers are waited for before it's shown (onReady). */
export const READY_WAIT_MS = 3000;

/**
 * Calls back once `deck` has drawn and every layer reports its data loaded (the tiles
 * in view), or after READY_WAIT_MS; `onFrame` is wired to the deck's after-render.
 */
export function whenLoaded(deck: () => object | null, onFrame: (check: () => void) => void, callback: () => void) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    callback();
  };
  const timer = window.setTimeout(finish, READY_WAIT_MS);
  onFrame(() => {
    if (done) return;
    // (The layer manager is deck.gl's own; the layers' `isLoaded` says whether their data, the tiles, are in.)
    const layers = (deck() as unknown as { layerManager: { getLayers(): Layer[] } | null } | null)?.layerManager?.getLayers() ?? null;
    if (layers && layers.every((layer) => layer.isLoaded)) {
      window.clearTimeout(timer);
      finish();
    }
  });
}
