"""Tellus statistical engine (Python reference implementation).

Every function here is mirrored bit-for-bit in frontend/src/engine/stats.ts;
parity is enforced by tests/parity/. Methods follow Gilbert (1987),
"Statistical Methods for Environmental Pollution Monitoring", and
Helsel & Hirsch (2002), "Statistical Methods in Water Resources".

All functions accept 1-D sequences of equal length with NaNs already removed
(caller's responsibility), because missing-data policy belongs to the
aggregation layer, not the tests.
"""
from __future__ import annotations

import math
from typing import NamedTuple, Sequence

import numpy as np
from scipy import stats as sps

SQRT2 = math.sqrt(2.0)


# ---------------------------------------------------------------------------
# Mann-Kendall trend test
# ---------------------------------------------------------------------------

def mann_kendall(values: Sequence[float]) -> dict:
    """Mann-Kendall test, normal approximation with tie and continuity correction.

    Returns S, var_s (tie-corrected), z, p (two-sided). Requires n >= 4;
    the normal approximation is considered acceptable for n >= 10.
    """
    x = np.asarray(values, dtype=float)
    n = x.size
    if n < 4:
        return {"S": np.nan, "var_s": np.nan, "z": np.nan, "p": np.nan, "n": n}

    # S = sum over i<j of sign(x_j - x_i)
    diff = x[np.newaxis, :] - x[:, np.newaxis]  # diff[i, j] = x[j] - x[i]
    iu = np.triu_indices(n, k=1)
    S = float(np.sign(diff[iu]).sum())

    # Tie correction
    _, counts = np.unique(x, return_counts=True)
    tie_term = float(sum(t * (t - 1) * (2 * t + 5) for t in counts if t > 1))
    var_s = (n * (n - 1) * (2 * n + 5) - tie_term) / 18.0

    if var_s <= 0 or S == 0:
        z = 0.0
    elif S > 0:
        z = (S - 1) / math.sqrt(var_s)
    else:
        z = (S + 1) / math.sqrt(var_s)
    p = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(abs(z) / SQRT2)))
    p = min(1.0, max(0.0, p))
    return {"S": S, "var_s": var_s, "z": z, "p": p, "n": n}


# ---------------------------------------------------------------------------
# Sen's slope + Gilbert confidence interval
# ---------------------------------------------------------------------------

def sen_slope(years: Sequence[float], values: Sequence[float]) -> float:
    """Median of all pairwise slopes (y_j - y_i) / (x_j - x_i), i < j."""
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    n = x.size
    if n < 2:
        return float("nan")
    dx = x[np.newaxis, :] - x[:, np.newaxis]
    dy = y[np.newaxis, :] - y[:, np.newaxis]
    iu = np.triu_indices(n, k=1)
    num, den = dy[iu], dx[iu]
    slopes = num[den != 0] / den[den != 0]
    if slopes.size == 0:
        return float("nan")
    return float(np.median(slopes))


def sen_slope_ci(years: Sequence[float], values: Sequence[float],
                 var_s: float, conf: float = 0.95) -> tuple[float, float]:
    """Gilbert (1987) rank-based confidence interval for Sen's slope.

    Ranks are rounded to the nearest integer and clamped to [1, N]; this exact
    convention is mirrored in the TypeScript engine.
    """
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    n = x.size
    if n < 2 or not (var_s > 0):
        return (float("nan"), float("nan"))
    z_crit = float(sps.norm.ppf(0.5 + conf / 2.0))

    dx = x[np.newaxis, :] - x[:, np.newaxis]
    dy = y[np.newaxis, :] - y[:, np.newaxis]
    iu = np.triu_indices(n, k=1)
    num, den = dy[iu], dx[iu]
    slopes = np.sort(num[den != 0] / den[den != 0])
    N = slopes.size
    if N == 0:
        return (float("nan"), float("nan"))

    c = z_crit * math.sqrt(var_s)
    rank_low = int(round((N - c) / 2.0))
    rank_high = int(round((N + c) / 2.0)) + 1
    rank_low = min(max(rank_low, 1), N)
    rank_high = min(max(rank_high, 1), N)
    return (float(slopes[rank_low - 1]), float(slopes[rank_high - 1]))


