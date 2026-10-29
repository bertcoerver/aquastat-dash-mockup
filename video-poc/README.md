# WaPOR datacube → video tiles on a globe (POC)

A year of dekadal WaPOR v3 actual evapotranspiration (`L2-AETI-D`, 100 m) for two or
three adjacent 1° tiles, encoded as one video with alpha per tile (WebM VP9, plus HEVC for
Safari) and played in sync on a deck.gl `_GlobeView`.

## Run it

```sh
# Python env (conda-forge, includes an ffmpeg with libvpx)
conda create -n video-poc -c conda-forge python=3.12 rasterio numpy matplotlib requests pillow ffmpeg
conda activate video-poc

python pipeline/extract.py    # 1. COG windows → data/<region>/cache/<tile>.npy
python pipeline/render.py     # 2. cubes → RGBA PNGs in data/<region>/frames/
python pipeline/encode.py     # 3. PNGs → web/public/<region>/videos/ + manifest.json
python pipeline/verify.py     # 5. checks against the COGs

cd web && npm install && npm run dev   # 4. viewer: http://localhost:5173/?region=nile-delta
```

Every step takes `--region nile-delta` (default), `gezira` or `delta-ns`; `extract.py`
also takes `--level L1|L2` and `--years 2022` or `--years 2018-2026`. `data/` is
gitignored; `web/public/` holds what the viewer needs: one folder per encoded region and
`regions.json`, which fills the viewer's region menu.

## How it works

**Extract.** The catalog API
(`data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets/L2-AETI-D/rasters`)
lists each dekad's COG URL, scale (0.1), nodata (−9999) and grid. Each tile window is read
with rasterio over `/vsicurl/` (range requests only) through a `WarpedVRT` onto a fixed
EPSG:4326 grid per tile. At L2 a whole or half degree is exactly 1024 or 512 pixels on the
source grid, so this is an exact pixel copy; at L1 (1° = 341⅓ px) it resamples (nearest).
Raw dekads are cached per tile in `data/raw/` as they arrive, so an interrupted run
resumes and regions that share a tile fetch it once. Failed reads are retried, then
listed; a rerun fetches only those.

**Render.** One colour range for all tiles and dekads (2nd–98th percentile of a 1-in-16
pixel sample), viridis, alpha 0 on nodata.

