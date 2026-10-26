/*
 * One pixel's value from an online COG, read with as few bytes as possible: for a
 * time series that's one read of each of a few hundred rasters, so the cost per raster
 * is what counts.
 *
 * The map's reader (GeoTIFF.fromUrl) reads the tags of every overview when it opens a
 * raster, and the tile offsets in 64 KiB blocks: about 500 KB and 8 requests per
 * WaPOR raster before the pixel's tile. Only the full resolution image is needed here,
 * so this reads its IFD itself (the first, in a COG):
 *
 *   1. the first 16 KiB: the header and the first IFD (a COG keeps them at the start),
 *      then the georeferencing, which GDAL puts after the tile offsets (~150 bytes)
 *   2. the tile's entries in TileOffsets and TileByteCounts (8 bytes each, at once)
 *   3. the tile, decoded by the map's decoder pool (it's compressed as a whole)
 *
 * About 70 KB and 5 requests per raster; the parsed IFD is kept, so another point in
 * the same raster needs only 2 and 3. The compressed tiles are kept too (see TILE_CACHE_BYTES):
 * a WaPOR tile spans 0.75° at 300 m, so points clicked near each other often share one.
 *
 * The map reads whole tiles this way too (cogTile), where a raster is sampled onto a
 * finer grid at full resolution (see wapor.ts, resampledTile).
 *
 * Based on holoviz-utils' pixel_values.js, which does the same with geotiff.js.
 */
import { defaultDecoderPool, type DecoderMetadata, type DecoderPool, type RasterTypedArray } from "@developmentseed/geotiff";
import type { LngLat } from "../map/places";

const HEADER_BYTES = 16 * 1024;

/** TIFF tags read from the first IFD. */
const TAG = {
  width: 256,
  height: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  planarConfiguration: 284,
  predictor: 317,
  tileWidth: 322,
  tileHeight: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  pixelScale: 33550,
  tiepoint: 33922,
  transformation: 34264,
  nodata: 42113,
};

/** Bytes per value, by TIFF field type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** An IFD entry: its values are at `offset` in the file (inline ones too). */
interface Entry {
  type: number;
  count: number;
  offset: number;
}

/** What a pixel read needs of a raster's full resolution image. */
interface Image {
  url: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Pixel (col, row) to x/y: x = a·col + b·row + c, y = d·col + e·row + f. */
  transform: [number, number, number, number, number, number];
  nodata: number | null;
  tileOffsets: Entry;
  tileByteCounts: Entry;
  compression: Parameters<DecoderPool["decode"]>[1];
  metadata: DecoderMetadata;
}

class Missing extends Error {}

/** A request that hangs would hold up the whole series: it's given up on, and tried again. */
const REQUEST_TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

/** Bytes [start, start + length) of a file; Missing if there's no such file (not published yet). */
async function readRange(url: string, start: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await readRangeOnce(url, start, length, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (err) {
      if (signal?.aborted || err instanceof Missing || attempt === ATTEMPTS) throw err;
    }
  }
}

