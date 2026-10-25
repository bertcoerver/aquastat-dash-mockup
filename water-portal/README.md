# Water Portal

A map of the world (MapLibre globe + deck.gl) under a top bar for choosing the view
(Country / Basin / Local) and a date range. The map has no basemap: it shows FAO's
M49 countries (or, in the Basin view, the SDG 6 major basins), with lakes and rivers
on top. In the Local view, the map shows WaPOR's actual evapotranspiration for any
selected range, to the day, added up from WaPOR's dekadal, monthly and annual rasters, and a play
button moves the range forward as an animation; for a single dekad, a slider in its
legend hides pixels whose
NDVI input is gap-filled (no valid satellite observation for some dekads). In the Basin view, charts after FAO's
Water Portal rank the world's major basins (or the selected major basin's
sub-basins) by precipitation minus evapotranspiration, evapotranspiration and share of
precipitation over the range, with the monthly cycle and, for a basin, precipitation against
evapotranspiration per sub-basin; the legend's title switches between the charts' maps and the
discharge and storage change from FAO's water balance model (precomputed; per major basin, or per
sub-basin of the selected one), and the range ends at the model's latest dekad. The model's own panel (a sub-basin and
everything upstream of it, with its time series and a Sankey diagram) is in the code but switched
off for now (`MODEL_SHOWN` in
`src/basin/water-balance.ts`); until then, picking a sub-basin, by name or on the map, selects
its major basin. In the Country view, a panel
shows FAO AQUASTAT statistics for the selected country (or the World) in four topics (SDG 6.4,
water resources, water use, irrigation): number tiles and charts, each with a map that goes with
it. Hovering a tile or chart previews its map, clicking pins it (Escape unpins), and hovering a
row in a regional chart picks out that region's countries. Clicking a country or basin drops a marker; clicking the ocean removes it.
A debug window (drag it by its title, resize it from the corner) shows what's under
the last click and the pointer, and the selected time range.

