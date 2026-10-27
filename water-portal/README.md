# Water Portal

A map of the world (MapLibre globe + deck.gl) under a top bar for choosing the view
(Country / Basin / Local) and a date range. The map has no basemap: it shows FAO's
M49 countries (or, in the Basin view, the SDG 6 major basins), with lakes and rivers
on top. In the Local view, the map shows a WaPOR variable (actual or reference evapotranspiration and its parts, precipitation, NPP, …) for any
selected range, to the day, added up from WaPOR's dekadal, monthly and annual rasters, and a play
button moves the range forward as an animation; for a single dekad, a slider in its
legend hides pixels whose
NDVI input is gap-filled (no valid satellite observation for some dekads). In the Basin view, a panel
built like the Country view's has three topics (rain and evaporation, water left, discharge), each
with number tiles and charts about the selected major basin or the World: per group of major
basins (by climate for rain and evaporation, by where the water goes for discharge and storage)
against the average of the same days in the other years, the highest and
lowest major basins, the same days every year (click a year to select it), and the selected
basin's sub-basins. Precipitation and evapotranspiration come from WaPOR; discharge and storage
change from FAO's water balance model (precomputed; per major basin, or per sub-basin of the
selected one). Each tile and chart has its map, and the range ends at the model's latest dekad. The model's own panel (a sub-basin and
everything upstream of it, with its time series and a Sankey diagram) is in the code but switched
off for now (`MODEL_SHOWN` in
`src/basin/water-balance.ts`); until then, picking a sub-basin, by name or on the map, selects
its major basin. In the Country view, a panel
shows FAO AQUASTAT statistics for the selected country (or the World) in four topics (SDG 6.4,
water resources, water use, irrigation): number tiles and charts, each with a map that goes with
it. Hovering a tile or chart previews its map, clicking pins it (Escape unpins), and hovering a
row in a regional chart picks out that region's countries. Clicking a country or basin drops a marker; clicking the ocean removes it.

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
| `npm run deploy` | Build the site and publish it to GitHub Pages (the `gh-pages` branch), from this machine since the tiles and model output aren't committed. `scripts/pre-push` does this on each push to `main` that changes `water-portal/`; install it once with `ln -s ../../water-portal/scripts/pre-push .git/hooks/pre-push` from the repo root |
| `npm run typecheck` | Only check the TypeScript for errors |
| `npm run lists` | Rebuild the country, basin and sub-basin lists for the top bar (`public/data/`) |
| `npm run country-info` | Rebuild each country's region and map centre for the Country view (`public/data/country-info.json`; needs the polygons `npm run tiles` downloads) |
| `npm run groups` | Rebuild the major basins' groups for the Basin view: where their water goes and their climate (`public/data/basin-groups.json`; needs GDAL, downloads ~400 MB the first time, takes ~6 min) |
| `npm run rivers` | Rebuild the river network per major basin and the sub-basins' middles for the Basin view's water balance scheme (`public/data/rivers/`, `public/data/sub-basin-middles.json`; from `../river-flow-poc`'s `rivers.bin` and `nodes.json`) |
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
│   │   ├── rivers/         The river network per major basin (<id>.bin), for the water balance scheme
│   │   ├── sub-basin-middles.json  A point inside each sub-basin, for its circle or bar
│   │   └── model/          Precomputed Q and ΔS (not in git; see Notes: the water balance model)
│   └── tiles/              Vector tiles ({z}/{x}/{y}.pbf)
│       ├── m49/            Country areas
│       └── borders/        Country borders and coastlines (UN boundary lines)
├── scripts/                Data preparation, not part of the website
│   ├── build-tiles.sh      Download M49 polygons and UN boundary lines → tippecanoe → public/tiles/
│   ├── build-lists.mjs     Country / basin / sub-basin lists for the top bar → public/data/
│   ├── build-country-info.mjs  Each country's region (UNSD M49) and centre → public/data/
│   └── build-basin-groups.mjs  Each major basin's ocean (or inland) and aridity class → public/data/
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
    │   ├── tween.ts        Eases the circles, bars and scheme lines from one map to the next
    │   └── layers/         One file per kind of layer
    │       ├── tile-urls.ts  Where each tile set lives (local or FAO's bucket)
    │       ├── countries.ts  M49 country areas (land; what clicks hit), the selected one's outline,
    │       │                 circles on countries (Country view; and basins, Basin view)
    │       ├── bars.ts       3D bars on the areas, a fixed height in pixels at any zoom
    │       ├── borders.ts    Country borders (UN lines; disputed ones dashed)
    │       ├── basins.ts     SDG 6 major basins and sub-basins: areas + outlines (sub-basins only shade the hovered one and those upstream)
    │       ├── water.ts      Lakes (HydroLAKES) and rivers
    │       ├── wapor.ts      WaPOR v3 ETIa for a range (Local view): one COG or a sum
    │       ├── wapor-l2.ts   Where WaPOR has level 2 (100 m): a 1° footprint
    │       ├── wapor-plan.ts Which WaPOR rasters to add up for a range, cheapest first
    │       ├── wapor-shader.ts  GPU colour map for the WaPOR raster
    │       ├── basin-scheme.ts  The water balance scheme: discharge lines, mouth arrows, particles
    │       ├── river-particles.ts  Particles streaming down the rivers (river-flow-poc's wind map)
    │       ├── rain.ts       Rain falling as densely as a grid says (river-flow-poc's rain page)
    │       ├── vapour.ts     Vapour rising as densely as a grid says, transpiration and evaporation
    │       ├── haze.ts       A heat shimmer over the map, as strong as a grid says
    │       ├── basin-effects.ts  The Basin view's rain, vapour and shimmer, and the rasters on the ground
    │       └── marker.ts     The click marker
    ├── basin/              Basin view: the water balance of the selected sub-basin
    │   ├── model.ts        Loads the precomputed files (PCP, AETI, Q, ΔS; fao_wapor_discharge.portal), and a network's series for the panel
    │   ├── variables.ts    PCP / AETI / Q / ΔS: labels, units, colour scales
    │   ├── timeseries.ts   Time series charts (drag to choose the period)
    │   ├── sankey.ts       Sankey diagram of the network's water balance
    │   ├── stats-data.ts   PCP and AETI per sub-basin over the range, the same days in other years, and per month (summed from subbasins.bin)
    │   ├── stats-cards.ts  The statistics topics: tiles, charts and each one's map
    │   ├── groups.ts       The major basins' groups: by where the water goes, by climate
    │   ├── rivers.ts       Loads a major basin's river network and the sub-basins' middles
    │   ├── scheme.ts       The water balance scheme: lines along the rivers, a point on each sub-basin's river, simplification
    │   ├── scheme-map.ts   The scheme on the map: the legend's switch, key and simplify slider
    │   ├── basin-grids.ts  WaPOR's PCP, AETI and T over a range on a grid over a major basin, masked to it
    │   ├── effects-map.ts  Precipitation as rain, evapotranspiration as vapour: the legend's switch, key and sliders
    │   ├── basin-stats.ts  Statistics in the panel: topics, preview / pin, map colours, legend, tooltip
    │   └── water-balance.ts  Connects selection, date range, model, map and panel
    ├── country/            Country view: AQUASTAT statistics and the maps that go with them
    │   ├── data.ts         Loads a topic's AQUASTAT variables in BigQuery; values per country and region
    │   ├── charts.ts       Bar, 100 % stacked bar, line and scatter charts (SVG; also the Basin view's)
    │   ├── cards.ts        Per topic: the number tiles and charts, and each one's map
    │   └── country-panel.ts  The panel, preview / pin, the map colours, legend and tooltips
    ├── panels/
    │   ├── layers-menu.ts  The "Layers" button: switch rivers and lakes on/off
    │   ├── map-drivers.ts  Chart cards that drive the map: hover previews, click pins (both panels)
    │   ├── legend.ts       The Basin and Country legends: a checklist of maps, a section per layer
    │   ├── shape-switch.ts A map's switch: the areas' colours, circles or 3D bars
    │   ├── shape-style.ts  How circles and bars look: a menu on their key (colours, full size)
    │   ├── foldable.ts     Graph panes fold to their heading (and pinned chart) off hover
    │   └── load-bar.ts     Load bar under the graph pane's heading while anything loads
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
        ├── panels.css      Layers menu and resizable panes
        ├── basin.css       Water balance panel, its legend and tooltips
        ├── country.css     Country panel, chart cards, chart colours, its legend
        └── legend.css      Map legends: the WaPOR legend, layers, the checklist
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
  (`fao-maps-review.zonal_stats_openEO.L1-PCP-D_…` and `L1-AETI-D_…`, 2018 to Dec 2025), every
  sub-basin's dekadal series at once from the model's files (`subbasins.bin`, ~9 MB: see below),
  loaded when the Basin view first opens. The period, the same days in
  every other year of the record and the monthly cycle are summed from it in the browser (a few ms),
  so changing the range shows at once. Totals are each sub-basin's mean daily rate × the days covered; major basins, groups and
  the World are area-weighted (or, over the basin, summed) over their sub-basins, and their
  discharge and storage change summed over their major basins. A range of more than a year is
  compared with the other spans of its length that fit in the record, so with fewer than 3 of
  them (a range of 3 years or more) there is no comparison. The groups (`npm run groups`):
  **where the water goes** is the ocean most of a basin's area drains into (each sub-basin
  followed downstream to its outlet; the outlet's coast votes for the nearest of Marine Regions'
  Global Oceans and Seas, Baltic counted with the Atlantic, Black Sea with the Mediterranean), or
  inland (an inland sink, or an outlet "to the sea" more than 0.5° from any ocean: the Caspian);
  **climate** is the UNEP aridity class of WaPOR L1 PCP-A over RET-A, 2018–2025, area-weighted.
  WaPOR's precipitation stops at 60°N, so 17 northern basins have no climate group. Without a pin, the map shows the topic's first tile (or what the legend picked),
  except with a sub-basin selected while the model's panel is shown.
- **Map layers** (Basin and Country views, [src/panels/legend.ts](src/panels/legend.ts)): the
  legend's title is a checklist of the maps, and several can be on the map at once, one per way
  of drawing them (the checklist says which): a fill, circles, 3D bars, and the scheme's discharge
  lines (Basin). Checking a map replaces the one drawn the
  same way; a previewed or pinned chart's map takes its place for the while.
- **Colours, circles or 3D bars** ([src/panels/shape-switch.ts](src/panels/shape-switch.ts)): a
  switch in a map's legend section draws it as the areas' colours, a circle on each (area: the
  value) or a bar on each (height: the value), coloured as the fill would be; amounts (Country)
  are circles or bars. Switched into a shape another map is drawn in, the map takes it and the
  other moves to the shape this one left (or another free one it can take); only with none
  free is it replaced. The basin's discharge, precipitation and evapotranspiration maps have
  the same three in their own switch, beside their scheme or effect. The change eases (map/tween.ts): the new circles grow and bars rise
  while the old ones shrink away and the colours fade, and the switch's highlight, which goes
  with its map from section to section, slides. Bars tilt the map while shown and stay the same
  height in pixels as you zoom. In the Basin view they stand at the sub-basins' middles, and a
  major basin's at the middle of its sub-basin nearest the middle of them all; storage change's
  on each sub-basin's river near its middle (the scheme's, below: they wait for the river
  network). Circles on sub-basins are smaller (12 px at the reference value) than on countries
  and major basins (26 px), as there are many, close together. The maps that have their own
  switch (discharge, precipitation and evapotranspiration of a basin's sub-basins) don't get this one.
- **How circles and bars look** ([src/panels/shape-style.ts](src/panels/shape-style.ts)): a key
  of their sizes, three of them labelled with their values, under their colours' key, is a menu,
  as the colour ramp is (each map keeps its own). Colours: the map's own (its ramp or classes,
  an amount's one colour) or, for a map of values either side of zero (a diverging ramp), green
  above zero and red below, the key of sizes then showing both in place of the ramp. Full size:
  the 98th percentile, so a few outliers don't flatten the rest (those above grow to at most
  1.6 ×), or the largest value. Values start at the 98th percentile and an amount's circles
  at the largest; storage change (Basin) starts as circles, green rising and red falling. Each layer has its
  section in the legend (its key: a colour ramp, classes or sizes), and the tooltip lists them all.
- **The lock** (a padlock in each legend's title) keeps the ranges as they are, so other periods
  and places compare: the colour ramps' domains, the circles', bars' and lines' sizes, and the
  WaPOR colour map. Each map keeps the range it had when first shown since the lock went on, per
  unit (`LayerLegend.hold`); the stretch menu is off meanwhile. Picking another WaPOR variable unlocks.
- **Circles** (proportional symbols) are drawn without a depth test like every layer,
  so only those on the near side of the globe are kept. The bars are depth-tested, so near
  ones hide those behind.
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
- **Changes on the map are eased in** (a 400 ms ease-out; while a range plays, evenly
  over the whole step, so the map flows from one step to the next). The areas' fills
  fade: each area layer is drawn twice, the new fills coming in over the last by their
  opacity (not deck.gl's `transitions`: for polygons those read the colours back from
  the GPU at every change, which stalled each step). The circles,
  bars and scheme lines are sorted by size, so a step reorders them and
  deck.gl would slide them between places; [src/map/tween.ts](src/map/tween.ts) eases
  those instead, paired by key (their area); ones that come grow from nothing, and ones
  that go shrink away (so a map switched to circles or bars grows in).
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
  shift at the switch. The Local panel's time series stay L1 (a series from L2's
  512-pixel tiles is 70 MB against 20 MB, for the same time; FAO's zonalstats API
  would be 113 KB but 14–20 s with nothing shown until the end), as do the basin
  statistics (precomputed zonal statistics).
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
  within the dekad, as WaPOR v3 has no daily ETIa, and the legend says so.
- **The colour range** stretches WaPOR's dekadal colour map over the values on screen:
  the legend's button cycles between 0–100%, 1–99% and 5–95% of them. `waporViewRange`
  in [wapor.ts](src/map/layers/wapor.ts) sums the cached tiles in view again, keeps
  the pixels inside the visible lon/lat box (and not hidden by the quality filter), and
  takes the percentiles from a 4096-bin histogram. It runs when the view stops moving,
  a tile loads, or the period, filter or button changes; during playback the range is
  kept, so frames can be compared. For a variable WaPOR publishes (not PCP − AETI or
  WP), the menu also has WaPOR's default colour map: the catalogue's default style
  (`styles`, e.g. AETI-D-INT16, PCP-M, NPP), stops and colours, for the rasters in the
  unit shown (a dekad's per day, a month's per month, a year's per year; in total, those
  nearest the period in length; else the nearest WaPOR has, scaled). `waporStyleRamp`
  works it out; the shader takes up to 12 stops (PCP-M has 11).
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
  the far side: over 16,000 tiles at zoom 9.
- **Playback** (Local view, [src/map/wapor-player.ts](src/map/wapor-player.ts)) moves
  the range forward a day at a time, 0.2 s a frame, and stops at the last published one
  (play again there starts from 2018). Frames are loaded ahead into a cache of decoded
  tiles in [wapor.ts](src/map/layers/wapor.ts) (384 MB, shared with the map, so sums
  that share a raster share its tiles): 30 frames ahead, 3 at a time, only the tiles in
  view. Frames within a dekad mostly weigh the same rasters, so loading is mostly at
  each new dekad. It starts once 3 are in; with fewer than 10 in ahead each frame shows
  longer (up to 3×), so it slows down rather than stopping, and if it catches up it
  waits (the button's ring turns meanwhile); the slider shows how far ahead it has
  loaded. While it plays, the point's series in the panel reads 2 dekads at a time
  instead of 12, so the frames get the bucket first. The map keeps the shown frame until
  the next has every tile in view, then fades it in over the frame's time: three layers,
  the one before (going), the shown one and the next one (hidden). Moving the map loads
  the frames ahead again for the new view; any change of range or view stops playback.
  Up to 16 requests to the bucket at once (it speaks HTTP/2), instead of
  deck.gl-raster's default of 6.
- **Playback in Country and Basin** ([src/toolbar/range-player.ts](src/toolbar/range-player.ts))
  moves the range on a year (Country, 0.8 s a frame) or a dekad (Basin, 0.3 s) at a time,
  keeping its length, and stops at the view's last one; played from there, it starts over
  from the first. Nothing is loaded ahead: each frame just sets the range.
- **The water balance scheme** ([src/basin/scheme.ts](src/basin/scheme.ts), from
  river-flow-poc's `scheme.html`): with a major basin selected, the discharge map of its
  sub-basins has a switch in the legend: **Network** (lines along the rivers, as wide as the
  discharge they carry), **Particles** (see below), or the other maps' **Colours**, **Circles**
  or **3D bars**. Each sub-basin has a point on its river near its middle (where storage
  change's circles and bars stand). In a sub-basin, the line runs from each upstream sub-basin's
  outlet down the network to where the river leaves it; a piece carries the outflow of the
  upstream sub-basins passing through it and, below that point, the sub-basin's own gain (where it
  loses water, everything is scaled down to its outflow), so widths are linear and add up where
  rivers join, and each outlet's width is that sub-basin's outflow. Outlets are traced from
  upstream down rather than taken as the end of a sub-basin's biggest arc: the network has
  parallel duplicate arcs, and the river traced along one twin never reaches the other's end.
  Where the network doesn't connect, the line is straight; water from other major basins counts
  as a sub-basin's own gain. The widest line is the basin's largest outflow in the period; the
  legend shows a key of widths instead of the ramp. The
  **Simplify** slider (discharge only) simplifies the lines between junctions (Douglas–Peucker)
  to 0–6 % of the basin's size (1.5 % at first): at 0 they are the network as stored, itself
  simplified to ~500 m from FAO's `rivers_world_47950`. The river network
  (`public/data/rivers/<id>.bin`, 8.3 MB in all, up to ~490 kB a basin (the Amazon)) and the middles
  (200 kB) load on the first such map.
- **Discharge as particles** ([src/map/layers/river-particles.ts](src/map/layers/river-particles.ts),
  from river-flow-poc's wind map, `index.html`): the major basin's real rivers (every arc, not
  simplified), each with its sub-basin's outflow × its share of the sub-basin's largest upstream
  area, as wide as log(Q) (1–7 px over 2.5 powers of ten; smaller rivers left out), and 3,500
  particles streaming down them. The rivers are drawn as a vector field into an offscreen texture
  whenever the view changes, the particles move through it on the GPU and leave fading trails;
  big rivers carry more of them as they're wider. While it shows, the map repaints every frame
  (map.ts's `animate`). It needs WebGL 2 with float render targets.
  For now the legend has sliders for the particles' look (count, speed, trails, size, speed
  contrast, river widths, how many rivers, their opacity) to find the best settings; **Copy
  settings** copies them as JSON. The defaults are `PARTICLES` in `scheme-map.ts`.
- **Precipitation as rain, evapotranspiration as vapour** ([src/basin/effects-map.ts](src/basin/effects-map.ts),
  from river-flow-poc's `rain.html` and `et.html`): with a major basin selected, the precipitation
  and evapotranspiration maps of its sub-basins have a switch in the legend: the other maps' **Colours**,
  **Circles** or **3D bars**, or **Rain** / **Vapour**. Each is a layer of its own (the legend's `rain` and `vapour`
  slots), so both can show at once, over another map's fills. They follow WaPOR's rasters rather
  than the sub-basins' means ([src/basin/basin-grids.ts](src/basin/basin-grids.ts)): the mean
  mm/day over the period, added up from the same rasters the WaPOR map would use (wapor.ts's
  `waporPeriod`: a year, months, dekads), each read at the coarsest overview still as fine as a
  grid of ~480 cells across the basin's box, only the tiles over it, and masked to the basin's
  outline (drawn from the major basins' vector tiles). Drops and puffs fall and rise only where
  the grid says, as many per area as (mm/day ÷ the "all at" value)^contrast; vapour is green with
  the chance of T ÷ AETI (transpiration), else blue (evaporation). The shimmer copies the canvas
  drawn so far and draws the basin again from it, each pixel shifted by rising ripples as far as
  AETI says. Like the particles, they're computed on the GPU from each instance's index and the
  time (no state), and the map repaints every frame while they show. Under each, the raster can
  be drawn on the ground (river-flow-poc's colours). The map has no 3D relief, so the rain reads
  best tilted (ctrl-drag). For now the legend has sliders for their look, a colour menu and **Copy
  settings**; the defaults are `RAIN` and `VAPOUR` in `effects-map.ts`.
- **The Basin view's data** (PCP, AETI, and the water balance model's Q and ΔS) are files
  precomputed by [fao-wapor-discharge](../../fao-wapor-discharge)'s
  `python -m fao_wapor_discharge.portal --sub-basins public/data/sub-basins.json --out-dir public/data/model`
  (about 15 min), which downloads all PCP and AETI from FAO's BigQuery proxy, runs the model
  for every outlet network (as its pipeline does) and writes `latest.json` (the dekads
  covered), `subbasins.bin` (per sub-basin: PCP and AETI), `majors.bin` (per major basin: Q
  at its outlets, ΔS summed) and `major/<id>.bin` (per sub-basin: Q and ΔS), all over the
  same dekads; the format is in `portal.py` and `src/basin/model.ts`. The app queries
  nothing itself (only the Country view's AQUASTAT data is read live). Known issue: the model uses
  Web-Mercator sub-basin areas, so Q and ΔS are too high by 1/cos²(latitude) (~2× at 45°):
  see [AREA_BUG.md](../../fao-wapor-discharge/AREA_BUG.md). Meant to run
  after each new dekad (a scheduled job, not set up yet); a full run, not an append,
  since a new calendar year moves the model's warmup and changes earlier dekads. The
  files are looked for in `public/data/model/` (not in git: 26 MB; `subbasins.bin` 8.8 MB, `majors.bin` 0.5 MB, `major/<id>.bin` up to 1.8 MB), or at
  `VITE_MODEL_FILES` (a URL ending in `/`, e.g. a bucket) when set at build time.
  `latest.json` is fetched afresh each time; the others carry its `updated` time in their
  URL, so browsers don't keep old copies. The Basin view's range can't go past the last
  dekad in `latest.json` (hatched on the slider), so a failed or late update shows as a
  shorter range rather than gaps; without the files the range isn't limited and Q and ΔS
  say they couldn't be loaded.
- **The water balance panel** (switched off for now) shows the selected sub-basin and
  everything upstream of it, as in FAO's
  [WaPOR Discharge](https://storage.googleapis.com/fao-wapor-accounter/wapor-discharge/main.html)
  app, which this view replicates. It reads the same precomputed files as the maps
  (`subbasins.bin`, and `major/<id>.bin` of each major basin the network reaches into), so it
  shows the same numbers; a sub-basin's Q depends only on what is upstream of it.
- **Light / dark** follows the operating system setting, both for the top bar and the
  map.
- The URL keeps the map position (`#zoom/lat/lon`), so a view can be shared as a link.

Data: FAO M49 boundaries (`boundaries:m49_geom` on FAO's GeoServer); FAO SDG 6 major
basins and sub-basins; HydroLAKES v1.0; rivers from HydroSHEDS; FAO WaPOR v3. Boundaries do not
imply official endorsement.
