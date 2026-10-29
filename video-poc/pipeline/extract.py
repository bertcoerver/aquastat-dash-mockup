"""Phase 1: read the tile windows of each dekad's COG and cache them as (time, y, x) cubes.

    python pipeline/extract.py                 # Nile Delta, L2 (100 m), 2022
    python pipeline/extract.py --region gezira --level L1 --years 2018-2026

Writes data/<region>/cache/<tile>.npy (float32, mm/day, NaN = nodata) and meta.json.
Each dekad is cached raw in data/raw/<mapset>/<tile>/ first, so an interrupted run resumes
and regions that share a tile fetch it once.
"""

import json
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import rasterio
import requests
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds

from common import CATALOG, cache_dir, cube_path, meta_path, parser, raw_dir, tiles

# Few enough parallel reads that each still gets bandwidth on a slow link.
WORKERS = 4
ATTEMPTS = 3


def catalog_rasters(mapset: str, years: range) -> list[dict]:
    """All rasters of `mapset` in `years`, oldest first, as listed by the catalog API."""
    items, page = [], 0
    while True:
        r = requests.get(f"{CATALOG}/mapsets/{mapset}/rasters", params={"page": page}, timeout=60)
        r.raise_for_status()
        resp = r.json()["response"]
        items += resp["items"]
        if not resp["hasNext"]:
            break
        page += 1
    items = [i for i in items if i["dimensions"][0]["member"]["year"] in years]
    return sorted(items, key=lambda i: i["dimensions"][0]["member"]["startDate"])


def tile_grid(bounds, res: float):
    """A fixed EPSG:4326 grid over `bounds` with pixels as close to `res` as fits exactly."""
    w, s, e, n = bounds
    width, height = round((e - w) / res), round((n - s) / res)
    return from_origin(w, n, (e - w) / width, (n - s) / height), width, height


def window_bytes(src, bounds) -> int:
    """Compressed bytes of the full-resolution COG tiles that cover `bounds`."""
    win = from_bounds(*bounds, src.transform)
    bh, bw = src.block_shapes[0]
    r0, r1 = math.floor(win.row_off) // bh, (math.ceil(win.row_off + win.height) - 1) // bh
    c0, c1 = math.floor(win.col_off) // bw, (math.ceil(win.col_off + win.width) - 1) // bw
    return sum(
        int(src.get_tag_item(f"BLOCK_SIZE_{c}_{r}", "TIFF", bidx=1) or 0)
        for r in range(r0, r1 + 1)
        for c in range(c0, c1 + 1)
    )


def read_window(url: str, bounds, grid, nodata: float):
    transform, width, height = grid
    with rasterio.open(f"/vsicurl/{url}") as src:
        nbytes = window_bytes(src, bounds)
        with WarpedVRT(
            src,
            crs="EPSG:4326",
            transform=transform,
            width=width,
            height=height,
            resampling=Resampling.nearest,
            src_nodata=nodata,
            nodata=nodata,
        ) as vrt:
            return vrt.read(1), nbytes


def read_with_retries(url: str, bounds, grid, nodata: float):
    """read_window, retried: GDAL's HTTP retries don't cover a tile cut off mid-transfer."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return read_window(url, bounds, grid, nodata)
        except rasterio.errors.RasterioIOError:
            if attempt == ATTEMPTS:
                raise
            time.sleep(5 * attempt)


def main():
    ap = parser(__doc__)
    ap.add_argument("--level", default="L2", choices=["L1", "L2"], help="L1 = 300 m, L2 = 100 m")
    ap.add_argument("--years", default="2022", help="a year or a range, e.g. 2018-2026")
    ap.add_argument("--limit", type=int, help="only the first N dekads (for quick samples)")
    args = ap.parse_args()
    first, _, last = args.years.partition("-")
    years = range(int(first), int(last or first) + 1)
    mapset = f"{args.level}-AETI-D"
    region, tile_bounds = args.region, tiles(args.region)

    rasters = catalog_rasters(mapset, years)[: args.limit]
    if not rasters:
        raise SystemExit(f"No {mapset} rasters for {args.years}")
    ref = rasters[0]
    res, nodata = ref["affineTransform"][1], ref["noDataValue"]
    grids = {t: tile_grid(b, res) for t, b in tile_bounds.items()}
    print(f"{region}, {mapset}: {len(rasters)} dekads × {len(tile_bounds)} tiles, pixel {res:.6f}°")

    nbytes = {t: [0] * len(rasters) for t in tile_bounds}
    jobs = {}
    t0 = time.time()
    with ThreadPoolExecutor(WORKERS) as pool:
        for k, r in enumerate(rasters):
            for t, b in tile_bounds.items():
                out = raw_dir(mapset, t) / f"{r['dimensions'][0]['member']['code']}.npz"
                if out.exists():
                    nbytes[t][k] = int(np.load(out)["nbytes"])
                    continue
                jobs[pool.submit(read_with_retries, r["downloadUrl"], b, grids[t], nodata)] = (t, k, out)
        failed = []
        for i, fut in enumerate(as_completed(jobs), 1):
            t, k, out = jobs[fut]
            try:
                data, nb = fut.result()
            except rasterio.errors.RasterioIOError as e:
                failed.append(f"{t} {rasters[k]['dimensions'][0]['member']['code']}: {e}")
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            np.savez(out, data=data, nbytes=nb)
            nbytes[t][k] = nb
            print(f"\r  read {i}/{len(jobs)}  {time.time() - t0:.0f} s", end="", flush=True)
    if jobs:
        print()
    if failed:
        # The others are cached; a rerun only fetches these.
        raise SystemExit(f"{len(failed)} reads failed, run again to retry them:\n  " + "\n  ".join(failed))

    # Scale to mm/day; nodata (and anything negative) becomes NaN.
    scale, offset = ref["scale"], ref["offset"]
    cache_dir(region).mkdir(parents=True, exist_ok=True)
    for t in tile_bounds:
        cube = np.empty((len(rasters), grids[t][2], grids[t][1]), np.float32)
        for k, r in enumerate(rasters):
            raw = np.load(raw_dir(mapset, t) / f"{r['dimensions'][0]['member']['code']}.npz")["data"]
            cube[k] = np.where((raw == nodata) | (raw < 0), np.nan, raw * scale + offset)
        np.save(cube_path(region, t), cube)
        print(f"  {t}: {cube.shape}, {np.isnan(cube).mean():.1%} nodata")

    meta = {
        "region": region,
        "mapset": mapset,
        "unit": ref["measureUnit"],
        "scale": scale,
        "offset": offset,
        "nodata": nodata,
        "dates": [
            {k: r["dimensions"][0]["member"][k2] for k, k2 in (("code", "code"), ("start", "startDate"), ("end", "endDate"))}
            for r in rasters
        ],
        "urls": [r["downloadUrl"] for r in rasters],
        "tiles": {
            t: {"bounds": list(b), "width": grids[t][1], "height": grids[t][2], "cogBytes": nbytes[t]}
            for t, b in tile_bounds.items()
        },
    }
    meta_path(region).write_text(json.dumps(meta, indent=1))
    print(f"Wrote {meta_path(region)}")


if __name__ == "__main__":
    main()
