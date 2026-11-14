"""Reference-case tests for aggregation, calendar rules and area weighting.

Run with: python -m pytest tests/reference_cases -q
"""
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aggregate import (aggregate_season, area_fractions_by_category,  # noqa: E402
                       days_in_month, point_in_polygon, region_mask,
                       region_series, season_month_indices)


# ---------------------------------------------------------------- calendar

def test_days_in_month_including_leap_years():
    assert days_in_month(1984, 2) == 29
    assert days_in_month(1985, 2) == 28
    assert days_in_month(2000, 2) == 29
    assert days_in_month(1900, 2) == 28
    assert days_in_month(2025, 6) == 30


def test_djf_maps_december_of_previous_year():
    months = np.array([198112, 198201, 198202, 198212, 198301, 198302])
    m = season_month_indices(months, "DJF")
    # DJF of 1982 = Jan 1982 + Feb 1982 + Dec 1981
    assert set(months[m[1982]].tolist()) == {198112, 198201, 198202}
    assert 1981 not in m  # needs Dec 1980 which is absent


def test_annual_requires_all_twelve_months_to_exist():
    months = np.array([y * 100 + mo for y in (1981, 1982) for mo in range(1, 13)])
    m = season_month_indices(months, "annual")
    assert set(m) == {1981, 1982}
    truncated = months[:-1]  # drop Dec 1982
    m2 = season_month_indices(truncated, "annual")
    assert set(m2) == {1981}


# ---------------------------------------------------------------- aggregation

def _monthly_brick(lats, lons, months, value_fn):
    data = np.empty((len(lats), len(lons), len(months)))
    for i, la in enumerate(lats):
        for j, lo in enumerate(lons):
            for k, mo in enumerate(months):
                data[i, j, k] = value_fn(la, lo, int(mo))
    return data


def test_precipitation_total_hand_check():
    """One cell, one year, mm/day rates -> annual total must equal the
    hand-computed sum of rate x days."""
    months = np.array([1981 * 100 + m for m in range(1, 13)])
    rates = {m: 1.0 for m in range(1, 13)}          # 1 mm/day every month
    data = _monthly_brick([10.0], [80.0], months, lambda la, lo, mo: rates[mo % 100])
    years, out = aggregate_season(data, months, "annual", "sum")
    assert years[0] == 1981
    expected = sum(1.0 * days_in_month(1981, m) for m in range(1, 13))
    assert out[0, 0, 0] == pytest.approx(expected)  # 365.0


def test_missing_month_invalidates_sum_never_zero():
    """A missing month must invalidate the annual total, not understate it."""
    months = np.array([1981 * 100 + m for m in range(1, 13)])
    data = _monthly_brick([10.0], [80.0], months, lambda la, lo, mo: 1.0)
    data[0, 0, 6] = np.nan                           # July missing
    _, out = aggregate_season(data, months, "annual", "sum")
    assert np.isnan(out[0, 0, 0])


def test_mean_allows_some_missing_months():
    months = np.array([1981 * 100 + m for m in range(1, 13)])
    data = _monthly_brick([10.0], [80.0], months, lambda la, lo, mo: float(mo % 100))
    data[0, 0, 0] = np.nan                           # one month missing of 12
    data[0, 0, 6] = np.nan                           # two missing: still >= 10/12
    _, out = aggregate_season(data, months, "annual", "mean")
    assert np.isfinite(out[0, 0, 0])
    data[0, 0, 1] = np.nan; data[0, 0, 2] = np.nan   # four missing of 12 -> invalid
    _, out = aggregate_season(data, months, "annual", "mean")
    assert np.isnan(out[0, 0, 0])


def test_jjas_selection():
    months = np.array([1983 * 100 + m for m in range(1, 13)])
    m = season_month_indices(months, "JJAS")
    assert set(months[m[1983]].tolist()) == {198306, 198307, 198308, 198309}


# ---------------------------------------------------------------- geometry

def test_point_in_polygon_cases():
    square = [[0.0, 0.0], [0.0, 10.0], [10.0, 10.0], [10.0, 0.0]]
    assert point_in_polygon(5.0, 5.0, square)
    assert not point_in_polygon(15.0, 5.0, square)
    assert not point_in_polygon(-0.1, 5.0, square)
    # point exactly on the boundary convention: ray casting is implementation
    # defined there; we accept either but require stability
    tri = [[0.0, 0.0], [4.0, 0.0], [2.0, 4.0]]
    assert point_in_polygon(2.0, 1.0, tri)
    assert not point_in_polygon(3.9, 3.9, tri)


def test_region_mask_grid_counts():
    lons = np.array([0.5, 1.5, 2.5, 3.5])
    lats = np.array([0.5, 1.5, 2.5, 3.5])
    square = [[0.0, 0.0], [0.0, 3.0], [3.0, 3.0], [3.0, 0.0]]
    mask = region_mask(lons, lats, square)
    assert mask.sum() == 9  # 3x3 cell centres inside


def test_cos_lat_weighted_series_hand_check():
    """Two cells at different latitudes, one year: weighted mean by cos(lat)."""
    lons = np.array([80.0, 80.5])
    lats = np.array([0.0, 60.0])
    polygon = [[79.5, -1.0], [79.5, 61.0], [81.0, 61.0], [81.0, -1.0]]
    annual = np.full((2, 2, 1), np.nan)      # [n_lat, n_lon, n_years]
    annual[0, 0, 0] = 2.0                    # cell at lat 0
    annual[1, 1, 0] = 4.0                    # cell at lat 60
    out = region_series(annual, lons, lats, polygon)
    w0, w1 = np.cos(np.deg2rad(0)), np.cos(np.deg2rad(60))
    expected = (2.0 * w0 + 4.0 * w1) / (w0 + w1)
    assert out["values"][0] == pytest.approx(expected)
    assert out["n_cells"] == 4  # all four cell centres fall inside the polygon
    assert out["n_valid"][0] == 2


def test_missing_year_dropped_not_zeroed():
    lons = np.array([80.0])
    lats = np.array([20.0])
    polygon = [[79.0, 19.0], [79.0, 21.0], [81.0, 21.0], [81.0, 19.0]]
    annual = np.array([[[1.0, np.nan, 3.0]]])
    out = region_series(annual, lons, lats, polygon)
    assert out["values"][1] != 0.0
    assert np.isnan(out["values"][1])
    assert out["values"][0] == pytest.approx(1.0)


# ---------------------------------------------------------------- area fractions

def test_area_fractions_sum_and_values():
    lats = np.array([0.0, 30.0, 60.0])
    labels = np.array([["detected-increase", "no-detected-trend"],
                       ["no-detected-trend", "detected-decrease"],
                       ["insufficient-data", "no-detected-trend"]])
    fr = area_fractions_by_category(labels, lats)
    assert sum(fr.values()) == pytest.approx(1.0)
    w = np.cos(np.deg2rad(lats))
    total = 2.0 * w.sum()  # two cells per latitude row
    assert fr["detected-increase"] == pytest.approx(w[0] / total)
    assert fr["detected-decrease"] == pytest.approx(w[1] / total)
