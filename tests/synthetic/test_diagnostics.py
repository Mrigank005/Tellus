"""Synthetic checks for the four time-series diagnostics in pipeline/stats.py:
time of emergence, two-region slope difference, start x end window scan and
the Pettitt change-point test.

Run with: python -m pytest tests/synthetic/test_diagnostics.py -q
"""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import (pettitt, slope_difference, time_of_emergence,  # noqa: E402
                   window_robustness, window_scan)

YEARS = np.arange(1981, 2026, dtype=float)


def ar1(n, phi, rng, sd=1.0):
    e = rng.normal(0, sd, n)
    y = np.empty(n)
    y[0] = e[0]
    for t in range(1, n):
        y[t] = phi * y[t - 1] + e[t]
    return y


# ---------------------------------------------------------------- emergence

def test_emergence_known_slope():
    rng = np.random.default_rng(3)
    y = 0.08 * (YEARS - 1981) + rng.normal(0, 0.4, YEARS.size)
    e = time_of_emergence(YEARS, y)
    assert e["status"] == "emerged"
    assert e["direction"] == 1
    assert 2000 <= e["emergence_year"] <= 2025
    assert e["years_before_end"] == 2025 - e["emergence_year"]
    # stays detected (same sign) for every end year from emergence onwards
    after = [p for p in e["path"] if p["end"] >= e["emergence_year"]]
    assert all(p["label"] == "detected-increase" for p in after)


def test_emergence_decrease_direction():
    rng = np.random.default_rng(4)
    y = -0.08 * (YEARS - 1981) + rng.normal(0, 0.4, YEARS.size)
    e = time_of_emergence(YEARS, y)
    assert e["status"] == "emerged" and e["direction"] == -1


def test_emergence_strong_trend_is_at_earliest():
    y = 0.5 * (YEARS - 1981) + np.random.default_rng(5).normal(0, 0.1, YEARS.size)
    e = time_of_emergence(YEARS, y)
    assert e["emergence_year"] == 2000 and e["at_earliest"]


def test_emergence_noise_rarely_emerges():
    hits = 0
    n_sim = 200
    for s in range(n_sim):
        y = np.random.default_rng(900 + s).normal(0, 1, YEARS.size)
        hits += time_of_emergence(YEARS, y)["status"] == "emerged"
    assert hits / n_sim < 0.12, f"{hits}/{n_sim} noise series 'emerged'"


def test_emergence_reversing_trend_does_not_count():
    # rises through 2000 (end years up to ~2000 are detected INCREASES), then
    # falls back: the full window is not a clear trend, so nothing "emerged"
    # even though the early windows were detected.
    rng = np.random.default_rng(7)
    y = np.where(YEARS <= 2000, 0.15 * (YEARS - 1981),
                 0.15 * 19 - 0.45 * (YEARS - 2000)) + rng.normal(0, 0.3, YEARS.size)
    e = time_of_emergence(YEARS, y)
    early = [p for p in e["path"] if p["end"] <= 2000]
    assert any(p["label"] == "detected-increase" for p in early)
    assert e["status"] == "not-emerged" and e["emergence_year"] is None
    assert e["ever_detected"]


def test_emergence_chain_invariant_on_reversals():
    # whenever a trend emerges, every later end year has the SAME sign and
    # the end year just before the emergence year does not
    n_emerged = 0
    for s in range(60):
        rng = np.random.default_rng(1200 + s)
        turn = int(rng.integers(1995, 2010))
        up = rng.uniform(0.05, 0.2)
        down = rng.uniform(0.02, 0.1)
        y = np.where(YEARS <= turn, up * (YEARS - 1981),
                     up * (turn - 1981) - down * (YEARS - turn))             + rng.normal(0, 0.3, YEARS.size)
        e = time_of_emergence(YEARS, y)
        if e["status"] != "emerged":
            continue
        n_emerged += 1
        full = e["path"][-1]["label"]
        k = next(i for i, p in enumerate(e["path"]) if p["end"] == e["emergence_year"])
        assert all(p["label"] == full for p in e["path"][k:])
        if k > 0:
            assert e["path"][k - 1]["label"] != full
    assert n_emerged > 0


def test_emergence_not_detected_in_full_window():
    rng = np.random.default_rng(8)
    y = rng.normal(0, 1, YEARS.size)
    # make sure the full window is not detected
    while time_of_emergence(YEARS, y)["status"] == "emerged":
        y = rng.normal(0, 1, YEARS.size)
    e = time_of_emergence(YEARS, y)
    assert e["status"] == "not-emerged" and e["emergence_year"] is None


