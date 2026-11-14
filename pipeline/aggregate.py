"""Parse raw POWER tiles and build analysis-ready aggregates.

Data rules implemented here (mirrored in the frontend loader/engine):

* POWER's own annual summary keys ("YYYY13") are ignored; annual and seasonal
  values are computed by Tellus from monthly values for transparency.
* Fill value -999 becomes NaN.
* A cell belongs to a region when its centre lies inside the polygon
  (ray casting). Regional means weight cells by cos(latitude).
* Mean-aggregated variables: annual value valid when >= 80% of months are
  present; seasons require every month of the season. Means over present
  months are days-weighted.
* Sum-aggregated variables (mm/day rates -> totals): annual/seasonal values
  are valid only when every month is present; missing months are never
  treated as zero.
* Winter DJF of year N = December of N-1 + January and February of N.
"""
from __future__ import annotations

import calendar
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from config_loader import load_config  # noqa: E402

CFG = load_config()
FILL = CFG["power"]["fill_value"]


# ---------------------------------------------------------------------------
# Tile parsing
# ---------------------------------------------------------------------------

def parse_power_tiles(param: str, raw_dir: Path | None = None) -> dict:
    """Merge all raw tiles of one parameter into a monthly grid.

    Returns {"lats", "lons", "months" (int YYYYMM), "data" [n_lat, n_lon, n_months]}.
    """
    raw_dir = raw_dir or ROOT / "data" / "raw" / "power" / param
    points: dict[tuple[float, float], dict[int, float]] = {}
    for path in sorted(raw_dir.glob("*.json")):
        doc = json.loads(path.read_text())
        for feat in doc["features"]:
            lon, lat = feat["geometry"]["coordinates"][:2]
            series = feat["properties"]["parameter"][param]
            cell = points.setdefault((round(float(lon), 6), round(float(lat), 6)), {})
            for k, v in series.items():
                k_int = int(k)
                if k_int % 100 == 13:      # POWER's own annual key — recompute ourselves
                    continue
                cell[k_int] = float(v)

    lons = np.array(sorted({p[0] for p in points}))
    lats = np.array(sorted({p[1] for p in points}))
    months = sorted({m for cell in points.values() for m in cell})
    months = np.array(months, dtype=int)

    dlat = np.diff(lats)
    dlon = np.diff(lons)
    if dlat.size and (dlat.max() - dlat.min()) > 1e-6:
        raise ValueError(f"non-uniform latitude grid for {param}: {dlat[:3]}")
    if dlon.size and (dlon.max() - dlon.min()) > 1e-6:
        raise ValueError(f"non-uniform longitude grid for {param}: {dlon[:3]}")

    data = np.full((lats.size, lons.size, months.size), np.nan)
    for (lon, lat), cell in points.items():
        i = int(np.searchsorted(lats, lat))
        j = int(np.searchsorted(lons, lon))
        for k, m in enumerate(months):
            v = cell.get(int(m), np.nan)
            if v == FILL or v <= -998.9:
                v = np.nan
            data[i, j, k] = v
    return {"lats": lats, "lons": lons, "months": months, "data": data}


# ---------------------------------------------------------------------------
# Calendar helpers
# ---------------------------------------------------------------------------

