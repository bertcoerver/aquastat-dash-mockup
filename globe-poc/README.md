# AQUASTAT globe — proof of concept

deck.gl `GlobeView` (interleaved over a MapLibre globe) with two toggleable layers:

1. **Wheat harvested area: two COGs added on the GPU.** FAO/IIASA GAEZ v4
   rainfed (`RES06-HAR.WHE.RAF`) and irrigated (`RES06-HAR.WHE.IRR`) harvested area are
   read straight from FAO's bucket by
   [`MultiCOGLayer`](https://developmentseed.org/deck.gl-raster/) and summed in a
   custom shader module ([src/sum-shader.ts](src/sum-shader.ts)). The *Rainfed* /
   *Irrigated* buttons change the shader weights (`[1,0]`, `[0,1]`), so you can check
   that the sum is the sum of its parts.
2. **SDG 6.4.2 water stress by country.** FAO's `boundaries:m49_geom`, cut into
   `.pbf` vector tiles with tippecanoe, drawn with deck.gl's `MVTLayer` and joined on
   M49 to AQUASTAT's `latest_sdg64` query (live, with a local snapshot fallback).

## Run

```bash
npm install        # also applies patches/ via patch-package
npm run dev        # http://localhost:5173
```

`npm run tiles` re-downloads the boundaries (~160 MB) if missing and rebuilds
`public/tiles/m49/` (needs `tippecanoe`).

## Things this PoC surfaced

- **The GAEZ bucket has no CORS headers.** Browsers can't range-read the COGs from
  `storage.googleapis.com/fao-gismgr-gaez-v4-data` directly, so `vite.config.ts`
  proxies `/gaez/*` to it. A static deployment needs the same proxy or a CORS rule on
  the bucket. (`gismgr.fao.org`, which serves WaPOR, *does* send CORS headers.)
- **deck.gl-raster 0.9 `MultiCOGLayer` rejects band-interleaved TIFFs**, even
  single-band ones. The GAEZ files are written with `INTERLEAVE=BAND`.
  [patches/](patches/) makes single-band band-separate rasters pass through
  unchanged; this is a candidate upstream fix.
- **`m49_geom` contains more than countries**: M49 regions (World, Africa, Europe, …),
  historical units (USSR, Czechoslovakia, …), the EU and China mainland vs China.
  Their overlapping polygons are filtered out in
  [scripts/build-tiles.sh](scripts/build-tiles.sh).
- Float32 rasters are still marked *experimental* in `MultiCOGLayer`; they work here.
- **`MVTLayer` doesn't clip tiles in `GlobeView`** (its `ClipExtension` is only added
  for Web Mercator). With tippecanoe's default buffer, the strip where tiles overlap is
  drawn twice and shows up as seams under translucent fills, so the polygon tiles are
  built with `--buffer=0`. Stroking the polygons would also outline every tile edge
  they were cut at, so borders are a second tile set: the same M49 rings as lines
  ([scripts/rings-to-lines.py](scripts/rings-to-lines.py)), drawn opaque on top. The
  basemap's own (OSM) boundaries are hidden.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | Map, layers, controls |
| `src/sum-shader.ts` | GPU arithmetic + colour ramp |
| `src/sdg64.ts` | SDG 6.4.2 loading and classes |
| `scripts/build-tiles.sh` | Download M49 polygons → tippecanoe → `public/tiles/m49/` (fill) and `public/tiles/m49-borders/` (lines) |
| `scripts/rings-to-lines.py` | Polygon rings → lines for the border tiles |
| `data/m49_geom.geojson` | Source polygons from FAO GeoServer (WFS), unmodified |
| `public/data/sdg64.csv` | Snapshot of the SDG 6.4 query (fallback) |