## Getting started

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install     # once, and after dependencies change
npm run dev     # start a local server at http://localhost:5173 (reloads on save)
```

Other commands:

| Command | What it does |
|---|---|
| `npm run build` | Type-check, then build a static site into `dist/` |
| `npm run preview` | Serve the built `dist/` locally, to check a build |
| `npm run typecheck` | Only check the TypeScript for errors |
| `npm run lists` | Rebuild the country, basin and sub-basin lists for the top bar (`public/data/`) |
| `npm run country-info` | Rebuild each country's region and map centre for the Country view (`public/data/country-info.json`; needs the polygons `npm run tiles` downloads) |
| `npm run tiles` | Rebuild the country and border tiles (needs `tippecanoe`; downloads ~220 MB the first time) |

## Project layout

```
water-portal/
├── index.html              Page markup: the map container and the top bar
├── package.json            Dependencies and the npm commands above
├── tsconfig.json           TypeScript settings
├── vite.config.ts          Dev server / build settings (Vite)
├── public/                 Copied as-is into the site
│   ├── data/               Country, major basin and sub-basin lists (name, ID, bounding
│   │   │                   box; for sub-basins also their major basin, where they drain and area)
│   │   └── model/          Precomputed Q and ΔS (not in git; see Notes: the water balance model)
│   └── tiles/              Vector tiles ({z}/{x}/{y}.pbf)
│       ├── m49/            Country areas
│       └── borders/        Country borders and coastlines (UN boundary lines)
├── scripts/                Data preparation, not part of the website
│   ├── build-tiles.sh      Download M49 polygons and UN boundary lines → tippecanoe → public/tiles/
│   ├── build-lists.mjs     Country / basin / sub-basin lists for the top bar → public/data/
│   └── build-country-info.mjs  Each country's region (UNSD M49) and centre → public/data/
├── data/                   Source data: downloaded boundaries (not committed) and
│                           fao_sb_ids.json (sub-basin routes and areas, from fao-wapor-discharge)
└── src/                    The application code
    ├── main.ts             Entry point: starts the map and the top bar, connects them
    ├── selection.ts        The current selection (point, country, basin)
    ├── map/
    │   ├── map.ts          MapLibre globe + deck.gl overlay; layer order, view, clicks
    │   ├── theme.ts        Map colours (light and dark)
    │   ├── places.ts       What's at a point: country, major basin, sub-basin
    │   ├── sub-basin-network.ts  Sub-basins upstream of a sub-basin
    │   ├── wapor-legend.ts Legend for the WaPOR raster, with the NDVI quality slider
    │   ├── wapor-player.ts Playback (Local view): frames, loading ahead, timing
    │   └── layers/         One file per kind of layer
    │       ├── tile-urls.ts  Where each tile set lives (local or FAO's bucket)
    │       ├── countries.ts  M49 country areas (land; what clicks hit), the selected one's outline,
    │       │                 circles on countries (Country view)
    │       ├── borders.ts    Country borders (UN lines; disputed ones dashed)
    │       ├── basins.ts     SDG 6 major basins and sub-basins: areas + outlines (sub-basins only shade the hovered one and those upstream)
    │       ├── water.ts      Lakes (HydroLAKES) and rivers
    │       ├── wapor.ts      WaPOR v3 ETIa for a range (Local view): one COG or a sum
    │       ├── wapor-l2.ts   Where WaPOR has level 2 (100 m): a 1° footprint
    │       ├── wapor-plan.ts Which WaPOR rasters to add up for a range, cheapest first
    │       ├── wapor-shader.ts  GPU colour map for the WaPOR raster
    │       └── marker.ts     The click marker
    ├── basin/              Basin view: the water balance of the selected sub-basin
    │   ├── calc_runoff.js  The model (copy of fao-wapor-discharge's js/calc_runoff.js)
    │   ├── model.ts        Loads the precomputed Q and ΔS; for the panel, fetches a network's PCP/AETI (BigQuery) and runs the model
    │   ├── variables.ts    PCP / AETI / Q / ΔS: labels, units, colour scales
    │   ├── timeseries.ts   Time series charts (drag to choose the period)
    │   ├── sankey.ts       Sankey diagram of the network's water balance
    │   ├── stats-data.ts   PCP and AETI per sub-basin over the range, and per month (BigQuery)
    │   ├── stats-cards.ts  The statistics charts (world, or a major basin) and each one's map
    │   ├── basin-stats.ts  Statistics in the panel: preview / pin, map colours, legend, tooltip
    │   └── water-balance.ts  Connects selection, date range, model, map and panel
    ├── country/            Country view: AQUASTAT statistics and the maps that go with them
    │   ├── data.ts         Loads a topic's AQUASTAT variables in BigQuery; values per country and region
    │   ├── charts.ts       Bar, 100 % stacked bar, line and scatter charts (SVG; also the Basin view's)
    │   ├── cards.ts        Per topic: the number tiles and charts, and each one's map
    │   └── country-panel.ts  The panel, preview / pin, the map colours, legend and tooltips
    ├── panels/
    │   ├── layers-menu.ts  The "Layers" button: switch rivers and lakes on/off
    │   ├── map-drivers.ts  Chart cards that drive the map: hover previews, click pins (both panels)
    │   ├── debug-panel.ts  Draggable window: click, time and hover state as a JSON tree
    │   └── loading-indicator.ts  Spinner in the top bar while any data request is running
    ├── toolbar/
    │   ├── dekads.ts       Dates as dekad numbers (3 per month, 36 per year), and as day numbers
    │   ├── place-picker.ts Country / basin search or coordinates, per view
    │   ├── combobox.ts     Text field with a dropdown that narrows as you type
    │   ├── tree-combobox.ts  The same with a tree (search keeps whole branches)
    │   ├── basin-tree.ts   Major basins → sub-basins, nested the way the rivers run
    │   ├── range-rules.ts  Which ranges each view allows, and how they're adjusted
    │   ├── range-slider.ts The two-handle date range slider
    │   ├── date-picker.ts  Calendar for picking either end exactly (click a date above the slider)
    │   └── toolbar.ts      View tabs, the current range, highlights
    └── styles/
        ├── tokens.css      Colours and fonts (light and dark)
        ├── base.css        Page-wide defaults
        ├── toolbar.css     Top bar
        ├── map.css         Map container
        ├── panels.css      Layers menu and debug window
        ├── basin.css       Water balance panel, its legend and tooltips
        ├── country.css     Country panel, chart cards, chart colours, its legend
        └── legend.css      WaPOR legend
```

## Notes

- **Country statistics** come from FAO's AQUASTAT dissemination table
  (`fao-maps.fao_aquastat_dissemination.mvw_aquastat`) through the same BigQuery proxy as the
  Basin view's model, one query per topic (~300 KB, a few seconds), from 2010. Years after
  AQUASTAT's latest (2023 at present) can't be selected; the limit is read from the loaded data,
  so a new AQUASTAT year becomes selectable without a code change. A range of several years
  shows each value's yearly mean (regions: the mean of their yearly aggregates); line charts
  shade the range. Regional rows
  use AQUASTAT's own aggregates; where it has none (wastewater reuse, irrigation by source) they
  are summed or area-weighted from the region's countries. Regions follow FAO's Water Portal (SDG
  regions with some split into sub-regions), from UNSD's M49 table.
- **Basin statistics** read the same WaPOR v3 L1 dekadal zonal statistics as the model
  (`fao-maps-review.zonal_stats_openEO.L1-PCP-D_…` and `L1-AETI-D_…`, 2018 to Dec 2025): one
  query per range for all ~7,600 sub-basins (~250 KB, ~3 s, after the range rests for 0.4 s), and
  one for the monthly cycle. Totals are each sub-basin's mean daily rate × the days covered; major
  basins are area-weighted over their sub-basins. Without a pin, the map shows the first chart's
  map, except with a sub-basin selected: then it shows the model's values as before.
- **Country circles** (proportional symbols) are drawn without a depth test like every layer,
  so only those on the near side of the globe are kept.
- **Date rules** are documented at the top of
  [src/toolbar/range-rules.ts](src/toolbar/range-rules.ts). The slider works in days:
  any day in Local, dekad boundaries in Basin, whole calendar years (one or more) in Country. The track runs
  from 1 Jan 2016 to the current dekad; the part a view can't select is hatched (before
  1 Jan 2018 in Basin and Local, after AQUASTAT's latest year in Country). Basin and
  Country get the range as dekads; entering Basin from a day range takes the dekads it
  lies in. The track has about 4–5 days per pixel, so to pick a day exactly click the
  date above the slider (a calendar, following the same rules: a day in Local, a dekad in
  Basin, a year in Country) or use the arrow keys on a handle (a day in Local). When the system changes a
  date the user didn't touch (for example on switching view), that end of the slider
  briefly lights up.
- **Borders are lines, not polygon outlines.** Tiles cut polygons at their edges, and
  deck.gl doesn't clip tiles on a globe, so outlining polygons would also draw every
  tile edge.
- **Basin outlines** come from polygon tiles cut with a buffer, so they are drawn as
  lines with the parts outside each tile dropped (see `tileOutlines` in
  [src/map/layers/basins.ts](src/map/layers/basins.ts)); a plain polygon stroke would
  also outline every tile edge.
- **Lakes, rivers and basins** are loaded straight from FAO's tile bucket
  (`storage.googleapis.com/fao-cog-data/basins/…`, zoom 0–8). Those tile sets have no
  file for empty tiles, so 404s there are expected and ignored.
- **WaPOR rasters** (`L1-AETI-D`, `-M`, `-A`: global, 300 m) are read straight from
  FAO's bucket (`storage.googleapis.com/fao-gismgr-wapor-3-data/…`, which sends CORS
  headers) with deck.gl-raster's `MultiCOGLayer`, coloured with WaPOR's own styles. The
  newest periods are published with a delay; the legend then says so. The files are
  written with `INTERLEAVE=BAND`, which `MultiCOGLayer` 0.9 rejects even for one band;
  [patches/](patches/) fixes that and is applied by `npm install` (patch-package).
- **WaPOR level 2** (`L2-AETI-D`, `-M`, `-A`, `L2-T-`, `-E-`, `-I-`, `-NPP-`,
  `L2-QUAL-NDVI-D`: 100 m) covers Africa, the Near East, Pakistan, Afghanistan, Sri
  Lanka and Colombia, for the same periods as L1 and published in step with it. Each
  file spans 60° N – 60° S on a grid three times as fine as L1's, lined up with it, with
  nodata outside those countries (tiles of ~2 KB, not sparse ones). The map shows it
  only where L1 runs out, from about zoom 9 (`L2_FROM` in
  [wapor.ts](src/map/layers/wapor.ts)), and only when the view reaches its countries
  ([wapor-l2.ts](src/map/layers/wapor-l2.ts): a 1° footprint). So a view loads one
  level or the other, never both, and an L2 view costs about what an L1 view at
  zoom 8 does. Across a border, pixels L2 has no data for are filled from L1, sampled
  onto L2's grid with the Local panel's lean COG reader (one tile of it, not every
  overview's tags). L1 and L2 differ (L2 averaged 3×3 against L1: a median
  difference of 0.1–0.4 mm/day in July 2025, and a bias in places), so colours can
  shift at the switch. The Local panel's time series read L2 at a point in its
  countries where L2 has a value; the legend and panel say which pixel size. The
  basin statistics stay L1 (precomputed zonal statistics).
- **Any range in the Local view** is a sum of published rasters with signs, e.g.
  Feb–Nov 2025 = `A[2025] − M[2025-01] − M[2025-12]`
  ([src/map/layers/wapor-plan.ts](src/map/layers/wapor-plan.ts)). Of the possible
  sums it picks the cheapest to load, weighing each raster by its size (in 2024 a
  month was 2.0× a dekad, a year 5.8×: Int32 and larger values) plus a fixed cost per
  raster (existence check, header, a request per tile); so 7 months load as 7 M, 8 as
  A − 4 M. Rasters not published yet are left out and the sum planned again. All
  rasters share one grid, so each tile is summed on the CPU from the same tile of
  each, as the total in mm, divided by the days in the range: the map always shows
  the average in mm/day. At full resolution this is exact (a month is the sum of
  days × its dekads, a year the sum of its months, to WaPOR's rounding); the
  overviews are averaged separately, so zoomed out it's close but not exact. A range that starts or
  ends within a dekad takes those days' share of the dekad's raster (mm/day × days,
  e.g. 5 Jan – 31 Dec 2025 = `A[2025] − 4·D[2025-01-D1]`): that assumes ET is even
  within the dekad, as WaPOR v3 has no daily ETIa, and the legend and debug window say
  so. The debug window's `wapor` entry shows the equation, the number of rasters and the cost.
- **The colour range** stretches WaPOR's dekadal colour map over the values on screen:
  the legend's button cycles between 0–100%, 1–99% and 5–95% of them. `waporViewRange`
  in [wapor.ts](src/map/layers/wapor.ts) sums the cached tiles in view again, keeps
  the pixels inside the visible lon/lat box (and not hidden by the quality filter), and
  takes the percentiles from a 4096-bin histogram. It runs when the view stops moving,
  a tile loads, or the period, filter or button changes; during playback the range is
  kept, so frames can be compared.
- **The NDVI quality filter** (single dekads) loads `L1-QUAL-NDVI-D` as a second
  source of the same layer, on the same grid: dekads since the last valid observation (0–255,
  255 nodata). The shader drops pixels above the slider's value, so moving it fetches
  nothing. The quality layer is published some dekads after AETI (in Oct 2026, up to
  2026-08-D1); without it AETI shows unfiltered and the slider is disabled. Its
  overviews are averages, so when zoomed out the filter acts on averaged gaps.
- **Which WaPOR tiles load** is decided in [src/map/layers/wapor.ts](src/map/layers/wapor.ts),
  not by deck.gl-raster: one overview for the whole view (the coarsest whose pixels are
  at most 2 CSS pixels on screen; full resolution from about zoom 8), and only tiles on
  the visible part of the globe. deck.gl-raster's own choice works per tile from the Web
  Mercator scale, which on a globe asks for ever finer tiles towards the poles and keeps
  the far side: over 16,000 tiles at zoom 9. The debug window's `wapor` entry shows the
  zoom, overview, pixel size and tile count.
- **Playback** (Local view, [src/map/wapor-player.ts](src/map/wapor-player.ts)) moves
  the range forward by its own unit (a year for whole years, a month for whole months,
  a dekad for whole dekads, else 10 days), 0.7 s a frame, and stops at the last published one (play again there
  starts from 2018). Frames are loaded ahead into a cache of decoded tiles in
  [wapor.ts](src/map/layers/wapor.ts) (384 MB, shared with the map, so sums that share
  a raster share its tiles): 12 frames ahead, 3 at a time, only the tiles in view. It
  starts once 3 are in, and waits again if it catches up (the button's ring turns
  meanwhile); the slider shows how far ahead it has loaded. The map keeps the shown
  frame until the next has every tile in view, then switches: two layers, the next one
  hidden. Moving the map loads the frames ahead again for the new view; any change of
  range or view stops playback. Up to 16 requests to the bucket at once (it speaks
  HTTP/2), instead of deck.gl-raster's default of 6.
- **The water balance model's maps** (Q and ΔS in the Basin view's legend) read files
  precomputed by [fao-wapor-discharge](../../fao-wapor-discharge)'s
  `python -m fao_wapor_discharge.portal --sub-basins public/data/sub-basins.json --out-dir …`,
  which downloads all PCP and AETI, runs the model for every outlet network (as its
  pipeline does) and writes `latest.json` (the dekads covered), `majors.json` (per major
  basin: Q at its outlets, ΔS summed) and `major/<id>.json` (per sub-basin). Meant to run
  after each new dekad (a scheduled job, not set up yet); a full run, not an append,
  since a new calendar year moves the model's warmup and changes earlier dekads. The
  files are looked for in `public/data/model/` (not in git: ~80 MB), or at
  `VITE_MODEL_FILES` (a URL ending in `/`, e.g. a bucket) when set at build time.
  `latest.json` is fetched afresh each time; the others carry its `updated` time in their
  URL, so browsers don't keep old copies. The Basin view's range can't go past the last
  dekad in `latest.json` (hatched on the slider), so a failed or late update shows as a
  shorter range rather than gaps; without the files the range isn't limited and Q and ΔS
  say they couldn't be loaded.
- **The water balance panel** (switched off for now) runs the model itself:
  [fao-wapor-discharge](../../fao-wapor-discharge)'s `js/calc_runoff.js`, a JavaScript port
  of its Python `calc_runoff` that gives identical numbers (checked bit for bit by its
  `examples/verify_js_runoff.py`), copied with its `.d.ts` to
  [src/basin/calc_runoff.js](src/basin/calc_runoff.js) (copy them again when they change).
  [src/basin/model.ts](src/basin/model.ts) fetches the network's dekadal PCP and AETI from
  FAO's read-only BigQuery proxy (`data.apps.fao.org/api/v2/bigquery`, which sends CORS
  headers), one row per sub-basin with arrays (the proxy returns at most 50,000 rows), and
  runs the model in the browser. That takes about 3 s for a small network and 8 s for the
  biggest (Lower Mississippi, 766 sub-basins, ~11 MB; the model itself ~0.2 s); results are
  kept for the session. The network is the selected sub-basin and everything upstream of it, as in FAO's
  [WaPOR Discharge](https://storage.googleapis.com/fao-wapor-accounter/wapor-discharge/main.html)
  app, which this view replicates.
- **Light / dark** follows the operating system setting, both for the top bar and the
  map.
- The URL keeps the map position (`#zoom/lat/lon`), so a view can be shared as a link.

Data: FAO M49 boundaries (`boundaries:m49_geom` on FAO's GeoServer); FAO SDG 6 major
basins and sub-basins; HydroLAKES v1.0; rivers from HydroSHEDS; FAO WaPOR v3. Boundaries do not
imply official endorsement.
