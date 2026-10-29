/*
 * The WaPOR layer: deck.gl-raster's MultiCOGLayer, drawing a period's rasters added up
 * (wapor-tiles.ts) in the period's colours, with its own choice of tiles (one overview
 * for the whole view, only those on the visible part of the globe), which it tells the
 * view about (wapor.ts, setView). Loaded along with the first raster (wapor.ts,
 * prepareWapor), not with the page: the Country view needs neither this nor the
 * GeoTIFF reader behind it.
 */
import type { Viewport } from "@deck.gl/core";
import type { TileLayer } from "@deck.gl/geo-layers";
import { MultiCOGLayer } from "@developmentseed/deck.gl-geotiff";
import type { GeoTIFF, RasterTypedArray } from "@developmentseed/geotiff";
import type { Texture } from "@luma.gl/core";
import { loadedGeotiffLib } from "./geotiff-lib";
import { setView, visibleBox, waporViewLevel } from "./wapor";
import { boxInL2 } from "./wapor-l2";
import { AetiRamp, rampProps, type WaporRamp } from "./wapor-shader";
import type { RasterSum } from "./wapor-period";
import { assemble, cachedAt, loadSources, loadedTile, opened, ownUrls, sourceUrls } from "./wapor-tiles";

/**
 * Which overview to show: the coarsest whose pixels are at most this many CSS pixels on
 * screen, at the centre of the view. At 2, the raster is magnified up to 2× (4× in
 * device pixels on a retina screen), and the full 300 m only loads from about zoom 8.
 */
const CSS_PX_PER_RASTER_PX = 2;

/** An L1 pixel is this many L2 pixels across. */
const L1_PER_L2 = 3;

/**
 * L2 is shown once its full 100 m would be picked, i.e. its first overview (200 m) is
 * magnified more than CSS_PX_PER_RASTER_PX. That overview isn't worth reading: it's
 * 2.25 times L1's pixels for 1.5 times the detail. Until then L1's 300 m is magnified
 * up to 1.5 times more than usual.
 */
const L2_FROM = 2 / L1_PER_L2; // L1's pixel size, times this, is L2's first overview's

/** Great-circle distance in metres. */
function metersBetween([lon1, lat1]: number[], [lon2, lat2]: number[]) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

type Level = {
  metersPerPixel: number;
  matrixWidth: number;
  matrixHeight: number;
  projectedTileCorners(col: number, row: number): { topLeft: [number, number]; bottomRight: [number, number] };
};

/**
 * MultiCOGLayer with its own choice of tiles: one overview for the whole view (see
 * CSS_PX_PER_RASTER_PX), and only the tiles on the visible part of the globe.
 *
 * deck.gl-raster picks a level per tile, from the Web Mercator scale at the tile's
 * latitude. On a globe that asks for ever finer tiles towards the poles, and it doesn't
 * leave out the far side of the globe: at zoom 9 it picked over 16,000 tiles.
 */
class GlobeMultiCOGLayer extends MultiCOGLayer {
  static layerName = "GlobeMultiCOGLayer";

  /**
   * One tile: the period's rasters added up into one band, "aeti" (as float32), next
   * to the quality band if there is one. A variable's rasters (and the quality raster
   * of a 300 m one) share one grid, so tile (x, y, z) covers the same pixels in each;
   * a part on another grid is sampled onto it (see sumTiles and resampledTile), and so
   * is L1 where L2 has no data (see assemble).
   */
  async _getTileData(...[tile, options]: Parameters<MultiCOGLayer["_getTileData"]>) {
    const { x, y, z } = tile.index;
    const { multiDescriptor } = this.state;
    const { device, signal } = options;
    const { period } = this.props as unknown as { period: RasterSum };

    const get = await loadSources(period, { x, y, z }, true, signal);
    const { values, quality, width, height } = assemble(period, true, get);
    const bands = new Map([["aeti", band(device, values, "r32float", width, height)]]);
    if (quality) bands.set("quality", band(device, quality, "r8unorm", width, height));
    const { forwardTransform, inverseTransform } = multiDescriptor!.primary.levels[z].tileTransform(x, y);
    const byteLength = values.byteLength + (quality?.byteLength ?? 0);
    return { bands, forwardTransform, inverseTransform, width, height, byteLength };
  }

