"""Build the Basin view's data files: PCP, AETI, Q and ΔS per dekad.

A full run every time (meant for a scheduled job, after new dekads of PCP/AETI come
online): download both zonal-stats tables for every sub-basin, solve every outlet
network with the model's core (``fao_wapor_discharge.pipeline._solve_all``, two spinup
passes, as its ``run_global`` does), and write::

    <out-dir>/latest.json        {"version", "updated", "first", "last", "dekads"}
    <out-dir>/subbasins.bin      per sub-basin: major basin, area (km²), PCP, AETI (mm/day)
    <out-dir>/majors.bin         per major basin: Q (summed over its outlets), ΔS (m³/s)
    <out-dir>/major/<id>.bin     per sub-basin of one major basin: Q, ΔS (m³/s)

The dashboard reads nothing else: no queries of its own. Every series is one value per
dekad from ``first`` to ``last`` (start dates, ISO), missing where the tables have no
value or the model no output (outside a network's common date range, or ΔS where
PCP/AETI are missing). Sub-basins without an outlet (broken networks) have PCP and AETI
but no Q or ΔS, as have those without PCP or AETI and every one downstream of them
(``fao_wapor_discharge.pipeline._without_inputs``). Areas are the tables' (geodesic), as are the routes'.

The .bin files (little-endian)::

    Uint32 header length, then the header: JSON, padded with spaces to 4 bytes,
      {"first", "dekads", "n", "columns": [{"name", "type"}],
       "series": [{"name", "type", "scale"?, "none"?}]}
    Int32[n]            ids (sub-basins, or major basins in majors.bin)
    per column:         n values of its type
    per series:         n × dekads values, id after id
      float32:          NaN where missing
      uint16:           value × scale, rounded; ``none`` where missing

Why a full run rather than ``fao_wapor_discharge.pipeline.continue_global``: the warmup cutoff moves a
year each time a new calendar year starts, and a network's common date range can grow
when a late sub-basin catches up; both change earlier results, which a full run picks
up. ``latest.json`` is written last, so a reader never sees it ahead of the other files.

Major basins: the routes don't say which major basin a sub-basin is in (it is not
always ``id // 1000``), so that comes from the dashboard's ``sub-basins.json``
(``[{"id", "majorBasin", ...}]``). A major basin's Q is the sum of Q at the outlets in
it: the water it delivers to the sea or an inland sink (a sub-basin draining into a
neighbouring major basin counts at that basin's outlet). Its ΔS is the sum over its
sub-basins. Sums skip missing values, and are null where all are missing, or
everywhere when sub-basins without Q for lack of inputs make up 1% or more of the
major basin's area (a few small islands don't stop it from adding up).

Needs the fao-wapor-discharge package (``pip install -e path/to/fao-wapor-discharge``).
From water-portal/::

    python scripts/build-model.py --sub-basins public/data/sub-basins.json --out-dir public/data/model
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from fao_wapor_discharge.pipeline import _combine, _solve_all, load_routes, routes_by_outlet
from fao_wapor_discharge.query_outlet_basins import (
    ROUTES_PATH,
    TABLES,
    _iter_chunks,
    _query_chunk,
    build_basin_to_outlet,
)

FORMAT_VERSION = 2
# mm/day as uint16: PCP to 163 at 0.0025, AETI to 13 at 0.0002 (the highest dekads
# by 2025: 135 and 7.4). Q and ΔS span too many orders of magnitude: float32.
SCALES = {"PCP": 400, "AETI": 5000}
NONE = 65535
RETRIES = 3
# The proxy returns at most this many rows, without saying so when it cuts a result off.
PROXY_ROW_LIMIT = 50_000


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #
def _query_with_retries(table_id: str, ids: list[int]) -> pd.DataFrame:
    for attempt in range(1, RETRIES + 1):
        try:
            return _query_chunk(table_id, ids)
        except Exception as err:  # the proxy fails now and then; try again
            if attempt == RETRIES:
                raise
            print(f"    retrying after {err!r}")
            time.sleep(5 * attempt)
    raise AssertionError("unreachable")


def download_tables(routes: dict) -> dict[str, pd.DataFrame]:
    """The PCP and AETI tables for every sub-basin, with each one's outlet (NaN: none)."""
    basin_to_outlet, unresolved = build_basin_to_outlet(routes)
    ids = sorted(map(int, routes))
    print(f"{len(ids):,} basins, {len(basin_to_outlet):,} in {len(set(basin_to_outlet.values())):,} "
          f"outlet networks ({len(unresolved)} without an outlet: no model output)")
    tables = {}
    for label in ("PCP", "AETI"):
        frames = []
        for index, chunk in _iter_chunks(ids):
            df = _query_with_retries(TABLES[label], chunk)
            print(f"  {label} chunk {index + 1}: {len(df):,} rows")
            if len(df) >= PROXY_ROW_LIMIT:  # (CHUNK_SIZE basins × dekads; ~333 dekads fit)
                raise RuntimeError(f"{label} chunk {index + 1} reached the proxy's {PROXY_ROW_LIMIT:,}-row "
                                   "limit, so it may be cut off: lower query_outlet_basins.CHUNK_SIZE.")
            if not df.empty:
                df.insert(df.columns.get_loc("FAO_SB_ID") + 1, "OUTLET_SB_ID",
                          df["FAO_SB_ID"].astype(int).map(basin_to_outlet))
                frames.append(df)
        table = pd.concat(frames, ignore_index=True)
        # A chunk whose values are all null comes back as object dtype (None).
        table["mean"] = table["mean"].astype("float64")
        tables[label] = table
    return tables


