/*
 * A WaPOR raster for the map: one overview of an annual AETI COG (EPSG:4326, so its
 * pixels are a lon/lat grid), read whole, coloured on the CPU into an image. The
 * portal's layer does this per tile on the GPU; here the point is only that a lon/lat
 * image reprojects through the same vertex path as everything else.
 */
import { fromUrl } from "geotiff";
import { ramp, type Raster } from "./layers";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET";
export const RASTER_URL = `${BUCKET}/L1-AETI-A/WAPOR-3.L1-AETI-A.2023.tif`;
/** The widest overview read (pixels across). */
const MAX_WIDTH = 2600;
/** AETI-A's values are mm/year times 10; the colours run to this many mm/year. */
const SCALE = 0.1;
const MAX_MM = 1500;

export async function loadRaster(onProgress: (text: string) => void): Promise<Raster> {
  onProgress("opening the GeoTIFF…");
  const tiff = await fromUrl(RASTER_URL, { allowFullFile: false });
  const count = await tiff.getImageCount();
  const full = await tiff.getImage(0);
  // (Only the full-resolution image carries the georeferencing; the overviews cover the same box.)
  const bounds = full.getBoundingBox() as [number, number, number, number];
  let image = full;
  for (let i = 1; i < count; i++) {
    const candidate = await tiff.getImage(i);
    if (candidate.getWidth() <= MAX_WIDTH) {
      image = candidate;
      break;
    }
  }
  const width = image.getWidth();
  const height = image.getHeight();
  onProgress(`reading a ${width} × ${height} overview…`);
  const [band] = (await image.readRasters({ interleave: false })) as unknown as [ArrayLike<number>];
  const nodata = image.getGDALNoData();
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = band[i];
    if (v === nodata || !Number.isFinite(v) || v < 0) continue;
    const [r, g, b] = ramp((v * SCALE) / MAX_MM);
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  onProgress(`${width} × ${height} px, ${bounds.map((b) => b.toFixed(1)).join(", ")}`);
  return { image: new ImageData(pixels, width, height), bounds };
}