async function readRangeOnce(url: string, start: number, length: number, signal: AbortSignal) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal });
  if (res.status >= 400 && res.status < 500) throw new Missing(`${res.status} ${url}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  const buffer = await res.arrayBuffer();
  // A server that ignores the range sends the whole file.
  return res.status === 206 ? buffer : buffer.slice(start, start + length);
}

/** Parsed IFDs, by URL (a few hundred numbers each). Failed reads are tried again. */
const images = new Map<string, Promise<Image>>();

function openImage(url: string, signal?: AbortSignal): Promise<Image> {
  let image = images.get(url);
  if (!image) {
    image = readImage(url, signal);
    images.set(url, image);
    image.catch((err) => err instanceof Missing || images.delete(url));
  }
  return image;
}

async function readImage(url: string, signal?: AbortSignal): Promise<Image> {
  const head = new DataView(await readRange(url, 0, HEADER_BYTES, signal));
  const le = head.getUint16(0) === 0x4949; // "II"
  const big = head.getUint16(2, le) === 43; // BigTIFF
  const u16 = (at: number) => head.getUint16(at, le);
  const u32 = (at: number) => head.getUint32(at, le);
  const u64 = (at: number) => Number(head.getBigUint64(at, le));

  const ifd = big ? u64(8) : u32(4);
  const count = big ? u64(ifd) : u16(ifd);
  const [first, size, inline] = big ? [ifd + 8, 20, 8] : [ifd + 2, 12, 4];
  if (first + count * size > head.byteLength) throw new Error(`The first IFD isn't in the first ${HEADER_BYTES} bytes: ${url}`);
  const entries = new Map<number, Entry>();
  for (let i = 0; i < count; i++) {
    const at = first + i * size;
    const type = u16(at + 2);
    const n = big ? u64(at + 4) : u32(at + 4);
    const valueAt = at + (big ? 12 : 8);
    const fits = n * (TYPE_SIZE[type] ?? 1) <= inline;
    entries.set(u16(at), { type, count: n, offset: fits ? valueAt : big ? u64(valueAt) : u32(valueAt) });
  }

  // Values out of the header: in a GDAL COG, the georeferencing comes after the tile
  // offsets. They're next to each other, so one read gets them all.
  const byteSize = (e: Entry) => e.count * TYPE_SIZE[e.type];
  const outside = Object.values(TAG)
    .map((tag) => entries.get(tag))
    .filter((e): e is Entry => !!e && e !== entries.get(TAG.tileOffsets) && e !== entries.get(TAG.tileByteCounts))
    .filter((e) => e.offset + byteSize(e) > head.byteLength);
  let extra: { start: number; buffer: ArrayBuffer } | null = null;
  if (outside.length) {
    const start = Math.min(...outside.map((e) => e.offset));
    const end = Math.max(...outside.map((e) => e.offset + byteSize(e)));
    if (end - start <= 64 * 1024) extra = { start, buffer: await readRange(url, start, end - start, signal) };
  }
  const values = async (tag: number): Promise<number[] | null> => {
    const entry = entries.get(tag);
    if (!entry) return null;
    const bytes = byteSize(entry);
    const view =
      entry.offset + bytes <= head.byteLength
        ? new DataView(head.buffer, entry.offset, bytes)
        : extra && entry.offset >= extra.start && entry.offset + bytes <= extra.start + extra.buffer.byteLength
          ? new DataView(extra.buffer, entry.offset - extra.start, bytes)
          : new DataView(await readRange(url, entry.offset, bytes, signal));
    return Array.from({ length: entry.count }, (_, i) => readValue(view, entry.type, i, le));
  };
  const one = async (tag: number, fallback: number) => (await values(tag))?.[0] ?? fallback;
  const text = async (tag: number) => {
    const codes = await values(tag);
    return codes && String.fromCharCode(...codes).replace(/\0+$/, "");
  };

  const [width, height, tileWidth, tileHeight, bitsPerSample, compression, samplesPerPixel, planarConfiguration, predictor, sampleFormat] =
    await Promise.all([
      one(TAG.width, 0),
      one(TAG.height, 0),
      one(TAG.tileWidth, 0),
      one(TAG.tileHeight, 0),
      one(TAG.bitsPerSample, 1),
      one(TAG.compression, 1),
      one(TAG.samplesPerPixel, 1),
      one(TAG.planarConfiguration, 1),
      one(TAG.predictor, 1),
      one(TAG.sampleFormat, 1),
    ]);
  const tileOffsets = entries.get(TAG.tileOffsets);
  const tileByteCounts = entries.get(TAG.tileByteCounts);
  if (!tileWidth || !tileOffsets || !tileByteCounts) throw new Error(`Not a tiled TIFF: ${url}`);

  const [scale, tiepoint, matrix, nodata] = await Promise.all([
    values(TAG.pixelScale),
    values(TAG.tiepoint),
    values(TAG.transformation),
    text(TAG.nodata),
  ]);
  let transform: Image["transform"];
  if (scale && tiepoint) {
    // Raster (i, j) is at (x, y): the corner of pixel (0, 0) follows.
    const [i, j, , x, y] = tiepoint;
    transform = [scale[0], 0, x - i * scale[0], 0, -scale[1], y + j * scale[1]];
  } else if (matrix) {
    transform = [matrix[0], matrix[1], matrix[3], matrix[4], matrix[5], matrix[7]];
  } else {
    throw new Error(`No georeferencing: ${url}`);
  }

  return {
    url,
    width,
    height,
    tileWidth,
    tileHeight,
    transform,
    nodata: nodata ? Number(nodata) : null,
    tileOffsets,
    tileByteCounts,
    compression: compression as Image["compression"],
    metadata: {
      sampleFormat: sampleFormat as DecoderMetadata["sampleFormat"],
      bitsPerSample,
      samplesPerPixel,
      width: tileWidth,
      height: tileHeight,
      predictor: predictor as DecoderMetadata["predictor"],
      planarConfiguration: planarConfiguration as DecoderMetadata["planarConfiguration"],
      littleEndian: le,
    },
  };
}

function readValue(view: DataView, type: number, i: number, le: boolean): number {
  const at = i * TYPE_SIZE[type];
  switch (type) {
    case 3:
      return view.getUint16(at, le);
    case 4:
      return view.getUint32(at, le);
    case 8:
      return view.getInt16(at, le);
    case 9:
      return view.getInt32(at, le);
    case 11:
      return view.getFloat32(at, le);
    case 12:
      return view.getFloat64(at, le);
    case 16:
    case 18:
      return Number(view.getBigUint64(at, le));
    case 17:
      return Number(view.getBigInt64(at, le));
    case 6:
      return view.getInt8(at);
    default: // BYTE, ASCII, UNDEFINED (rationals aren't needed)
      return view.getUint8(at);
  }
}

/**
 * Compressed tiles, by raster and tile, the least recently used dropped first. Kept
 * compressed: decoding one again is quicker than reading it again.
 */
const TILE_CACHE_BYTES = 64 * 2 ** 20;
const tiles = new Map<string, Promise<ArrayBuffer | null>>();
const tileSizes = new Map<string, number>();
let tileBytes = 0;