# ---------------------------------------------------------------------------
# OLS slope + t-test (secondary method)
# ---------------------------------------------------------------------------

class OLSResult(NamedTuple):
    slope: float
    intercept: float
    se: float
    t: float
    p: float
    r2: float


def ols(years: Sequence[float], values: Sequence[float]) -> OLSResult:
    """Ordinary least squares linear trend with two-sided t-test on the slope."""
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    n = x.size
    nan = float("nan")
    if n < 3:
        return OLSResult(nan, nan, nan, nan, nan, nan)
    xm, ym = x.mean(), y.mean()
    sxx = float(((x - xm) ** 2).sum())
    sxy = float(((x - xm) * (y - ym)).sum())
    if sxx == 0:
        return OLSResult(nan, nan, nan, nan, nan, nan)
    slope = sxy / sxx
    intercept = ym - slope * xm
    yhat = intercept + slope * x
    sse = float(((y - yhat) ** 2).sum())
    mse = sse / (n - 2)
    se = math.sqrt(mse / sxx)
    t = slope / se if se > 0 else float("nan")
    p = float(sps.t.sf(abs(t), df=n - 2) * 2.0) if math.isfinite(t) else float("nan")
    sst = float(((y - ym) ** 2).sum())
    r2 = 1.0 - sse / sst if sst > 0 else float("nan")
    return OLSResult(slope, intercept, se, t, p, r2)


# ---------------------------------------------------------------------------
# Multiple-testing correction
# ---------------------------------------------------------------------------

def fdr_adjust(pvals: Sequence[float], method: str = "bh") -> np.ndarray:
    """Adjusted p-values controlling false discovery rate.

    method='bh' (Benjamini-Hochberg, valid under independence/PRDS) or
    'by' (Benjamini-Yekutieli, valid under arbitrary dependence).
    NaN p-values are preserved and excluded from the procedure.
    """
    p = np.asarray(pvals, dtype=float)
    out = np.full_like(p, np.nan)
    ok = np.isfinite(p)
    q = p[ok]
    n = q.size
    if n == 0:
        return out
    if method == "by":
        q = q * float(sum(1.0 / i for i in range(1, n + 1)))
        q = np.clip(q, 0.0, 1.0)
    order = np.argsort(q, kind="stable")
    ranked = q[order]
    adj = ranked * n / (np.arange(n) + 1)
    adj = np.minimum.accumulate(adj[::-1])[::-1]
    adj = np.clip(adj, 0.0, 1.0)
    result = np.empty(n)
    result[order] = adj
    out[ok] = result
    return out


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def classify(n: int, p_adj: float, slope: float, ols_slope: float,
             alpha: float = 0.05, min_years: int = 20,
             caution_years: int = 25) -> dict:
    """Map test results onto Tellus's fixed output vocabulary.

    Returns {label, caution, caution_reasons}. 'caution' is a flag shown
    alongside the label, never a replacement for it.
    """
    reasons: list[str] = []
    if n < min_years or not (p_adj == p_adj) or not (slope == slope):
        return {"label": "insufficient-data", "caution": False,
                "caution_reasons": ["fewer than %d valid observations" % min_years]}

    if p_adj < alpha:
        label = "detected-increase" if slope > 0 else (
            "detected-decrease" if slope < 0 else "no-detected-trend")
    else:
        label = "no-detected-trend"

    if n < caution_years:
        reasons.append("short series (%d observations)" % n)
    if ols_slope == ols_slope and slope != 0 and (ols_slope > 0) != (slope > 0):
        reasons.append("Mann-Kendall and OLS slopes point in opposite directions")
    return {"label": label, "caution": bool(reasons), "caution_reasons": reasons}


# ---------------------------------------------------------------------------
# Persistence (autocorrelation) adjustment — AR(1) effective sample size
#
# Variance of a trend statistic under AR(1) year-to-year persistence inflates
# by (1+r)/(1-r) for lag-1 autocorrelation r (Weatherhead et al. 1998; Santer
# et al. 2000 use this exact form for climate trend detection). We estimate r
# on detrended residuals with a small-sample bias correction, then apply the
# SAME factor to the Mann-Kendall variance, the Sen/Gilbert interval, and the
# OLS t-test (with effective-n degrees of freedom).
#
# Hamed & Rao's (1998) rank-based correction was implemented and evaluated
# first; it under-corrected badly at small n (false positives 15-21% at
# r=0.6 vs 6-8% for this correction in 2000-run simulations), so it was
# rejected. The evaluation lives in tests/synthetic/test_persistence.py.
# ---------------------------------------------------------------------------

