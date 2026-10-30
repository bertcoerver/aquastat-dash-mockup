# Map projection — proof of concept

A flat world map in the Robinson projection (and Equal Earth, Natural Earth, Winkel
Tripel, Mollweide, equirectangular, with Web Mercator for comparison), drawn with the
same deck.gl layers and the same tiles the water portal uses: FAO's M49 countries and
UN boundary lines, the SDG 6 major basins, HydroLAKES, the rivers, a WaPOR raster. The
projection can be changed while the map is shown: it morphs from one to the next.

**Now in the portal.** The four modules below live on in
[../water-portal/src/map/flat/](../water-portal/src/map/flat/) (the same code; the
copies here are kept in step), behind the Layers menu's "Map" dropdown: the globe, or a
flat map in any of these projections. What the portal added: a host interface
(`water-portal/src/map/host.ts`) so MapLibre's globe and the flat `Deck` are
interchangeable at the same place and zoom, the effect layers (rain, vapour, haze,
particles) projecting through the same shader module, labels as HTML elements placed by
either host, and the map's own zoom, compass and credits controls.

```bash
npm install
npm run dev        # http://localhost:5174  (#robinson, #equalEarth, … in the URL)
```

`public/tiles` and `public/data` are symbolic links into `../water-portal/public`
(the country and border tiles, the country centres). The basin, lake and river tiles
and the raster come from FAO's buckets.

## Why not MapLibre, Mapbox or OpenLayers

- **MapLibre GL JS** (what the portal draws its globe with) has Mercator, globe and
  vertical-perspective projections, and no others; non-Mercator projections are a
  [roadmap item](https://maplibre.org/roadmap/maplibre-gl-js/non-mercator-projection),
  with the projection logic living in its shaders.
- **Mapbox GL JS** has "adaptive projections" (Albers, Equal Earth, Equirectangular,
  Lambert, Natural Earth, Winkel Tripel) but not Robinson, and is proprietary since v2.
- **OpenLayers** can show any proj4 projection and reprojects raster and vector tiles,
  but would replace the whole stack: none of the portal's deck.gl layers (the WaPOR
  tiles coloured on the GPU, the bars, the particles, the rain and vapour) can be
  drawn in it.

The portal has no basemap: MapLibre only paints the ocean, and every layer is a
deck.gl layer. So the question is only "can deck.gl draw in Robinson?", and the answer
is yes, with three small pieces that need no change to deck.gl itself.

## How it works

1. **[src/projections.ts](src/projections.ts)** — each projection's forward formula
   twice: d3-geo's "raw" projection for JavaScript, and a port of the same code to GLSL.
   Both take radians and return d3's units; common space is those times 512 / 2π, so
   the world is about as wide as deck.gl's Mercator world and zoom levels keep their
   meaning.
2. **[src/projected-viewport.ts](src/projected-viewport.ts)** — a `Viewport` subclass
   that is to this map what `WebMercatorViewport` is to a Mercator map: the camera
   (view and projection matrices from `@math.gl/web-mercator`, which are generic),
   `projectFlat` / `unprojectFlat` (picking, the camera's centre), `getBounds` (which
   tiles to load) and `panByPosition` (dragging, zooming about the pointer). Beyond the
   map's edges the plane goes on (longitudes past ±180°, latitudes past ±90°), so a drag
   that starts off the map still pans. It sets `resolution` as `GlobeViewport` does,
   which makes `MVTLayer` decode tiles to lon/lat and makes deck.gl subdivide polygons,
   paths and bitmaps every few degrees, so long edges curve. deck.gl's `MapController`
   drives it unchanged ([src/projected-view.ts](src/projected-view.ts)).
3. **[src/reproject-extension.ts](src/reproject-extension.ts)** — a `LayerExtension`
   added to every layer. deck.gl's vertex shaders project every vertex to Web Mercator;
   in the `DECKGL_FILTER_GL_POSITION` hook the extension moves it by the difference
   between the chosen projection's and Mercator's position of the vertex's anchor
   (`geometry.worldPosition`, in lon/lat). Offsets from the anchor (a circle's radius
   in pixels, a bar's height, a line's width) come along unchanged. To the shaders the
   viewport claims to be Web Mercator; the viewport's own `projectFlat` is the real
   projection, so the camera's centre and the drawn geometry agree. A morph is the
   same shader mixing two projections (`t` from 0 to 1), with the viewport blending
   the same two on the JavaScript side.

