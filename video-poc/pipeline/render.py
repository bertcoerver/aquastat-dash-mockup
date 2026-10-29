"""Phase 2: colour the cached cubes into RGBA PNG sequences, one folder per tile.

    python pipeline/render.py [--region gezira]

One colour range for all tiles and dekads (2nd–98th percentile), so tiles match at their
edges and colours mean the same in every frame. Nodata is transparent (alpha 0, black).
The range and colormap are added to meta.json for encode.py's manifest.
"""

import json
import shutil

import matplotlib
import numpy as np
from PIL import Image

from common import cube_path, frames_dir, load_meta, meta_path, parser

COLORMAP = "viridis"
PERCENTILES = (2, 98)
# Every 4th pixel in x and y is plenty for the percentiles, and keeps 9-year cubes in memory.
SAMPLE_STRIDE = 4


def colour_range(region: str, tiles) -> tuple[float, float]:
    sample = np.concatenate(
        [np.load(cube_path(region, t), mmap_mode="r")[:, ::SAMPLE_STRIDE, ::SAMPLE_STRIDE].ravel() for t in tiles]
    )
    lo, hi = np.percentile(sample[np.isfinite(sample)], PERCENTILES)
    return float(lo), float(hi)


def main():
    region = parser(__doc__).parse_args().region
    meta = load_meta(region)
    lo, hi = colour_range(region, meta["tiles"])
    print(f"Colour range ({PERCENTILES[0]}–{PERCENTILES[1]}th percentile): {lo:.2f}–{hi:.2f} {meta['unit']}")

    lut = (matplotlib.colormaps[COLORMAP](np.linspace(0, 1, 256)) * 255).round().astype(np.uint8)
    lut[:, 3] = 255
    for t in meta["tiles"]:
        cube = np.load(cube_path(region, t), mmap_mode="r")
        out = frames_dir(region) / t
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        for k, frame in enumerate(cube):
            valid = np.isfinite(frame)
            idx = np.clip((np.nan_to_num(frame, nan=lo) - lo) / (hi - lo) * 255, 0, 255).round().astype(np.uint8)
            rgba = lut[idx]
            rgba[~valid] = 0
            Image.fromarray(rgba, "RGBA").save(out / f"{k:05d}.png", compress_level=1)
        print(f"  {t}: {len(cube)} frames")

    meta["color"] = {"range": [lo, hi], "colormap": COLORMAP, "percentiles": list(PERCENTILES)}
    meta_path(region).write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