def _lag_corr(seq: np.ndarray, k: int) -> float:
    """Biased lag-k autocorrelation: sum (u_t-m)(u_{t+k}-m) / sum (u_t-m)^2."""
    m = seq.mean()
    d = seq - m
    den = float((d * d).sum())
    if den <= 0 or seq.size <= k:
        return 0.0
    return float((d[:-k] * d[k:]).sum() / den)


def lag1_residual_autocorr(years: Sequence[float], values: Sequence[float],
                           slope: float) -> float:
    """Bias-corrected lag-1 autocorrelation of residuals, clamped [0, 0.95].

    Negative year-to-year autocorrelation is treated as 0 (never anti-
    conservative); the Marriott-Pope-style correction (r(n-1)+1)/(n-3)
    removes the strong downward bias of r at climate-record lengths.
    """
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    n = x.size
    resid = y - (y.mean() + slope * (x - x.mean()))
    r0 = _lag_corr(resid, 1)
    if n < 5:
        return min(max(r0, 0.0), 0.95)
    r = (r0 * (n - 1) + 1.0) / (n - 3)
    return min(max(r, 0.0), 0.95)


def persistence_variance_factor(r1: float) -> float:
    """(1+r)/(1-r): variance inflation for AR(1) persistence. Factor >= 1."""
    r1 = min(max(r1, 0.0), 0.95)
    return (1.0 + r1) / (1.0 - r1)


def trend_result(years: Sequence[float], values: Sequence[float],
                 conf: float = 0.95) -> dict:
    """One complete trend analysis of a single series (no FDR).

    Returns both the persistence-adjusted quantities (used for verdicts) and
    the naive ones (shown when they differ).
    """
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    keep = np.isfinite(x) & np.isfinite(y)
    x, y = x[keep], y[keep]
    n = x.size
    if n < 4:
        return {"n": n, "label": "insufficient-data"}
    mk = mann_kendall(y)
    slope = sen_slope(x, y)
    ci = sen_slope_ci(x, y, mk["var_s"], conf)
    o = ols(x, y)

    r1 = lag1_residual_autocorr(x, y, slope)
    factor = persistence_variance_factor(r1)
    var_s_adj = mk["var_s"] * factor
    if var_s_adj > 0 and mk["S"] != 0:
        z_adj = (mk["S"] - 1) / math.sqrt(var_s_adj) if mk["S"] > 0 \
            else (mk["S"] + 1) / math.sqrt(var_s_adj)
    else:
        z_adj = 0.0
    p_adj = 2.0 * (1.0 - 0.5 * (1.0 + math.erf(abs(z_adj) / SQRT2)))
    p_adj = min(1.0, max(0.0, p_adj))
    ci_adj = sen_slope_ci(x, y, var_s_adj, conf)

    n_eff = min(max(n * (1.0 - r1) / (1.0 + r1), 3.0), float(n))
    t_adj = o.t / math.sqrt(factor) if math.isfinite(o.t) else float("nan")
    dof_adj = max(3, int(n_eff) - 2)
    p_ols_adj = float(sps.t.sf(abs(t_adj), dof_adj) * 2.0) \
        if math.isfinite(t_adj) else float("nan")

    return {
        "n": n,
        "sen_slope": slope,
        "ci_low": ci[0],
        "ci_high": ci[1],
        "mk_s": mk["S"], "mk_z": mk["z"], "mk_p": mk["p"],
        "ols_slope": o.slope, "ols_p": o.p, "ols_r2": o.r2,
        # persistence-adjusted quantities
        "var_factor": factor,
        "lag1_r": r1,
        "n_eff": n_eff,
        "mk_z_adj": z_adj, "mk_p_adj": p_adj,
        "ci_adj_low": ci_adj[0], "ci_adj_high": ci_adj[1],
        "ols_p_adj": p_ols_adj,
    }