def test_emergence_too_short():
    e = time_of_emergence(YEARS[:15], np.arange(15.0))
    assert e["status"] == "insufficient-data"


# ----------------------------------------------------------- slope difference

def _pair(slope_a, slope_b, rng, noise=0.5, phi=0.3):
    a = slope_a * (YEARS - 1981) + ar1(YEARS.size, phi, rng, noise)
    b = slope_b * (YEARS - 1981) + ar1(YEARS.size, phi, rng, noise)
    return a, b


def test_slope_difference_equal_slopes_mostly_not_different():
    rng = np.random.default_rng(11)
    n_sim, diff = 400, 0
    for _ in range(n_sim):
        a, b = _pair(0.03, 0.03, rng)
        diff += slope_difference(YEARS, a, YEARS, b)["label"] == "differ"
    rate = diff / n_sim
    assert rate < 0.10, f"false-difference rate {rate:.3f}"


def test_slope_difference_very_different_slopes():
    rng = np.random.default_rng(12)
    hits = 0
    for _ in range(100):
        a, b = _pair(0.08, -0.03, rng)
        r = slope_difference(YEARS, a, YEARS, b)
        hits += r["label"] == "differ"
    assert hits == 100
    assert r["ci_low"] > 0 and r["diff"] > 0


def test_slope_difference_ci_matches_p():
    rng = np.random.default_rng(13)
    a, b = _pair(0.03, 0.0, rng)
    r = slope_difference(YEARS, a, YEARS, b)
    excludes_zero = r["ci_low"] > 0 or r["ci_high"] < 0
    assert excludes_zero == (r["p"] < 0.05)
    assert math.isclose(r["diff"], r["slope_a"] - r["slope_b"])
    assert math.isclose(r["z"], r["diff"] / r["se_diff"])


def test_slope_difference_uses_only_common_years():
    rng = np.random.default_rng(14)
    a, b = _pair(0.03, 0.03, rng)
    r_full = slope_difference(YEARS, a, YEARS, b)
    # B only covers the last 25 years; A covers all 45
    r_part = slope_difference(YEARS, a, YEARS[20:], b[20:])
    assert r_full["n"] == 45 and r_part["n"] == 25
    manual = slope_difference(YEARS[20:], a[20:], YEARS[20:], b[20:])
    assert r_part["diff"] == pytest.approx(manual["diff"])
    assert r_part["p"] == pytest.approx(manual["p"])


def test_slope_difference_insufficient_overlap():
    a = np.arange(45.0)
    r = slope_difference(YEARS, a, YEARS[30:], a[30:])
    assert r["label"] == "insufficient-data"


def test_slope_difference_persistence_widens_se():
    rng = np.random.default_rng(15)
    a0 = ar1(YEARS.size, 0.0, rng)
    b0 = ar1(YEARS.size, 0.0, rng)
    a1 = ar1(YEARS.size, 0.7, rng)
    b1 = ar1(YEARS.size, 0.7, rng)
    s0 = slope_difference(YEARS, a0, YEARS, b0)["se_diff"]
    s1 = slope_difference(YEARS, a1, YEARS, b1)["se_diff"]
    assert s1 > s0


# ---------------------------------------------------------------- window scan

def test_window_scan_counts_and_robust_increase():
    rng = np.random.default_rng(21)
    y = 0.08 * (YEARS - 1981) + rng.normal(0, 0.3, YEARS.size)
    ws = window_scan(YEARS, y)
    # 26 start years, 351 windows of >= 20 years in a 45 year record
    assert len(ws["windows"]) == 351
    assert min(w["end"] - w["start"] + 1 for w in ws["windows"]) == 20
    assert ws["robustness"]["verdict"] == "robust-increase"
    assert ws["robustness"]["share"] >= 0.8


def test_window_scan_noise_is_not_a_robust_trend():
    rng = np.random.default_rng(22)
    y = rng.normal(0, 1, YEARS.size)
    ws = window_scan(YEARS, y)
    assert ws["robustness"]["verdict"] in ("robust-none", "depends")
    assert ws["robustness"]["n_increase"] + ws["robustness"]["n_decrease"] \
        < 0.5 * ws["robustness"]["n_windows"]


