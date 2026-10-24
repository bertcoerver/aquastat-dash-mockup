#!/usr/bin/env bash
# Download FAO's M49 country polygons and cut them into a directory of
# uncompressed Mapbox Vector Tiles ({z}/{x}/{y}.pbf) with tippecanoe.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/data/m49_geom.geojson"
OUT="$ROOT/public/tiles/m49"
LINES="$ROOT/data/m49_borders.geojson"
LINES_OUT="$ROOT/public/tiles/m49-borders"
WFS="https://data.apps.fao.org/map/gsrv/gsrv1/boundaries/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=boundaries:m49_geom&outputFormat=application/json"

if [ ! -s "$SRC" ]; then
  echo "Downloading boundaries:m49_geom (~160 MB)…"
  curl -sSL --fail -o "$SRC" "$WFS"
fi

# m49_geom also holds polygons for groups that overlap the countries; drop them:
# - M49 regions and sub-regions (World, Africa, Americas, Europe, …)
# - historical / aggregate units: Belgium-Luxembourg, Czechoslovakia, Ethiopia PDR,
#   Sudan (former), USSR, Yugoslav SFR, Serbia and Montenegro, EU (-5707),
#   Channel Islands (-25, overlaps Guernsey and Jersey)
# - China, mainland (159): AQUASTAT reports China as 156, which covers it
EXCLUDE="2,5,9,11,13,14,15,17,18,19,21,29,30,34,35,39,53,54,57,61,142,143,145,150,151,154,155,202,419,58,200,230,736,810,890,891,-5707,-25,159"
FILTER="{\"*\": [\"!in\", \"m49\", $EXCLUDE]}"

rm -rf "$OUT"
# -e: write a tile directory instead of an .mbtiles file
# --no-tile-compression: plain .pbf, so a static server needs no Content-Encoding
# --no-tiny-polygon-reduction: keep small island states visible at low zoom
# -s EPSG:4326: GeoServer writes lon/lat order but labels it EPSG:4326, not CRS84
# --buffer=0: deck.gl doesn't clip tiles to their bounds in GlobeView, so any buffer
#   is drawn twice where tiles meet (visible seams with translucent fills)
tippecanoe \
  --quiet \
  -s EPSG:4326 \
  -e "$OUT" \
  --layer=m49 \
  --minimum-zoom=0 --maximum-zoom=5 \
  --buffer=0 \
  --include=m49 --include=name \
  --feature-filter="$FILTER" \
  --no-tile-compression \
  --no-tiny-polygon-reduction \
  --detect-shared-borders \
  --force \
  "$SRC"

# Borders: the same rings as lines, in their own tile set, drawn over the fill.
# Lines keep tippecanoe's default buffer so they run on across tile edges without
# gaps; the overlap is invisible as long as the line colour is opaque.
python3 "$ROOT/scripts/rings-to-lines.py" "$SRC" "$LINES"
rm -rf "$LINES_OUT"
tippecanoe \
  --quiet \
  -s EPSG:4326 \
  -e "$LINES_OUT" \
  --layer=m49_borders \
  --minimum-zoom=0 --maximum-zoom=5 \
  --include=m49 \
  --feature-filter="$FILTER" \
  --no-tile-compression \
  --force \
  "$LINES"

for dir in "$OUT" "$LINES_OUT"; do
  echo "$(basename "$dir"): $(find "$dir" -name '*.pbf' | wc -l | tr -d ' ') tiles, $(du -sh "$dir" | cut -f1)"
done
