"""Phase 5: check the cubes and videos against the source COGs.

    python pipeline/verify.py [--region gezira]

1. Alignment: cube values at random pixels of a few dekads equal the COG's (read point by point).
2. Video: decoded frames, mapped back through the colormap, match the cube for the same dekad
   (and fit worse for the neighbouring dekads, so frame k really is dekad k); alpha = nodata.
3. Edges: adjacent tile grids abut without gap or overlap, and the seam is no jumpier than
   any other column step. Writes a mosaic of decoded frames to data/<region>/verify/.
4. Size: the videos against the compressed COG tiles that cover the same windows.
"""

import subprocess

import matplotlib
import numpy as np
import rasterio
from PIL import Image

from common import DATA, cube_path, load_meta, parser, videos_dir
from encode import ffmpeg

POINTS = 12
rng = np.random.default_rng(0)


def pixel_size(info):
    w, s, e, n = info["bounds"]
    return (e - w) / info["width"], (n - s) / info["height"]


def check_alignment(region, meta, cubes):
    print("1. Alignment: cube vs COG at random pixels")
    n = len(meta["dates"])
    worst = 0.0
    for k in sorted({0, n // 2, n - 1}):
        with rasterio.open(f"/vsicurl/{meta['urls'][k]}") as src:
            for t, info in meta["tiles"].items():
                w, s, e, n_ = info["bounds"]
                dx, dy = pixel_size(info)
                rows = rng.integers(0, info["height"], POINTS)
                cols = rng.integers(0, info["width"], POINTS)
                xy = [(w + (c + 0.5) * dx, n_ - (r + 0.5) * dy) for r, c in zip(rows, cols)]
                raw = np.array([v[0] for v in src.sample(xy)], float)
                cog = np.where(raw == meta["nodata"], np.nan, raw * meta["scale"] + meta["offset"])
                cube = cubes[t][k, rows, cols]
                same_nodata = np.array_equal(np.isnan(cog), np.isnan(cube))
                diff = np.nanmax(np.abs(cog - cube), initial=0)
                worst = max(worst, diff if same_nodata else np.inf)
                print(f"   {meta['dates'][k]['code']} {t}: max |diff| {diff:.4f}, nodata agrees: {same_nodata}")
    print(f"   → {'OK' if worst < 1e-4 else 'MISMATCH'}")


def decode(path, width, height) -> np.ndarray:
    # The libvpx decoder keeps the alpha plane; FFmpeg's native VP9 decoder drops it.
    out = subprocess.run(
        [ffmpeg(), "-v", "error", "-c:v", "libvpx-vp9", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(out, np.uint8).reshape(-1, height, width, 4)


def check_videos(meta, cubes):
    print("2. Video vs cube (colours mapped back to mm/day through the colormap)")
    lo, hi = meta["color"]["range"]
    lut = matplotlib.colormaps[meta["color"]["colormap"]](np.linspace(0, 1, 256))[:, :3] * 255
    step = (hi - lo) / 255
    frames = {}
    for t, info in meta["tiles"].items():
        video = np.concatenate([
            decode(videos_dir(meta["region"]) / f"{t}.{year}.webm", info["width"], info["height"])
            for year in sorted({d["start"][:4] for d in meta["dates"]})
        ])
        frames[t] = video
        cube = cubes[t]
        assert len(video) == len(cube), f"{t}: {len(video)} frames, {len(cube)} dekads"
        errors, alpha_bad, shifted = [], 0, []
        for k in range(len(cube)):
            sub = (slice(None, None, 4), slice(None, None, 4))
            rgba, ref = video[k][sub].reshape(-1, 4).astype(float), cube[k][sub].ravel()
            opaque, valid = rgba[:, 3] >= 128, np.isfinite(ref)
            alpha_bad += np.count_nonzero(opaque != valid)
            both = opaque & valid
            idx = np.argmin(((rgba[both, None, :3] - lut[None]) ** 2).sum(-1), axis=1)
            value = lo + idx * step

            def err(j):
                r = cube[j][sub].ravel()[both]
                return np.median(np.abs(value - np.clip(r, lo, hi)))

            errors.append(err(k))
            # The decoded frame should fit its own dekad better than either neighbour.
            if any(err(j) < errors[-1] for j in (k - 1, k + 1) if 0 <= j < len(cube)):
                shifted.append(meta["dates"][k]["code"])
        total = len(cube) * (info["height"] // 4 + (info["height"] % 4 > 0)) * (info["width"] // 4 + (info["width"] % 4 > 0))
        print(
            f"   {t}: {len(video)} frames, median |err| {np.median(errors):.3f} mm/day "
            f"(worst frame {max(errors):.3f}; one colour step = {step:.3f}), "
            f"alpha ≠ nodata at {alpha_bad / total:.3%} of pixels, frames fitting a neighbouring dekad better: {shifted or 'none'}"
        )
    return frames


def check_edges(region, meta, cubes, frames):
    print("3. Tile edges")
    tiles = meta["tiles"]
    ids = list(tiles)
    for a in ids:
        for b in ids:
            wa, sa, ea, na = tiles[a]["bounds"]
            wb, sb, eb, nb = tiles[b]["bounds"]
            if np.isclose(ea, wb) and np.isclose(sa, sb) and np.isclose(na, nb):
                edge, line, cube_a, cube_b = f"{ea:g}°E", "columns", cubes[a], cubes[b]
                frame_a, frame_b = frames[a], frames[b]
            elif np.isclose(sa, nb) and np.isclose(wa, wb) and np.isclose(ea, eb):
                # a lies north of b: swap y and x so rows become columns.
                edge, line = f"{sa:g}°N", "rows"
                cube_a, cube_b = cubes[a].swapaxes(1, 2), cubes[b].swapaxes(1, 2)
                frame_a, frame_b = frames[a].swapaxes(1, 2), frames[b].swapaxes(1, 2)
            else:
                continue
            same_grid = pixel_size(tiles[a]) == pixel_size(tiles[b]) and cube_a.shape[1] == cube_b.shape[1]
            # Mean step across the seam vs the mean step between neighbouring columns inside
            # each tile. Like the seam, the inside steps cross a 4:2:0 chroma pair (2k+1 | 2k+2):
            # steps within a pair are smoother.
            seam = np.nanmean(np.abs(cube_a[:, :, -1] - cube_b[:, :, 0]))
            cols = np.arange(63, cube_a.shape[2] - 1, 64)
            inner = np.nanmean([np.nanmean(np.abs(c[:, :, cols + 1] - c[:, :, cols])) for c in (cube_a, cube_b)])
            fa, fb = frame_a[..., :3].astype(float), frame_b[..., :3].astype(float)
            vseam = np.mean(np.abs(fa[:, :, -1] - fb[:, :, 0]))
            vinner = np.mean([np.mean(np.abs(f[:, :, cols + 1] - f[:, :, cols])) for f in (fa, fb)])
            print(
                f"   {a} | {b}: shared edge {edge}, same pixel grid: {same_grid}; "
                f"mean step between neighbouring {line}, across the seam / inside the tiles: "
                f"data {seam:.3f}/{inner:.3f} mm/day ({seam / inner:.2f}×), video {vseam:.1f}/{vinner:.1f} RGB ({vseam / vinner:.2f}×)"
            )

    # A mosaic of decoded frames, placed by their bounds, for a look at the seams.
    out = DATA / region / "verify"
    out.mkdir(parents=True, exist_ok=True)
    west = min(i["bounds"][0] for i in tiles.values())
    north = max(i["bounds"][3] for i in tiles.values())
    dx, dy = pixel_size(next(iter(tiles.values())))
    width = round((max(i["bounds"][2] for i in tiles.values()) - west) / dx)
    height = round((north - min(i["bounds"][1] for i in tiles.values())) / dy)
    n = len(meta["dates"])
    for k in sorted({0, n // 3, 2 * n // 3}):
        canvas = np.zeros((height, width, 4), np.uint8)
        for t, i in tiles.items():
            x, y = round((i["bounds"][0] - west) / dx), round((north - i["bounds"][3]) / dy)
            canvas[y : y + i["height"], x : x + i["width"]] = frames[t][k]
        name = f"mosaic-{meta['dates'][k]['code']}.png"
        Image.fromarray(canvas).save(out / name)
        print(f"   wrote {(out / name).relative_to(DATA.parent)}")


def check_size(meta):
    print("4. Size")
    video = sum(p.stat().st_size for t in meta["tiles"] for p in videos_dir(meta["region"]).glob(f"{t}.*.webm"))
    cog = sum(sum(i["cogBytes"]) for i in meta["tiles"].values())
    pixels = sum(i["width"] * i["height"] for i in meta["tiles"].values()) * len(meta["dates"])
    print(f"   COG tiles covering the windows: {cog / 1e6:.1f} MB (what a browser reading the COGs would fetch)")
    print(f"   uncompressed Int16 windows:     {pixels * 2 / 1e6:.1f} MB")
    print(f"   videos:                         {video / 1e6:.2f} MB  → {cog / video:.0f}× less than the COG tiles")


def main():
    region = parser(__doc__).parse_args().region
    meta = load_meta(region)
    cubes = {t: np.load(cube_path(region, t), mmap_mode="r") for t in meta["tiles"]}
    check_alignment(region, meta, cubes)
    frames = check_videos(meta, cubes)
    check_edges(region, meta, cubes, frames)
    check_size(meta)


if __name__ == "__main__":
    main()
