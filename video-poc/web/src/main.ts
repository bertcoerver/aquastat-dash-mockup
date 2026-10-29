import { COORDINATE_SYSTEM, Deck, _GlobeView as GlobeView, type Viewport } from "@deck.gl/core";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, PathLayer } from "@deck.gl/layers";
import type { Device, Texture } from "@luma.gl/core";

type Bounds = [west: number, south: number, east: number, north: number];

type Manifest = {
  region: string;
  variable: string;
  unit: string;
  fps: number;
  dates: { code: string; start: string; end: string }[];
  color: { range: [number, number]; colormap: string };
  tiles: {
    id: string;
    bounds: Bounds;
    /** Consecutive videos (one per year): frames first … first + count - 1 of `dates`. */
    segments: { first: number; count: number; video: string; videoHevc?: string }[];
  }[];
};

type Segment = { first: number; count: number; video: HTMLVideoElement };

type Tile = {
  id: string;
  bounds: Bounds;
  segments: Segment[];
  /** Index of the segment that is shown (and plays). */
  active: number;
  texture?: Texture;
  /** A new frame was presented and isn't on the GPU yet. */
  dirty: boolean;
  /** The tile's centre faces the camera. */
  visible: boolean;
};

const regions: string[] = await (await fetch("regions.json")).json();
const requested = new URLSearchParams(location.search).get("region");
const region = requested && regions.includes(requested) ? requested : regions.includes("nile-delta") ? "nile-delta" : regions[0];
const manifest: Manifest = await (await fetch(`${region}/manifest.json`)).json();
const { fps, dates } = manifest;
const lastFrame = dates.length - 1;

const playButton = document.querySelector<HTMLButtonElement>("#play")!;
const dateLabel = document.querySelector<HTMLSpanElement>("#date")!;
const slider = document.querySelector<HTMLInputElement>("#frame")!;
const speed = document.querySelector<HTMLSelectElement>("#speed")!;
const regionMenu = document.querySelector<HTMLSelectElement>("#region")!;
const edgesToggle = document.querySelector<HTMLInputElement>("#edges")!;
slider.max = String(lastFrame);
regionMenu.append(...regions.map((r) => new Option(r, r, r === region, r === region)));

// Safari plays VP9 but drops its alpha, and there's no canPlayType() for alpha: pick the
// HEVC-with-alpha files by vendor.
const useHevc = navigator.vendor.startsWith("Apple");

const tiles: Tile[] = manifest.tiles.map((t) => ({
  id: t.id,
  bounds: t.bounds,
  segments: t.segments.map((s) => {
    const video = document.createElement("video");
    const src = `${region}/${useHevc && s.videoHevc ? s.videoHevc : s.video}`;
    // One segment loops by itself; several are chained by `advance`.
    Object.assign(video, { src, muted: true, loop: t.segments.length === 1, playsInline: true, preload: "auto" });
    return { first: s.first, count: s.count, video };
  }),
  active: 0,
  dirty: true,
  visible: true,
}));
// The first tile is the clock; the others follow it.
const master = tiles[0];
let frame = 0;
let playing = false;
let scrubbing = false;

const activeSegment = (t: Tile) => t.segments[t.active];
const allVideos = () => tiles.flatMap((t) => t.segments.map((s) => s.video));
/** Seconds since the first dekad, from the tile's active video. */
const globalTime = (t: Tile) => activeSegment(t).first / fps + activeSegment(t).video.currentTime;
/** The segment index that holds frame `k`. */
const segmentOf = (t: Tile, k: number) => Math.max(0, t.segments.findIndex((s) => k < s.first + s.count));

for (const tile of tiles) {
  tile.segments.forEach((segment, i) => {
    const next = (i + 1) % tile.segments.length;
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
      if (tile.active === i) {
        tile.dirty = true;
        const k = Math.round(meta.mediaTime * fps);
        if (tile === master) frame = Math.min(lastFrame, segment.first + k);
        // The segment's last frame is on screen: hand over to the next segment when its
        // time is up. Waiting for "ended" adds that event's latency to the last frame.
        if (playing && tile.segments.length > 1 && k === segment.count - 1) {
          setTimeout(() => {
            if (playing && tile.active === i) activate(tile, next, 0);
          }, 1000 / (fps * segment.video.playbackRate));
        }
      }
      segment.video.requestVideoFrameCallback(onFrame);
    };
    segment.video.requestVideoFrameCallback(onFrame);
    // Fallback for the handover above.
    segment.video.addEventListener("ended", () => {
      if (playing && tile.active === i) activate(tile, next, 0);
    });
  });
}

