"""Settings and paths shared by the pipeline steps.

Every step takes --region. extract.py also takes the run settings (level, years) and
writes them, with the dekad list, into data/<region>/cache/meta.json; later steps read it.
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
PUBLIC = ROOT / "web" / "public"

CATALOG = "https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3"

# Tiles per region, [west, south, east, north]: 1° at L2 (1024 px), 3° at L1 (1024 px).
REGIONS = {
    # Delta core, coast and Port Said: the sea is nodata, so the videos need their alpha.
    # Winter crops peak in Feb–Apr, summer crops (rice, maize, cotton) in Jul–Aug.
    "nile-delta": [(30.0, 30.5, 31.0, 31.5), (31.0, 30.5, 32.0, 31.5), (32.0, 30.5, 33.0, 31.5)],
    # Gezira–Managil and Rahad: irrigated winter crops in the dry season, rainfed land in
    # Aug–Oct. No nodata at all (the desert is a valid 0).
    "gezira": [(32.0, 14.0, 33.0, 15.0), (33.0, 14.0, 34.0, 15.0), (34.0, 14.0, 35.0, 15.0)],
    # Two tiles stacked north–south, for a seam along a parallel: Cairo and the Nile valley
    # below the Delta's middle tile (shared with nile-delta).
    "delta-ns": [(31.0, 29.5, 32.0, 30.5), (31.0, 30.5, 32.0, 31.5)],
    # One tile over several years (extract with --years 2022-2023), one video per year:
    # tests that playback runs on from one video into the next.
    "delta-years": [(31.0, 30.5, 32.0, 31.5)],
    # Not adjacent: four kinds of 3° L1 tile, to measure bitrates for a global estimate
    # (extract with --level L1 --limit 12). Delta and sea, irrigated Punjab, Sahara, Amazon.
    "l1-sample": [(30.0, 30.0, 33.0, 33.0), (72.0, 30.0, 75.0, 33.0), (9.0, 24.0, 12.0, 27.0), (-63.0, -6.0, -60.0, -3.0)],
}

# Range reads only: no directory listings, merged and parallel ranges.
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "GDAL_HTTP_VERSION": "2",
    "VSI_CACHE": "TRUE",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "1",
}
os.environ.update(GDAL_ENV)
# Use this env's PROJ database, not one a previously activated conda env left in PROJ_DATA.
if (proj := Path(sys.prefix) / "share" / "proj").exists():
    os.environ["PROJ_DATA"] = os.environ["PROJ_LIB"] = str(proj)


def tiles(region: str) -> dict[str, tuple]:
    """Tile id (e.g. 30E30.5N, from the south-west corner) → bounds."""
    return {f"{b[0]:g}E{b[1]:g}N": b for b in REGIONS[region]}


def parser(doc: str) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default="nile-delta", choices=REGIONS)
    return ap


def raw_dir(mapset: str, tile: str) -> Path:
    """Raw dekads of one tile, shared by the regions that contain it."""
    return DATA / "raw" / mapset / tile


def videos_dir(region: str) -> Path:
    return PUBLIC / region / "videos"


def cache_dir(region: str) -> Path:
    return DATA / region / "cache"


def frames_dir(region: str) -> Path:
    return DATA / region / "frames"


def meta_path(region: str) -> Path:
    return cache_dir(region) / "meta.json"


def load_meta(region: str) -> dict:
    return json.loads(meta_path(region).read_text())


def cube_path(region: str, tile: str) -> Path:
    return cache_dir(region) / f"{tile}.npy"
