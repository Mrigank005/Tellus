"""The vectorized fast path must reproduce the reference per-series engine
exactly (or to float tolerance) on random grids, including rows with ties,
missing values, and ineligible rows.

Run with: python -m pytest tests/synthetic/test_stats_fast.py -q
"""
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import classify, fdr_adjust, mann_kendall, ols, sen_slope, sen_slope_ci  # noqa: E402
from stats_fast import trend_grid_fast  # noqa: E402

CFG = dict(alpha=0.05, min_years=20, caution_years=25)


def _reference_row(y, x, adj_p):
    from stats import trend_result
    tr = trend_result(x, y)
    sl = tr["sen_slope"]
    c = classify(len(y), adj_p, sl, tr["ols_slope"],
                 CFG["alpha"], CFG["min_years"], CFG["caution_years"])
    code = {"detected-increase": 0, "detected-decrease": 1,
            "no-detected-trend": 2, "insufficient-data": 3}[c["label"]]
    bits = 0x80 if c["caution"] else 0
    if tr["mk_p"] < CFG["alpha"] and adj_p >= CFG["alpha"]:
        bits |= 0x40
    return tr, code | bits


def test_fast_matches_reference_on_mixed_grid():
    rng = np.random.default_rng(123)
    n_cells, n = 240, 45
    x = np.arange(1981, 1981 + n, dtype=float)
    grid = np.empty((n_cells, n))
    for i in range(n_cells):
        slope = rng.choice([0.0, 0.02, -0.03, 0.1, -0.005])
        noise = rng.choice([0.02, 0.2, 1.0])
        grid[i] = slope * (x - 1981) + rng.normal(0, noise, n)
    # inject pathologies
    grid[5, ::4] = np.round(grid[5, ::4])          # ties
    grid[7, 10:16] = np.nan                        # missing years (still 39 valid)
    grid[9, 20:] = np.nan                          # only 20 valid (eligible boundary)
    grid[11, 5:] = np.nan                          # 5 valid -> ineligible
    grid[13, 0] = grid[13, 1] = grid[13, 2]        # more ties
    grid[15, 30:33] = np.nan                       # missing but many valid

    fast = trend_grid_fast(grid, x.astype(int), **CFG)

    eligible = np.isfinite(grid).sum(axis=1) >= CFG["min_years"]
    from stats import trend_result
    pvals = [trend_result(x[np.isfinite(grid[i])], grid[i][np.isfinite(grid[i])])["mk_p_adj"]
             for i in range(n_cells) if eligible[i]]
    adj = fdr_adjust(pvals, "bh")
    adj_map = {i: a for i, a in zip(np.where(eligible)[0], adj)}

    mismatches = 0
    for i in range(n_cells):
        y = grid[i]
        xs, ys = x[np.isfinite(y)], y[np.isfinite(y)]
        if ys.size < CFG["min_years"]:
            assert fast["label"][i] & 0x7F == 3, f"row {i} should be insufficient"
            continue
        tr, code = _reference_row(ys, xs, adj_map[i])
        assert fast["slope"][i] == pytest.approx(tr["sen_slope"], abs=1e-12), f"row {i} slope"
        assert fast["ci_low"][i] == pytest.approx(tr["ci_low"], abs=1e-12), f"row {i} ci_low"
        assert fast["ci_high"][i] == pytest.approx(tr["ci_high"], abs=1e-12), f"row {i} ci_high"
        assert fast["mk_p"][i] == pytest.approx(tr["mk_p"], abs=2e-9), f"row {i} mk_p"
        assert fast["ols_slope"][i] == pytest.approx(tr["ols_slope"], abs=1e-10), f"row {i} ols"
        assert fast["ols_p"][i] == pytest.approx(tr["ols_p"], abs=1e-10), f"row {i} ols_p"
        assert fast["mk_p_adj"][i] == pytest.approx(tr["mk_p_adj"], abs=2e-9), f"row {i} mk_p_adj"
        assert fast["ci_adj_low"][i] == pytest.approx(tr["ci_adj_low"], abs=1e-12), f"row {i} ci_adj_low"
        assert fast["ci_adj_high"][i] == pytest.approx(tr["ci_adj_high"], abs=1e-12), f"row {i} ci_adj_high"
        assert fast["ols_p_adj"][i] == pytest.approx(tr["ols_p_adj"], abs=1e-10), f"row {i} ols_p_adj"
        assert fast["lag1_r"][i] == pytest.approx(tr["lag1_r"], abs=1e-12), f"row {i} lag1_r"
        assert fast["var_factor"][i] == pytest.approx(tr["var_factor"], abs=1e-12), f"row {i} factor"
        assert fast["fdr_p"][i] == pytest.approx(adj_map[i], abs=1e-12)
        assert fast["label"][i] == code, f"row {i} label {fast['label'][i]} != {code}"
        mismatches += 0
    assert mismatches == 0


def test_fast_all_ineligible_short_series():
    x = np.arange(1990, 2010)  # 20 values... use 15 to be ineligible
    x = np.arange(1990, 2005)
    grid = np.random.default_rng(1).normal(size=(50, x.size))
    fast = trend_grid_fast(grid, x, **CFG)
    assert (fast["label"] & 0x7F == 3).all()
    assert np.isnan(fast["slope"]).all()


def test_fast_speed_sanity():
    """A realistic global-sized grid should process in seconds, not hours."""
    import time
    rng = np.random.default_rng(7)
    x = np.arange(1981, 2026)
    grid = 0.02 * (x - 1981)[None, :] + rng.normal(0, 0.5, (200_000, x.size))
    t0 = time.time()
    out = trend_grid_fast(grid, x, **CFG)
    dt = time.time() - t0
    assert np.isfinite(out["slope"]).all()
    # every row carries the same +0.02/yr trend: slopes cluster near truth and
    # the overwhelming majority are detected at alpha=0.05
    assert np.abs(out["slope"] - 0.02).mean() < 0.005
    assert (out["mk_p"] < 0.05).mean() > 0.85  # MK power at this SNR ≈ 0.9
    assert dt < 120, f"fast path too slow: {dt:.1f}s"
