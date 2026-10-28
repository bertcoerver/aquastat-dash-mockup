# Point time series: COG reads vs FAO's zonalstats API

The Local panel shows a WaPOR variable's whole dekadal record (2018 to now, 317 dekads)
at the selected point. This note compares how it reads that record now with FAO's
zonal statistics API (the one `wapordl.wapor_ts(method="cloud")` uses). It then sketches
options that would combine the API's data transfer with the current reader's speed
and progressive loading.

Measured 25–27 October 2026 from the same machine and connection. Points: the Nile
delta (31.0° E, 30.8° N), Kenya (37.0° E, 0.0°) and Spain (4.0° W, 39.0° N). Variable:
AETI, dekadal.

## How the Local panel reads a series now

[src/local/cog-pixel.ts](../src/local/cog-pixel.ts) reads one pixel per dekadal COG
straight from FAO's bucket (`storage.googleapis.com/fao-gismgr-wapor-3-data`). Each raster
needs:

1. The header and the first IFD. The first IFD ends at byte 616 in WaPOR's files, so
   the reader takes the first KiB (and reads on if an IFD is ever longer). The
   ~150 bytes of georeferencing are read separately.
2. The tile's entries in TileOffsets and TileByteCounts (8 bytes each).
3. The tile itself, which is decoded in the browser. A tile is LZW-compressed as a whole,
   so the full tile is needed for one pixel.

All the dekads of a mapset share one layout: the same grid, and the same IFD at the
same place. So only the first raster of a mapset is read in that order (four round
trips, with the georeferencing). After it, a raster's tile entries (2) are read straight
away with the first raster's layout, while its own first KiB (1) is read alongside to
check that its layout is the same. The tile (3) follows once both are in: two round
trips per dekad. If a layout differs, that raster is read on its own.

The tile waits for the check because, with a wrong layout, the entries would be any
two numbers. In a test with a differently tiled file, they asked for a 4.3 GB range.

Until 27 October 2026 the reader took the first 16 KiB of every raster, and read
every raster in the four steps.

Twelve loaders run at once. Dekads in the selected period are read first, then
outwards from it. The chart fills in as values arrive.

## FAO's zonalstats API

```
POST https://api.data.apps.fao.org/api/v2/map/zonalstats?streaming=false
{
  "GEE_imageCollection_id": "gs://fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L1-AETI-D",
  "area_of_interest": { "type": "Point", "coordinates": [31.0, 30.8] },
  "dateRange": { "startDate": "2018-01-01", "endDate": "2026-12-31" }
}
```

It returns one item per raster in the range, with `min`, `max`, `mean`, `sum`,
`unmaskedCount`, `system_id` and `system_time_start`/`_end`. The values are raw and
need the mapset's `scale`. In `wapordl` this is
`wapordl/toolbox/ts_queries.py` (`request_ts`), called from `wapor_ts(method="cloud")`.

The geometry type matters:

- **`Point`**: the value of the pixel at the point (`unmaskedCount: 1`). This matched a
  direct read with GDAL (L2 = 14, L1 = 12, raw, for 2025-07-D3 in the Nile delta). This is
  the one to use.
- **A tiny polygon** (what `wapordl` sends): with `all_touched: true` it returns the mean
  of the 2–4 pixels it touches. Without `all_touched`, a polygon smaller than a pixel
  returns no data.

It can be called from the browser: the response has `Access-Control-Allow-Origin: *` and
the preflight for `content-type` succeeds.

## Measurements

| | Data to the browser | Requests | First values | Selected year (36 dekads) | Whole record (317) |
|---|---|---|---|---|---|
| **COG reads, L1, before** (16 KiB header per raster) | 15.1–18.5 MB | 1,585 | 0.6–1.0 s | 1.5–2.1 s | 9.4–12.4 s |
| **COG reads, L1, now** (1 KiB, layout reused) | 10.2–13.6 MB | 1,269 | 0.7 s | 1.5–2.0 s | 7.8–9.4 s |
| **COG reads, L2** (tried, dropped) | 70.6 MB | 1,585 | – | – | 11–12 s |
| **API, L1** | 112 KB | 1 | 20.6 s | 20.6 s | 20.6 s |
| **API, L2** | 113 KB | 1 | 13.6–14.7 s | 13.6–14.7 s | 13.6–14.7 s |
| **API, L2, one year only** | 13 KB | 1 | 3.3 s | 3.3 s | – |
| **API, L2, 9 yearly requests at once** | 107 KB | 9 | 3.6 s | 4–22 s | 22.0 s |

