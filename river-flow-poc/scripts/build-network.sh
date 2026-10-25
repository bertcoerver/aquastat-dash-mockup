#!/usr/bin/env bash
# Build public/data/rivers.bin from FAO's rivers_world_47950 shapefile (the source of
# the portal's river tiles). Needs GDAL (ogr2ogr) and Node.
#   ./scripts/build-network.sh [path/to/rivers_world_47950.shp]
set -euo pipefail
cd "$(dirname "$0")/.."

SHP="${1:-$HOME/Local/DATA/VECTORS/rivers_world_47950/rivers_world_47950.shp}"
mkdir -p data public/data

# Multi-part arcs become one arc per part.
ogr2ogr -f GeoJSON data/rivers.geojson "$SHP" \
  -explodecollections \
  -select SUBBAS_ID,RASTERVA_1,Strahler,Regime \
  -lco COORDINATE_PRECISION=6

node scripts/build-network.mjs data/rivers.geojson public/data/rivers.bin
