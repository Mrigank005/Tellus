"""Vectorized trend computation for whole-grid map packs.

Computes, for every grid cell at once: Mann-Kendall S/z/p, Sen's slope with
Gilbert CI, OLS slope/t/p, BH-FDR, and classification labels — exactly
matching pipeline/stats.py (the per-series reference). Rows containing ties
or missing values fall back to the reference implementation, so the fast
path only handles the common complete no-tie case and results are identical
by construction + by test (tests/synthetic/test_stats_fast.py).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from scipy.special import erf as erf_vec

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import classify, fdr_adjust, mann_kendall, ols, sen_slope_ci  # noqa: E402

SQRT2 = math.sqrt(2.0)


def _pair_indices(n: int):
    iu, ju = np.triu_indices(n, k=1)
    return iu, ju  # pairs (i, j), i < j


def trend_grid_fast(annual: np.ndarray, years: np.ndarray,
                    alpha: float, min_years: int, caution_years: int,
                    conf: float = 0.95, fdr_method: str = "bh") -> dict:
    """annual: [n_cells, n_years] float (NaN allowed). years: [n_years] ints.

    Returns dict of arrays: slope, ci_low, ci_high, mk_p, fdr_p, ols_slope,
    ols_p, label (0..3 | 0x80 caution), n_valid.
    """
    n_cells, n_years_total = annual.shape
    x = years.astype(np.float64)
    out = {
        "slope": np.full(n_cells, np.nan),
        "ci_low": np.full(n_cells, np.nan),
        "ci_high": np.full(n_cells, np.nan),
        "mk_p": np.full(n_cells, np.nan),
        "fdr_p": np.full(n_cells, np.nan),
        "ols_slope": np.full(n_cells, np.nan),
        "ols_p": np.full(n_cells, np.nan),
        "mk_p_adj": np.full(n_cells, np.nan),
        "ci_adj_low": np.full(n_cells, np.nan),
        "ci_adj_high": np.full(n_cells, np.nan),
        "ols_p_adj": np.full(n_cells, np.nan),
        "lag1_r": np.full(n_cells, np.nan),
        "var_factor": np.full(n_cells, np.nan),
        "label": np.zeros(n_cells, dtype=np.uint8),
        "n_valid": np.zeros(n_cells, dtype=np.uint8),
    }
    out["label"][:] = 3  # insufficient-data default

    n_finite = np.isfinite(annual).sum(axis=1)
    out["n_valid"] = n_finite.astype(np.uint8)
    eligible = n_finite >= min_years
    if not eligible.any():
        return out

    # rows the fast path cannot take: ties or any missing values
    test_rows = annual[eligible]
    finite_mask = np.isfinite(test_rows)
    complete = finite_mask.all(axis=1)
    has_ties = np.zeros(test_rows.shape[0], dtype=bool)
    for r in range(test_rows.shape[0]):
        if complete[r]:
            v = np.unique(test_rows[r])
            if v.size != test_rows.shape[1]:
                has_ties[r] = True

    fast = complete & ~has_ties
    idx_fast = np.where(eligible)[0][fast]
    idx_slow = np.where(eligible)[0][~fast]

    pvals_by_row = {}

    if idx_fast.size:
        Y = annual[idx_fast]                      # [m, n] complete rows
        n = Y.shape[1]
        iu, ju = _pair_indices(n)
        m = Y.shape[0]
        S = np.zeros(m)
        var_s = np.full(m, n * (n - 1) * (2 * n + 5) / 18.0)
        z = np.zeros(m)
        p = np.zeros(m)
        slopes = np.empty((m, iu.size))
        CHUNK = 20_000
        for c0 in range(0, m, CHUNK):
            c1 = min(c0 + CHUNK, m)
            block = Y[c0:c1]
            num = block[:, ju] - block[:, iu]
            S[c0:c1] = np.sign(num).sum(axis=1)
            den = x[ju] - x[iu]
            slopes[c0:c1] = num / den  # den>0 always for annual years
        # z with continuity correction
        pos, zer = S > 0, S == 0
        z[pos] = (S[pos] - 1) / np.sqrt(var_s[pos])
        z[zer] = 0.0
        neg = S < 0
        z[neg] = (S[neg] + 1) / np.sqrt(var_s[neg])
        p = 2.0 * (1.0 - 0.5 * (1.0 + erf_vec(np.abs(z) / SQRT2)))
        p = np.clip(p, 0.0, 1.0)

        slopes.sort(axis=1)
        N = slopes.shape[1]
        med = np.empty(m)
        if N % 2 == 1:
            med = slopes[:, N // 2].copy()
        else:
            med = (slopes[:, N // 2 - 1] + slopes[:, N // 2]) / 2.0
        z_crit = 1.959963984540054 if conf == 0.95 else _norm_ppf(0.5 + conf / 2)
        cterm = z_crit * np.sqrt(var_s)
        rank_low = np.clip(np.round((N - cterm) / 2.0).astype(int) + 0, 1, N)
        rank_high = np.clip(np.round((N + cterm) / 2.0).astype(int) + 1, 1, N)
        rows = np.arange(m)
        ci_lo = slopes[rows, rank_low - 1]
        ci_hi = slopes[rows, rank_high - 1]

        # OLS vectorized
        xm = x.mean()
        ym = Y.mean(axis=1)
        dx = x - xm
        sxx = (dx * dx).sum()
        sxy = ((Y - ym[:, None]) * dx[None, :]).sum(axis=1)
        slope_ols = sxy / sxx
        yhat = ym[:, None] + slope_ols[:, None] * dx[None, :]
        sse = ((Y - yhat) ** 2).sum(axis=1)
        sst = ((Y - ym[:, None]) ** 2).sum(axis=1)
        mse = sse / (n - 2)
        se = np.sqrt(mse / sxx)
        t = slope_ols / se
        from scipy import stats as sps
        p_ols = 2 * sps.t.sf(np.abs(t), n - 2)

        # --- persistence adjustment (mirror of pipeline/stats.py) -----------
        # lag-1 autocorrelation of Sen-detrended residuals, bias-corrected
        # and clamped to [0, 0.95]; variance factor (1+r)/(1-r)
        resid = Y - (ym[:, None] + med[:, None] * dx[None, :])
        d = resid - resid.mean(axis=1, keepdims=True)
        den = (d * d).sum(axis=1)
        num1 = (d[:, :-1] * d[:, 1:]).sum(axis=1)
        r0 = np.where(den > 0, num1 / np.where(den > 0, den, 1.0), 0.0)
        r1 = np.clip((r0 * (n - 1) + 1.0) / (n - 3), 0.0, 0.95)
        factor = (1.0 + r1) / (1.0 - r1)
        var_adj = var_s * factor
        z_adj = np.zeros(m)
        pos, neg = S > 0, S < 0
        z_adj[pos] = (S[pos] - 1) / np.sqrt(var_adj[pos])
        z_adj[neg] = (S[neg] + 1) / np.sqrt(var_adj[neg])
        p_adj = np.clip(2.0 * (1.0 - 0.5 * (1.0 + erf_vec(np.abs(z_adj) / SQRT2))), 0.0, 1.0)
        # adjusted CI ranks from the already-sorted pairwise slopes
        cterm_adj = z_crit * np.sqrt(var_adj)
        rl = np.clip(np.round((N - cterm_adj) / 2.0).astype(int), 1, N)
        rh = np.clip(np.round((N + cterm_adj) / 2.0).astype(int) + 1, 1, N)
        ci_lo_adj = slopes[rows, rl - 1]
        ci_hi_adj = slopes[rows, rh - 1]
        # adjusted OLS: effective-n degrees of freedom, inflated SE
        n_eff = np.clip(n * (1.0 - r1) / (1.0 + r1), 3.0, float(n))
        dof = np.maximum(3, n_eff.astype(int) - 2)
        p_ols_adj = 2 * sps.t.sf(np.abs(t) / np.sqrt(factor), dof)

        out["slope"][idx_fast] = med
        out["ci_low"][idx_fast] = ci_lo
        out["ci_high"][idx_fast] = ci_hi
        out["mk_p"][idx_fast] = p
        out["ols_slope"][idx_fast] = slope_ols
        out["ols_p"][idx_fast] = p_ols
        out["mk_p_adj"][idx_fast] = p_adj
        out["ci_adj_low"][idx_fast] = ci_lo_adj
        out["ci_adj_high"][idx_fast] = ci_hi_adj
        out["ols_p_adj"][idx_fast] = p_ols_adj
        out["lag1_r"][idx_fast] = r1
        out["var_factor"][idx_fast] = factor
        # FDR runs on the persistence-ADJUSTED p-values
        for k, ridx in enumerate(idx_fast):
            pvals_by_row[ridx] = p_adj[k]

    # slow path: rows with ties or missing values — exact reference code
    from stats import trend_result
    for ridx in idx_slow:
        row = annual[ridx]
        xs = x[np.isfinite(row)]
        ys = row[np.isfinite(row)]
        if xs.size < min_years:
            continue
        tr = trend_result(xs, ys, conf)
        out["slope"][ridx] = tr["sen_slope"]
        out["ci_low"][ridx] = tr["ci_low"]
        out["ci_high"][ridx] = tr["ci_high"]
        out["mk_p"][ridx] = tr["mk_p"]
        out["ols_slope"][ridx] = tr["ols_slope"]
        out["ols_p"][ridx] = tr["ols_p"]
        out["mk_p_adj"][ridx] = tr["mk_p_adj"]
        out["ci_adj_low"][ridx] = tr["ci_adj_low"]
        out["ci_adj_high"][ridx] = tr["ci_adj_high"]
        out["ols_p_adj"][ridx] = tr["ols_p_adj"]
        out["lag1_r"][ridx] = tr["lag1_r"]
        out["var_factor"][ridx] = tr["var_factor"]
        pvals_by_row[ridx] = tr["mk_p_adj"]

    # FDR over the eligible family
    rows_sorted = sorted(pvals_by_row)
    pv = np.array([pvals_by_row[r] for r in rows_sorted])
    adj = fdr_adjust(pv, fdr_method)
    lab = np.full(n_cells, 3, dtype=np.uint8)
    for k, ridx in enumerate(rows_sorted):
        sl = out["slope"][ridx]
        ols_sl = out["ols_slope"][ridx]
        c = classify(int(out["n_valid"][ridx]), float(adj[k]), float(sl),
                     float(ols_sl), alpha, min_years, caution_years)
        code = {"detected-increase": 0, "detected-decrease": 1,
                "no-detected-trend": 2, "insufficient-data": 3}[c["label"]]
        bits = 0x80 if c["caution"] else 0
        if out["mk_p"][ridx] < alpha and adj[k] >= alpha:
            bits |= 0x40  # detected by the naive test only (persistence removed it)
        lab[ridx] = code | bits
        out["fdr_p"][ridx] = adj[k]
    out["label"] = lab
    return out


def _pw_slopes(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    n = x.size
    dx = x[np.newaxis, :] - x[:, np.newaxis]
    dy = y[np.newaxis, :] - y[:, np.newaxis]
    iu = np.triu_indices(n, k=1)
    num, den = dy[iu], dx[iu]
    return num[den != 0] / den[den != 0]


def _norm_ppf(q: float) -> float:
    from scipy import stats as sps
    return float(sps.norm.ppf(q))
