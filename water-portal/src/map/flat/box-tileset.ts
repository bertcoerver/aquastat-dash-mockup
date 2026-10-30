/*
 * Which tiles to load: those under the viewport's lon/lat bounds (ProjectedViewport's
 * getBounds). deck.gl's own tileset walks the tile tree testing each tile's box, in Web
 * Mercator's common space, against the camera's frustum; with the camera in another
 * projection the two don't match and it keeps one tile. (The WaPOR layer picks its own
 * tiles the same way, for the globe: wapor-layer.ts.)
 */
import { _Tileset2D as Tileset2D } from "@deck.gl/geo-layers";

const TILE_SIZE = 512;

export class BoxTileset extends Tileset2D {
  getTileIndices({ viewport, maxZoom, minZoom }: Parameters<Tileset2D["getTileIndices"]>[0]) {
    const { tileSize = TILE_SIZE, zoomOffset = 0 } = this.opts;
    let z = Math.round(viewport.zoom + Math.log2(TILE_SIZE / tileSize) + zoomOffset);
    // (As deck.gl: below the layer's first zoom nothing loads; the rivers show zoomed in.)
    if (minZoom !== undefined && z < minZoom) return [];
    if (maxZoom !== undefined && z > maxZoom) z = maxZoom;
    const [west, south, east, north] = viewport.getBounds();
    if (west >= east || south >= north) return [];
    const n = 2 ** z;
    const tileX = (lon: number) => ((lon + 180) / 360) * n;
    const tileY = (lat: number) => {
      const r = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    };
    const x0 = Math.max(0, Math.floor(tileX(west)));
    const x1 = Math.min(n - 1, Math.ceil(tileX(east)) - 1);
    const y0 = Math.max(0, Math.floor(tileY(north)));
    const y1 = Math.min(n - 1, Math.ceil(tileY(south)) - 1);
    const indices = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) indices.push({ x, y, z });
    return indices;
  }
}
