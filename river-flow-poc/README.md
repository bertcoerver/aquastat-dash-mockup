# River flow — proof of concept

Can river discharge be shown the way windy.com shows wind, with particles that stream along
the rivers? This PoC draws FAO's river network (the source of the portal's river tiles) with
small white dots drifting downstream in lanes across each river's width: slower near the
banks, faster on the outside of bends. The discharge sets how many lanes of dots a river
carries (and its colour and width); the dots move at the same speed on every river.

- **World**: every river gets a proxy discharge (its upstream area × a uniform runoff of
  ~315 mm a year), so you see the network's structure without any model.
- **A major basin** (pick one): discharge per sub-basin and dekad from the portal's water
  balance model ([src/basin-model.ts](src/basin-model.ts)): the portal's precomputed files
  (`water-portal/public/data/model/major/<id>.json`) when they're there, otherwise the model
  run in the browser with the portal's `runNetwork`, once per outlet network. A timeline then
  steps through the dekads (2018 to 2025), and rivers gain lanes of dots, widen and change
  colour with the floods. Only the basin's rivers (and any
  upstream networks the model runs with them) are drawn; the rest of the world is hidden. Hover a river for its discharge, velocity and upstream area.

There are two versions:

- **[index.html](index.html): a wind map as deck.gl layers** ([src/wind-main.ts](src/wind-main.ts),
  [src/wind/river-particles-layer.ts](src/wind/river-particles-layer.ts)), interleaved in
  MapLibre as in the portal, flat or on the globe. The river network is drawn, for the
  current view, as a vector field, and particles blow through it the way wind maps (windy,
  Mapbox's webgl-wind) move particles through wind. See "The wind map" and "As a deck.gl
  layer" below.
- **[canvas.html](canvas.html): the same on its own WebGL canvas** ([src/canvas-main.ts](src/canvas-main.ts),
  [src/wind/river-wind.ts](src/wind/river-wind.ts)), flat only; the first version.
- **[lanes.html](lanes.html): lanes of dots** ([src/lanes-main.ts](src/lanes-main.ts)),
  described in the rest of this README.
- **[rain.html](rain.html): rain in 3D** ([src/rain-main.ts](src/rain-main.ts),
  [src/rain/rain-layer.ts](src/rain/rain-layer.ts)): WaPOR's dekadal precipitation falling
  as rain on a tilted map, with the river particles carrying it away. See "Rain" below.
- **[et.html](et.html): evapotranspiration in 3D** ([src/et-main.ts](src/et-main.ts),
  [src/et/](src/et/)): WaPOR's dekadal evapotranspiration rising as vapour off a tilted map,
  through a heat shimmer. See "Evapotranspiration" below.

## The wind map

Wind maps keep three textures on the GPU: the vector field ((u, v) per pixel), the
particles' positions (one texel each), and a screen of trails. Each frame a shader moves
every particle by the field under it, and sends particles that leave the field, or that
randomly "die" (0.3 % a frame), to a random new place. The particles are then drawn as dots
on the previous frame's trails, faded a little: the fade makes the tails.

Here the field is the river network, drawn into an offscreen texture whenever the view
changes, plain WebGL 2 on a canvas over the map:

- each segment is a quad as wide as its river, plus a disc on its start vertex to round
  the corners; every pixel (a half-float texture) holds the segment's downstream direction
  in screen space times the speed, where it lies across the river (−1 to 1), and a spawn
  weight;
- each particle keeps the across position it was born at and steers back to it, so
  particles stay spread over the whole width. (Steering everything towards the centre line
  near the banks instead made the direction jumps where segments meet kick particles
  sideways; they piled up along both banks and left the middle empty.)
- pixels off the rivers are empty, so a particle that leaves a river (at its mouth, or
  off a bank) respawns: up to 12 random pixels a frame, taking one on a river;
- the width grows with discharge, so a river's share of particles does too: big rivers
  carry many streams side by side, small ones one;
- a pan shifts the particles and trails with the map; a zoom starts them afresh, and the
  map is kept north up and flat (Web Mercator screen space).

Hovering a river shows its discharge, sub-basin and upstream area: deck.gl draws a
near-transparent, pickable copy of the rivers (same widths) under the particle canvas, which
lets the mouse through.

It runs at 60 fps with 8,000 particles over the whole network (Chrome, M-series Mac).
The sliders set the particle count, speed, trail length and speed contrast; the colour
map can be Spectral, Viridis, Turbo, Blues, grey, or off (rivers not drawn, particles only),
and the particles white, cyan, amber, or coloured by discharge. For that, the field pass also
writes each river's particle colour to a second texture (two render targets), and particles
take the colour under them every frame, so they change colour as they flow into a bigger river.

## As a deck.gl layer

`RiverParticlesLayer` does the same as the canvas version inside deck.gl, so it draws among
the portal's other layers, in its view (flat or MapLibre's globe). The rivers themselves are
an ordinary `PathLayer` under it (pickable: that's the tooltip), with the portal's
`HorizonExtension`.

- Only the field pass needs the projection: each segment's ends go through deck.gl's
  `project_position_to_clipspace`, and the segment is widened in screen pixels, so the field
  follows the globe. Far-side segments are dropped as `HorizonExtension` does. The rest
  (particles, trails) is screen space and doesn't care about the projection.
- Each frame, `draw()` runs the field pass (when the view or the rivers changed), the
  particle update and the trails in offscreen luma.gl render passes, then draws the trails
  into deck.gl's pass. luma.gl restores the GL state after each pass, so this works
  interleaved in MapLibre's context.
- Any change of view restarts the particles: on the globe a pan is a rotation, not a shift of
  the screen. (The canvas version shifts them with a flat pan.)
- Pitfall: deck.gl gives the models a layer lists in `getModels()` the layer's blending
  (premultiplied alpha) just before `draw()`. The field model must overwrite, so `draw()` sets
  its parameters again; otherwise disc and segment blend into each other and the field's
  values (alpha is 1 + spawn weight) come out scaled.

## Performance and load

Measured on an M-series Mac in Chrome (the automated window runs slower than a normal one,
so compare the numbers with each other, not with 60 fps):

- **The particles are cheap.** GPU time per frame: particle update 0.3–0.8 ms, trails
  0.2–0.7 ms, and while the map moves the field pass 0.4–1.4 ms (1.7 M instances: every
  segment and its corner disc). Switching the particle layer off barely changes the frame
  rate.
- **The rivers' PathLayer is the heavy part**: 915 k vertices at full detail at every zoom
  (the portal's river tiles generalise with zoom). On a laptop GPU that is what to watch at
  world zoom. Fixes: drop small streams when zoomed out (they're faded anyway), build a few
  generalised levels into the network, or keep drawing the visible rivers from the tiles and
  use the network only for the particle field (drawn only when the view moves).
- **The globe costs more** than flat (roughly half the frame rate here), mostly MapLibre's
  globe and the rivers drawn on it.
- **Load**: `rivers.bin` is 8.5 MB, 4.9 MB gzipped, 3.5 MB with brotli; parsing it and
  building the GPU buffers takes 100–160 ms. So ~4 s on a 10 Mbit/s connection, before
  any rivers show. Fixes: quantise the coordinates (16-bit, relative to each arc; roughly
  halves it), split it per major basin (a basin is tens to hundreds of kB; the world view
  could use only the larger rivers), and serve it with brotli.
- **GPU memory**: the field (16-bit float) and the colour and two trail textures are the size
  of the canvas: ~95 MB at 1400 × 850 on a 2× screen. The field and trails could be half
  resolution. The PathLayer's own buffers for 915 k vertices are of the same order.
- **Requirements**: WebGL 2 with float render targets (`EXT_color_buffer_float`: desktop
  browsers, most phones); the shaders are GLSL, so not deck.gl's WebGPU backend.

`?rivers=0` and `?particles=0` leave out the rivers or the particles, to measure.

## Rain

[rain.html](rain.html) plays a year of WaPOR v3 L1 dekadal precipitation (PCP, mm/day) as
rain on a tilted map (drag with the right mouse button to tilt and turn), over a ground
coloured by it, with relief shading and the rivers (proxy discharge) flowing.

- **Data** ([src/rain/precipitation.ts](src/rain/precipitation.ts)): the PCP COG of each
  dekad straight from FAO's bucket, as the portal's map reads it, but only its third
  overview: 1800 × 600 cells of 0.2° (~22 km), 60° N to 60° S, read whole with geotiff.js.
  ~0.3–0.4 s a dekad; the next two are read ahead while playing, and one dekad fades into
  the next. The sea has no data (no rain there).
- **The drops** ([src/rain/rain-layer.ts](src/rain/rain-layer.ts), `RainLayer`): a deck.gl
  layer with no particle state. Each drop is an instance whose place and moment come from
  its index and the time (an integer hash): it falls from a height to the ground, splashes
  (a ring that grows and fades), and starts again elsewhere. Drops are spread evenly over
  the view and shown with a chance of (mm/day ÷ 20)^0.6, so the density follows the rain.
  Heights and lengths are in pixels at the ground, turned into metres for deck.gl's
  projection, so the rain looks alike at every zoom; they're real 3D positions, so they
  tilt and turn with the map. One draw call, one small texture per dekad.
- **Cost**: next to nothing. A million drops ran at the same frame rate as 20,000
  (59 fps, the display's rate, without rivers); with the rivers on it's the river PathLayer
  that costs (40 fps here, as on the river page).
- **Not 3D terrain**: MapLibre's terrain would hide deck.gl layers, which are drawn at sea
  level, so the relief is only shaded. Draping would need deck.gl's own TerrainLayer.

## Evapotranspiration

[et.html](et.html) is the same idea the other way up: a year of WaPOR v3 L1 dekadal
evapotranspiration rising as vapour, the map shimmering beneath it where water goes up.

- **Data** ([src/et/evapotranspiration.ts](src/et/evapotranspiration.ts)): the AETI and T
  (transpiration) COGs of each dekad, both at once, from FAO's bucket. They're global 300 m
  rasters; the seventh overview, 1920 × 960 cells of 0.19° (~20 km), is read whole: ~1 s a
  dekad. The sea has no data.
- **The vapour** ([src/et/vapour-layer.ts](src/et/vapour-layer.ts), `VapourLayer`): built
  like `RainLayer` (no particle state, an instance a puff). A puff rises fast off the
  ground and slows, sways, drifts with the wind, grows and fades, with a short trail so
  it reads as rising in a still too. It's shown with a chance of (mm/day ÷ 5)^1.3 (steeper
  than rain: deserts still give off a few tenths of a mm a day), and is green
  (transpiration) with a chance of T ÷ AETI, otherwise blue (evaporation, including
  interception). Puffs are also thinned with distance from the camera, so on a tilted map
  their density on the screen follows the data, not the squeezed horizon.
- **The shimmer** ([src/et/haze-layer.ts](src/et/haze-layer.ts), `HazeLayer`): it copies
  the canvas drawn so far (basemap, relief, ground colour) into a texture with
  `copyTexSubImage2D` and draws the land in view again from it, each pixel shifted by
  ripples rising up the screen, in drifting patches, as far as AETI there says (up to 2 px
  by default). Drawn beneath MapLibre's labels (`beforeId`), so they stay sharp.
- **Cost**: 54–56 fps at 1400 × 850 whether 20,000 or a million puffs, with the shimmer on
  or off.
- **Physics, loosely**: real heat shimmer is strongest over hot, *dry* ground, where the
  sun's energy heats the air rather than evaporating water. Here it follows the water going
  up, as a picture of it; a shimmer of the unmet demand (reference ET − AETI) would be the
  more physical choice.

## Run

```bash
npm install
npm run network   # once: builds public/data/rivers.bin from the shapefile (needs GDAL)
npm run dev       # http://localhost:5175
```

`npm run network` reads `~/Local/DATA/VECTORS/rivers_world_47950/rivers_world_47950.shp`;
pass another path as `./scripts/build-network.sh path/to/rivers_world_47950.shp`. The
basin list, sub-basin list and model come from `../water-portal`, so that folder must be
next to this one (see `vite.config.ts`).

## How it works

**The network** ([scripts/build-network.mjs](scripts/build-network.mjs)). The shapefile's
arcs are digitised downstream and carry flow accumulation (`RASTERVA_1`, upstream area in
km² × 100), Strahler order and the SDG 6 sub-basin. Its `FROM_NODE`/`TO_NODE` ids don't
connect the arcs (they repeat across regions), so the topology is rebuilt from the end
points (snapped within 3e-4°): an arc flows into the arc that starts where it ends. Two
artefacts of the raster tracing are dropped: 24,600 "starbursts" (eight one-cell arcs
fanning out of each sink) and self-loops. That leaves 63,577 arcs and 6,489 outlets,
simplified to 915k vertices (8.5 MB), sorted so every arc comes before the arc it flows into.

**Flow time** ([src/network.ts](src/network.ts)). Each vertex gets the time water takes to
reach it, in hours, along its stream, at each arc's velocity. A stream continues through a
confluence along its bigger branch, so flow time is continuous along every line, however
the velocity changes. Each stream head starts at a random time, so particles aren't lined up
across the network. Recomputing it for all 915k vertices takes a few milliseconds.

**The dots** ([src/flow-layer.ts](src/flow-layer.ts)) are drawn in the fragment shader of a
`PathLayer` subclass, the way deck.gl's `TripsLayer` draws a trip, but repeating. No particle
state is kept on the CPU. The river's width is split into lanes about 4 px apart, and in each
lane a dot sits wherever `clock − laneTime` is a multiple of a period, where `laneTime` is the
flow time adjusted for that lane:

- lanes near the banks are slower: the flow time grows by up to 25 % towards the banks;
- in bends the outer lanes get ahead: every corner of the line adds to a "bend lead" (in
  [src/network.ts](src/network.ts), from the turn angle, capped so no lane runs backwards,
  dying away downstream), which is added to one bank's lanes and taken off the other's;
- each lane has its own random phase, and a random 35 % of dot slots stay empty.

The period is picked per pixel from how many hours of flow a pixel spans (the screen
derivative of the flow time), as a power of two of hours, so dot slots are ~12 px apart on
any river at any zoom: fast rivers are as dense as slow ones; their dots just move faster.
Halving the period keeps the coarser one's dots and adds one in between each pair; those fade
in, so where the period changes (zooming, or along a river as it speeds up) dots fill in or
thin out gradually rather than jumping. The animation clock runs slower as you zoom in, so
dots keep about the same speed on screen. When the discharge changes (a new dekad), the new
flow times and bend leads are cross-faded with the old ones (both sets in one `vec4`
attribute: PathLayer already uses 13 of WebGL's 16 vertex attributes). Rivers are drawn opaque,
faded towards black instead of transparent (small streams zoomed out, whose dots fade too),
and arcs meeting end to end use butt caps: otherwise overlapping segments, at corners and arc
ends, add up and show as lighter bands and blobs. So rivers cover the basemap.

**Discharge per arc** ([src/discharge.ts](src/discharge.ts)). The model gives the discharge
out of each sub-basin. Each arc gets its share by upstream area: arc accumulation ÷ the
sub-basin's largest. It's shown by the number of lanes, `floor(1 + 1.5 log10 Q)` from 1 to
8 (one up to ~5 m³/s, eight from ~50,000), and the width makes room for them; lanes and
width scale together with zoom, so a river keeps its lane count. Velocity is
`(Q / 1000 m³/s) ^ k`; `k` is the "speed contrast" slider, 0 by default (the same speed
everywhere). Making small rivers slower made mountain streams look sluggish; a slope-based
velocity (the shapefile has elevations) would be the realistic alternative.

## Findings

- **Yes, it works**, and it's cheap: one draw call of a path layer, 40+ fps with the
  whole world's network in Chrome; a basin's discharge loads instantly from the portal's
  precomputed files, or takes 1–4 s to run in the browser.
- **It needs the network as connected lines, not vector tiles.** Tiles cut lines at tile
  edges and drop the topology, so flow time can't be worked out from them. The network
  ships as one 8.5 MB binary here. For the portal it could be split per major basin, or carry
  the flow time precomputed for a fixed velocity (then only colour and speed would change by dekad).
- **Velocities are illustrative**, not hydraulic. The model gives discharge, not velocity,
  so the dots move at one speed and discharge is shown by the number of lanes.
- **Within a sub-basin, discharge is spread by upstream area.** In coastal sub-basins with
  several separate rivers, each gets its share relative to the largest one, which overstates
  the small ones.
- **Mercator only.** The portal uses a globe; a `PathLayer` works in deck.gl's GlobeView, but
  that isn't tried here (nor WebGPU: the shader injections are GLSL only).
