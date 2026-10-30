/*
 * The flat map: a Deck of its own (no MapLibre) in a ProjectedView, drawn in one of
 * projections.ts's projections, with a morph from one to the next (the shader mixes the
 * two, the viewport blends the same two). deck.gl's MapController does the panning,
 * zooming, tilting and turning; the camera moves (fitBounds, flyTo, easeTo) are view
 * state transitions. Labels are HTML elements over the canvas, moved with the camera.
 *
 * One of the projections is the globe as MapLibre draws it ("orthographic", centred on
 * the view): a switch to or from MapLibre's globe morphs to or from it, and cuts to the
 * other host at the same camera (map.ts). While the globe shows, its disc is drawn under
 * the layers (the far side fades out in the shader).
 */
import { Deck, FlyToInterpolator, LinearInterpolator, type Layer, type MapViewState } from "@deck.gl/core";
import type { LngLat } from "../places";
import { easeOutQuad, whenLoaded, type Camera, type HostMarker, type HostOptions, type MapHost, type MarkerOptions } from "../host";
import { ProjectedView, holdStill } from "./projected-view";
import { globeWeight, isProjectedViewport, viewportClass, type Blend, type ProjectedViewportClass } from "./projected-viewport";
import { globeDistance, globeRaw, globeScale, projectionById, SCALE, type MapProjection, type ProjectionId } from "./projections";
import { setReprojection, setReprojectionView } from "./reproject-extension";
import { globeDiscLayer } from "./world-layers";

/** How long the morph from one projection to another takes. */
const MORPH_MS = 800;
/** Zoomed out to here the world is small; in to here the globe is the thing (precision, see reproject-extension.ts). */
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 15;
/** The centre may leave the map a little (the plane goes on past its edges), not run away. */
const MAX_OFF_MAP = { lon: 200, lat: 100 };

const VIEW_ID = "map";
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export interface FlatHostOptions extends HostOptions {
  /** The projection to open in ("orthographic": the globe, to morph out of). */
  projection: ProjectionId;
}

export interface FlatHost extends MapHost {
  kind: "flat";
  /** Morph to another projection (the globe's stand-in included); resolves when it's there. */
  morphTo(projection: ProjectionId): Promise<void>;
  /** The projection shown, or morphed to ("orthographic": the globe's stage, as the globe). */
  shown(): MapProjection;
}

