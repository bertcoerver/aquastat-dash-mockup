#!/usr/bin/env bash
# Download FAO's M49 country polygons and the UN boundary lines, and cut them into
# directories of uncompressed Mapbox Vector Tiles ({z}/{x}/{y}.pbf) with tippecanoe.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/data/m49_geom.geojson"
LINES="$ROOT/data/bndl.geojson"
OUT="$ROOT/public/tiles/m49"
LINES_OUT="$ROOT/public/tiles/borders"
OWS="https://data.apps.fao.org/map/gsrv/gsrv1/boundaries/ows?service=WFS&version=1.0.0&request=GetFeature&outputFormat=application/json"
WFS="$OWS&typeName=boundaries:m49_geom"
LINES_WFS="$OWS&typeName=boundaries:bndl&propertyName=bdytyp,geom"

if [ ! -s "$SRC" ]; then
  echo "Downloading boundaries:m49_geom (~160 MB)…"
  mkdir -p "$(dirname "$SRC")"
  curl -sSL --fail -o "$SRC" "$WFS"
fi
if [ ! -s "$LINES" ]; then
  echo "Downloading boundaries:bndl (~60 MB)…"
  curl -sSL --fail -o "$LINES" "$LINES_WFS"
fi

# m49_geom also holds polygons for groups that overlap the countries; drop them:
# - M49 regions and sub-regions (World, Africa, Americas, Europe, …)
# - historical / aggregate units: Belgium-Luxembourg, Czechoslovakia, Ethiopia PDR,
#   Sudan (former), USSR, Yugoslav SFR, Serbia and Montenegro, EU (-5707),
#   Channel Islands (-25, overlaps Guernsey and Jersey)
# - China, mainland (159): AQUASTAT reports China as 156, which covers it
EXCLUDE="2,5,9,11,13,14,15,17,18,19,21,29,30,34,35,39,53,54,57,61,142,143,145,150,151,154,155,202,419,58,200,230,736,810,890,891,-5707,-25,159"
FILTER="{\"*\": [\"!in\", \"m49\", $EXCLUDE]}"

# -e: write a tile directory instead of an .mbtiles file
# --no-tile-compression: plain .pbf, so a static server needs no Content-Encoding
# -s EPSG:4326: GeoServer writes lon/lat order but labels it EPSG:4326, not CRS84

# Country areas (land, and what a click on the map hits).
# --buffer=0: deck.gl doesn't clip tiles to their bounds on a globe, so any buffer
#   would be drawn twice where tiles meet
# --no-tiny-polygon-reduction: keep small island states at low zoom
rm -rf "$OUT"
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

# Borders are the UN boundary lines (bndl), the ones FAO's maps draw: lines, not the
# polygon outlines, because stroking polygon tiles would also outline every tile edge
# they were cut at, and because only these say which lines are disputed. bdytyp, as
# in FAO's GeoServer style for the layer (unmap_boundary_lines):
#   0 coastline, 1 international boundary, 2 special boundary, 3 armistice line or
#   undetermined boundary, 4 other line of separation, 8 autonomous region boundary,
#   9 sovereign base limit, 99 untraced (dateline and Antarctic seams: dropped)
# Lines keep the default buffer so they run on across tile edges without gaps.
rm -rf "$LINES_OUT"
tippecanoe \
  --quiet \
  -s EPSG:4326 \
  -e "$LINES_OUT" \
  --layer=bndl \
  --minimum-zoom=0 --maximum-zoom=5 \
  --include=bdytyp \
  --feature-filter='{"*": ["!=", "bdytyp", 99]}' \
  --no-tile-compression \
  --force \
  "$LINES"

for dir in "$OUT" "$LINES_OUT"; do
  echo "$(basename "$dir"): $(find "$dir" -name '*.pbf' | wc -l | tr -d ' ') tiles, $(du -sh "$dir" | cut -f1)"
done
