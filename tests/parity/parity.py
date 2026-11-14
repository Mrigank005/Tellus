"""Run the Python engine on the shared parity series and compare with the
TypeScript engine's output.

Usage:
    python tests/parity/parity.py            # assumes TS output already exists
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import stats as sps
from scipy.special import erf as scipy_erf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import (classify, fdr_adjust, mann_kendall, ols, pettitt, sen_slope,  # noqa: E402
                   sen_slope_ci, slope_difference, summarize, time_of_emergence,
                   window_scan)


PETTITT_KEYS = ["n", "K", "t", "p", "p_adj", "year", "year_before", "mean_before",
                "mean_after", "sse_step", "sse_line", "step_better", "var_factor", "lag1_r"]
SLOPEDIFF_KEYS = ["label", "n", "slope_a", "slope_b", "se_a", "se_b", "diff", "se_diff",
                  "z", "df", "p", "ci_low", "ci_high"]


def py_engine(doc: dict) -> dict:
    out = {"series": {}, "fdr": {}, "special": {}, "emergence": {},
           "windows": {}, "slopediff": {}, "pettitt": {}}
    ser = doc["series"]
    for i, s in enumerate(ser):
        pt = pettitt(s["x"], s["y"])
        out["pettitt"][s["id"]] = {k: pt.get(k) for k in PETTITT_KEYS}
        if i % 2 == 0 and len(s["x"]) >= 22:
            e = time_of_emergence(s["x"], s["y"])
            out["emergence"][s["id"]] = {
                "status": e["status"], "emergence_year": e["emergence_year"],
                "at_earliest": e.get("at_earliest"),
                "ever_detected": e.get("ever_detected"),
                "path": [p["label"] for p in e["path"]],
            }
        if i % 15 == 0 and len(s["x"]) >= 30:
            w = window_scan(s["x"], s["y"])
            out["windows"][s["id"]] = {
                "labels": [c["label"] for c in w["windows"]],
                "slopes": [c["slope"] for c in w["windows"]],
                "verdict": w["robustness"]["verdict"],
                "n_increase": w["robustness"]["n_increase"],
                "n_decrease": w["robustness"]["n_decrease"],
                "share": w["robustness"]["share"],
            }
        if i % 2 == 0 and i + 1 < len(ser):
            o = ser[i + 1]
            d = slope_difference(s["x"], s["y"], o["x"], o["y"])
            out["slopediff"][f"{s['id']}|{o['id']}"] = {k: d.get(k) for k in SLOPEDIFF_KEYS}
    for s in doc["series"]:
        x, y = s["x"], s["y"]
        mk = mann_kendall(y)
        ci = sen_slope_ci(x, y, mk["var_s"])
        o = ols(x, y)
        summ = summarize(x, y)
        out["series"][s["id"]] = {
            "S": mk["S"], "var_s": mk["var_s"], "z": mk["z"], "p": mk["p"],
            "sen": sen_slope(x, y), "ci_low": ci[0], "ci_high": ci[1],
            "ols_slope": o.slope, "ols_t": o.t, "ols_p": o.p, "ols_r2": o.r2,
            "var_factor": summ.get("var_factor"), "lag1_r": summ.get("lag1_r"),
            "n_eff": summ.get("n_eff"), "mk_p_adj": summ.get("mk_p_adj"),
            "ci_adj_low": summ.get("ci_adj_low"), "ci_adj_high": summ.get("ci_adj_high"),
            "ols_p_adj": summ.get("ols_p_adj"),
            "label": summ.get("label"), "caution": summ.get("caution"),
        }
    adj_bh = fdr_adjust(doc["pvals"], "bh")
    adj_by = fdr_adjust(doc["pvals"], "by")
    out["fdr"] = {"bh": adj_bh.tolist(), "by": adj_by.tolist()}
    out["special"] = {
        "erf_05": scipy_erf(0.5), "erf_2": scipy_erf(2.0),
        "erf_neg1": scipy_erf(-1.0),
        "norm_ppf_975": float(sps.norm.ppf(0.975)),
        "t_p_2_10": float(2 * sps.t.sf(2.0, 10)),
        "t_p_3_44": float(2 * sps.t.sf(3.0, 44)),
    }
    return out


def compare(py: dict, ts: dict) -> int:
    failures = 0

    def check(name, a, b, tol):
        nonlocal failures
        if a is None and b is None:
            return
        if (a is None) != (b is None) or (isinstance(a, float) and isinstance(b, float)
                                          and (math.isnan(a) != math.isnan(b))):
            print(f"  MISMATCH-STRUCT {name}: py={a} ts={b}")
            failures += 1
            return
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) \
                and math.isfinite(a) and math.isfinite(b):
            if abs(a - b) > tol:
                print(f"  MISMATCH {name}: py={a!r} ts={b!r} diff={abs(a - b):.3e}")
                failures += 1

    tolerances = {
        "S": 0, "var_s": 1e-12, "z": 1e-12, "p": 2e-6,
        "sen": 1e-12, "ci_low": 1e-12, "ci_high": 1e-12,
        "ols_slope": 1e-10, "ols_t": 1e-9, "ols_p": 1e-8, "ols_r2": 1e-12,
        "var_factor": 1e-12, "lag1_r": 1e-12, "n_eff": 1e-12,
        "mk_p_adj": 2e-6, "ci_adj_low": 1e-12, "ci_adj_high": 1e-12,
        "ols_p_adj": 1e-9,
        "label": 0, "caution": 0,
    }
    ids = sorted(set(py["series"]) | set(ts["series"]))
    for sid in ids:
        p, t = py["series"].get(sid), ts["series"].get(sid)
        if p is None or t is None:
            print(f"  MISSING series {sid}")
            failures += 1
            continue
        for key, tol in tolerances.items():
            check(f"{sid}.{key}", p[key], t[key], tol if tol else 0)

    # ---- diagnostics: exact structure, tight numeric tolerance --------------
    pet_tol = {"K": 0, "t": 0, "n": 0, "p": 1e-12, "p_adj": 1e-12,
               "year": 0, "year_before": 0, "mean_before": 1e-12,
               "mean_after": 1e-12, "sse_step": 1e-10, "sse_line": 1e-10,
               "step_better": 0, "var_factor": 1e-12, "lag1_r": 1e-12}
    for sid, p in py["pettitt"].items():
        t = ts["pettitt"].get(sid)
        for k, tol in pet_tol.items():
            check(f"pettitt.{sid}.{k}", p[k], None if t is None else t[k], tol)
    sd_tol = {"n": 0, "slope_a": 1e-10, "slope_b": 1e-10, "se_a": 1e-10,
              "se_b": 1e-10, "diff": 1e-10, "se_diff": 1e-10, "z": 1e-8,
              "df": 1e-8, "p": 1e-7, "ci_low": 1e-9, "ci_high": 1e-9}
    for sid, p in py["slopediff"].items():
        t = ts["slopediff"].get(sid)
        if t is None or p["label"] != t["label"]:
            print(f"  MISMATCH slopediff {sid}: {p['label']} vs {None if t is None else t['label']}")
            failures += 1
            continue
        for k, tol in sd_tol.items():
            check(f"slopediff.{sid}.{k}", p[k], t[k], tol)
    for sid, p in py["emergence"].items():
        t = ts["emergence"].get(sid)
        if t is None or p != t:
            print(f"  MISMATCH emergence {sid}: py={p} ts={t}")
            failures += 1
    for sid, p in py["windows"].items():
        t = ts["windows"].get(sid)
        if t is None or p["labels"] != t["labels"] or p["verdict"] != t["verdict"] \
                or p["n_increase"] != t["n_increase"] or p["n_decrease"] != t["n_decrease"]:
            print(f"  MISMATCH windows {sid}")
            failures += 1
            continue
        for i, (a, b) in enumerate(zip(p["slopes"], t["slopes"])):
            check(f"windows.{sid}.slope[{i}]", a, b, 1e-12)
        check(f"windows.{sid}.share", p["share"], t["share"], 1e-12)

    for method in ("bh", "by"):
        pa, ta = py["fdr"][method], ts["fdr"][method]
        if len(pa) != len(ta):
            print(f"  FDR {method} length {len(pa)} vs {len(ta)}")
            failures += 1
            continue
        bad = 0
        for i, (a, b) in enumerate(zip(pa, ta)):
            a, b = float(a), float(b)
            if math.isnan(a) != math.isnan(b) or (
                    math.isfinite(a) and abs(a - b) > 1e-9):
                bad += 1
        if bad:
            print(f"  FDR {method}: {bad} mismatched values")
            failures += 1

    for key, tol in {"erf_05": 2e-7, "erf_2": 2e-7, "erf_neg1": 2e-7,
                     "norm_ppf_975": 1e-8, "t_p_2_10": 1e-12,
                     "t_p_3_44": 1e-12}.items():
        check(f"special.{key}", py["special"][key], ts["special"][key], tol)
    return failures


def main():
    doc = json.loads((HERE / "series.json").read_text())
    py = py_engine(doc)
    (HERE / "parity_py.json").write_text(json.dumps(py))
    ts_path = HERE / "parity_ts.json"
    if not ts_path.exists():
        sys.exit("Run `npm run parity` in frontend/ first to produce parity_ts.json")
    ts = json.loads(ts_path.read_text())
    failures = compare(py, ts)
    n = len(py["series"])
    if failures == 0:
        print(f"PARITY OK — {n} series, FDR, special functions, plus "
              f"{len(py['emergence'])} emergence, {len(py['windows'])} window-scan, "
              f"{len(py['slopediff'])} slope-difference and {len(py['pettitt'])} Pettitt cases match")
    else:
        print(f"PARITY FAILED — {failures} mismatches")
        sys.exit(1)


if __name__ == "__main__":
    main()