**Encode.** One video per tile and calendar year (`<tile>.<year>.webm`), so a new dekad
only re-encodes the current year. `libvpx-vp9`, `yuva420p`, CRF 32, 5 fps (the viewer's
1×; the frame rate doesn't change file size: 10, 5 and 2.5 fps gave identical bytes at
the same CRF), a keyframe every 10 frames,
`-auto-alt-ref 0` (alt-ref frames don't carry alpha). Safari plays VP9 but drops its
alpha, so on macOS each tile also gets an HEVC-with-alpha `.mov` (`hevc_videotoolbox`,
`-alpha_quality 0.75`, ~20 % smaller than the WebM). `manifest.json` lists per tile the
segments (first frame, frame count, videos) and bounds, plus fps, the dekad dates, the
colour range and the colormap.

**Viewer** ([web/src/main.ts](web/src/main.ts)). One hidden `<video>` per tile, each
copied into its own luma.gl texture (with mipmaps) whenever `requestVideoFrameCallback`
says it presented a new frame, and drawn by a `BitmapLayer` over an OSM `TileLayer`.
The first tile is the clock: every animation frame, a follower more than half a frame
off is moved to the master's time. A tile's yearly segments are chained: the next one
waits paused on its first frame and takes over one frame duration after the current one
presents its last frame (`ended` as a fallback); after the last year it wraps to the
first. The date label comes from the master's presented
frame (`mediaTime × fps`), the slider seeks every video to (n + 0.5) / fps.
Uploads happen in deck's `onBeforeRender`, and deck renders through its own loop:
`_animate` is on while playing or while a video has a new frame, off otherwise (0 redraws
when paused). An earlier version forced `deck.redraw()` from its own
`requestAnimationFrame`, and the globe shook in Firefox.
Safari gets the `.mov` files (picked by `navigator.vendor`, as there's no `canPlayType()`
for alpha). *Tile edges* outlines each video tile.
The video and the basemap lie on the same sphere, so the video layers skip the depth
test and are hidden when their centre is behind the globe.

## Regions

- **nile-delta** (default): 30–33°E × 30.5–31.5°N. Delta core, coast and Port Said; the
  sea is nodata, which exercises the alpha channel.
- **gezira**: 32–35°E × 14–15°N. Gezira–Managil and Rahad, irrigated in the dry season,
  rainfed east of the Blue Nile in Aug–Oct. Stronger seasonality, but no nodata at all
  (WaPOR gives the desert a valid 0).
- **delta-ns**: 31–32°E × 29.5–31.5°N, two tiles stacked north–south (Cairo and the Nile
  valley under the Delta's middle tile), so the seam runs along a parallel (30.5°N).
- **delta-years**: the Delta's middle tile over 2022–2023 (`--years 2022-2023`), as two
  yearly videos: tests playback running on from one video into the next.
- **l1-sample**: four 3° tiles at L1 (`--level L1 --limit 12`), not adjacent: Delta and
  sea, Punjab, Sahara, Amazon. Bitrates for the global estimate below.

## Results

Measured 2026-10-29 with `verify.py` (2022, 36 dekads, 1024² px per tile and frame) and
headless-Chrome runs of the viewer. The WebM (VP9) files; the HEVC ones aren't verified
beyond their alpha (24.4 % transparent in 32E30.5N, as its nodata).

| | nile-delta | gezira | delta-ns |
|---|---|---|---|
| Cube = COG at 12 random pixels × 3 dekads × each tile | exact | exact | exact |
| Alpha ≠ nodata | 0.000 % | 0.000 % (no nodata) | 0.000 % |
| Video → mm/day, median error (CRF 32) | 0.20 / 0.20 / 0.03 | 0.05 / 0.07 / 0.04 | 0.19 / 0.03 |
| Videos vs the COG tiles a browser would fetch | 9.9 vs 67.5 MB (7×) | 7.2 vs 53.2 MB (7×) | 6.6 vs 43.7 MB (7×) |
| Uncompressed Int16 windows | 226.5 MB | 226.5 MB | 151.0 MB |
| Max drift between videos while playing | 14 ms | 38 ms | |

(Error per tile, west to east or north to south. One colour step is 0.03 mm/day.)

- **Seams.** The tiles abut exactly: same 1/1024° grid, shared edges at 31°E/32°E (Delta),
  33°E/34°E (Gezira) and 30.5°N (delta-ns). No seam is visible in the mosaics
  (`data/<region>/verify/`) or on the globe (turn on *Tile edges* to find them). Measured,
  the step across a seam relative to the step between neighbouring columns (or rows) inside
  the tiles is, data → video: 1.12× → 1.24× at the Delta's E–W seams and 1.55× → 1.65× at
  30.5°N (high in the data because that seam runs through fields while the southern tile is
  mostly desert). So the codec adds 6–10 % at frame edges. The inside steps are taken
  across 4:2:0 chroma pairs (columns 2k+1 | 2k+2), as at the seam; steps within a pair are
  ~30 % smaller.
- **Accuracy is limited by chroma subsampling, not by CRF.** CRF 16 / 24 / 32 give 20.7 /
  15.6 / 9.9 MB but median errors of 0.16 / 0.17 / 0.20 mm/day in the Delta: `yuva420p`
  shares one chroma sample between 2 × 2 pixels, and viridis carries much of its signal in
  hue. Fine field patterns (Delta) suffer, smooth ones (Gezira) don't. The fix for a next
  step: encode the *value* as luma (a grey video) and apply the colormap in the shader.
  That also makes the colormap and range switchable without re-encoding.
- **Frame order.** Each decoded frame fits its own dekad better than either neighbour,
  except 2022-11-D2 in two Delta tiles, where consecutive dekads differ by less than the
  codec error.
- **Date label and seeks.** Seeking to dekads 0, 5, 17 and 35 shows the right dates;
  playing for 8 s shows all 36 frames.
- **Year to year (delta-years).** Logging every frame uploaded to the GPU in headless
  Chrome, 3 runs each: at 1× (5 fps) both 2022 → 2023 and the wrap 2023 → 2022 show every
  frame, 199–217 ms at the boundary (200 ms normally). At 2× the boundary frame is on time
  but the next one is dropped: a paused `<video>` starts ~170 ms late, more than a 100 ms
  frame. (A pre-roll at 1/16× speed made it worse.) Frame-exact chaining at any speed
  needs Media Source Extensions: append the yearly files to one `SourceBuffer`, so the
  decoder never restarts. Starting playback has the same ~170 ms delay, on any video.

## Scaling to global L1 (estimate)

`L1-AETI-D` (checked 2026-10-29): 317 dekads (2018-01-D1 … 2026-10-D2), 272 GB of COGs
(607–1206 MB per dekad, overviews included). 300 m = 3/1024°, so a 3° tile is exactly
1024 × 1024 px on the source grid, 4 × 4 COG blocks, no resampling. On a 3° grid, 2402 of
7200 tiles have data (80.8°N–56.1°S), 1401 of them over 90 % land.

Measured bitrate per 1024² frame (l1-sample, CRF 32): Sahara 9 KB, Delta + sea 47 KB,
Amazon 78 KB, irrigated Punjab 107 KB (WebM); HEVC is 0.72× that. Weighting land as
roughly ⅓ desert/barren, 30 % forest, 12 % cropland, 25 % grass/shrub gives ~50 KB per
full-land frame and ~30 KB per coastal one:

| | WebM | HEVC | both |
|---|---|---|---|
| 2402 tiles × 317 dekads (761k frames) | ~32 GB | ~23 GB | ~55 GB |
| + overview pyramid (6°, 12°, … tiles, +⅓) | ~43 GB | ~31 GB | **~75 GB** |
| one new dekad | ~0.1 GB | ~0.07 GB | |

Check from the other side: COG full resolution ≈ ¾ of 272 GB ≈ 204 GB, and the sample's
COG/WebM ratio is 5.6 → ≤ 36 GB WebM (an upper bound: all-nodata COG blocks cost bytes,
the video spends almost none on them). Uncertainty ±30 %: 12 frames of Jan–Apr only, and
the global colour range will differ from the sample's (0–4.6 mm/day).

Other requirements:

- **Reading.** ~200 GB of full-resolution blocks, once. In the cloud next to the bucket:
  well under an hour. From here: ~4–5 h at 100 Mbit/s (today's 33 KB/s: weeks).
- **Encoding** (~1.0M frames with the pyramid). VP9: 325 ms CPU per frame → ~90 CPU-hours,
  ~3 h on a 32-vCPU VM, ~19 h on this M2. HEVC with alpha needs macOS VideoToolbox:
  11 ms per frame → ~3 h on an M2. (x265 has an alpha option too; untested.)
- **Scratch disk.** Don't write PNGs (they'd be ~1.5 TB): per tile, read its 317 windows,
  colour them and pipe raw RGBA into ffmpeg. ~1.3 GB RAM per worker for a float32 tile
  cube; the global 2–98 % colour range comes first, from the COG overviews.
- **Files.** 2402 tiles × 9 years × 2 formats ≈ 43k files, ~57k with the pyramid. Static
  hosting with CORS and range requests; storage is ~$2/month, egress dominates.
- **Viewer.** It must pick tiles by zoom (like a `TileLayer`) and load/unload videos:
  at most ~10–20 playing at once (decoders, 4 MB textures each, ~5 MB/s upload per tile
  at 5 fps). A viewer of 12 tiles downloads ~2 MB per tile-year, ~25 MB per year of
  playback, vs ~5× that reading the COG windows.

## Browsers

Chrome: works. Firefox: transparency works; the globe shook with the first render loop
(fixed, see *Viewer*; to be re-checked). Safari: plays the WebMs but without alpha (the sea
was opaque), hence the `.mov` files (to be re-checked).

## Not done (out of scope)

- Real COG values on pause, a legend, hover values.
- Antimeridian and polar extents.
