# Water Portal

A map of the world (MapLibre globe + deck.gl, or deck.gl alone as a flat map in a
projection chosen in the Layers menu: Robinson, Equal Earth, Natural Earth, Winkel Tripel,
Mollweide, equirectangular or Web Mercator) under a top bar for choosing the view
(Country / Basin / Local) and a date range. The map has no basemap: it shows FAO's
M49 countries (or, in the Basin view, the SDG 6 major basins), with lakes and rivers
on top. In the Local view, the map shows a WaPOR variable (actual or reference evapotranspiration and its parts, precipitation, NPP, …) for any
selected range, to the day, added up from WaPOR's dekadal, monthly and annual rasters, and a play
button moves the range forward as an animation; for a single dekad, a slider in its
legend hides pixels whose
NDVI input is gap-filled (no valid satellite observation for some dekads). In its place the map can show
one of GAEZ v5's cropland maps, which have no time: cropland, irrigated and rain-fed cropland (~1 km), and
2020's harvested area of a crop, irrigated, rain-fed or both (~10 km), all as % of the pixel's area; with
no map that has time on it, the date range fades away. Vector maps can go on top
of it, picked in the same legend: for now AQUASTAT's dams, as circles or 3D bars by their reservoir
capacity, area or height, or coloured by the year completed, their purpose or whether their location
was checked; hovering one shows its details, and clicking one (or, a dam picked, searching for another
in the Local panel's title) selects it, at its own coordinates: the panel's dam cards then show it among all
the dams, a card per attribute. In the Basin view, a panel
built like the Country view's has three topics (rain and evaporation, water left, discharge), each
with number tiles and charts about the selected sub-basin (alone, or with everything upstream of
it: a switch under the heading), major basin or the World: the highest
and lowest major basins (with the selected sub-basin on top and the World below) against the
average of the same days in the other years, the same days every year (click a year to select it), and the selected
basin's sub-basins. Precipitation and evapotranspiration come from WaPOR; discharge and storage
change from FAO's water balance model (precomputed; per major basin, or per sub-basin of the
selected one). Each tile and chart has its map, and the range ends at the model's latest dekad. Picking a sub-basin, by name or on the map, selects
its major basin. In the Country view, a panel
shows FAO AQUASTAT statistics for the selected country (or the World) in four topics (SDG 6.4,
water resources, water use, irrigation): number tiles and charts, each with a map that goes with
it. Hovering a tile or chart previews its map, clicking pins it (Escape unpins). Hovering a
row in a regional chart picks out that region's countries, and pinning a row of a region or country
selects it (the World row: nothing). Clicking a country or basin drops a marker; clicking the ocean removes it.

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
| `npm run lint` | ESLint, for what the type checker doesn't catch (`eslint.config.js`) |
| `npm test` | The unit tests (`test/*.test.ts`, [Vitest](https://vitest.dev)): the date rules, the basin statistics' sums, the WaPOR rasters a range adds up, the sub-basin network, the axis and CSV helpers |
| `npm run smoke` | Drive the built site through its three views in a headless browser and fail on any error (`scripts/smoke.mjs`; needs Playwright's Chromium: `npx playwright install chromium`) |
| `npm run check` | Type-check, lint, test and build, as [the GitHub Actions workflow](../.github/workflows/ci.yml) does on every push |
| `npm run lists` | Rebuild the country, basin and sub-basin lists for the top bar (`public/data/`) |
| `npm run country-info` | Rebuild each country's region and map centre for the Country view (`public/data/country-info.json`; needs the polygons `npm run tiles` downloads) |
| `npm run rivers` | Rebuild the river network per major basin and the sub-basins' middles for the Basin view's water balance scheme (`public/data/rivers/`, `public/data/sub-basin-middles.json`; from `../river-flow-poc`'s `rivers.bin` and `nodes.json`) |
| `npm run dams` | Rebuild the dams for the Local view's Dams map (`public/data/dams.json`; from the CSV FAO's Water Portal loads for its Infrastructure > Dams layer) |
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
│   │   │                   box; for sub-basins also their major basin, where they drain and area;
│   │   │                   sub-basins.json is by column: { id: [...], name: [...], … })
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
│   ├── build-dams.mjs      AQUASTAT's dams (with coordinates), a list per field → public/data/dams.json
│   ├── dam-names.mjs       Mends the CSV's names that lost their accented letters ("Hirfanl?"), from AQUASTAT's regional Excel files and the words spelled right
│   ├── build-model.py      PCP, AETI and the water balance model's Q and ΔS for the Basin view → public/data/model/
│   └── lib.mjs             What the scripts share: the project folder, rounding, a checked fetch, writing JSON
├── data/                   Source data: downloaded boundaries (not committed) and
│                           fao_sb_ids.json (sub-basin routes and areas, from fao-wapor-discharge)
└── src/                    The application code
    ├── main.ts             Entry point: starts the map and the top bar, connects them
    ├── selection.ts        The current selection (point, country, basin)
    ├── url-state.ts        The state in the URL's hash: the view, the selection, the range, the panel's pin and maps
    ├── lib/                Small helpers used across the folders
    │   ├── dom.ts          byId (an element by id, or an error naming it), reduceMotion
    │   ├── html.ts         esc: text as HTML
    │   ├── math.ts         clamp, lerp
    │   ├── scale.ts        Round steps and ticks for chart axes
    │   ├── csv.ts          Rows as a CSV file the browser saves
    │   ├── format.ts       Numbers as text: one locale (en-US) everywhere
    │   ├── data-url.ts     The static data files' URLs, with a version that changes when a file does
    │   ├── memo.ts         A memoised promise that forgets a failure; keeping the last few entries of a map
    │   ├── schedule.ts     perFrame: a draw once per animation frame
    │   ├── drag.ts         A pointer drag, its listeners taken off at the end
    │   └── popover.ts      What closes a popup: Escape, a press elsewhere, the focus leaving, a resize
    ├── map/
    │   ├── map.ts          The layers (order, view, clicks) on a host; the projection switch
    │   ├── host.ts         What draws the layers: the globe or the flat map (the interface)
    │   ├── globe-host.ts   MapLibre's globe with deck.gl's layers drawn into it
    │   ├── controls.ts     Zoom, compass and credits, for either host
    │   ├── spin.ts         The globe's spin button
    │   ├── flat/           The flat map in any projection (from ../map-poc)
    │   │   ├── flat-host.ts  deck.gl alone, in a ProjectedView; the morph between projections; camera moves
    │   │   ├── projections.ts  Robinson, Equal Earth, …: d3-geo's formulas, and the same in GLSL
    │   │   ├── projected-viewport.ts  The camera, picking, tile bounds and panning in a projection
    │   │   ├── projected-view.ts  The view and its controller (held still while the marker is dragged)
    │   │   ├── reproject-extension.ts  Moves every layer's vertices from Web Mercator to the projection
    │   │   ├── box-tileset.ts  Which tiles to load: those under the view's lon/lat bounds
    │   │   └── world-layers.ts  The ocean (the map's outline) and Antarctica's last degrees
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
    │       ├── wapor-variables.ts  WaPOR v3's variables: the catalogue, units, colours, where the rasters are
    │       ├── wapor-period.ts  A range as the rasters it's added up from, and whether they're published
    │       ├── geotiff-lib.ts   The GeoTIFF reader, loaded with the first raster rather than the page
    │       ├── wapor-tiles.ts   The rasters and tiles read, decoded, kept and added up
    │       ├── wapor-layer.ts   The layer that draws a period's rasters (loaded with the first raster too)
    │       ├── wapor.ts      The WaPOR raster on the map (Local view): the view's tiles and level, the values in view
    │       ├── gaez.ts       GAEZ v5's cropland and harvested area maps (Local view), drawn by wapor.ts's layer
    │       ├── wapor-l2.ts   Where WaPOR has level 2 (100 m): a 1° footprint
    │       ├── wapor-plan.ts Which WaPOR rasters to add up for a range, cheapest first
    │       ├── wapor-shader.ts  GPU colour map for the WaPOR raster
    │       ├── basin-scheme.ts  The water balance scheme: discharge lines, mouth arrows, particles
    │       ├── river-particles.ts  Particles streaming down the rivers (river-flow-poc's wind map)
    │       ├── effects-common.ts  What rain, vapour and haze share: the grid texture, GLSL, a uniform block from its types, the layer base
    │       ├── rain.ts       Rain falling as densely as a grid says (river-flow-poc's rain page)
    │       ├── vapour.ts     Vapour rising as densely as a grid says, transpiration and evaporation
    │       ├── haze.ts       A heat shimmer over the map, as strong as a grid says
    │       ├── basin-effects.ts  The Basin view's rain, vapour and shimmer, and the rasters on the ground
    │       └── marker.ts     The click marker
    ├── local/              Local view: the legend's maps and the panel's charts at the selected point
    │   ├── local-maps.ts   The legend: a checklist of WaPOR's variables and the vector maps, a section per map, the points' tooltips
    │   ├── vector-maps.ts  The vector maps (Dams): their data file, attributes and how each is drawn, tooltips
    │   ├── local-panel.ts  The panel: the mapped variable's time series and the same days every year, the crop and dam cards
    │   ├── crop-card.ts    GAEZ's card: the harvested area by crop at the point; drives the map as a dam card
    │   ├── dam-card.ts     The dam cards: the selected dam, and a card per attribute (all the dams, the selected one among them)
    │   ├── point-series.ts The series at the point (read from the COGs, or FAO's zonal statistics)
    │   ├── cog-pixel.ts    A lean reader of one pixel of a COG
    │   ├── wapor-raster.ts The WaPOR raster on the map: its legend, the checks, the colour stretch, playback
    │   └── year-bars.ts    The same days every year, as bars
    ├── basin/              Basin view: statistics about the selected basin, each with its map
    │   ├── model.ts        Loads the precomputed files (PCP, AETI, Q, ΔS; scripts/build-model.py)
    │   ├── variables.ts    PCP / AETI / Q / ΔS: labels, units, colour scales
    │   ├── timeseries.ts   Time series charts (drag to choose the period)
    │   ├── stats-data.ts   PCP and AETI per sub-basin over the range, the same days in other years, and per month (summed from subbasins.bin)
    │   ├── stats-cards.ts  The statistics topics: tiles, charts and each one's map
    │   ├── rivers.ts       Loads a major basin's river network and the sub-basins' middles
    │   ├── scheme.ts       The water balance scheme: lines along the rivers, a point on each sub-basin's river, simplification
    │   ├── scheme-map.ts   The scheme on the map: the legend's switch, key and simplify slider
    │   ├── basin-grids.ts  WaPOR's PCP, AETI and T over a range on a grid over a major basin, masked to it
    │   ├── effects-map.ts  Precipitation as rain, evapotranspiration as vapour: the legend's switch, key and sliders
    │   └── basin-stats.ts  Statistics in the panel: topics, preview / pin, map colours, legend, tooltip
    ├── country/            Country view: AQUASTAT statistics and the maps that go with them
    │   ├── data.ts         Loads a topic's AQUASTAT variables in BigQuery; values per country and region
    │   ├── charts.ts       Bar, 100 % stacked bar, line and scatter charts (SVG; also the Basin view's)
    │   ├── cards.ts        Per topic: the number tiles and charts, and each one's map
    │   └── country-panel.ts  The panel, preview / pin, the map colours, legend and tooltips
    ├── panels/
    │   ├── layers-menu.ts  The "Layers" button: the map's projection, rivers and lakes on/off, the theme
    │   ├── map-drivers.ts  Chart cards that drive the map: hover previews, click pins (both panels)
    │   ├── stat-panel.ts   The Country and Basin panels' core: the preview, the pin, the legend's checklist, the maps on the map
    │   ├── legend.ts       The Basin and Country legends: a checklist of maps, a section per layer
    │   ├── tuning-pane.ts  Hidden pane of sliders for the particles, rain and vapour (triple-click a legend)
    │   ├── shape-switch.ts A map's switch: the areas' colours, circles or 3D bars
    │   ├── shape-style.ts  How circles and bars look: a menu on their key (colours, full size)
    │   ├── foldable.ts     Graph panes fold to their heading (and pinned chart) off hover
    │   ├── load-bar.ts     Load bar under the graph pane's heading while anything loads
    │   ├── corner-warning.ts The bottom-left corner's warnings, one above the other; their ⚠ copies a report
    │   ├── crash-warning.ts Warning there for an error nothing else reports, and the map's graphics context lost
    │   ├── slow-server.ts  Warning there when the connection to Google Cloud is slow
    │   └── cors-check.ts   Warning there when a server's data is blocked by the browser (no CORS headers)
    ├── toolbar/
    │   ├── dekads.ts       Dates as dekad numbers (3 per month, 36 per year), and as day numbers
    │   ├── place-picker.ts Region / country, basin / sub-basin search, or a dam or coordinates, per view
    │   ├── tree-combobox.ts  Text field with a dropdown tree that narrows as you type (search keeps whole branches)
    │   ├── country-tree.ts Regions → countries
    │   ├── dam-tree.ts     Countries → dams (the Local panel's search)
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

- **Globe or flat map** ([src/map/host.ts](src/map/host.ts)): the Layers menu's "Map" picks the
  globe (MapLibre, with deck.gl's layers drawn into it) or a flat map in one of seven projections,
  drawn by deck.gl alone ([src/map/flat/](src/map/flat/), from [../map-poc](../map-poc)). MapLibre has
  no projection but Mercator and the globe, so the flat map is a `Deck` of its own: a `Viewport`
  subclass does what `WebMercatorViewport` does for a Mercator map (the camera, picking, which tiles
  to load, panning) with d3-geo's projection formulas, and a `LayerExtension` on every layer moves
  each vertex, in the vertex shader, from where Web Mercator put its anchor to where the projection
  does, so deck.gl's layers draw unchanged (offsets in pixels, a circle's radius or a line's width, come
  along). The layers that project in shaders of their own (rain, vapour, haze, particles) include the
  same module. From one flat projection to another the map morphs (the shader mixes the two
  formulas over 0.8 s). To or from the globe it morphs too: one of the shader's projections is the
  globe as MapLibre draws it (seen from above the view's centre, by a camera 1.5 times the view's
  height above the surface, sized so the scale at the centre matches Web Mercator's: MapLibre's own
  numbers), so the flat map folds into a globe, the far side fading out as it folds, and MapLibre's
  globe then takes over at the same camera once it has drawn its tiles, a cut between two
  near-identical frames (to within a pixel at the rim); from the globe, the flat map opens as that
  globe stage, takes over once drawn, and unfolds into the chosen projection. While it's the globe
  stage, dragging turns it and a disc in the ocean colour lies under the layers. The map's controls (zoom, compass, credits,
  [src/map/controls.ts](src/map/controls.ts)) are the portal's own, so they work on both; the spin
  button is the globe's. Labels (the graticule's longitudes, a dam's name) are HTML elements either
  host places. Zoomed in past zoom 12, deck.gl keeps positions relative to the view's centre and the
  extension follows, so the flat map stays sharp up to its zoom 15; the globe goes further. Known
  limits: wide lines near a map's sides lean a little (a path's joints are laid out in Mercator before
  the vertex is moved), sizes in metres use Mercator's scale at the centre, and a box across 180°
  can't be framed in one piece (its bigger part is). The projection is in the URL (`projection=`).
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
  so changing the range shows at once. Totals are each sub-basin's mean daily rate × the days covered; major basins and
  the World are area-weighted (or, over the basin, summed) over their sub-basins, and their
  discharge and storage change summed over their major basins. A range of more than a year is
  compared with the other spans of its length that fit in the record, so with fewer than 3 of
  them (a range of 3 years or more) there is no comparison. Without a pin, the map shows the topic's first tile (or what the legend picked),
  except with a sub-basin selected while the model's panel is shown.
- **Map layers** (Basin and Country views, [src/panels/legend.ts](src/panels/legend.ts)): the
  legend's title is a checklist of the maps, and several can be on the map at once, one per way
  of drawing them (the checklist says which): a fill, circles, 3D bars, and the scheme's discharge
  lines (Basin). Checking a map replaces the one drawn the
  same way; a previewed or pinned chart's map takes its place for the while.
- **Map layers** (Local view, [src/local/local-maps.ts](src/local/local-maps.ts)): the same legend,
  its checklist under groups: WaPOR's variables and GAEZ's cropland maps (drawn as a raster, one
  at a time: checking another replaces it; a WaPOR variable's section holds the WaPOR legend, a
  GAEZ map's its fixed colours and, for harvested area, a menu of the crops) and the vector maps
  ([src/local/vector-maps.ts](src/local/vector-maps.ts); for now Infrastructure > Dams). A vector
  map shows one attribute at a time, a menu under its title; an amount is drawn as circles or 3D
  bars (the icons), a value or classes as circles of one size, coloured, the classes' swatches
  switching them off. Its data are one JSON file of columns, loaded all at once the first time it's
  shown (not vector tiles: ~14,000 points are 0.3 MB gzipped, and the legend's sizes, ranges and
  classes are over all of them). Taken off the map, the raster stops loading, and the play button
  only moves the range on. Only WaPOR's variables have time: without one on the map (GAEZ's maps,
  the dams, nothing), the date range fades out and is gone until one is back.
- **GAEZ v5** ([src/map/layers/gaez.ts](src/map/layers/gaez.ts)): read straight from FAO's bucket, as
  WaPOR's. Irrigated cropland is LR-LCC's class LC12, the same raster as GAEZ's "share of irrigated
  land" (LR-IRR: of the pixel, not of the cropland as its catalogue says); rain-fed is LC02 − LC12.
  Harvested area (ha per pixel, RES06-HAR) is shown as % of the pixel's area, of the full-resolution
  pixel (the overviews average it). The bucket sends CORS headers on GET but not HEAD, so the map only
  reads with GET. A server that sends none (the GAEZ v4 bucket) is caught by
  [src/panels/cors-check.ts](src/panels/cors-check.ts), with a warning bottom left.
- **The Local panel follows the raster on the map**: its time series is of the WaPOR variable
  checked in the legend; with no map with time (a GAEZ map, only the dams, or nothing) the card says
  to check one, and nothing is read. GAEZ's crops have a card of their own, always there
  ([src/local/crop-card.ts](src/local/crop-card.ts)): each crop's harvested area in 2020 in the 5′
  pixel at the point (RES06-HAR), largest first, on the checked GAEZ map's supply (all, irrigated
  or rain-fed; none checked: all). Like a dam card it drives the map: hovered, its GAEZ map shows
  in the raster's place, without changing the series or the range (a bar hovered only shows its
  value in the headline); a bar clicked checks that crop's harvested area in the legend, the card
  pinned its map.
- **A dam as the point** (Local view): a click on a dam's circle or bar selects the dam
  (`feature` in [src/selection.ts](src/selection.ts)) at its own coordinates, not where the click
  was, and the panel's title reads "point · dam"; the point opens the coordinates' fields, the dam's name a
  search of the dams by country and name ([src/toolbar/dam-tree.ts](src/toolbar/dam-tree.ts)) (only
  there once a dam is picked: without one the title opens just the fields), and
  its × goes from the dam to its point, then to none. The dam cards
  ([src/local/dam-card.ts](src/local/dam-card.ts)) are always there: one with the selected dam's
  fields, then one per attribute of the Dams map, in the legend's order: capacity, area, height and
  year as strips of how many dams have each value (the median dashed), purpose and location checked
  as shares per class in the map's colours, the selected dam marked on each. Like a Country or
  Basin card each drives the map: hovered, the dams show on top by its attribute; pinned, they're
  checked in the legend with that attribute (selecting a dam pins the first card, the dams as
  they are).
- **A chart's maps** (`also` in [src/country/cards.ts](src/country/cards.ts) and
  [src/basin/stats-cards.ts](src/basin/stats-cards.ts)): most charts bring more maps along
  with their own, each drawn its own way, so the map shows the chart's variables together:
  water stress under circles of the population or the water withdrawn, the water left under the
  discharge network, rain and vapour over it, or the water balance's terms as fill, circles and
  bars (see `waterportal-inventory/waterportal-multivariable-maps.md`). Each map says how it would
  be drawn (`shape` in the Country view; `prefer` in the Basin view, which can also ask for rain,
  vapour, the network or particles); one switched in the legend stays as switched, and one that
  would be drawn the same way as another of the chart's moves to a free way. While shown they
  take the places of the maps checked in the legend; the checklist lists them after their
  chart's own (id `<chart>~<index>`). A map against the other years (Basin) has a title of its
  own, so it can show beside the values. Amounts split into parts (by sector, source, method)
  are **pie circles**: [src/map/layers/countries.ts](src/map/layers/countries.ts)'s circles
  layer paints the slices in its fragment shader by the angle from the top, from cut points and
  colours per circle (so they ease like the rest); the legend's swatches switch parts off.
  Variables of other topics a chart combines with its own are loaded with the topic
  (`TOPIC_VARS` in [src/country/data.ts](src/country/data.ts)).
- **Months and dekads on the map** (Basin): hovering a month on the monthly charts (the lines,
  and the month × year grid of PCP − AETI) or a dekad on the rain and discharge chart maps that
  month or dekad alone (a context over that range: `BasinCtx.at`; the legend shows its dates),
  with its rain and vapour, or its discharge as particles; clicking it selects it in the top
  bar (`select` on the card).
- **Transpiration per sub-basin**: there are no zonal statistics of T, so its share of AETI
  per sub-basin is averaged over the cells of WaPOR's T and AETI grids over the basin (the
  vapour's: [src/basin/basin-grids.ts](src/basin/basin-grids.ts)), each sub-basin drawn onto
  the grid from the sub-basins' vector tiles (cells on edges left out). Loaded with a basin
  selected and the panel open, not while a range plays.
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
  WaPOR has no annual NPP, so NPP's years come from `L1-TBP-A` (total biomass
  production, kg DM/ha), which is the year's NPP × 22.222: NPP (gC/m²) = TBP × 0.045,
  shown in the equation as `TBP[2025]×0.045`. That makes a year of NPP (and of WP) one
  raster instead of twelve monthly ones.
- **WaPOR level 2** (`L2-AETI-D`, `-M`, `-A`, `L2-T-`, `-E-`, `-I-`, `-NPP-`, `L2-TBP-A`,
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
  is 113 KB but 14–20 s with nothing shown until the end, so it's only asked alongside,
  and wins when the bucket is slow: docs/point-timeseries.md), as do the basin
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
  waits; the slider shows how far ahead it has loaded. Meanwhile the load bar shows the
  frames it's waiting for (sweeping until the first is in), or while it plays on with
  few in ahead, how far those are: playback leads it (setProgress's `lead`), so the
  point's series' progress isn't shown then. While it plays, that series reads 2 dekads
  at a time instead of 12, so the frames get the bucket first. The map keeps the shown frame until
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
  Sliders for the particles' look (count, speed, trails, size, speed contrast, river widths,
  how many rivers, their opacity) are out of sight in a tuning pane
  ([src/panels/tuning-pane.ts](src/panels/tuning-pane.ts)): a triple click on the legend opens
  it, and it drags by its heading. **Copy settings** copies them as JSON. The defaults are `PARTICLES` in `scheme-map.ts`.
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
  best tilted (ctrl-drag). The tuning pane has sliders for their look too, a colour menu and **Copy
  settings**; the defaults are `RAIN` and `VAPOUR` in `effects-map.ts`.
- **The Basin view's data** (PCP, AETI, and the water balance model's Q and ΔS) are files
  precomputed by `python scripts/build-model.py --sub-basins public/data/sub-basins.json --out-dir public/data/model`
  (about 15 min, in a Python environment with [fao-wapor-discharge](../../fao-wapor-discharge)
  installed), which downloads all PCP and AETI from FAO's BigQuery proxy, runs that model
  for every outlet network (as its pipeline does) and writes `latest.json` (the dekads
  covered), `subbasins.bin` (per sub-basin: PCP and AETI), `majors.bin` (per major basin: Q
  at its outlets, ΔS summed) and `major/<id>.bin` (per sub-basin: Q and ΔS), all over the
  same dekads; the format is in `scripts/build-model.py` and `src/basin/model.ts`. The app queries
  nothing itself (only the Country view's AQUASTAT data is read live). Meant to run
  after each new dekad (a scheduled job, not set up yet); a full run, not an append,
  since a new calendar year moves the model's warmup and changes earlier dekads. The
  files are looked for in `public/data/model/` (not in git: 26 MB; `subbasins.bin` 8.8 MB, `majors.bin` 0.5 MB, `major/<id>.bin` up to 1.8 MB), or at
  `VITE_MODEL_FILES` (a URL ending in `/`, e.g. a bucket) when set at build time.
  `latest.json` is fetched afresh each time; the others carry its `updated` time in their
  URL, so browsers don't keep old copies. The Basin view's range can't go past the last
  dekad in `latest.json` (hatched on the slider), so a failed or late update shows as a
  shorter range rather than gaps; without the files the range isn't limited and Q and ΔS
  say they couldn't be loaded.
- **The static data files** (`public/data`: the lists, the dams, the rivers) are fetched
  with a version in their URL, a hash of their contents worked out at build time
  (`vite.config.ts`, `src/lib/data-url.ts`), so a rebuilt file is never served from a
  browser's or the host's cache. The tiles aren't versioned (they change rarely, and there
  are thousands). The GeoTIFF reader and the map's raster layer are loaded with the first
  raster, not with the page (`src/map/layers/geotiff-lib.ts`, `wapor-layer.ts`): the
  Country view needs neither.
- **What nothing else reports** (an error thrown outside any handler, a promise rejected
  with nothing to catch it, the map's WebGL context lost) shows in the corner
  (`src/panels/crash-warning.ts`), the last with a button to reload.
- **Keyboard and screen readers**: the charts are focusable (Tab), the arrow keys step
  along a chart's rows, steps or points (shown as hovered, with the tooltip), Enter pins
  the chart or selects the step, Escape unpins; every SVG chart has a description
  (`role="img"`), and the panels' messages are announced (`role="status"`).
- **Light / dark** follows the operating system setting, both for the top bar and the
  map.
- **The URL keeps the state** (`src/url-state.ts`), so a view can be shared as a link: the
  map's place and zoom (`map=zoom/lat/lon`, MapLibre's form, written for either host), its
  projection if not the globe, the view, what is selected (a country or region, a basin or
  sub-basin, the Local view's point and dam), the date range, and the view's panel: its topic
  or scope, the chart pinned and the maps checked. Written as the state changes, read once on load.

Data: FAO M49 boundaries (`boundaries:m49_geom` on FAO's GeoServer); FAO SDG 6 major
basins and sub-basins; HydroLAKES v1.0; rivers from HydroSHEDS; FAO WaPOR v3. Boundaries do not
imply official endorsement.