def summarize(years: Sequence[float], values: Sequence[float],
              alpha: float = 0.05, min_years: int = 20,
              caution_years: int = 25, conf: float = 0.95) -> dict:
    """Trend analysis + classification for one series (regional use,
    p-value unadjusted for multiplicity, but adjusted for persistence)."""
    r = trend_result(years, values, conf)
    if r.get("label") == "insufficient-data":
        return r
    c = classify(r["n"], r["mk_p_adj"], r["sen_slope"], r["ols_slope"],
                 alpha, min_years, caution_years)
    if r["mk_p"] < alpha <= r["mk_p_adj"]:
        reasons = list(c["caution_reasons"])
        reasons.append("detected without the persistence adjustment only")
        c = {"label": c["label"], "caution": True, "caution_reasons": reasons}
    return {**r, **c}


# ===========================================================================
# Time-series diagnostics built on the persistence-adjusted verdict.
# All four functions below are mirrored in frontend/src/engine/stats.ts and
# covered by tests/parity (emergence, window scan, slope difference, Pettitt).
# ===========================================================================

DETECTED = ("detected-increase", "detected-decrease")


def _clean_sorted(years: Sequence[float], values: Sequence[float]):
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    keep = np.isfinite(x) & np.isfinite(y)
    x, y = x[keep], y[keep]
    order = np.argsort(x, kind="stable")
    return x[order], y[order]


# ---------------------------------------------------------------------------
# 1. Time of emergence - "when would we have known?"
# ---------------------------------------------------------------------------

def time_of_emergence(years: Sequence[float], values: Sequence[float],
                      min_years: int = 20, alpha: float = 0.05,
                      caution_years: int = 25) -> dict:
    """Year in which a trend became (and stayed) statistically clear.

    The persistence-adjusted verdict (``summarize``) is recomputed on
    [first year, e] for every candidate end year e from first + min_years - 1
    up to the last year. The *emergence year* is the first e such that the
    verdict is detected with the SAME sign as the full-window verdict for e
    and for every later end year. A trend that was detected early but later
    faded or reversed therefore does not count as emerged until it settles.

    status: 'emerged' | 'not-emerged' | 'insufficient-data'.
    """
    x, y = _clean_sorted(years, values)
    if x.size == 0:
        return {"status": "insufficient-data", "emergence_year": None, "path": []}
    first_end = x[0] + min_years - 1
    ends = [float(e) for e in np.unique(x) if e >= first_end]
    if not ends:
        return {"status": "insufficient-data", "emergence_year": None, "path": []}

    path = []
    for e in ends:
        m = x <= e
        s = summarize(x[m], y[m], alpha, min_years, caution_years)
        path.append({
            "end": int(round(e)),
            "label": s["label"],
            "slope": s.get("sen_slope"),
            "p_adj": s.get("mk_p_adj"),
        })
    full = path[-1]["label"]
    last_year = path[-1]["end"]
    out = {"status": "not-emerged", "emergence_year": None, "direction": 0,
           "last_year": last_year, "first_testable_year": path[0]["end"],
           "years_before_end": None, "at_earliest": False,
           "ever_detected": any(p["label"] in DETECTED for p in path),
           "path": path}
    if full not in DETECTED:
        return out
    k = len(path) - 1
    while k > 0 and path[k - 1]["label"] == full:
        k -= 1
    out.update({
        "status": "emerged",
        "direction": 1 if full == "detected-increase" else -1,
        "emergence_year": path[k]["end"],
        "years_before_end": last_year - path[k]["end"],
        "at_earliest": k == 0,
    })
    return out


# ---------------------------------------------------------------------------
# 2. Difference of two regional trends
# ---------------------------------------------------------------------------

def _t_quantile(conf: float, df: float) -> float:
    return float(sps.t.ppf(0.5 + conf / 2.0, df))