function compressedTile(image: Image, index: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  const key = `${index} ${image.url}`;
  let tile = tiles.get(key);
  if (tile) {
    tiles.delete(key);
    tiles.set(key, tile);
    return tile;
  }
  tile = readTile(image, index, signal);
  tiles.set(key, tile);
  tile.then(
    (bytes) => {
      if (tiles.get(key) !== tile) return;
      const size = bytes?.byteLength ?? 0;
      tileSizes.set(key, size);
      tileBytes += size;
      for (const old of tiles.keys()) {
        if (tileBytes <= TILE_CACHE_BYTES) break;
        if (!tileSizes.has(old)) continue; // still loading
        tiles.delete(old);
        tileBytes -= tileSizes.get(old)!;
        tileSizes.delete(old);
      }
    },
    () => tiles.get(key) === tile && tiles.delete(key),
  );
  return tile;
}

/** A tile's bytes as stored; null for a sparse tile (no data at all). */
async function readTile(image: Image, index: number, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  const entry = async ({ type, count, offset }: Entry) => {
    if (index >= count) throw new Error(`No tile ${index} in ${image.url}`);
    const size = TYPE_SIZE[type];
    // (A single tile's entry is inline: it's in the header already, but cheap to read again.)
    const view = new DataView(await readRange(image.url, offset + index * size, size, signal));
    return readValue(view, type, 0, image.metadata.littleEndian);
  };
  const [offset, length] = await Promise.all([entry(image.tileOffsets), entry(image.tileByteCounts)]);
  if (!offset || !length) return null;
  return readRange(image.url, offset, length, signal);
}

/** A raster's pixel size, in its CRS's units (degrees for WaPOR); null if there's no such raster. */
export async function cogPixelSize(url: string, signal?: AbortSignal): Promise<[number, number] | null> {
  try {
    const { transform: [a, b, , d, e] } = await openImage(url, signal);
    return [Math.hypot(a, d), Math.hypot(b, e)];
  } catch (err) {
    if (err instanceof Missing) return null;
    throw err;
  }
}

/** What the map needs of a raster's full resolution image (see cogTile). */
export type CogImage = Pick<Image, "width" | "height" | "tileWidth" | "tileHeight" | "transform" | "nodata">;

/** A raster's full resolution image; null if there's no such raster. */
export async function cogImage(url: string, signal?: AbortSignal): Promise<CogImage | null> {
  try {
    const { width, height, tileWidth, tileHeight, transform, nodata } = await openImage(url, signal);
    return { width, height, tileWidth, tileHeight, transform, nodata };
  } catch (err) {
    if (err instanceof Missing) return null;
    throw err;
  }
}

/**
 * Tile (col, row) of a raster's full resolution image, decoded: its first band, always
 * tileWidth × tileHeight (a TIFF pads its edge tiles). A sparse tile is all NaN.
 */
export async function cogTile(url: string, col: number, row: number, signal?: AbortSignal): Promise<RasterTypedArray> {
  const image = await openImage(url, signal);
  const { tileWidth: tw, tileHeight: th } = image;
  const bytes = await compressedTile(image, row * Math.ceil(image.width / tw) + col, signal);
  if (!bytes) return new Float32Array(tw * th).fill(Number.NaN);
  const decoded = await defaultDecoderPool().decode(bytes.slice(0), image.compression, image.metadata);
  if (decoded.layout === "band-separate") return decoded.bands[0];
  const n = image.metadata.samplesPerPixel;
  return n === 1 ? decoded.data : decoded.data.filter((_, i) => i % n === 0);
}

/**
 * The raw value of the pixel at a point, given in the raster's CRS (lon/lat for
 * WaPOR); its first band. Null where the raster has no data: nodata, a sparse tile,
 * outside it, or no such raster (not published yet).
 */
export async function cogPixel(url: string, [x, y]: LngLat, signal?: AbortSignal): Promise<number | null> {
  let image: Image;
  try {
    image = await openImage(url, signal);
  } catch (err) {
    if (err instanceof Missing) return null;
    throw err;
  }
  const [a, b, c, d, e, f] = image.transform;
  // The inverse of the transform.
  const det = a * e - b * d;
  const col = Math.floor((e * (x - c) - b * (y - f)) / det);
  const row = Math.floor((a * (y - f) - d * (x - c)) / det);
  if (col < 0 || row < 0 || col >= image.width || row >= image.height) return null;

  const { tileWidth: tw, tileHeight: th } = image;
  const index = Math.floor(row / th) * Math.ceil(image.width / tw) + Math.floor(col / tw);
  const bytes = await compressedTile(image, index, signal);
  if (!bytes) return null;
  // The pool may hand the buffer to a worker: give it a copy, the cache keeps its own.
  const decoded = await defaultDecoderPool().decode(bytes.slice(0), image.compression, image.metadata);
  const p = (row % th) * tw + (col % tw);
  const v = decoded.layout === "band-separate" ? decoded.bands[0][p] : decoded.data[p * image.metadata.samplesPerPixel];
  return v === image.nodata || Number.isNaN(v) ? null : Number(v);
}
