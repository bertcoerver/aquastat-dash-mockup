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
takes three requests in turn:

1. The first 16 KiB of the file, for the header and the first IFD (plus ~150 bytes of
   georeferencing, read separately).
2. The tile's entries in TileOffsets and TileByteCounts (8 bytes each).
3. The tile itself, which is decoded in the browser. A tile is LZW-compressed as a whole,
   so the full tile is needed for one pixel.

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
| **COG reads, L1** (now) | 15.1–18.5 MB | 1,583 | 0.9–1.1 s | 1.7–2.1 s | 10.6–12.2 s |
| **COG reads, L2** (tried, dropped) | 70.6 MB | 1,585 | – | – | 11–12 s |
| **API, L1** | 112 KB | 1 | 20.6 s | 20.6 s | 20.6 s |
| **API, L2** | 113 KB | 1 | 13.6–14.7 s | 13.6–14.7 s | 13.6–14.7 s |
| **API, L2, one year only** | 13 KB | 1 | 3.3 s | 3.3 s | – |
| **API, L2, 9 yearly requests at once** | 107 KB | 9 | 3.6 s | 4–22 s | 22.0 s |

For the COG reads, "first values" and "selected year" are when the first tile and the
36th tile of the selected year (2023) arrived. For the API, no value is shown before the
response is complete.

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

Where the COG reads' bytes go (L1, per dekad): ~16.4 KB of header and georeferencing,
16 bytes of tile entries, and a 35–45 KB tile. About 5 MB of the 15–18 MB is header.
The first IFD actually ends at byte 616.

### Conclusion

For the Local panel, the API trades a ~1 s first value and an ~11 s record for nothing
until 14–20 s. Its 113 KB beats 15–18 MB, but showing the selected period quickly is
most of what makes the panel feel fast. We kept the COG reads, at L1.

The API is still useful for areas: it takes any polygon, any mapset (including PCP,
monthly and annual), and L2. It could replace the precomputed L1 basin statistics with
live ones, at about 1.5 s + 40 ms per raster per polygon.

## Combining the two: options

The goal is the API's transfer (≈100 KB for a record) with the current reader's first
values in about 1 s and its progressive fill. Five directions follow, from no
infrastructure to the most.

Figures marked *estimate* are worked out from the measurements above and haven't been
measured themselves.

### 1. Leaner COG reads (no infrastructure)

This keeps the current approach and trims what each dekad costs.

- **Read 1 KB of header, not 16 KiB.** The first IFD ends at byte 616 in L1 and L2
  files alike. This saves ~15 KB per raster, about 5 MB per L1 record (~30%).
- **Reuse the IFD's layout.** Every dekad of a mapset has its IFD at byte 200, its
  TileByteCounts at byte 616 and its TileOffsets at the same place. The georeferencing is
  also the same. After the first raster, the header and georeferencing reads could be
  skipped: a dekad would take two round trips (tile entries, then the tile), not three.
  If a tile fails to decode, the reader would go back to reading the header. That
  removes ~630 requests and one round trip per dekad.

*Estimate:* 10–13 MB, ~950 requests, and the record in perhaps 7–9 s. First values come
somewhat sooner. Transfer stays two orders of magnitude above the API's, because the
tiles themselves are the bulk.

### 2. Hybrid: COG reads for the period, the API for the rest (no infrastructure)

- Read the selected period's dekads from the COGs, as now, so they show in ~1–2 s.
- Ask the API for the whole record in one background request (~113 KB), and fill in
  the rest of the chart when it arrives.

*Estimate:* about 2 MB for a year's period plus 113 KB. The first values come as now;
the rest of the record arrives at 14–20 s instead of ~11 s, all at once. The yearly
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
| Now (L1) | 15–18 MB | ~1 s | ~11 s | none |
| 1. Leaner COG reads | ~10–13 MB* | <1 s* | ~7–9 s* | none |
| 2. Hybrid with FAO's API | ~2 MB* | ~1 s | 14–20 s, at once | none (depends on FAO) |
| 3. Pixel service | ~10–20 KB* | <1 s* | ~1–3 s* | a small service |
| 4. Time-major copy | ~50–150 KB* | <1 s* | <1 s* | storage + pipeline |

\* estimate, not measured.

### Recommendation

- **Do option 1 now.** It's small, self-contained and cuts about a third of the bytes
  and a round trip per dekad.
- **If transfer matters (e.g. users on mobile data), option 3 is the one that meets
  the goal.** It reuses the code we have, keeps the streaming, and brings back the L2
  series at L1's cost to the browser.
- **Option 4 is better at scale, but it's a data product, not a feature.** It's worth
  raising with FAO rather than building alone.