The two L1 COG rows were measured on 27 October with the reader on its own: a bare
page that runs `loadPointSeries` with no map, for the old and the new reader in turn,
twice at each of the three points. Both returned identical values at all three
points. "First values" is the first dekad read; "selected year" is when all 36 dekads
of 2023 were in.

In the full app the times were less steady: its animated layers compete for the main
thread in a headless browser. The bytes and requests were the same. For the API, no
value is shown before the response is complete.

What the numbers show:

- **The API cuts data transfer by about 150× (L1) to 600× (L2)**, because the server reads
  the tiles and sends only the values.
- **It isn't faster.** The cost is about 1.5 s per request plus about 40 ms per raster on
  FAO's side.
- **It doesn't stream.** With `streaming=true`, the first byte still arrives after
  13.5 s, together with the rest.
- **Parallel requests don't help.** Nine yearly requests at once took 22 s in total, with
  single requests taking 4–22 s. The server seems to queue them.
- **Nothing is cached.** Asking for the same record again took the same 13.6 s.
- **L1 was slower than L2** (20.6 s vs 13.6–14.7 s), for reasons not known.

Where the COG reads' bytes go (L1, per dekad): 1 KiB of header, 16 bytes of tile
entries, and a 30–40 KB tile. Before, the header was 16 KiB, about 4.9 MB of a record.
The tiles are now nearly all of it, and they can't be made smaller from the browser.

### Conclusion

For the Local panel, the API trades a ~0.7 s first value and an 8–9 s record for
nothing until 14–20 s. Its 113 KB beats 10–14 MB, but showing the selected period
quickly is most of what makes the panel feel fast. We kept the COG reads, at L1.

The API is still useful for areas: it takes any polygon, any mapset (including PCP,
monthly and annual), and L2. It could replace the precomputed L1 basin statistics with
live ones, at about 1.5 s + 40 ms per raster per polygon.

## Combining the two: options

The goal is the API's transfer (≈100 KB for a record) with the current reader's first
values in under a second and its progressive fill. Five directions follow, from no
infrastructure to the most.

Figures marked *estimate* are worked out from the measurements above and haven't been
measured themselves.

### 1. Leaner COG reads (done, 27 October 2026)

This keeps the current approach and trims what each dekad costs (see *How the Local
panel reads a series now*):

- **1 KiB of header, not 16 KiB.**
- **The first raster's layout reused for the rest of the mapset**, each raster's own
  IFD checked alongside its tile entries.

The plan was to skip the header altogether after the first raster, and fall back when
a tile failed to decode. That would have saved another 317 requests, but a wrong
layout isn't reliably caught by decoding, and it can ask for gigabytes. So each raster's
first KiB is still read, in parallel, as a check.

*Measured:* 4.9 MB less per record (−26 to −32%: 10.2–13.6 MB), 316 fewer requests
(1,269), and the whole record 8.5 s on average instead of 10.7 s (−20%). First values
and the selected year come as before (~0.7 s and 1.5–2 s): the first raster of a
mapset still takes four round trips. Transfer stays two orders of magnitude above the
API's, because the tiles are the bulk.

### 2. Hybrid: COG reads for the period, the API for the rest (no infrastructure)

*Done as a race (27 October 2026).* The API is asked for the whole record alongside
the reads, not for the rest only. What it returns that isn't read yet is filled in, and
the reads stop; if the reads finish first, its request is dropped. A raster the reads
can't get isn't an error if the API has it. Its values matched GDAL's for every dekad
tried (AETI and NPP, Jan–Feb 2023, five points). Measured in the app (AETI, Kenya):

- normal connection: the reads finish in 8.1 s and the API request is dropped;
- every bucket request delayed by 1.5 s (as with the slow DNS of `slow-server.ts`):
  the API answers at 16 s, when 168 of the 1,267 reads are done, and the rest stop.
  WP (two API requests, for NPP and AETI) is complete at 18 s.

Each point costs FAO's server one request per part, even when it's dropped.

- Read the selected period's dekads from the COGs, as now, so they show in ~1–2 s.
- Ask the API for the whole record in one background request (~113 KB), and fill in
  the rest of the chart when it arrives.

*Estimate:* about 1.5 MB for a year's period plus 113 KB. The first values come as now;
the rest of the record arrives at 14–20 s instead of 8–9 s, all at once. The yearly
bars and the multi-year average band need the whole record, so they would come later.

Risks: this depends on FAO's API (availability, unannounced limits, the 1.5–20 s
spread), and its throughput is shared with every other caller.

