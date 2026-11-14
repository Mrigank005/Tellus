"""Synthetic validation of the Tellus statistics engine.

Run with: python -m pytest tests/synthetic -q
"""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import (classify, fdr_adjust, mann_kendall, ols, sen_slope,  # noqa: E402
                   sen_slope_ci, summarize, trend_result)

RNG = np.random.default_rng(42)


def series(n=45, slope=0.0, noise=1.0, start=1981, seed=None):
    r = np.random.default_rng(seed) if seed is not None else RNG
    x = np.arange(start, start + n, dtype=float)
    y = slope * (x - x[0]) + r.normal(0, noise, n)
    return x, y


# ---------------------------------------------------------------- slopes

@pytest.mark.parametrize("true_slope", [0.02, -0.02, 0.1])
def test_recovers_known_slope(true_slope):
    x, y = series(n=45, slope=true_slope, noise=0.05, seed=7)
    r = trend_result(x, y)
    assert r["sen_slope"] == pytest.approx(true_slope, abs=0.005)
    assert r["ols_slope"] == pytest.approx(true_slope, abs=0.005)
    assert r["mk_p"] < 1e-6
    label = classify(r["n"], r["mk_p"], r["sen_slope"], r["ols_slope"])
    expected = "detected-increase" if true_slope > 0 else "detected-decrease"
    assert label["label"] == expected


def test_sen_exact_on_linear_data():
    x = np.arange(1981, 2026, dtype=float)
    y = 3.0 + 0.05 * (x - 1981)
    assert sen_slope(x, y) == pytest.approx(0.05, abs=1e-12)
    lo, hi = sen_slope_ci(x, y, mann_kendall(y)["var_s"])
    assert lo == pytest.approx(0.05, abs=1e-12)
    assert hi == pytest.approx(0.05, abs=1e-12)


def test_flat_series_no_trend():
    x, y = series(n=45, slope=0.0, noise=1.0, seed=11)
    r = trend_result(x, y)
    assert r["mk_p"] > 0.05
    assert classify(r["n"], r["mk_p"], r["sen_slope"], r["ols_slope"])["label"] \
        == "no-detected-trend"


# ---------------------------------------------------------------- null calibration

def test_null_mk_false_positive_rate():
    """Under no trend, detection at alpha=0.05 should be near 5%."""
    n_sim, n = 2000, 45
    detected = 0
    for s in range(n_sim):
        _, y = series(n=n, slope=0.0, noise=1.0, seed=1000 + s)
        if mann_kendall(y)["p"] < 0.05:
            detected += 1
    rate = detected / n_sim
    # binomial 99% band around 0.05 for n=2000: about +/- 0.011
    assert 0.03 < rate < 0.075, f"false positive rate {rate:.3f}"


def test_null_calibration_becomes_conservative_under_autocorrelation():
    """AR(1) red noise inflates naive MK false positives; we document this
    rather than silently claiming independence."""
    phi = 0.6
    n_sim, n = 500, 45
    detected = 0
    for s in range(n_sim):
        r = np.random.default_rng(5000 + s)
        e = r.normal(0, 1, n)
        y = np.empty(n)
        y[0] = e[0]
        for t in range(1, n):
            y[t] = phi * y[t - 1] + e[t]
        if mann_kendall(y)["p"] < 0.05:
            detected += 1
    rate = detected / n_sim
    assert rate > 0.07  # inflated — this is exactly why the caveat exists


# ---------------------------------------------------------------- MK properties

def test_mk_direction_and_sign():
    x = np.arange(45, dtype=float)
    inc = np.arange(45, dtype=float)
    dec = inc[::-1].copy()
    assert mann_kendall(inc)["S"] > 0 and mann_kendall(inc)["p"] < 0.05
    assert mann_kendall(dec)["S"] < 0 and mann_kendall(dec)["p"] < 0.05


def test_mk_tie_correction():
    y = np.array([1.0, 1.0, 1.0, 2.0, 2.0, 3.0, 1.0, 2.0, 3.0, 3.0,
                  1.0, 2.0, 3.0, 1.0, 2.0, 2.0, 3.0, 3.0, 1.0, 2.0,
                  3.0, 1.0, 2.0, 3.0, 3.0], dtype=float)
    r = mann_kendall(y)
    assert math.isfinite(r["var_s"]) and r["var_s"] > 0
    assert 0.0 <= r["p"] <= 1.0