export function createFlatHost({ container, theme, camera, projection, onClick, onHover, onPointerLeave, onMove, onMoveEnd, onContextLost, cursor }: FlatHostOptions): FlatHost {
  const element = document.createElement("div");
  element.className = "map-host map-flat";
  const canvas = document.createElement("canvas");
  const labels = document.createElement("div");
  labels.className = "map-flat-labels";
  element.append(canvas, labels);
  container.append(element);

  let blend: Blend = { from: projectionById(projection), to: projectionById(projection), t: 1 };
  let Viewport: ProjectedViewportClass = viewportClass(blend);
  setReprojection(blend.to);

  let viewState: MapViewState = {
    longitude: camera.center[0],
    latitude: camera.center[1],
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom)),
    pitch: camera.pitch,
    bearing: camera.bearing,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    maxPitch: 60,
  };
  /** The view as the shaders need it (the globe's stage is seen from above the centre, in perspective). */
  const tellView = () => setReprojectionView([viewState.longitude, viewState.latitude], viewState.zoom, canvas.clientHeight || 1);
  tellView();
  const theView = () => ({ center: [viewState.longitude, viewState.latitude] as [number, number], zoom: viewState.zoom, height: canvas.clientHeight || 1 });

  const view = () =>
    new ProjectedView({
      id: VIEW_ID,
      // (MapController reads `normalize` though its options type leaves it out: false keeps the centre from wrapping at ±180°.)
      controller: { ...({ normalize: false } as object), inertia: 300, dragRotate: true, touchRotate: true, keyboard: true },
      viewportClass: Viewport,
    });

  let layers: (Layer | null)[] = [];
  /** The layers with the globe's disc under them while the globe shows. */
  function drawn(): (Layer | null)[] {
    const globe = globeWeight(blend);
    if (globe <= 0) return layers;
    const { center, zoom, height } = theView();
    const rim = globeRaw(0, 0, globeScale(center[1]), globeDistance(height, zoom, center[1])).rim * SCALE;
    return [globeDiscLayer(center, rim, theme.oceanColor, globe), ...layers];
  }
  let afterRender: (() => void) | null = null;
  let moving = false;
  const deck = new Deck({
    canvas,
    views: [view()],
    // The controller keeps the view state (setting `viewState` back on every change, the
    // controlled way, stops deck.gl's tap recognizer: a click's pointerdown reports a
    // change, and the props set during the gesture reset it). A move is set as a new
    // `initialViewState` (see moveTo).
    initialViewState: { [VIEW_ID]: viewState },
    layers: [],
    useDevicePixels: true,
    onViewStateChange: ({ viewState: next }) => {
      viewState = { ...viewState, ...(next as MapViewState) };
      const longitude = Math.max(-MAX_OFF_MAP.lon, Math.min(MAX_OFF_MAP.lon, viewState.longitude));
      const latitude = Math.max(-MAX_OFF_MAP.lat, Math.min(MAX_OFF_MAP.lat, viewState.latitude));
      if (longitude !== viewState.longitude || latitude !== viewState.latitude) moveTo({ longitude, latitude });
      tellView();
      // (The globe's disc sits on the centre.)
      if (globeWeight(blend) > 0) deck.setProps({ layers: drawn() });
      moving = true;
      placeLabels();
      onMove();
    },
    // (The controller's states: all off once a gesture and its inertia or a transition are over.)
    onInteractionStateChange: ({ isDragging, inTransition, isPanning, isRotating, isZooming }) => {
      if (isDragging || inTransition || isPanning || isRotating || isZooming) return;
      if (!moving) return;
      moving = false;
      onMoveEnd();
    },
    onHover,
    onClick,
    getCursor: ({ isDragging }) => cursor() ?? (isDragging ? "grabbing" : "grab"),
    onAfterRender: () => afterRender?.(),
  });
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("webglcontextlost", onContextLost);

  /** The viewport as drawn (null before the first frame: one from the view state then). */
  const viewport = () => deck.getViewports().find((v) => v.id === VIEW_ID) ?? new Viewport({ ...viewState, width: canvas.clientWidth, height: canvas.clientHeight });

  const getCamera = (): Camera => ({
    center: [viewState.longitude, viewState.latitude],
    zoom: viewState.zoom,
    pitch: viewState.pitch ?? 0,
    bearing: viewState.bearing ?? 0,
  });

  /** Move the camera: deck.gl takes a new initialViewState object as the view to show (eased, with a transition). */
  function moveTo(change: Partial<MapViewState>, transition?: { duration: number; interpolator: FlyToInterpolator | LinearInterpolator; easing?: (t: number) => number }) {
    viewState = { ...viewState, ...change };
    const transitionProps = transition
      ? { transitionDuration: transition.duration, transitionInterpolator: transition.interpolator, transitionEasing: transition.easing ?? easeOutQuad }
      : {};
    deck.setProps({ initialViewState: { [VIEW_ID]: { ...viewState, ...transitionProps } } });
    if (!transition) {
      // (Nothing animates: say it moved, as a transition would.)
      placeLabels();
      onMove();
      onMoveEnd();
    }
  }
  const linear = (props: string[]) => new LinearInterpolator(props);

  /** The centre that puts lon/lat `center` at `offset` pixels from the middle of the view, at `zoom`. */
  function centerFor(center: LngLat, zoom: number, offset: [number, number]): [number, number] {
    const view = theView();
    const [x, y] = Viewport.forward(center[0], center[1], view);
    const scale = 2 ** zoom;
    return Viewport.invert(x - offset[0] / scale, y + offset[1] / scale, view);
  }

  // --- The morph ------------------------------------------------------------------------

  let morph = 0;
  function morphTo(id: ProjectionId): Promise<void> {
    const to = projectionById(id);
    const from = blend.to;
    if (from === to) return Promise.resolve();
    return new Promise((resolve) => {
      const started = performance.now();
      const run = ++morph;
      const globe = from.centred || to.centred;
      const frame = () => {
        if (run !== morph) return;
        const t = Math.min(1, (performance.now() - started) / MORPH_MS);
        const e = easeInOut(t);
        blend = { from, to, t: e };
        Viewport = viewportClass(blend);
        setReprojection(to, from, e);
        // (A new view redraws the layers, whose shaders read the blend: the layers stay,
        // unless the globe's disc fades in or out under them.)
        deck.setProps({ views: [view()], ...(globe ? { layers: drawn() } : {}) });
        placeLabels();
        onMove();
        if (t < 1) requestAnimationFrame(frame);
        else {
          onMoveEnd();
          resolve();
        }
      };
      frame();
    });
  }

  // --- Labels: HTML elements over the canvas, placed again on every move. ---------------------

  interface Placed {
    element: HTMLElement;
    anchor: MarkerOptions["anchor"];
    lngLat: LngLat | null;
    offset: [number, number];
  }
  const placed = new Set<Placed>();
  function placeLabels() {
    if (!placed.size) return;
    const vp = viewport();
    for (const label of placed) {
      if (!label.lngLat) continue;
      const [x, y] = vp.project(label.lngLat);
      const [dx, dy] = label.offset;
      // (The anchor: the element's left middle, or bottom left.)
      label.element.style.transform = `translate(${(x + dx).toFixed(1)}px, ${(y + dy).toFixed(1)}px) translate(0, ${label.anchor === "left" ? "-50%" : "-100%"})`;
    }
  }

  return {
    kind: "flat",
    element,
    canvas,
    camera: getCamera,
    project(lngLat) {
      const [x, y] = viewport().project(lngLat);
      return [x, y];
    },
    unproject(pixel) {
      const vp = viewport();
      return isProjectedViewport(vp) ? vp.unprojectOnMap(pixel) : null;
    },
    setLayers(next) {
      layers = next;
      deck.setProps({ layers: drawn() });
    },
    pickObject: (opts) => deck.pickObject(opts),
    animate(on) {
      deck.setProps({ _animate: on });
    },
    fitBounds([west, south, east, north], { padding, maxZoom, duration }) {
      // A box across 180° can't be shown in one piece on a flat map: its bigger part.
      if (west > east) {
        if (180 - west >= east + 180) east = 180;
        else west = -180;
      }
      const { width, height } = viewport();
      // The box's extent in common space: its edges (a parallel's ends aren't its
      // extremes where the meridians curve).
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        for (const [lon, lat] of [
          [west + (east - west) * t, south],
          [west + (east - west) * t, north],
          [west, south + (north - south) * t],
          [east, south + (north - south) * t],
        ]) {
          const [x, y] = Viewport.forward(lon, lat);
          [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
        }
      }
      const room = { width: Math.max(1, width - padding.left - padding.right), height: Math.max(1, height - padding.top - padding.bottom) };
      const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, MAX_ZOOM, Math.log2(Math.min(room.width / Math.max(x1 - x0, 1e-6), room.height / Math.max(y1 - y0, 1e-6)))));
      // The box's middle lands in the middle of the room left by the padding.
      const offset: [number, number] = [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2];
      const [longitude, latitude] = centerFor(Viewport.invert((x0 + x1) / 2, (y0 + y1) / 2), zoom, offset);
      moveTo({ longitude, latitude, zoom }, { duration, interpolator: new FlyToInterpolator(), easing: easeInOut });
    },
    flyTo({ center, zoom, offset, duration }) {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      const [longitude, latitude] = centerFor(center, z, offset);
      moveTo({ longitude, latitude, zoom: z }, { duration, interpolator: new FlyToInterpolator(), easing: easeInOut });
    },
    easeTo({ center, zoom, pitch, bearing, offset = [0, 0], duration = 500 }) {
      const change: Partial<MapViewState> = {};
      if (zoom !== undefined) change.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
      if (center) [change.longitude, change.latitude] = centerFor(center, change.zoom ?? viewState.zoom, offset);
      if (pitch !== undefined) change.pitch = pitch;
      if (bearing !== undefined) change.bearing = bearing;
      moveTo(change, duration > 0 ? { duration, interpolator: linear(Object.keys(change)) } : undefined);
    },
    holdStill,
    marker(markerElement, { anchor, offset = [0, 0] }): HostMarker {
      const label: Placed = { element: markerElement, anchor, lngLat: null, offset };
      markerElement.classList.add("map-flat-label");
      return {
        show(lngLat, at = offset) {
          label.lngLat = lngLat;
          label.offset = at;
          if (!placed.has(label)) {
            placed.add(label);
            labels.append(markerElement);
          }
          placeLabels();
        },
        hide() {
          label.lngLat = null;
          placed.delete(label);
          markerElement.remove();
        },
        remove() {
          placed.delete(label);
          markerElement.remove();
        },
      };
    },
    controls: [],
    onReady(callback) {
      whenLoaded(
        () => deck,
        (check) => (afterRender = check),
        () => {
          afterRender = null;
          callback();
        },
      );
    },
    morphTo,
    shown: () => (blend.to.centred ? "globe" : blend.to.id),
    destroy() {
      morph++;
      holdStill(false);
      deck.finalize();
      element.remove();
    },
  };
}