def days_in_month(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def month_grid(months: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    years = months // 100
    mo = months % 100
    return years, mo


def season_month_indices(months: np.ndarray, season: str) -> dict[int, np.ndarray]:
    """Map each output year to the month indices that compose it."""
    years, mo = month_grid(months)
    sm = CFG["seasons"][season]["months"]
    if season in ("annual", "JJAS"):
        out = {}
        for y in sorted(set(years.tolist())):
            idx = np.where((years == y) & np.isin(mo, sm))[0]
            if idx.size == len(sm):
                out[y] = idx
        return out
    # DJF: December of y-1, January + February of y
    out = {}
    for y in sorted(set(years.tolist())):
        if y - 1 < int(years.min()):
            continue
        idx_dec = np.where((years == y - 1) & (mo == 12))[0]
        idx_jf = np.where((years == y) & np.isin(mo, [1, 2]))[0]
        if idx_dec.size == 1 and idx_jf.size == 2:
            out[y] = np.concatenate([idx_jf, idx_dec])
    return out


# ---------------------------------------------------------------------------
# Monthly -> annual/seasonal
# ---------------------------------------------------------------------------

def aggregate_season(monthly: np.ndarray, months: np.ndarray, season: str,
                     aggregation: str) -> tuple[np.ndarray, np.ndarray]:
    """Aggregate [n_lat, n_lon, n_months] to [n_lat, n_lon, n_years].

    Returns (years, values). NaN marks invalid year/cell combinations.
    """
    year_map = season_month_indices(months, season)
    n_years = len(year_map)
    out = np.full(monthly.shape[:2] + (n_years,), np.nan)
    years = np.array(sorted(year_map), dtype=int)
    for k, y in enumerate(sorted(year_map)):
        idx = year_map[y]
        sub = monthly[:, :, idx]                       # [n_lat, n_lon, m_season]
        present = np.isfinite(sub)
        n_present = present.sum(axis=2)
        n_needed = len(idx)
        if aggregation == "mean":
            # days-weighted mean over present months
            w = np.empty(sub.shape)
            for c, m in enumerate(idx):
                yy, mm = int(months[m]) // 100, int(months[m]) % 100
                w[:, :, c] = days_in_month(yy, mm)
            w = np.where(present, w, np.nan)
            with np.errstate(invalid="ignore"):
                vals = np.nansum(sub * w, axis=2) / np.nansum(w, axis=2)
            if season == "annual":
                ok = n_present >= math.ceil(0.8 * n_needed)
            else:
                ok = n_present >= math.ceil(0.99 * n_needed)
            vals = np.where(ok, vals, np.nan)
        elif aggregation == "sum":
            # rate (mm/day) -> total (mm); every month must be present
            totals = np.zeros(sub.shape[:2])
            for c, m in enumerate(idx):
                yy, mm = int(months[m]) // 100, int(months[m]) % 100
                totals += np.where(np.isfinite(sub[:, :, c]),
                                   sub[:, :, c] * days_in_month(yy, mm), np.nan)
            vals = np.where(n_present == n_needed, totals, np.nan)
        else:
            raise ValueError(f"unknown aggregation {aggregation!r}")
        out[:, :, k] = vals
    return years, out


# ---------------------------------------------------------------------------
# Geography
# ---------------------------------------------------------------------------

def point_in_polygon(lon: float, lat: float, polygon: list[list[float]]) -> bool:
    """Ray casting; polygon is [[lon, lat], ...] (closed or open ring)."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def region_mask(lons: np.ndarray, lats: np.ndarray,
                polygon: list[list[float]]) -> np.ndarray:
    """Boolean mask [n_lat, n_lon]; True where the cell centre is inside."""
    mask = np.zeros((lats.size, lons.size), dtype=bool)
    for i, la in enumerate(lats):
        for j, lo in enumerate(lons):
            if point_in_polygon(float(lo), float(la), polygon):
                mask[i, j] = True
    return mask


def region_series(annual: np.ndarray, lons: np.ndarray, lats: np.ndarray,
                  polygon: list[list[float]]) -> dict:
    """cos(latitude)-weighted mean series of all cells whose centre is inside.

    Returns {values, n_cells, n_valid_per_year}. NaN years are excluded from
    the weighted mean, never treated as zero.
    """
    mask = region_mask(lons, lats, polygon)
    w = np.cos(np.deg2rad(lats))[:, np.newaxis] * mask  # [n_lat, n_lon]
    sub = annual * mask[:, :, np.newaxis]               # zero outside but masked below
    present = np.isfinite(sub)
    w3 = np.broadcast_to(w[:, :, np.newaxis], sub.shape)
    num = np.nansum(np.where(present, sub, 0.0) * w3, axis=(0, 1))
    den = (np.where(present, w3, 0.0)).sum(axis=(0, 1))
    with np.errstate(invalid="ignore"):
        values = np.where(den > 0, num / den, np.nan)
    in_mask = annual[mask]                                # [n_cells, n_years]
    n_valid = np.isfinite(in_mask).sum(axis=0)
    return {"values": values, "n_cells": int(mask.sum()), "n_valid": n_valid}


def area_fractions_by_category(labels: np.ndarray, lats: np.ndarray,
                               mask: np.ndarray | None = None) -> dict:
    """Fraction of cell area in each category. Area weight ~ cos(latitude)."""
    if mask is None:
        mask = np.ones_like(labels, dtype=bool)
    w = np.broadcast_to(np.cos(np.deg2rad(lats))[:, np.newaxis], labels.shape) * mask
    cats = {}
    total = float(w.sum())
    for cat in ["detected-increase", "detected-decrease", "no-detected-trend",
                "insufficient-data"]:
        sel = (labels == cat) & mask
        cats[cat] = float(w[sel].sum()) / total if total > 0 else 0.0
    return cats
