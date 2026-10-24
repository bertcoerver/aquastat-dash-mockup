"""Turn each (Multi)Polygon's rings into a MultiLineString with the same properties.

Usage: python3 rings-to-lines.py <in.geojson> <out.geojson>

The border layer is drawn from these lines rather than by stroking the polygons:
tiles cut polygons at their edges, and a stroke would outline every cut too.
"""
import json
import sys

src, dst = sys.argv[1:3]
with open(src) as f:
    fc = json.load(f)

out = []
for feat in fc["features"]:
    geom = feat.get("geometry")
    if not geom:
        continue
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    rings = [ring for poly in polys for ring in poly]
    out.append({
        "type": "Feature",
        "properties": feat["properties"],
        "geometry": {"type": "MultiLineString", "coordinates": rings},
    })

with open(dst, "w") as f:
    json.dump({"type": "FeatureCollection", "features": out}, f, separators=(",", ":"))