### 3. A small pixel service next to the bucket (recommended)

Run the current reader's logic on a server close to the data, and stream the values to
the browser.

- **What it does.** `GET /series?mapset=L1-AETI-D&lon=31.0&lat=30.8&from=2023-01-01`
  returns NDJSON: one line per dekad (`{"dk":"2023-07-D1","v":38}`), flushed as each
  arrives. The selected period comes first, then outwards from it, as in
  `point-series.ts`. The browser reads it with `fetch` and a `ReadableStream`, and fills
  in the chart line by line, as it does now.
- **Why it's fast.** The server makes the same range reads, but at data-centre latency
  and with more of them at once (e.g. 64). It keeps IFDs in memory between requests, so
  it doesn't read headers per call. It can also cache recently read tiles: a 300 m tile
  spans 0.75°, so points clicked near each other mostly share tiles.
- **Where.** Cloud Run or a Cloud Function in the bucket's region; Google doesn't
  charge for reads from a bucket to compute in the same region. The bucket's region
  isn't public (the API needs credentials), so we'd have to ask FAO or find it by
  timing. A Cloudflare Worker would also work, with somewhat higher latency to Google
  Cloud Storage.
- **Code.** cog-pixel.ts is plain TypeScript with no DOM: it would run on Node or Deno
  as it is, with an LZW decoder.

*Estimate:* 10–20 KB to the browser (compressed less), first values well under 1 s,
and the whole record in about 1–3 s. The ~1,600 reads would take tens of
milliseconds each and run 64 at a time, not 12. L2 would cost the browser the same as
L1, which would bring the 100 m series back.

Costs: a service to deploy, monitor and keep up, with CORS, rate limiting and abuse
protection. Compute is small (decoding a 256×256 LZW tile takes about a millisecond).
The output is easy to cache: a CDN in front of it, keyed by mapset and pixel (not by
the clicked coordinates).

### 4. A time-major copy of the data (most work, fastest)

The COGs are stored map by map, so a point's record is scattered across 317 files. The
alternative is a copy stored series by series: a Zarr (or similar) array chunked as
(all dekads × 16 × 16 pixels).

- A point's whole record is then one request for one chunk. 317 × 256 values of Int16 is
  162 KB raw; it should compress well, as neighbouring dekads are alike. The browser can
  read it directly with range requests, with no server in between.
- Chunks of (36 dekads × 32 × 32) give one request per year instead. The selected
  period's year comes first, then the rest, which keeps loading progressive.

*Estimate:* 50–150 KB and one to nine requests per record, and well under a second.

Costs:

- **Storage.** An L1 dekadal file is 0.6–1.2 GB, so roughly 200–300 GB per variable
  at L1, before gains from compressing along time, and roughly three times that at L2.
- **A pipeline to append each new dekad.** With year-long chunks, the current year's
  chunks are rewritten every dekad.
- **The copy can fall behind or differ from FAO's published rasters.** This is the
  analysis-ready layout that large climate archives use. It's worth it if many users
  read series, or if FAO would host it.

### 5. Coarser rasters for the context (a UI choice)

Most of the record is context around the selected period. It could be read from the
monthly rasters (105 instead of 280 dekadal reads outside a year's period), with
dekadal reads only for the period itself. Monthly tiles are about twice a dekad's size,
so this saves roughly a quarter of the bytes. It also changes what the chart shows
outside the period. This is mentioned for completeness; it doesn't reach the goal.

### Side by side

| | To the browser | First values | Whole record | Infrastructure |
|---|---|---|---|---|
| Before (L1) | 15–18.5 MB | 0.6–1.0 s | 9.4–12.4 s | none |
| 1. Leaner COG reads (now) | 10–13.6 MB | ~0.7 s | 7.8–9.4 s | none |
| 2. Hybrid with FAO's API | ~1.5 MB* | ~0.7 s | 14–20 s, at once | none (depends on FAO) |
| 3. Pixel service | ~10–20 KB* | <1 s* | ~1–3 s* | a small service |
| 4. Time-major copy | ~50–150 KB* | <1 s* | <1 s* | storage + pipeline |

\* estimate, not measured.

### Recommendation

- **Option 1 is done.** It cut about 30% of the bytes and 20% of the time, with no
  change in behaviour.
- **If transfer matters (e.g. users on mobile data), option 3 is the one that meets
  the goal.** It reuses the code we have, keeps the streaming, and brings back the L2
  series at L1's cost to the browser.
- **Option 4 is better at scale, but it's a data product, not a feature.** It's worth
  raising with FAO rather than building alone.