def model_inputs(tables: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """PCP + AETI of every basin with an outlet, combined as the pipeline does."""
    pcp, aeti = (t[t["OUTLET_SB_ID"].notna()] for t in (tables["PCP"], tables["AETI"]))
    pcp = pcp.assign(OUTLET_SB_ID=pcp["OUTLET_SB_ID"].astype("int64"))
    return _combine(pcp, aeti)


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def dekad_axis(first: pd.Timestamp, last: pd.Timestamp) -> list[pd.Timestamp]:
    """Every dekad start (day 1, 11, 21) from ``first`` to ``last``."""
    axis, t = [], first
    while t <= last:
        axis.append(t)
        t = t + pd.Timedelta(days=10) if t.day < 21 else (t + pd.offsets.MonthBegin(1))
    return axis


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _uint16(values: np.ndarray, scale: float) -> np.ndarray:
    scaled = np.round(values * scale)
    clipped = int(np.sum(scaled >= NONE))
    if clipped:
        print(f"    {clipped} values above the scale's range ({(NONE - 1) / scale:g}), clipped")
    return np.where(np.isnan(values), NONE, np.minimum(scaled, NONE - 1)).astype("<u2")


def write_series(path: Path, head: dict, ids, series: dict[str, pd.DataFrame], columns: dict[str, np.ndarray] = {}) -> None:
    """A .bin file (see the module's docstring): ``series`` as float32, or uint16 if in SCALES."""
    header = {
        "first": head["first"],
        "dekads": head["dekads"],
        "n": len(ids),
        "columns": [{"name": name, "type": str(np.asarray(v).dtype)} for name, v in columns.items()],
        "series": [
            {"name": name, "type": "uint16", "scale": SCALES[name], "none": NONE} if name in SCALES
            else {"name": name, "type": "float32"}
            for name in series
        ],
    }
    text = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode()
    text += b" " * (-len(text) % 4)
    parts = [np.uint32(len(text)).astype("<u4").tobytes(), text, np.asarray(ids, "<i4").tobytes()]
    parts += [np.asarray(v).astype(np.asarray(v).dtype.newbyteorder("<")).tobytes() for v in columns.values()]
    for name, frame in series.items():
        values = frame.reindex(index=ids).to_numpy("float64")
        parts.append(_uint16(values, SCALES[name]).tobytes() if name in SCALES else values.astype("<f4").tobytes())
    _write(path, b"".join(parts))


def build(sub_basins_path, out_dir, routes_path=ROUTES_PATH) -> dict:
    """Run the model for every network and write the files; returns latest.json's content."""
    out_dir = Path(out_dir)
    routes = load_routes(routes_path)
    major_of = {int(s["id"]): int(s["majorBasin"]) for s in json.loads(Path(sub_basins_path).read_text())}
    missing = [b for b in map(int, routes) if b not in major_of]
    if missing:
        raise ValueError(f"{len(missing)} sub-basins have no major basin in {sub_basins_path}: {missing[:10]}")

    tables = download_tables(routes)
    groups, _ = routes_by_outlet(routes)
    print("Running the model...")
    inputs = model_inputs(tables)
    result = _solve_all(inputs, groups, spinup=2)
    excluded = set(inputs["SDG6_SB_ID"].astype(int)) - set(result["FAO_SB_ID"].astype(int))
    print(f"  {len(excluded):,} basins without PCP or AETI, or downstream of one: no Q or ΔS")

    # One axis for all the files: the tables' dekads (the model's lie within them).
    starts = pd.concat([t["start_datetime"] for t in tables.values()])
    axis = dekad_axis(starts.min(), starts.max())
    q = result.pivot(index="FAO_SB_ID", columns="start_datetime", values="Q").reindex(columns=axis)
    ds = result.pivot(index="FAO_SB_ID", columns="start_datetime", values="ΔS").reindex(columns=axis)
    outlets = set(result.loc[result["FAO_SB_ID"] == result["OUTLET_SB_ID"], "FAO_SB_ID"].astype(int))
    head = {"first": axis[0].strftime("%Y-%m-%d"), "last": axis[-1].strftime("%Y-%m-%d"), "dekads": len(axis)}

    # PCP and AETI of every sub-basin, with its major basin and area (the tables', m² -> km²).
    print("Writing the files...")
    sub_ids = sorted(map(int, routes))
    wapor = {
        label: t.pivot(index="FAO_SB_ID", columns="start_datetime", values="mean").reindex(columns=axis)
        for label, t in tables.items()
    }
    area = pd.concat([t.groupby("FAO_SB_ID")["area"].first() for t in tables.values()])
    area = area[~area.index.duplicated()].reindex(sub_ids).astype("float64") / 1e6
    write_series(out_dir / "subbasins.bin", head, sub_ids, wapor, {
        "majorBasin": np.array([major_of[b] for b in sub_ids], "int32"),
        "area": area.to_numpy("float32"),
    })

    members: dict[int, list[int]] = {}
    for b in map(int, routes):
        members.setdefault(major_of[b], []).append(b)

    major_q, major_ds = {}, {}
    for major, ids in sorted(members.items()):
        in_result = sorted(b for b in ids if b in q.index)
        major_q[major] = q.loc[[b for b in in_result if b in outlets]].sum(min_count=1)
        major_ds[major] = ds.loc[in_result].sum(min_count=1)
        # The sums would leave the excluded basins out: fine for a few small islands.
        if area.reindex(list(excluded.intersection(ids))).sum() >= 0.01 * area.reindex(ids).sum():
            major_q[major][:] = major_ds[major][:] = np.nan
        write_series(out_dir / "major" / f"{major}.bin", head, in_result, {"Q": q, "dS": ds})
    majors = sorted(members)
    write_series(out_dir / "majors.bin", head, majors, {
        "Q": pd.DataFrame(major_q).T.reindex(columns=axis),
        "dS": pd.DataFrame(major_ds).T.reindex(columns=axis),
    })

    latest = {
        "version": FORMAT_VERSION,
        "updated": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **head,
    }
    # Last: the other files are in place.
    _write(out_dir / "latest.json", json.dumps(latest, separators=(",", ":")).encode())
    return latest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sub-basins", type=Path, required=True,
                        help="The dashboard's sub-basins.json (id -> majorBasin).")
    parser.add_argument("--out-dir", type=Path, required=True, help="Where to write the files.")
    parser.add_argument("--routes", type=Path, default=ROUTES_PATH, help="fao_sb_ids.json (default: the one in fao_wapor_discharge).")
    args = parser.parse_args()
    latest = build(args.sub_basins, args.out_dir, args.routes)
    print(f"Wrote {args.out_dir}: {latest['first']} – {latest['last']} ({latest['dekads']} dekads)")


if __name__ == "__main__":
    main()