def test_window_scan_reversal_depends_on_dates():
    y = np.where(YEARS <= 2003, 0.25 * (YEARS - 1981),
                 0.25 * 22 - 0.25 * (YEARS - 2003)) \
        + np.random.default_rng(23).normal(0, 0.3, YEARS.size)
    ws = window_scan(YEARS, y)
    assert ws["robustness"]["verdict"] == "depends"
    assert ws["robustness"]["mixed_signs"]


def test_window_scan_respects_min_years():
    ws = window_scan(YEARS[:25], np.arange(25.0), min_years=18)
    assert len(ws["windows"]) == sum(range(1, 25 - 18 + 2))


def test_window_robustness_thresholds():
    inc, dec, none = "detected-increase", "detected-decrease", "no-detected-trend"
    assert window_robustness([inc] * 8 + [none] * 2)["verdict"] == "robust-increase"
    assert window_robustness([inc] * 7 + [none] * 3)["verdict"] == "depends"
    assert window_robustness([none] * 9 + [inc])["verdict"] == "robust-none"
    assert window_robustness([dec] * 9 + [none])["verdict"] == "robust-decrease"
    assert window_robustness(["insufficient-data"] * 3)["verdict"] == "insufficient-data"
    # insufficient windows are excluded from the denominator
    r = window_robustness([inc] * 8 + [none] * 2 + ["insufficient-data"] * 50)
    assert r["n_windows"] == 10 and r["n_total"] == 60


# -------------------------------------------------------------------- Pettitt

def _pettitt_bruteforce(y):
    n = len(y)
    best, t_best = -1.0, 0
    for t in range(1, n):
        u = sum(np.sign(y[i] - y[j]) for i in range(t) for j in range(t, n))
        if abs(u) > best:
            best, t_best = abs(u), t
    return best, t_best


def test_pettitt_matches_definition():
    rng = np.random.default_rng(31)
    y = rng.normal(0, 1, 30)
    y[18:] += 1.0
    y[::4] = np.round(y[::4])    # ties
    r = pettitt(np.arange(30.0), y)
    K, t = _pettitt_bruteforce(y)
    assert r["K"] == K and r["t"] == t
    n = 30
    assert r["p"] == pytest.approx(min(1.0, 2 * math.exp(-6 * K * K / (n ** 3 + n ** 2))))
    assert r["p_adj"] >= r["p"]


def test_pettitt_finds_step_location():
    errs, hits = [], 0
    for s in range(100):
        rng = np.random.default_rng(500 + s)
        y = rng.normal(0, 0.5, YEARS.size) + (YEARS >= 1998) * 1.5
        r = pettitt(YEARS, y)
        hits += r["p_adj"] < 0.05
        errs.append(abs(r["year"] - 1998))
    assert hits >= 90   # power stays high even after the persistence adjustment
    assert np.median(errs) <= 2


def test_pettitt_step_beats_line_only_for_steps():
    rng = np.random.default_rng(32)
    step = rng.normal(0, 0.4, YEARS.size) + (YEARS >= 2003) * 2.0
    line = 0.06 * (YEARS - 1981) + rng.normal(0, 0.4, YEARS.size)
    assert pettitt(YEARS, step)["step_better"] is True
    assert pettitt(YEARS, line)["step_better"] is False


def test_pettitt_noise_false_alarm_rate():
    n_sim = 400
    naive = adj = 0
    for s in range(n_sim):
        y = np.random.default_rng(7000 + s).normal(0, 1, YEARS.size)
        r = pettitt(YEARS, y)
        naive += r["p"] < 0.05
        adj += r["p_adj"] < 0.05
    assert naive / n_sim < 0.08
    assert adj <= naive


def test_pettitt_persistence_adjustment_reduces_false_alarms():
    n_sim = 400
    naive = adj = 0
    for s in range(n_sim):
        y = ar1(YEARS.size, 0.6, np.random.default_rng(8000 + s))
        r = pettitt(YEARS, y)
        naive += r["p"] < 0.05
        adj += r["p_adj"] < 0.05
    assert adj < naive
    assert adj / n_sim < 0.12


def test_pettitt_direction_and_short_series():
    y = np.r_[np.zeros(15), np.ones(15)] + np.random.default_rng(33).normal(0, 0.1, 30)
    r = pettitt(np.arange(30.0), y)
    assert r["mean_after"] > r["mean_before"]
    assert pettitt(np.arange(8.0), np.arange(8.0))["label"] == "insufficient-data"
