"""Build Tellus's static assets for the WHOLE EARTH domain.

Stages (each resumable; run with --stage all|parse|packs|presets|catalog):
  parse    per variable: stream all .json.gz tiles through a process pool,
           aggregate to annual/JJAS/DJF, save data/processed/{var}_{season}.npy
  packs    per variable x season x window: vectorized trend map -> one
           .bin.gz pack (Int16 slope/CI + Uint8 pFdr/label, 8 bytes/cell)
  presets  regional annual series for all preset regions -> presets.json
  catalog  grid.json, catalog.json, gpcp_series.json, provenance.json

Grid: MERRA-2 native lattice, lats -90..90 step 0.5 (361), lons -180..180
step 0.625 (577) -> 208,297 cells. The lattice is derived analytically and
verified against every tile's returned coordinates.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from aggregate import aggregate_season, region_series  # noqa: E402
from config_loader import load_config  # noqa: E402
from stats_fast import trend_grid_fast  # noqa: E402

CFG = load_config()
POWER = CFG["power"]
DOMAIN = CFG["domain"]
METHODS = CFG["methods"]

LATS = np.round(np.arange(-90.0, 90.0 + 1e-9, 0.5), 6)            # 361
# longitude stops at 179.375: POWER never returns the +180.0 column, which is
# physically identical to the included -180.0 column on the periodic grid
LONS = np.round(np.arange(-180.0, 180.0 - 1e-9, 0.625), 6)        # 576
NLON = LONS.size
N_CELLS = LATS.size * LONS.size
MONTHS = np.array([y * 100 + m for y in range(POWER["start_year"], POWER["end_year"] + 1)
                   for m in range(1, 13)], dtype=int)             # 198101..202512
SEASONS = list(CFG["seasons"].keys())

RAW_DIR = ROOT / "data" / "raw" / "power"
PROC_DIR = ROOT / "data" / "processed"
OUT = ROOT / "frontend" / "public" / "data"

NAN_I16 = -32768
LABEL_CODE = {"detected-increase": 0, "detected-decrease": 1,
              "no-detected-trend": 2, "insufficient-data": 3}


# ---------------------------------------------------------------------------
# Stage: parse (process pool)
# ---------------------------------------------------------------------------

def _parse_one_tile(args):
    """Worker: one .json.gz tile -> (cell indices, seasonal arrays)."""
    path_str, param, fill = args
    import gzip as _gzip
    import json as _json

    import numpy as _np

    from aggregate import aggregate_season as _agg

    with _gzip.open(path_str, "rb") as f:
        doc = _json.loads(f.read())
    idxs, rows = [], []
    for feat in doc["features"]:
        lon, lat = feat["geometry"]["coordinates"][:2]
        i = int(round((float(lat) + 90.0) / 0.5))
        j = int(round((float(lon) + 180.0) / 0.625))
        if lon > 179.9:
            continue  # the +180 column is never returned; -180 covers the seam
        if not (0 <= i < 361 and 0 <= j < NLON):
            raise ValueError(f"tile coordinate outside lattice: {lat},{lon}")
        series = feat["properties"]["parameter"][param]
        monthly = _np.full(MONTHS.size, _np.nan, dtype=_np.float32)
        for k, m in enumerate(MONTHS):
            v = series.get(str(m))
            if v is not None and float(v) > fill + 0.5:
                monthly[k] = float(v)
        idxs.append(i * NLON + j)
        rows.append(monthly)
    if not idxs:
        return [], [], [], []
    monthly_2d = _np.vstack(rows)                       # [cells, 540]
    out_seasons = []
    for season in SEASONS:
        agg = "mean" if _season_aggregation(param) == "mean" else "sum"
        years, vals = _agg(monthly_2d.reshape(monthly_2d.shape[0], 1, monthly_2d.shape[1]),
                           MONTHS, season, agg)
        # aggregate_season returns [n_cells(=lat axis), 1(lon axis), n_years]
        out_seasons.append((years, vals[:, 0, :].astype(_np.float32)))
    return idxs, out_seasons[0], out_seasons[1], out_seasons[2]


def _parse_one_tile_monthly(args):
    """Worker: one .json.gz tile -> (cell indices, raw monthly [cells, 540])."""
    path_str, param, fill = args
    import gzip as _gzip
    import json as _json

    import numpy as _np

    with _gzip.open(path_str, "rb") as f:
        doc = _json.loads(f.read())
    idxs, rows = [], []
    for feat in doc["features"]:
        lon, lat = feat["geometry"]["coordinates"][:2]
        i = int(round((float(lat) + 90.0) / 0.5))
        j = int(round((float(lon) + 180.0) / 0.625))
        if lon > 179.9:
            continue
        if not (0 <= i < 361 and 0 <= j < NLON):
            raise ValueError(f"tile coordinate outside lattice: {lat},{lon}")
        series = feat["properties"]["parameter"][param]
        monthly = _np.full(MONTHS.size, _np.nan, dtype=_np.float32)
        for k, m in enumerate(MONTHS):
            v = series.get(str(m))
            if v is not None and float(v) > fill + 0.5:
                monthly[k] = float(v)
        idxs.append(i * NLON + j)
        rows.append(monthly)
    if not idxs:
        return [], None
    return idxs, _np.vstack(rows)


def _season_aggregation(param: str) -> str:
    for v in CFG["variables"]:
        if v["power_parameter"] == param:
            return v["aggregation"]
    return "mean"


def stage_parse(force: bool = False):
    PROC_DIR.mkdir(parents=True, exist_ok=True)
    for v in CFG["variables"]:
        param = v["power_parameter"]
        done = all((PROC_DIR / f"{param}_{s}.npy").exists() for s in SEASONS)
        if done and not force:
            print(f"parse {param}: cached")
            continue
        files = sorted((RAW_DIR / param).glob("*.json.gz"))
        expected = 36 * 18
        if len(files) < expected:
            raise SystemExit(f"{param}: only {len(files)}/{expected} tiles fetched — "
                             "run fetch_power.py first")
        arrays = {s: np.full((N_CELLS, len(_years_for(s))), np.nan, dtype=np.float32)
                  for s in SEASONS}
        jobs = [(str(p), param, POWER["fill_value"]) for p in files]
        seen = np.zeros(N_CELLS, dtype=bool)
        with ProcessPoolExecutor(max_workers=4) as ex:
            for n_done, (idxs, a0, a1, a2) in enumerate(
                    ex.map(_parse_one_tile, jobs, chunksize=4), 1):
                for season, (years, vals) in zip(SEASONS, (a0, a1, a2)):
                    arrays[season][idxs] = vals
                seen[idxs] = True
                if n_done % 100 == 0:
                    print(f"  {param}: {n_done}/{len(jobs)} tiles")
        if not seen.all():
            miss = int((~seen).sum())
            print(f"  WARNING {param}: {miss} cells never covered (holes -> NaN)")
        for season in SEASONS:
            np.save(PROC_DIR / f"{param}_{season}.npy", arrays[season])
        print(f"parse {param}: saved {SEASONS}")
    (PROC_DIR / "_years.json").write_text(
        json.dumps({s: _years_for(s) for s in SEASONS}))


def _years_for(season: str) -> list[int]:
    y0, y1 = POWER["start_year"], POWER["end_year"]
    if season == "DJF":
        return list(range(y0 + 1, y1 + 1))
    return list(range(y0, y1 + 1))


def _load_years() -> dict:
    doc = json.loads((PROC_DIR / "_years.json").read_text())
    return {s: [int(y) for y in doc[s]] for s in SEASONS}


def stage_monthly(force: bool = False):
    """Region-weighted MONTHLY series for every preset region -> presets_monthly.json.

    Powers the seasonal-cycle reveal (S7) and the deseasonalised view.
    """
    out = OUT / "presets_monthly.json"
    if out.exists() and not force:
        print("monthly: cached")
        return
    from aggregate import region_mask
    n_months = MONTHS.size
    regions = {r["id"]: r["polygon"] for r in CFG["regions"]}
    masks = {rid: region_mask(LONS, LATS, poly).ravel() for rid, poly in regions.items()}
    weights = np.cos(np.deg2rad(LATS))[:, None].repeat(LONS.size, axis=1).ravel()

    doc: dict[str, dict] = {}
    for v in CFG["variables"]:
        param = v["power_parameter"]
        num = {rid: np.zeros(n_months) for rid in regions}
        den = {rid: np.zeros(n_months) for rid in regions}
        files = sorted((RAW_DIR / param).glob("*.json.gz"))
        jobs = [(str(f), param, POWER["fill_value"]) for f in files]
        with ProcessPoolExecutor(max_workers=4) as ex:
            for n_done, (idxs, monthly) in enumerate(
                    ex.map(_parse_one_tile_monthly, jobs, chunksize=4), 1):
                if monthly is None:
                    continue
                vals = monthly.astype(np.float64)
                present = np.isfinite(vals)
                w = weights[idxs]
                for rid, mask in masks.items():
                    sel = mask[idxs]
                    if not sel.any():
                        continue
                        # region outside this tile
                    wp = w[sel]
                    pr = present[sel]
                    vp = np.where(pr, vals[sel], 0.0)
                    num[rid] += (vp * wp[:, None]).sum(axis=0)
                    den[rid] += (np.where(pr, 1.0, 0.0) * wp[:, None]).sum(axis=0)
                if n_done % 200 == 0:
                    print(f"  monthly {param}: {n_done}/{len(jobs)} tiles")
        doc[param] = {}
        for rid in regions:
            with np.errstate(invalid="ignore"):
                series = np.where(den[rid] > 0, num[rid] / den[rid], np.nan)
            doc[param][rid] = {
                "months": [int(m) for m in MONTHS],
                "values": [None if not np.isfinite(x) else round(float(x), 3) for x in series],
            }
        print(f"monthly {param}: done")
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"monthly: {out.stat().st_size/1e6:.2f} MB")


def stage_anomalies(force: bool = False):
    """Precompute exploratory anomaly/change-point results for every preset
    combination -> anomalies.json. Keeps the workspace fully static; the
    backend endpoint becomes an optional duplicate."""
    out = OUT / "anomalies.json"
    if out.exists() and not force:
        print("anomalies: cached")
        return
    from anomaly import candidate_change_points, robust_anomalies
    presets = json.loads((OUT / "presets.json").read_text())
    doc: dict[str, dict] = {}
    n = 0
    for v in CFG["variables"]:
        param = v["power_parameter"]
        doc[param] = {}
        for season in SEASONS:
            for rid, entry in presets.get(param, {}).get(season, {}).items():
                for w in CFG["windows"]:
                    years = [y for y in entry["years"] if w["start"] <= y <= w["end"]]
                    values = [
                        val for y, val in zip(entry["years"], entry["values"])
                        if w["start"] <= y <= w["end"] and val is not None
                    ]
                    # robust_anomalies expects equal-length year/value lists
                    yr2, va2 = [], []
                    for y, val in zip(entry["years"], entry["values"]):
                        if w["start"] <= y <= w["end"] and val is not None:
                            yr2.append(y)
                            va2.append(val)
                    doc[param].setdefault(season, {}).setdefault(rid, {})[w["id"]] = {
                        "anomalies": robust_anomalies(yr2, va2)[:5],
                        "changePoints": candidate_change_points(yr2, va2)[:3],
                    }
                    n += 1
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"anomalies: {n} combinations, {out.stat().st_size/1e6:.2f} MB")


# ---------------------------------------------------------------------------
# Stage: packs
# ---------------------------------------------------------------------------

def stage_packs(force: bool = False):
    years_map = _load_years()
    (OUT / "trends").mkdir(parents=True, exist_ok=True)
    index: dict[str, dict] = {}
    for v in CFG["variables"]:
        param = v["power_parameter"]
        index[param] = {}
        for season in SEASONS:
            path = PROC_DIR / f"{param}_{season}.npy"
            grid = np.load(path)                     # [cells, nYearsSeason]
            years = np.array(years_map[season])
            index[param][season] = {}
            for w in CFG["windows"]:
                f = OUT / "trends" / f"{param}_{season}_{w['id']}.bin.gz"
                meta = OUT / "trends" / f"{param}_{season}_{w['id']}.meta.json"
                if f.exists() and meta.exists() and not force:
                    # resume: index entry from the sidecar metadata
                    m = json.loads(meta.read_text())
                    index[param][season][w["id"]] = {**m, "bytes": f.stat().st_size}
                    continue
                sel = (years >= w["start"]) & (years <= w["end"])
                res = trend_grid_fast(
                    grid[:, sel].astype(np.float64), years[sel],
                    alpha=METHODS["alpha"], min_years=METHODS["min_years"],
                    caution_years=METHODS["caution_years"],
                    conf=METHODS["confidence_level"],
                    fdr_method=METHODS["fdr_method"])
                rng = float(np.nanmax(res["slope"]) - np.nanmin(res["slope"]))
                scale = max(rng / 30000.0, 1e-6)

                def q16(a):
                    out_ = np.rint(a / scale).astype(np.int32)
                    out_ = np.clip(out_, -32767, 32767).astype(np.int16)
                    out_[~np.isfinite(a)] = NAN_I16
                    return out_

                slope = q16(res["slope"])
                ci_lo = q16(res["ci_low"])
                ci_hi = q16(res["ci_high"])
                with np.errstate(divide="ignore", invalid="ignore"):
                    mlogp = np.where(np.isfinite(res["fdr_p"]) & (res["fdr_p"] > 0),
                                     -np.log10(np.maximum(res["fdr_p"], 1e-13)), 13.0)
                pfdr = np.clip(np.rint(mlogp * 20), 0, 255).astype(np.uint8)
                pfdr[~np.isfinite(res["fdr_p"])] = 255
                label = res["label"].astype(np.uint8)
                blob = b"".join(arr.tobytes() for arr in (slope, ci_lo, ci_hi, pfdr, label))
                with open(f, "wb") as fh:
                    fh.write(gzip.compress(blob, compresslevel=6, mtime=0))
                n_eligible = int(np.isfinite(res["slope"]).sum())
                entry = {"file": f.name, "slope_scale": scale, "n_eligible": n_eligible}
                meta.write_text(json.dumps(entry))
                index[param][season][w["id"]] = {**entry, "bytes": f.stat().st_size}
                det = int(((label & 0x7F) == 0).sum() + ((label & 0x7F) == 1).sum())
                print(f"pack {param} {season} {w['id']}: eligible={n_eligible} "
                      f"detected={det} ({f.stat().st_size/1e6:.2f} MB gz)")
    (OUT / "trends_index.json").write_text(json.dumps(index))


# ---------------------------------------------------------------------------
# Stage: presets + gpcp + catalog
# ---------------------------------------------------------------------------

def stage_presets(force: bool = False):
    out = OUT / "presets.json"
    if out.exists() and not force:
        return
    years_map = _load_years()
    presets: dict[str, dict] = {}
    for v in CFG["variables"]:
        param = v["power_parameter"]
        presets[param] = {}
        for season in SEASONS:
            grid = np.load(PROC_DIR / f"{param}_{season}.npy")
            g3 = grid.reshape(LATS.size, LONS.size, grid.shape[1])
            for r in CFG["regions"]:
                s = region_series(g3, LONS, LATS, r["polygon"])
                vals = [None if not math.isfinite(x) else round(float(x), 3)
                        for x in s["values"]]
                presets[param].setdefault(season, {})[r["id"]] = {
                    "years": years_map[season], "values": vals,
                    "n_cells": int(s["n_cells"])}
    out.write_text(json.dumps(presets, separators=(",", ":")))
    print(f"presets: {out.stat().st_size/1e6:.2f} MB")


def stage_catalog():
    # remove stale files from previous builds (keep coastline + packs + index)
    KEEP = {"coastline.json", "grid.json", "catalog.json", "provenance.json",
            "presets.json", "presets_monthly.json", "anomalies.json",
            "missions.json", "gpcp_series.json", "trends_index.json"}
    if OUT.exists():
        for f in OUT.iterdir():
            if f.is_file() and f.name not in KEEP:
                f.unlink()
        old_series = OUT / "series"
        if old_series.is_dir():
            import shutil
            shutil.rmtree(old_series)

    # gpcp regional presets (observed cross-check)
    from gpcp import load_gpcp_domain
    g = load_gpcp_domain()
    years_g, annual_g = aggregate_season(g["data"], g["months"], "annual", "sum")
    # annual "sum" of a mm/day rate yields an annual total, so relabel
    gpcp_out = {"units": "mm/yr", "source_units": g["units"], "source": CFG["gpcp"]["version"],
                "years": [int(y) for y in years_g], "regions": {}}
    for r in CFG["regions"]:
        s = region_series(annual_g, g["lons"], g["lats"], r["polygon"])
        gpcp_out["regions"][r["id"]] = {
            "values": [None if v != v else round(float(v), 2) for v in s["values"]],
            "n_cells": s["n_cells"]}
    (OUT / "gpcp_series.json").write_text(json.dumps(gpcp_out))

    (OUT / "grid.json").write_text(json.dumps({
        "lats": LATS.tolist(), "lons": LONS.tolist(),
        "months_span": [int(MONTHS[0]), int(MONTHS[-1])]}))

    power_manifest_path = RAW_DIR / "fetch_manifest.json"
    power_manifest = (json.loads(power_manifest_path.read_text())
                      if power_manifest_path.exists() else {})
    catalog = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "domain": DOMAIN,
        "variables": CFG["variables"],
        "regions": CFG["regions"],
        "seasons": {k: {"label": v["label"], "months": v["months"],
                        **({"convention": v["convention"]} if "convention" in v else {})}
                    for k, v in CFG["seasons"].items()},
        "windows": [{**w, "frozen": True} for w in CFG["windows"]],
        "presets_file": "presets.json",
        "trends_index_file": "trends_index.json",
        "n_cells": N_CELLS,
        "gpcp": {"regions": sorted(gpcp_out["regions"]),
                 "years": gpcp_out["years"], "units": gpcp_out["units"]},
    }
    (OUT / "catalog.json").write_text(json.dumps(catalog, indent=1))

    provenance = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "engine": "tellus-pipeline 2.0 (global)",
        "datasets": [
            {
                "role": "primary analysis data",
                "name": "NASA POWER Monthly Regional API (source-native MERRA-2 grid)",
                "url": POWER["base_url"],
                "retrieved_utc": power_manifest.get("generated_at"),
                "period": [POWER["start_year"], POWER["end_year"]],
                "variables": [v["power_parameter"] for v in CFG["variables"]],
                "requests": len(power_manifest.get("requests", [])),
            },
            {
                "role": "observed cross-check (precipitation)",
                "name": CFG["gpcp"]["version"],
                "url": CFG["gpcp"]["url"],
                "source": CFG["gpcp"]["source"],
            },
        ],
        "methods": METHODS,
        "grid": {"n_lat": int(LATS.size), "n_lon": int(LONS.size),
                 "lat_step": 0.5, "lon_step": 0.625,
                 "note": "MERRA-2 native resolution retained worldwide; no resampling."},
        "software": {"python": sys.version.split()[0], "numpy": np.__version__,
                     "scipy": __import__("scipy").__version__},
    }
    (OUT / "provenance.json").write_text(json.dumps(provenance, indent=1))
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"catalog: assets total {total/1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all",
                    choices=["all", "parse", "packs", "presets", "monthly", "anomalies", "catalog"])
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.stage in ("all", "parse"):
        stage_parse(args.force)
    if args.stage in ("all", "packs"):
        stage_packs(args.force)
    if args.stage in ("all", "presets"):
        stage_presets(args.force)
    if args.stage in ("all", "monthly"):
        stage_monthly(args.force)
    if args.stage in ("all", "anomalies"):
        stage_anomalies(args.force)
    if args.stage in ("all", "catalog"):
        stage_catalog()


if __name__ == "__main__":
    main()