def test_mk_matches_manual_small_case():
    # y = [1, 2, 3, 4]: S = 6 (all increasing), var_s = 10*... compute by hand:
    # n=4: n(n-1)(2n+5)/18 = 4*3*13/18 = 8.667, no ties
    y = np.array([1.0, 2.0, 3.0, 4.0])
    r = mann_kendall(y)
    assert r["S"] == 6.0
    assert r["var_s"] == pytest.approx(4 * 3 * 13 / 18.0)


# ---------------------------------------------------------------- OLS

def test_ols_matches_scipy():
    x, y = series(n=40, slope=0.03, noise=0.4, seed=3)
    o = ols(x, y)
    from scipy import stats as sps
    res = sps.linregress(x, y)
    assert o.slope == pytest.approx(res.slope)
    assert o.intercept == pytest.approx(res.intercept)
    assert o.p == pytest.approx(res.pvalue)
    assert o.r2 == pytest.approx(res.rvalue ** 2)


def test_ols_robust_ordering_with_outlier_vs_sen():
    """Sen's slope should move far less than OLS when one outlier lands at the end."""
    x = np.arange(1981, 2026, dtype=float)
    y = 10 + 0.02 * (x - 1981) + np.random.default_rng(5).normal(0, 0.1, x.size)
    y[-1] += 5.0  # extreme outlier in the last year
    shift_ols = abs(ols(x, y).slope - 0.02)
    shift_sen = abs(sen_slope(x, y) - 0.02)
    assert shift_sen < shift_ols / 3


# ---------------------------------------------------------------- CI coverage

def test_ci_coverage_across_simulations():
    """~95% of Gilbert CIs should contain the true slope."""
    n_sim, true_slope = 800, 0.03
    covered = 0
    for s in range(n_sim):
        x, y = series(n=45, slope=true_slope, noise=0.5, seed=9000 + s)
        mk = mann_kendall(y)
        lo, hi = sen_slope_ci(x, y, mk["var_s"])
        if lo <= true_slope <= hi:
            covered += 1
    rate = covered / n_sim
    assert 0.90 <= rate <= 0.985, f"CI coverage {rate:.3f}"


# ---------------------------------------------------------------- FDR

def test_bh_matches_manual_example():
    # Classic example: p = [.01, .04, .03, .005] -> BH adj = [.02, .04, .04, .02]
    p = [0.01, 0.04, 0.03, 0.005]
    adj = fdr_adjust(p, "bh")
    assert list(np.round(adj, 6)) == [0.02, 0.04, 0.04, 0.02]


def test_fdr_control_under_independence():
    """With all-true nulls, BH should reject at most ~alpha of families' FDR."""
    n_sim, m = 300, 100
    any_false = 0
    for s in range(n_sim):
        pvals = np.random.default_rng(7000 + s).uniform(size=m)
        adj = fdr_adjust(pvals, "bh")
        if (adj < 0.05).any():
            any_false += 1
    assert any_false / n_sim <= 0.08, f"FDR exceeded: {any_false / n_sim:.3f}"


def test_by_more_conservative_than_bh():
    p = np.array([0.01, 0.02, 0.03, 0.4, 0.5])
    assert (fdr_adjust(p, "by") >= fdr_adjust(p, "bh")).all()


# ---------------------------------------------------------------- classification

def test_insufficient_data_label():
    out = summarize(np.arange(15, dtype=float),
                    np.random.default_rng(1).normal(size=15))
    assert out["label"] == "insufficient-data"


def test_caution_flag_on_short_series():
    # 24 valid observations: above the 20-year eligibility floor but below the
    # 25-observation caution threshold
    x = np.arange(1981, 2005, dtype=float)
    y = 0.05 * (x - 1981) + np.random.default_rng(2).normal(0, 0.1, x.size)
    out = summarize(x, y)
    assert out["label"] == "detected-increase"
    assert out["caution"] is True
    assert any("short series" in r for r in out["caution_reasons"])


def test_nan_years_excluded():
    x = np.arange(1981, 2026, dtype=float)
    y = 0.03 * (x - 1981) + np.random.default_rng(4).normal(0, 0.2, x.size)
    y[10:14] = np.nan
    out = summarize(x, y)
    assert out["n"] == 41
    assert out["label"] in ("detected-increase", "detected-decrease")


def test_determinism():
    x, y = series(n=45, slope=0.01, noise=1.0, seed=99)
    a, b = summarize(x, y), summarize(x, y)
    for key in a:
        assert a[key] == b[key]