def _adjusted_ols(x: np.ndarray, y: np.ndarray) -> dict:
    """OLS slope with the AR(1)-inflated standard error used throughout.

    se_adj = se_ols * sqrt((1+r)/(1-r)); r is the bias-corrected lag-1
    autocorrelation of residuals about the Sen line (identical to
    ``trend_result``), df = max(3, int(n_eff) - 2).
    """
    n = x.size
    o = ols(x, y)
    r1 = lag1_residual_autocorr(x, y, sen_slope(x, y))
    factor = persistence_variance_factor(r1)
    n_eff = min(max(n * (1.0 - r1) / (1.0 + r1), 3.0), float(n))
    return {"slope": o.slope, "se": o.se * math.sqrt(factor),
            "dof": max(3, int(n_eff) - 2), "lag1_r": r1, "n_eff": n_eff}


def slope_difference(years_a: Sequence[float], values_a: Sequence[float],
                     years_b: Sequence[float], values_b: Sequence[float],
                     min_years: int = 20, alpha: float = 0.05,
                     conf: float = 0.95) -> dict:
    """Test whether two regional trends differ.

    Only years present (and finite) in BOTH series are used. For each series
    the OLS slope and its persistence-adjusted standard error are computed
    (OLS is used because its SE is closed-form; Sen's slope has no exact SE).
    Then

        z = (b_A - b_B) / sqrt(se_A^2 + se_B^2)

    is referred to a Student-t with Welch-Satterthwaite degrees of freedom
    (built from the two effective-n df), which approaches the normal when the
    effective sample is large and is conservative when it is small. The CI of
    the difference uses the same t quantile. The test assumes the regional
    series are independent: callers must warn when the regions overlap.

    label: 'differ' | 'no-evidence' | 'insufficient-data'. Slopes are per year.
    """
    xa, ya = _clean_sorted(years_a, values_a)
    xb, yb = _clean_sorted(years_b, values_b)
    common = np.intersect1d(xa, xb)
    ia = np.isin(xa, common)
    ib = np.isin(xb, common)
    x, a, b = xa[ia], ya[ia], yb[ib]
    n = x.size
    if n < min_years or n < 5:
        return {"label": "insufficient-data", "n": n}
    A, B = _adjusted_ols(x, a), _adjusted_ols(x, b)
    va, vb = A["se"] ** 2, B["se"] ** 2
    v = va + vb
    if not (v > 0) or not math.isfinite(v):
        return {"label": "insufficient-data", "n": n}
    diff = A["slope"] - B["slope"]
    se = math.sqrt(v)
    z = diff / se
    df = v * v / (va * va / A["dof"] + vb * vb / B["dof"])
    p = float(sps.t.sf(abs(z), df) * 2.0)
    tq = _t_quantile(conf, df)
    return {
        "label": "differ" if p < alpha else "no-evidence",
        "n": n, "slope_a": A["slope"], "slope_b": B["slope"],
        "se_a": A["se"], "se_b": B["se"], "diff": diff, "se_diff": se,
        "z": z, "df": df, "p": p,
        "ci_low": diff - tq * se, "ci_high": diff + tq * se,
        "lag1_r_a": A["lag1_r"], "lag1_r_b": B["lag1_r"],
    }


# ---------------------------------------------------------------------------
# 3. Start-year x end-year window scan + robustness verdict
# ---------------------------------------------------------------------------

ROBUST_SHARE = 0.80        # >= 80% of windows detect the same direction
OPPOSITE_MAX_SHARE = 0.05  # ... and <= 5% detect the opposite direction


def window_robustness(labels: Sequence[str]) -> dict:
    """Summarise window verdicts. Windows with insufficient data are excluded.

    robust-increase / robust-decrease: >= 80% of windows detect that direction
    and <= 5% detect the opposite one. robust-none: >= 80% detect nothing.
    Otherwise 'depends' (the finding depends on the dates chosen).
    """
    labs = [l for l in labels if l != "insufficient-data"]
    n = len(labs)
    n_inc = sum(1 for l in labs if l == "detected-increase")
    n_dec = sum(1 for l in labs if l == "detected-decrease")
    n_none = n - n_inc - n_dec
    out = {"n_windows": n, "n_total": len(labels), "n_increase": n_inc,
           "n_decrease": n_dec, "n_none": n_none}
    if n == 0:
        return {**out, "verdict": "insufficient-data", "share": 0.0,
                "mixed_signs": False}
    si, sd, sn = n_inc / n, n_dec / n, n_none / n
    if si >= ROBUST_SHARE and sd <= OPPOSITE_MAX_SHARE:
        verdict, share = "robust-increase", si
    elif sd >= ROBUST_SHARE and si <= OPPOSITE_MAX_SHARE:
        verdict, share = "robust-decrease", sd
    elif sn >= ROBUST_SHARE:
        verdict, share = "robust-none", sn
    else:
        verdict, share = "depends", max(si, sd, sn)
    return {**out, "verdict": verdict, "share": share,
            "mixed_signs": si > OPPOSITE_MAX_SHARE and sd > OPPOSITE_MAX_SHARE}


