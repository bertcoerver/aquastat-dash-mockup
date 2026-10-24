# Water Portal

A map of the world (MapLibre globe + deck.gl) under a top bar for choosing the view
(Country / Basin / Local) and a date range. The map has no basemap: it shows FAO's
M49 countries (or, in the Basin view, the SDG 6 major basins), with lakes and rivers
on top. In the Local view, the map shows WaPOR's actual evapotranspiration for the
selected dekad, month or year. Clicking a country or basin drops a marker; clicking the ocean removes it.
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
| `npm run tiles` | Rebuild the country and border tiles (needs `tippecanoe` and `python3`; downloads ~160 MB the first time) |

## Project layout

```
water-portal/
├── index.html              Page markup: the map container and the top bar
├── package.json            Dependencies and the npm commands above
├── tsconfig.json           TypeScript settings
├── vite.config.ts          Dev server / build settings (Vite)
├── public/                 Copied as-is into the site
│   ├── data/               Country, major basin and sub-basin lists (name, ID, bounding
│   │                       box; for sub-basins also their major basin and where they drain)
│   └── tiles/              Vector tiles ({z}/{x}/{y}.pbf)
│       ├── m49/            Country areas
│       └── m49-borders/    Country borders
├── scripts/                Data preparation, not part of the website
│   ├── build-tiles.sh      Download M49 polygons → tippecanoe → public/tiles/
│   ├── build-lists.mjs     Country / basin / sub-basin lists for the top bar → public/data/
│   └── rings-to-lines.py   Polygon outlines → lines
├── data/                   Downloaded source data (not committed)
└── src/                    The application code
    ├── main.ts             Entry point: starts the map and the top bar, connects them
    ├── selection.ts        The current selection (point, country, basin)
    ├── map/
    │   ├── map.ts          MapLibre globe + deck.gl overlay; layer order, view, clicks
    │   ├── theme.ts        Map colours (light and dark)
    │   ├── places.ts       What's at a point: country, major basin, sub-basin
    │   ├── sub-basin-network.ts  Sub-basins upstream of a sub-basin
    │   ├── wapor-legend.ts Legend for the WaPOR raster
    │   └── layers/         One file per kind of layer
    │       ├── tile-urls.ts  Where each tile set lives (local or FAO's bucket)
    │       ├── countries.ts  M49 country areas (land; what clicks hit)
    │       ├── borders.ts    M49 country borders
    │       ├── basins.ts     SDG 6 major basins and sub-basins: areas + outlines (sub-basins only shade the hovered one and those upstream)
    │       ├── water.ts      Lakes (HydroLAKES) and rivers
    │       ├── wapor.ts      WaPOR v3 ETIa COG for a period (Local view)
    │       ├── wapor-shader.ts  GPU colour map for the WaPOR raster
    │       └── marker.ts     The click marker
    ├── panels/
    │   ├── layers-menu.ts  The "Layers" button: switch rivers and lakes on/off
    │   ├── debug-panel.ts  Draggable window: click, time and hover state as a JSON tree
    │   └── loading-indicator.ts  Spinner in the top bar while any data request is running
    ├── toolbar/
    │   ├── dekads.ts       Dates as dekad numbers (3 per month, 36 per year)
    │   ├── place-picker.ts Country / basin search or coordinates, per view
    │   ├── combobox.ts     Text field with a dropdown that narrows as you type
    │   ├── tree-combobox.ts  The same with a tree (search keeps whole branches)
    │   ├── basin-tree.ts   Major basins → sub-basins, nested the way the rivers run
    │   ├── range-rules.ts  Which ranges each view allows, and how they're adjusted
    │   ├── range-slider.ts The two-handle date range slider
    │   └── toolbar.ts      View tabs, the current range, highlights
    └── styles/
        ├── tokens.css      Colours and fonts (light and dark)
        ├── base.css        Page-wide defaults
        ├── toolbar.css     Top bar
        ├── map.css         Map container
        ├── panels.css      Layers menu and debug window
        └── legend.css      WaPOR legend
```

## Notes

- **Date rules** are documented at the top of
  [src/toolbar/range-rules.ts](src/toolbar/range-rules.ts). When the system changes a
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
- **Which WaPOR tiles load** is decided in [src/map/layers/wapor.ts](src/map/layers/wapor.ts),
  not by deck.gl-raster: one overview for the whole view (the coarsest whose pixels are
  at most 2 CSS pixels on screen; full resolution from about zoom 8), and only tiles on
  the visible part of the globe. deck.gl-raster's own choice works per tile from the Web
  Mercator scale, which on a globe asks for ever finer tiles towards the poles and keeps
  the far side: over 16,000 tiles at zoom 9. The debug window's `wapor` entry shows the
  zoom, overview, pixel size and tile count.
- **Light / dark** follows the operating system setting, both for the top bar and the
  map.
- The URL keeps the map position (`#zoom/lat/lon`), so a view can be shared as a link.

Data: FAO M49 boundaries (`boundaries:m49_geom` on FAO's GeoServer); FAO SDG 6 major
basins and sub-basins; HydroLAKES v1.0; rivers from HydroSHEDS; FAO WaPOR v3. Boundaries do not
imply official endorsement.