/**
 * Show segment `i` of a tile from `time` seconds into it. The segment's video is already
 * loaded and decoded at its first frame, so a switch at a year boundary is immediate.
 */
function activate(t: Tile, i: number, time: number) {
  const next = t.segments[i].video;
  if (Math.abs(next.currentTime - time) > 0.01) next.currentTime = time;
  next.playbackRate = +speed.value;
  if (playing) void next.play();
  if (i !== t.active) {
    const previous = activeSegment(t).video;
    t.active = i;
    previous.pause();
    // Park it on its first frame, ready for the next time round.
    previous.currentTime = 0;
  }
  // A video parked on its first frame doesn't present that frame again when it starts
  // playing, so no frame callback follows: upload it, and set the date, now.
  t.dirty = true;
  if (t === master) frame = Math.min(lastFrame, t.segments[i].first + Math.floor(time * fps + 1e-3));
}

const deck = new Deck({
  parent: document.querySelector<HTMLDivElement>("#map")!,
  // Tessellate bitmaps every 0.5° so the 1° tiles follow the sphere.
  views: new GlobeView({ resolution: 0.5 }),
  initialViewState: { ...centre(tiles.map((t) => t.bounds)), zoom: 7.2 },
  controller: true,
  layers: [basemap()],
  onDeviceInitialized: (device) => void start(device),
  // Upload new video frames inside deck's own render loop, never from outside it.
  onBeforeRender: uploadFrames,
});

/** The middle of the tiles' combined extent. */
function centre(bounds: Bounds[]) {
  const west = Math.min(...bounds.map((b) => b[0]));
  const south = Math.min(...bounds.map((b) => b[1]));
  const east = Math.max(...bounds.map((b) => b[2]));
  const north = Math.max(...bounds.map((b) => b[3]));
  return { longitude: (west + east) / 2, latitude: (south + north) / 2 };
}

function basemap() {
  return new TileLayer<ImageBitmap>({
    id: "osm",
    data: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props) => {
      const [[west, south], [east, north]] = props.tile.boundingBox;
      return new BitmapLayer({
        id: props.id,
        image: props.data,
        bounds: [west, south, east, north],
        // OSM tiles are Web Mercator; let the shader reproject them onto the globe.
        _imageCoordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        desaturate: 0.7,
      });
    },
  });
}

function layers() {
  const video = tiles.map(
    (t) =>
      new BitmapLayer({
        id: `video-${t.id}`,
        image: t.texture ?? null,
        bounds: t.bounds,
        visible: t.visible,
        _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        // The video lies on the same surface as the basemap: draw it over, and hide
        // tiles past the horizon instead of relying on the depth test.
        parameters: { depthCompare: "always" },
      }),
  );
  const edges = new PathLayer<Tile>({
    id: "tile-edges",
    data: tiles,
    visible: edgesToggle.checked,
    getPath: (t) => outline(t.bounds),
    getColor: [255, 64, 64],
    getWidth: 2,
    widthUnits: "pixels",
    parameters: { depthCompare: "always" },
  });
  return [basemap(), ...video, edges];
}

/** A tile's outline, with a vertex every 0.05° so it follows the sphere. */
function outline([w, s, e, n]: Bounds): [number, number][] {
  const corners: [number, number][] = [[w, n], [e, n], [e, s], [w, s], [w, n]];
  const path: [number, number][] = [];
  for (let c = 0; c < 4; c++) {
    const [[x0, y0], [x1, y1]] = [corners[c], corners[c + 1]];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 0.05));
    for (let i = 0; i < steps; i++) path.push([x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]);
  }
  return [...path, [w, n]];
}

