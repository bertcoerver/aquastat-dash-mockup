/*
 * MultiCOGLayer with its own choice of tiles, for a global lon/lat COG on a globe.
 * Trimmed from water-portal/src/map/layers/wapor.ts (GlobeMultiCOGLayer).
 *
 * deck.gl-raster picks a level per tile from the Web Mercator scale at the tile's
 * latitude. On a globe that asks for ever finer tiles towards the poles, and it doesn't
 * leave out the far side: for WaPOR at zoom 8 it picked over 15,000 tiles.
 */
import type { Viewport } from "@deck.gl/core";
import type { TileLayer } from "@deck.gl/geo-layers";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";

/** The coarsest overview whose pixels are at most this many CSS pixels at the view's centre. */
const CSS_PX_PER_RASTER_PX = 2;
/**
 * At most this many tiles per view: a coarser overview otherwise. A pitched view sees
 * far towards the horizon, and one overview for all of it would be a lot of tiles.
 */
const MAX_TILES = 64;

type Level = { metersPerPixel: number; matrixWidth: number; matrixHeight: number };

export class GlobeMultiCOGLayer extends MultiCOGLayer {
  static layerName = "GlobeMultiCOGLayer";

  renderLayers() {
    // The inner TileLayer's tileset picks the tiles. deck.gl builds it once, from the
    // first class it's given, so the subclass holds no per-render state.
    const layer = super.renderLayers() as TileLayer | null;
    if (!layer) return null;
    const Tileset = layer.props.TilesetClass;
    class GlobeTileset extends Tileset {
      getTileIndices({ viewport }: { viewport: Viewport }) {
        // Levels run from the coarsest (z = 0) to full resolution (the last); the
        // descriptor is private in the typings.
        const { levels } = (this as unknown as { descriptor: { levels: Level[] } }).descriptor;
        const box = visibleBox(viewport);
        if (!box) return [];

        const { width, height } = viewport;
        const a = viewport.unproject([width / 2 - 5, height / 2]);
        const b = viewport.unproject([width / 2 + 5, height / 2]);
        const metersPerCssPixel = metersBetween(a, b) / 10;
        let z = 0;
        while (z < levels.length - 1 && levels[z].metersPerPixel > CSS_PX_PER_RASTER_PX * metersPerCssPixel) z++;
        while (z > 0 && tilesIn(box, levels[z]).length > MAX_TILES) z--;
        return tilesIn(box, levels[z]).map(([x, y]) => ({ x, y, z }));
      }
    }
    return layer.clone({ TilesetClass: GlobeTileset });
  }
}

/** A global lon/lat grid with square pixels: every tile spans the same degrees. */
function tilesIn(box: Box, { matrixWidth, matrixHeight }: Level) {
  const deg = 360 / matrixWidth;
  const x0 = Math.floor((box.west + 180) / deg);
  const x1 = Math.min(Math.floor((box.east + 180) / deg), x0 + matrixWidth - 1);
  const y0 = Math.max(0, Math.floor((90 - box.north) / deg));
  const y1 = Math.min(matrixHeight - 1, Math.floor((90 - box.south) / deg));
  const tiles: [number, number][] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) tiles.push([((x % matrixWidth) + matrixWidth) % matrixWidth, y]);
  }
  return tiles;
}

/** Great-circle distance in metres. */
function metersBetween([lon1, lat1]: number[], [lon2, lat2]: number[]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

interface Box {
  west: number; // may be below -180 or east above 180: longitudes run on around the view
  east: number;
  south: number;
  north: number;
}

/**
 * The part of the globe in view, as a lon/lat box, from a grid of screen points. Where
 * a row or column of the grid crosses the globe's edge, the edge is found by bisection,
 * as the parts near it span many degrees on very few pixels.
 */
function visibleBox(viewport: Viewport): Box | null {
  const { width, height } = viewport;
  const longitude = viewport.unproject([width / 2, height / 2])[0];
  // Off the globe, unproject gives the nearest point on the horizon instead; that
  // point doesn't project back onto the same pixel.
  const onGlobe = (x: number, y: number) => {
    const lngLat = viewport.unproject([x, y]);
    const [px, py] = viewport.project(lngLat);
    return Math.hypot(px - x, py - y) < 1 ? lngLat : null;
  };
  const box: Box = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  const add = ([lon, lat]: number[]) => {
    const l = longitude + ((((lon - longitude) % 360) + 540) % 360) - 180; // unwrapped around the view
    box.west = Math.min(box.west, l);
    box.east = Math.max(box.east, l);
    box.south = Math.min(box.south, lat);
    box.north = Math.max(box.north, lat);
  };
  const N = 16;
  const line = (at: (t: number) => [number, number]) => {
    let prev: { t: number; hit: boolean } | null = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const hit = onGlobe(...at(t));
      if (hit) add(hit);
      if (prev && prev.hit !== !!hit) {
        // Bisect for the edge between the two samples.
        let [a, b] = prev.hit ? [prev.t, t] : [t, prev.t]; // a on the globe, b off it
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2;
          if (onGlobe(...at(m))) a = m;
          else b = m;
        }
        add(onGlobe(...at(a))!);
      }
      prev = { t, hit: !!hit };
    }
  };
  for (let i = 0; i <= N; i++) {
    line((t) => [t * width, (i / N) * height]);
    line((t) => [(i / N) * width, t * height]);
  }
  if (box.west > box.east) return null;
  // A pole in view: every longitude is.
  for (const lat of [90, -90]) {
    const [x, y] = viewport.project([longitude, lat]);
    const near = x >= 0 && x <= width && y >= 0 && y <= height && onGlobe(x, y);
    if (near && Math.abs(near[1]) > 89) {
      Object.assign(box, { west: longitude - 180, east: longitude + 180 });
      if (lat > 0) box.north = 90;
      else box.south = -90;
    }
  }
  return box;
}