  renderLayers() {
    // The inner TileLayer's tileset picks the tiles. deck.gl builds it once, from the
    // first class it's given, so the subclass holds no per-render state; the period
    // stays the same for a layer's id (see map.ts).
    const layer = super.renderLayers() as TileLayer | null;
    if (!layer) return null;
    const Tileset = layer.props.TilesetClass;
    const { period } = this.props as unknown as { period: RasterSum };
    class GlobeTileset extends Tileset {
      getTileIndices({ viewport }: { viewport: Viewport }) {
        // Levels run from the coarsest (z = 0) to full resolution (the last); the
        // descriptor is private in the typings.
        const { levels } = (this as unknown as { descriptor: { levels: Level[] } }).descriptor;
        const last = levels.length - 1;
        const box = visibleBox(viewport);
        const { width, height } = viewport;
        const a = viewport.unproject([width / 2 - 5, height / 2]);
        const b = viewport.unproject([width / 2 + 5, height / 2]);
        if (!box) {
          setView(period.level, [], waporViewLevel(), null);
          return [];
        }

        const metersPerCssPixel = metersBetween(a, b) / 10;
        let z = 0;
        while (z < last && levels[z].metersPerPixel > CSS_PX_PER_RASTER_PX * metersPerCssPixel) z++;
        // L2 once its full resolution is due (see L2_FROM), if the view reaches its countries.
        const l1Meters = levels[last].metersPerPixel * (period.level === "L2" ? L1_PER_L2 : 1);
        const due = l1Meters * L2_FROM > CSS_PX_PER_RASTER_PX * metersPerCssPixel;
        const wanted = due && boxInL2(box.west, box.south, box.east, box.north) ? "L2" : "L1";

        // A lon/lat grid: every tile spans the same degrees, from the top left one's
        // corner (not every variable's grid reaches the poles).
        const level = levels[z];
        const { matrixWidth, matrixHeight } = level;
        const { topLeft: [west, north], bottomRight: [east, south] } = level.projectedTileCorners(0, 0);
        const [degX, degY] = [east - west, north - south];
        const around = Math.round(360 / degX); // tiles around the globe, if the grid went all the way
        const x0 = Math.floor((box.west - west) / degX);
        const x1 = Math.min(Math.floor((box.east - west) / degX), x0 + around - 1);
        const y0 = Math.max(0, Math.floor((north - box.north) / degY));
        const y1 = Math.min(matrixHeight - 1, Math.floor((north - box.south) / degY));
        const indices = [];
        for (let x = x0; x <= x1; x++) {
          const col = ((x % around) + around) % around;
          if (col < matrixWidth) for (let y = y0; y <= y1; y++) indices.push({ x: col, y, z });
        }
        setView(period.level, indices, wanted, box);

        // At the other level than the one shown: none, but an L1 layer keeps those it
        // has loaded, to show until L2's are in (see map.ts).
        const shown = period.level === "L2" ? wanted === "L2" : wanted === "L1" || !period.l2;
        if (!shown) return period.level === "L1" ? indices.filter((index) => loadedTile(period, true, cachedAt(index))) : [];
        return indices;
      }
    }
    return layer.clone({ TilesetClass: GlobeTileset });
  }
}

/**
 * A MultiCOGLayer source: a raster in the sum (t0, t1, …) on the period's grid, or the
 * quality raster; the layer builds its tile grid from them. Once opened, the layer gets
 * the raster itself as `url`, so it doesn't read the header again.
 */
type WaporSource = { url: string | GeoTIFF };

export function band(device: Texture["device"], data: RasterTypedArray, format: "r32float" | "r8unorm", width: number, height: number) {
  const texture = device.createTexture({ data, format, width, height, sampler: { minFilter: "nearest", magFilter: "nearest" } });
  return { texture, uvTransform: [0, 0, 1, 1] as [number, number, number, number], width, height, byteLength: data.byteLength };
}

// MultiCOGLayer opens its rasters again whenever it gets a new `sources` object. While
// playing, the map has two periods' layers: the one shown and the next.
const sourcesByKey = new Map<string, Record<string, WaporSource>>();

/**
 * The period's raster (or sum of rasters), coloured with `ramp`; nothing where
 * it has no data. With the period's quality raster, pixels with a gap longer than
 * `maxGap` dekads are left out too (null: none). No layer without a period: a hidden
 * MultiCOGLayer would still open its sources.
 */
export interface WaporLayerProps {
  period: RasterSum | null;
  ramp: WaporRamp;
  maxGap?: number | null;
  onLoad?: () => void;
  id?: string;
  /** Loads its tiles, but doesn't draw them (the next period while playing). */
  hidden?: boolean;
  /** How opaque it's drawn (fading in over the period before, see map.ts). */
  opacity?: number;
  /** Runs when every tile in view has loaded. */
  onViewportLoad?: () => void;
}
export function waporLayer({ period, ramp, maxGap = null, onLoad, id = "wapor-aeti", hidden = false, opacity = 1, onViewportLoad }: WaporLayerProps) {
  if (!period) return null;
  const key = `${period.key} ${period.qualityUrl}`;
  let sources = sourcesByKey.get(key);
  if (!sources) {
    const source = (url: string) => ({ url: opened.get(url) ?? url });
    sources = {};
    period.terms.forEach(({ url, grid }, i) => grid || (sources![`t${i}`] = source(url)));
    if (period.qualityUrl) sources.quality = source(period.qualityUrl);
    sourcesByKey.set(key, sources);
    sourceUrls.set(key, ownUrls(period));
    for (const old of sourcesByKey.keys()) {
      if (sourcesByKey.size <= 4) break;
      sourcesByKey.delete(old);
      sourceUrls.delete(old);
    }
  }
  return new GlobeMultiCOGLayer({
    id,
    visible: !hidden,
    opacity,
    sources: sources as Record<string, { url: string }>,
    concurrencyLimiter: loadedGeotiffLib().limiter,
    composite: period.qualityUrl ? { r: "aeti", g: "quality" } : { r: "aeti" },
    // A new ramp or maxGap only re-renders the loaded tiles.
    renderPipeline: [{ module: AetiRamp, props: rampProps(ramp, maxGap, period.variable.signed) }],
    // Linear filtering would blend values with the -9999 nodata at coasts.
    resampling: "nearest",
    parameters: { depthCompare: "always" },
    onGeoTIFFLoad: onLoad,
    // (Passed on to the TileLayer, though MultiCOGLayer's typings leave it out; `period`
    // for _getTileData.)
    ...({ onViewportLoad, period } as object),
  });
}
