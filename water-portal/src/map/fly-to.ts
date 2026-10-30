/*
 * Flying the map to what a chart row stands for (Country and Basin panels): a region's
 * countries or basins, one of them, together with the selected one where they fit.
 *
 * Boxes are [west, south, east, north] in degrees, west > east across 180°.
 */
import { facing, type WaterMap } from "./map";

export type Box = [number, number, number, number];

/** Something to show: its box, and its centre if better known than the box's. */
export interface Extent {
  box: Box;
  center?: [number, number];
}

/** The zoom that shows the whole globe. */
const GLOBE_ZOOM = 1.4;
/** The widest box showBox can frame on the globe, in degrees of longitude. */
const MAX_SPAN = 170;

/**
 * Fly to `own` and `extra` (the selection, outside `own`). Where they don't fit in one
 * view (the selection is far round the globe), show the whole globe if both are on its
 * near side, else `own` alone: it was what was clicked.
 */
export function flyTo(map: WaterMap, own: Extent[], extra: Extent | null) {
  if (!own.length) return;
  const showGlobe = (center: [number, number]) => map.showPoint(center, Math.min(map.getZoom(), GLOBE_ZOOM));
  const region = unionBox(own.map((x) => x.box));
  const both = extra === null ? region : unionBox([region, extra.box]);
  if (fits(both)) return map.showBox(both);
  const middle = meanCenter(own.map((x) => [x.center ?? boxCenter(x.box), boxArea(x.box)]));
  const there = extra === null ? null : extra.center ?? boxCenter(extra.box);
  if (there && facing(middle, there) > 0.2) return showGlobe(meanCenter([[middle, 1], [there, 1]]));
  if (fits(region)) return map.showBox(region);
  showGlobe(middle);
}

const lonSpan = ([w, , e]: Box) => (((e - w) % 360) + 360) % 360;
const fits = (box: Box) => lonSpan(box) <= MAX_SPAN && box[3] - box[1] <= MAX_SPAN;
const boxCenter = (box: Box): [number, number] => {
  const lon = box[0] + lonSpan(box) / 2;
  return [lon > 180 ? lon - 360 : lon, (box[1] + box[3]) / 2];
};
/** Roughly a box's area on the globe (square degrees at its middle latitude). */
const boxArea = (box: Box) => Math.max(lonSpan(box), 0.1) * Math.max(box[3] - box[1], 0.1) * Math.cos(((box[1] + box[3]) / 2) * (Math.PI / 180));

/** The smallest box around `list`: around the globe, it leaves out the widest gap in longitude. */
export function unionBox(list: Box[]): Box {
  const arcs = list.map((b) => [b[0], lonSpan(b)]).sort((a, b) => a[0] - b[0]);
  // Walk east from the westernmost start, keeping how far east the arcs so far reach.
  let reach = arcs[0][0] + arcs[0][1];
  let gap = { width: -Infinity, west: arcs[0][0] };
  for (const [start, span] of arcs.slice(1)) {
    if (start - reach > gap.width) gap = { width: start - reach, west: start };
    reach = Math.max(reach, start + span);
  }
  // …and the gap from the furthest reach round to the first start.
  if (arcs[0][0] + 360 - reach > gap.width) gap = { width: arcs[0][0] + 360 - reach, west: arcs[0][0] };
  const west = gap.west;
  const east = west + Math.min(359.9, 360 - Math.max(0, gap.width));
  return [west, Math.min(...list.map((b) => b[1])), east > 180 ? east - 360 : east, Math.max(...list.map((b) => b[3]))];
}

/** The weighted mean of points on the globe. */
function meanCenter(points: [[number, number], number][]): [number, number] {
  const r = Math.PI / 180;
  let [x, y, z] = [0, 0, 0];
  for (const [[lon, lat], w] of points) {
    x += w * Math.cos(lat * r) * Math.cos(lon * r);
    y += w * Math.cos(lat * r) * Math.sin(lon * r);
    z += w * Math.sin(lat * r);
  }
  return [Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r];
}