And one workaround, [src/box-tileset.ts](src/box-tileset.ts): deck.gl's tileset picks
tiles by walking the tile tree and testing each tile's box, in Mercator common space,
against the camera's frustum. With a camera in another projection the two don't
match and it keeps one tile. `BoxTileset` picks the tiles under the viewport's
lon/lat bounds instead (the portal's WaPOR layer already picks its own tiles this
way for the globe). As deck.gl's, it loads nothing below a layer's `minZoom` (the
rivers from zoom 5), rather than the whole world at that zoom.

Since the first version: zoomed in from zoom 12, deck.gl keeps positions relative to
the view's centre for precision (its "offset mode"); the extension now takes the same
difference relative to the centre, so the map stays sharp as far in as zoom 15 (it used to
drift past zoom 12). The viewport's inverse off the map is one rule (the latitude from the
central meridian, the longitude by the map's width there, with a floor where the poles are
points) rather than three special cases, and its class carries `forward` / `invert` as
statics so the camera can be moved without a viewport. The view's props are typed from
deck.gl's exports rather than a path into `node_modules`. The morph only replaces the view
each frame; the layers stay, and their shaders read the blend.

## What the POC shows working

- Country, border, basin, lake and river tiles, a graticule with labels (a `TextLayer`,
  which the portal couldn't use inside MapLibre's globe), circles in pixels, 3D bars
  with the map tilted, and a WaPOR raster (a `BitmapLayer` from an overview of
  `L1-AETI-A` 2023, which is global in EPSG:4326: lon/lat in, Robinson out).
- Hover and click pick the right country; zooming is about the pointer; dragging pans,
  also from off the map; the projection morphs in 0.8 s; zooming in loads finer tiles.
- Web Mercator tiles stop at 85.05° S: a polygon fills Antarctica's last 5° (on the
  globe it is a hole at the pole).

## What the portal would need

- **A second map backend.** `map.ts` is built round `maplibregl.Map` (camera moves,
  `fitBounds`, markers for labels, the spin button, the compass). The flat map is a
  `Deck` of its own with a `ProjectedView`; the layer functions in `map/layers/` are
  reusable as they are (every layer gets the extension, as every layer gets
  `HorizonExtension` now). The camera API (`showBox`, `showPoint`) needs a flat
  version: `fitBounds` is a few lines over `projectFlat`.
- **Tile selection**: `TilesetClass: BoxTileset` on each `MVTLayer`; the WaPOR
  layer's own `getTileIndices` already works from `visibleBox(viewport)`, which needs
  the viewport's `getBounds` rather than globe geometry.
- **The custom shader layers** (`wapor-shader.ts`'s colour map is in the fragment
  shader, so it's fine; `river-particles.ts`, `rain.ts`, `vapour.ts`, `haze.ts` compute
  positions themselves) need checking one by one: anything that calls
  `project_position` and sets `geometry.worldPosition` is covered by the extension;
  anything that draws from a texture over a lon/lat grid needs the inverse projection
  in its fragment shader (or a lookup texture), as the particles' and rain's grids do.
  deck.gl-raster's tiles are subdivided on a globe (`globe-grid-mesh`), which is
  triggered by `viewport.resolution`, so the WaPOR tiles reproject as the bitmap here.
- **Labels and markers** can be deck.gl `TextLayer`s (nothing is on a far side).
- **The URL state**: the projection next to the view, and a centre that may lie a
  little off the map.

## Limits and caveats

- **Line widths near the edges**: a path's joint offsets are computed in Mercator
  before the vertex is moved, so a line's width is right but its direction is
  Mercator's; near the map's sides, where Robinson's meridians lean, wide lines look a
  little skewed. A width of a pixel or two doesn't show it. The fix, if ever needed, is
  to patch `project_position` in deck.gl's project module (the portal already patches
  one dependency) rather than hook after it.
- **Sizes in metres** (`lineWidthUnits: "meters"`, bar heights) use Mercator's scale
  at the centre latitude. Pixel units are exact.
- **Precision at high zoom**: common space is 32-bit float in the shader. Relative to
  the view's centre (deck.gl's offset mode, from zoom 12) that's within a pixel up to
  about zoom 15; the portal caps the flat map there, and the globe goes further. Robinson
  is a world map anyway.
- **The seam**: a Robinson map has an edge at ±180°, where the globe has none; Mercator
  tiles are already cut there, so nothing crosses it. Russia's Chukotka and Fiji's
  eastern islands sit at the left edge.
- The Winkel Tripel inverse is iterative and can fail far outside the map; the viewport
  falls back to a longitude from the x scale at that latitude.
