"""Release gate for the persistence adjustment (S1).

Simulates no-trend AR(1) series and requires the adjusted Mann-Kendall to
hold roughly its nominal false-positive rate, while the naive test is
inflated under persistence — the contrast IS the story.

Adopted correction: variance inflation (1+r)/(1-r) with a bias-corrected
lag-1 residual autocorrelation (Weatherhead 1998 / Santer 2000 form).
Hamed & Rao (1998) was evaluated and rejected: it under-corrected at small n
(see docs/FINAL_PLAN.md and git history).

Run with: python -m pytest tests/synthetic/test_persistence.py -q
"""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import (lag1_residual_autocorr, mann_kendall, ols,  # noqa: E402
                   persistence_variance_factor, sen_slope, trend_result)

ALPHA = 0.05


def ar1(n, phi, rng):
    e = rng.normal(0, 1, n)
    y = np.empty(n)
    y[0] = e[0]
    for t in range(1, n):
        y[t] = phi * y[t - 1] + e[t]
    return y


def adjusted_mk_p(x, y):
    slope = sen_slope(x, y)
    mk = mann_kendall(y)
    r1 = lag1_residual_autocorr(x, y, slope)
    var_adj = mk["var_s"] * persistence_variance_factor(r1)
    if var_adj > 0 and mk["S"] != 0:
        z = (mk["S"] - 1) / math.sqrt(var_adj) if mk["S"] > 0 \
            else (mk["S"] + 1) / math.sqrt(var_adj)
    else:
        z = 0.0
    from stats import SQRT2
    p = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(abs(z) / SQRT2)))
    return min(1.0, max(0.0, p))


@pytest.mark.parametrize("n,phi,lo,hi", [
    (45, 0.0, 0.03, 0.075),
    (45, 0.3, 0.03, 0.09),
    (45, 0.6, 0.03, 0.10),
    (30, 0.6, 0.03, 0.11),
    (20, 0.6, 0.03, 0.12),
])
def test_adjusted_mk_false_positive_rate(n, phi, lo, hi):
    n_sim = 2000
    rng = np.random.default_rng(31_000 + n * 10 + int(phi * 10))
    x = np.arange(n, dtype=float)
    detected_adj = detected_naive = 0
    for _ in range(n_sim):
        y = ar1(n, phi, rng)
        if mann_kendall(y)["p"] < ALPHA:
            detected_naive += 1
        if adjusted_mk_p(x, y) < ALPHA:
            detected_adj += 1
    rate_adj = detected_adj / n_sim
    rate_naive = detected_naive / n_sim
    print(f"n={n} phi={phi}: naive={rate_naive:.3f} adjusted={rate_adj:.3f}")
    assert lo <= rate_adj <= hi, f"adjusted rate {rate_adj:.3f} outside [{lo},{hi}]"
    if phi >= 0.3:
        assert rate_adj < rate_naive, "adjustment must reduce false positives"


@pytest.mark.parametrize("n,phi", [(45, 0.3), (45, 0.6), (30, 0.3)])
def test_power_survives_adjustment(n, phi):
    """A strong real trend must still be detected after the adjustment."""
    rng = np.random.default_rng(77_000 + n)
    x = np.arange(n, dtype=float)
    detected = 0
    n_sim = 500
    for _ in range(n_sim):
        y = 0.05 * x + ar1(n, phi, rng) * 0.3
        if adjusted_mk_p(x, y) < ALPHA:
            detected += 1
    assert detected / n_sim > 0.85, f"power fell to {detected / n_sim:.3f}"


def test_adjustment_is_noop_under_independence():
    """With no persistence the factor stays near 1 and adjusted ~ naive p.

    Mean inflation is slightly above 1 by design: the one-sided clamp
    (r >= 0, never anti-conservative) costs a little conservatism under
    independence — the empirical false-positive rate at phi=0 is ~4.4%.
    """
    rng = np.random.default_rng(5)
    x = np.arange(45, dtype=float)
    factors = []
    for _ in range(300):
        y = rng.normal(0, 1, 45)
        factors.append(trend_result(x, y)["var_factor"])
    assert np.mean(factors) < 1.25


def test_factor_grows_with_persistence():
    x = np.arange(100, dtype=float)
    rng = np.random.default_rng(9)
    f_low = np.mean([persistence_variance_factor(
        lag1_residual_autocorr(x, ar1(100, 0.0, rng), 0.0)) for _ in range(200)])
    rng = np.random.default_rng(10)
    f_high = np.mean([persistence_variance_factor(
        lag1_residual_autocorr(x, ar1(100, 0.6, rng), 0.0)) for _ in range(200)])
    assert f_high > f_low + 1.0  # true inflation at phi=0.6 is 4.0


def test_wider_ci_and_ols_dof():
    x = np.arange(60, dtype=float)
    rng = np.random.default_rng(11)
    y = 0.02 * x + ar1(60, 0.6, rng)
    r = trend_result(x, y)
    assert r["ci_adj_high"] - r["ci_adj_low"] >= r["ci_high"] - r["ci_low"]
    assert r["n_eff"] < 60
    assert r["ols_p_adj"] >= r["ols_p"] - 1e-12
    assert 0.0 <= r["lag1_r"] <= 0.95
