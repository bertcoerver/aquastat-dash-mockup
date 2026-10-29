"""Phase 3: encode each tile's PNG sequence as video with alpha, and write the manifest.

    python pipeline/encode.py [--region gezira] [--crf 32]

One video per tile and calendar year (<tile>.<year>.webm): the viewer plays a tile's
years one after another, and a year can be added without re-encoding the others.
Writes web/public/<region>/videos/ and web/public/<region>/manifest.json, and adds the
region to web/public/regions.json (the viewer's region menu).
Chrome and Firefox get WebM VP9 with alpha. Safari plays VP9 but drops its alpha, so on
macOS each tile also gets an HEVC-with-alpha .mov from the VideoToolbox encoder.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

from common import PUBLIC, frames_dir, load_meta, parser, videos_dir

FPS = 5
# A keyframe every 10 frames, so a seek decodes at most 9 frames.
GOP = 10


def ffmpeg() -> str:
    # Prefer the ffmpeg of this Python's conda env, then whatever is on PATH.
    local = Path(sys.executable).parent / "ffmpeg"
    return str(local) if local.exists() else shutil.which("ffmpeg") or sys.exit("ffmpeg not found")


def has_encoder(name: str) -> bool:
    out = subprocess.run([ffmpeg(), "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return f" {name} " in out


def frames_input(frames: Path, first: int, count: int) -> list[str]:
    """ffmpeg input options for PNGs first … first + count - 1."""
    return ["-framerate", str(FPS), "-start_number", str(first), "-i", str(frames / "%05d.png"), "-frames:v", str(count)]


def encode_hevc(frames: Path, first: int, count: int, out: Path):
    """HEVC with an alpha layer, which Safari keeps (macOS only: needs VideoToolbox)."""
    subprocess.run(
        [
            ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
            *frames_input(frames, first, count),
            "-c:v", "hevc_videotoolbox", "-allow_sw", "1", "-alpha_quality", "0.75", "-q:v", "60",
            "-pix_fmt", "bgra", "-tag:v", "hvc1", "-g", str(GOP),
            "-an", str(out),
        ],
        check=True,
    )


def encode(frames: Path, first: int, count: int, out: Path, crf: int):
    subprocess.run(
        [
            ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
            *frames_input(frames, first, count),
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
            "-crf", str(crf), "-b:v", "0",
            "-g", str(GOP), "-keyint_min", str(GOP),
            # libvpx's alt-ref frames don't carry the alpha plane.
            "-auto-alt-ref", "0",
            "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
            "-an", str(out),
        ],
        check=True,
    )


def main():
    ap = parser(__doc__)
    ap.add_argument("--crf", type=int, default=32, help="VP9 quality, 0–63 (lower is better and bigger)")
    args = ap.parse_args()

    meta = load_meta(args.region)
    videos = videos_dir(args.region)
    videos.mkdir(parents=True, exist_ok=True)
    hevc = has_encoder("hevc_videotoolbox")
    if not hevc:
        print("  No hevc_videotoolbox encoder (not macOS?): skipping the Safari .mov files")
    # Frame ranges per calendar year: (year, first, count).
    years = []
    for k, d in enumerate(meta["dates"]):
        year = d["start"][:4]
        if years and years[-1][0] == year:
            years[-1][2] += 1
        else:
            years.append([year, k, 1])

    tiles = []
    for t, info in meta["tiles"].items():
        frames = frames_dir(args.region) / t
        segments = []
        for year, first, count in years:
            name = f"{t}.{year}"
            segment = {"first": first, "count": count, "video": f"videos/{name}.webm"}
            encode(frames, first, count, videos / f"{name}.webm", args.crf)
            sizes = f"{(videos / f'{name}.webm').stat().st_size / 1e6:.2f} MB WebM"
            if hevc:
                encode_hevc(frames, first, count, videos / f"{name}.mov")
                segment["videoHevc"] = f"videos/{name}.mov"
                sizes += f", {(videos / f'{name}.mov').stat().st_size / 1e6:.2f} MB HEVC"
            print(f"  {name}: {count} frames, {sizes}")
            segments.append(segment)
        tiles.append({"id": t, "bounds": info["bounds"], "segments": segments})

    manifest = {
        "region": args.region,
        "variable": meta["mapset"],
        "unit": meta["unit"],
        "fps": FPS,
        "dates": [{k: d[k] for k in ("code", "start", "end")} for d in meta["dates"]],
        "color": {"range": meta["color"]["range"], "colormap": meta["color"]["colormap"]},
        "tiles": tiles,
    }
    (videos.parent / "manifest.json").write_text(json.dumps(manifest, indent=1))
    index = PUBLIC / "regions.json"
    regions = set(json.loads(index.read_text())) if index.exists() else set()
    index.write_text(json.dumps(sorted(regions | {args.region})))
    print(f"Wrote {len(tiles)} tiles × {len(years)} years and manifest.json ({len(meta['dates'])} frames at {FPS} fps)")


if __name__ == "__main__":
    main()