def window_scan(years: Sequence[float], values: Sequence[float],
                min_years: int = 20, alpha: float = 0.05,
                caution_years: int = 25) -> dict:
    """Persistence-adjusted verdict + Sen slope for EVERY window [y0, y1]
    with y1 - y0 + 1 >= min_years inside the record."""
    x, y = _clean_sorted(years, values)
    windows = []
    if x.size:
        first, last = int(round(x[0])), int(round(x[-1]))
        for y0 in range(first, last - min_years + 2):
            for y1 in range(y0 + min_years - 1, last + 1):
                m = (x >= y0) & (x <= y1)
                s = summarize(x[m], y[m], alpha, min_years, caution_years)
                windows.append({
                    "start": y0, "end": y1, "n": s["n"], "label": s["label"],
                    "slope": s.get("sen_slope"), "p_adj": s.get("mk_p_adj"),
                })
    return {"windows": windows,
            "robustness": window_robustness([w["label"] for w in windows])}


# ---------------------------------------------------------------------------
# 4. Pettitt (1979) change-point test
# ---------------------------------------------------------------------------

def pettitt(years: Sequence[float], values: Sequence[float]) -> dict:
    """Pettitt's non-parametric single change-point test.

    U_t = sum_{i<=t} sum_{j>t} sgn(x_i - x_j); K = max_t |U_t|; the change
    sits after the first t (earliest maximiser) observations. Textbook
    p = 2 exp(-6 K^2 / (n^3 + n^2)), capped at 1. The test assumes
    independent observations, so the same AR(1) variance factor used for the
    trend tests is applied to give ``p_adj`` (K^2 divided by the factor);
    the app gates and reports on ``p_adj``. Requires n >= 10. Note a steady
    trend can also trigger it, which is why the app labels it exploratory.
    """
    x, y = _clean_sorted(years, values)
    n = x.size
    if n < 10:
        return {"n": n, "label": "insufficient-data"}
    # U_t = U_{t-1} + V_t,  V_t = sum_j sgn(x_t - x_j)
    v = np.sign(y[:, np.newaxis] - y[np.newaxis, :]).sum(axis=1)
    u = np.cumsum(v)[:-1]           # t = 1 .. n-1
    absu = np.abs(u)
    t = int(np.argmax(absu)) + 1    # first maximiser = size of the first segment
    K = float(absu[t - 1])
    denom = float(n) ** 3 + float(n) ** 2
    p = min(1.0, 2.0 * math.exp(-6.0 * K * K / denom))
    r1 = lag1_residual_autocorr(x, y, sen_slope(x, y))
    factor = persistence_variance_factor(r1)
    p_adj = min(1.0, 2.0 * math.exp(-6.0 * K * K / (denom * factor)))
    # does a step (two means) describe the data better than a straight line?
    # A steady trend also produces a significant Pettitt result, so the UI
    # tells the two apart with this flag.
    sse_step = float(((y[:t] - y[:t].mean()) ** 2).sum()
                     + ((y[t:] - y[t:].mean()) ** 2).sum())
    o = ols(x, y)
    sse_line = float(((y - (o.intercept + o.slope * x)) ** 2).sum())
    return {
        "n": n, "K": K, "t": t,
        "sse_step": sse_step, "sse_line": sse_line,
        "step_better": bool(sse_step < sse_line),
        "year_before": float(x[t - 1]), "year": float(x[t]),
        "mean_before": float(y[:t].mean()), "mean_after": float(y[t:].mean()),
        "p": p, "p_adj": p_adj, "var_factor": factor, "lag1_r": r1,
    }
