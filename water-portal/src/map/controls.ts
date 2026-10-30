/*
 * The map's controls in its bottom-right corner, for both hosts (MapLibre's own would
 * only drive its globe): zoom in and out, the compass (dragged, it turns and tilts the
 * map; clicked, it puts it back flat, north up) and the credits behind an ⓘ. Built with
 * MapLibre's class names, so its stylesheet draws them (and map.css colours them).
 */
import { controlGroup, type Camera, type MapHost } from "./host";

const CREDITS = 'FAO M49 &amp; SDG 6 basins · HydroLAKES · HydroSHEDS · <a href="https://maplibre.org/" target="_blank" rel="noopener">MapLibre</a> &amp; <a href="https://deck.gl/" target="_blank" rel="noopener">deck.gl</a>';

/** The zoom buttons and the compass; `update` turns the compass as the map turns and tilts. */
export function navigationControl(host: () => MapHost) {
  const button = (name: string, title: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `maplibregl-ctrl-${name}`;
    b.title = title;
    b.setAttribute("aria-label", title);
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    b.append(icon);
    return b;
  };
  const zoomIn = button("zoom-in", "Zoom in");
  const zoomOut = button("zoom-out", "Zoom out");
  const compass = button("compass", "Reset bearing to north");
  const arrow = compass.firstElementChild as HTMLElement;
  zoomIn.addEventListener("click", () => host().easeTo({ zoom: host().camera().zoom + 1, duration: 300 }));
  zoomOut.addEventListener("click", () => host().easeTo({ zoom: host().camera().zoom - 1, duration: 300 }));

  // Dragged: the bearing follows the pointer's angle round the compass, the pitch its
  // height (as MapLibre's); moved less than a few pixels, it's a click.
  let drag: { id: number; start: Camera; angle: number; y: number; moved: boolean } | null = null;
  const angleAt = (e: PointerEvent) => {
    const r = compass.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };
  compass.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, start: host().camera(), angle: angleAt(e), y: e.clientY, moved: false };
    compass.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  compass.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    let da = angleAt(e) - drag.angle;
    da = ((da + 540) % 360) - 180;
    if (!drag.moved && Math.hypot(dy, da) < 3) return;
    drag.moved = true;
    host().easeTo({ bearing: drag.start.bearing + da, pitch: Math.max(0, Math.min(60, drag.start.pitch - dy * 0.5)), duration: 0 });
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved } = drag;
    drag = null;
    if (!moved) host().easeTo({ bearing: 0, pitch: 0, duration: 500 });
  };
  compass.addEventListener("pointerup", end);
  compass.addEventListener("pointercancel", end);

  const element = controlGroup(zoomIn, zoomOut, compass);
  return {
    element,
    update() {
      const { bearing, pitch } = host().camera();
      // (MapLibre's: foreshortened by the tilt, turned against the bearing.)
      arrow.style.transform = `scale(${1 / Math.sqrt(Math.cos((pitch * Math.PI) / 180))}) rotateX(${pitch}deg) rotateZ(${-bearing}deg)`;
    },
  };
}

/** The credits, behind an ⓘ (MapLibre's compact attribution, by hand). */
export function attributionControl() {
  const element = document.createElement("div");
  element.className = "maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "maplibregl-ctrl-attrib-button";
  button.title = "Toggle attribution";
  button.setAttribute("aria-label", "Toggle attribution");
  button.setAttribute("aria-expanded", "false");
  const inner = document.createElement("div");
  inner.className = "maplibregl-ctrl-attrib-inner";
  inner.innerHTML = CREDITS;
  element.append(button, inner);
  const open = (shown: boolean) => {
    element.classList.toggle("maplibregl-compact-show", shown);
    button.setAttribute("aria-expanded", String(shown));
  };
  button.addEventListener("click", () => open(!element.classList.contains("maplibregl-compact-show")));
  document.addEventListener("pointerdown", (e) => {
    if (!element.contains(e.target as Node)) open(false);
  });
  return element;
}
