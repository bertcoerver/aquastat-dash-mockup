/*
 * The GeoTIFF reader (@developmentseed/geotiff: the rasters' headers and tiles, and the
 * decoder pool), loaded when a raster is first opened rather than with the page: the
 * Country view reads no raster. The map's COG layer, which builds on it, is loaded the
 * same way (wapor-layer.ts).
 */
import type { DecoderPool, GeoTIFF, PerOriginSemaphore } from "@developmentseed/geotiff";

export interface GeotiffLib {
  GeoTIFF: typeof GeoTIFF;
  decoderPool(): DecoderPool;
  /**
   * Requests to the bucket at once. It speaks HTTP/2, so more than the browser's 6 per
   * host for HTTP/1.1 (the library's default): playback loads several frames' tiles at once.
   */
  limiter: PerOriginSemaphore;
}

let loaded: GeotiffLib | null = null;
let loading: Promise<GeotiffLib> | null = null;

/** The library, loaded on first use. */
export function geotiffLib(): Promise<GeotiffLib> {
  return (loading ??= import("@developmentseed/geotiff").then(
    (m) => (loaded = { GeoTIFF: m.GeoTIFF, decoderPool: m.defaultDecoderPool, limiter: new m.PerOriginSemaphore({ maxRequests: 16 }) }),
  ));
}

/** The library, once it has loaded (a raster is open: see wapor-tiles.ts, openRaster). */
export function loadedGeotiffLib(): GeotiffLib {
  if (!loaded) throw new Error("The GeoTIFF library hasn't loaded yet.");
  return loaded;
}