async function start(device: Device) {
  await Promise.all(
    allVideos().map((video) =>
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ? undefined
        : new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true })),
    ),
  );
  for (const t of tiles) {
    const { videoWidth: width, videoHeight: height } = t.segments[0].video;
    t.texture = device.createTexture({
      width,
      height,
      format: "rgba8unorm",
      mipLevels: device.getMipLevelCount(width, height),
      sampler: {
        minFilter: "linear",
        mipmapFilter: "linear",
        // Show 100 m pixels as pixels when zoomed in.
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
  }
  deck.setProps({ layers: layers() });
  seek(0);
  playButton.disabled = false;
  requestAnimationFrame(tick);
}

function uploadFrames() {
  for (const t of tiles) {
    if (!t.dirty || !t.texture) continue;
    const { video } = activeSegment(t);
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;
    t.texture.copyExternalImage({ image: video, width: video.videoWidth, height: video.videoHeight });
    t.texture.generateMipmapsWebGL();
    t.dirty = false;
  }
}

/**
 * Every animation frame: keep the followers in step and update the controls. Rendering is
 * left to deck: it animates (redraws every frame) only while a video has a frame to upload.
 */
function tick() {
  if (playing) {
    const g = globalTime(master);
    for (const t of tiles) {
      if (t === master) continue;
      const i = segmentOf(t, Math.floor(g * fps));
      const local = g - t.segments[i].first / fps;
      if (i !== t.active) activate(t, i, local);
      else if (!activeSegment(t).video.seeking && Math.abs(activeSegment(t).video.currentTime - local) > 0.5 / fps) {
        activeSegment(t).video.currentTime = local;
      }
    }
  }
  if (updateVisibility()) deck.setProps({ layers: layers() });
  const animate = playing || tiles.some((t) => t.dirty);
  if (animate !== deck.props._animate) deck.setProps({ _animate: animate });
  showFrame(frame);
  requestAnimationFrame(tick);
}

/** Hide tiles whose centre is behind the globe. Returns whether anything changed. */
function updateVisibility() {
  const viewport: Viewport | undefined = deck.getViewports()[0];
  if (!viewport) return false;
  const camera = viewport.cameraPosition;
  let changed = false;
  for (const t of tiles) {
    const [w, s, e, n] = t.bounds;
    const p = viewport.projectPosition([(w + e) / 2, (s + n) / 2, 0]);
    // The surface point faces the camera when (camera - p) points away from the centre.
    const facing = p[0] * (camera[0] - p[0]) + p[1] * (camera[1] - p[1]) + p[2] * (camera[2] - p[2]) > 0;
    if (facing !== t.visible) {
      t.visible = facing;
      changed = true;
    }
  }
  return changed;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function showFrame(k: number) {
  const { start, end } = dates[k];
  const label = `${+start.slice(8)}–${+end.slice(8)} ${DATE_FORMAT.format(new Date(start))}`;
  if (dateLabel.textContent !== label) dateLabel.textContent = label;
  if (!scrubbing) slider.value = String(k);
}

/** Show frame `k` in every video. Seek to the middle of the frame so rounding can't land on its neighbour. */
function seek(k: number) {
  for (const t of tiles) {
    const i = segmentOf(t, k);
    activate(t, i, (k - t.segments[i].first + 0.5) / fps);
  }
  frame = k;
}

async function play() {
  playing = true;
  playButton.textContent = "❚❚";
  playButton.ariaLabel = "Pause";
  const g = globalTime(master);
  for (const t of tiles) {
    const i = segmentOf(t, Math.min(lastFrame, Math.floor(g * fps)));
    activate(t, i, g - t.segments[i].first / fps);
  }
  await Promise.all(tiles.map((t) => activeSegment(t).video.play()));
}

function pause() {
  playing = false;
  playButton.textContent = "▶";
  playButton.ariaLabel = "Play";
  for (const video of allVideos()) video.pause();
  seek(frame);
}

playButton.addEventListener("click", () => (playing ? pause() : void play()));
slider.addEventListener("pointerdown", () => (scrubbing = true));
slider.addEventListener("pointerup", () => (scrubbing = false));
slider.addEventListener("input", () => seek(+slider.value));
speed.addEventListener("change", () => {
  for (const video of allVideos()) video.playbackRate = +speed.value;
});
regionMenu.addEventListener("change", () => {
  location.search = `?region=${regionMenu.value}`;
});
edgesToggle.addEventListener("change", () => deck.setProps({ layers: layers() }));

// For checking from the console (and the verify script).
Object.assign(window, { poc: { deck, tiles, manifest, get frame() { return frame; }, play, pause, seek } });
