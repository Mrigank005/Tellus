"""Build missions.json from downloaded mission / model time series.

Input:  data/raw/missions/<variable-id>/<region-id>.(csv|tsv|txt|dat)
        one file per preset region, saved exactly as the server returned it
        (see pipeline/fetch_missions.py and pipeline/fetch_open_resources.py).
Output: frontend/public/data/missions.json   (same shape as presets.json)
        frontend/public/config-missions.json (copy of config/missions.json)
        data/raw/missions/manifest.json      (what was ingested / skipped, why)

Run:    python pipeline/build_missions.py

File layouts understood (auto-detected):
  * delimited table with a header row containing a time column
    ("time", "date", ...) — Giovanni-style, with any number of metadata lines
    above the header;
  * headerless rows "YYYY-MM[-DD] value", "YYYY MM value",
    "YYYY.fraction value", or "YYYY v1 ... v12" (one row per year).
  Lines starting with '#' are comments. Daily rows are averaged to months.

Per-variable options in config/missions.json:
  aggregation          "mean" | "sum"
  monthly_value_kind   for "sum" variables, what one monthly number is:
                       "total_per_month" (default) | "rate_per_day" |
                       "rate_per_hour" | "rate_per_second" | "accum_per_3h"
  scale, offset        applied to every value first: v * scale + offset
  csv_value_column     header name, or a substring of it, of the value column
                       (default: the last non-time column)
  fill_values          extra missing-value codes (numbers)
  min_days_fraction    daily input: share of the month's days required (0.5)
  min_years            override of methods.min_years for this variable only
                       (must be stated in the variable's caution text)

Rules: missing is never zero; totals need every month; a region with fewer
than `min_years` valid annual values is skipped, never repaired.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from aggregate import aggregate_season, days_in_month  # noqa: E402
from config_loader import load_config  # noqa: E402

RAW = ROOT / "data" / "raw" / "missions"
OUT = ROOT / "frontend" / "public" / "data" / "missions.json"
CONFIG_SRC = ROOT / "config" / "missions.json"
CONFIG_PUBLIC = ROOT / "frontend" / "public" / "config-missions.json"

EXTENSIONS = (".csv", ".tsv", ".txt", ".dat")
COMMON_FILLS = (-999.0, -999.9, -9999.0, -9999.9, -99999.0, -32767.0, -1e30,
                3e33, 1e20, 9.96921e36)
_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"

# value -> mm/day, so aggregate_season("sum") can multiply by days in month
RATE_TO_PER_DAY = {
    "rate_per_day": lambda v, y, m: v,
    "rate_per_hour": lambda v, y, m: v * 24.0,
    "rate_per_second": lambda v, y, m: v * 86400.0,
    "accum_per_3h": lambda v, y, m: v * 8.0,
    "total_per_month": lambda v, y, m: v / days_in_month(y, m),
}


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_timestamp(text: str) -> tuple[int, int, int | None] | None:
    """-> (year, month, day or None). Accepts ISO dates with or without a
    time part, YYYY-MM, YYYY/MM, YYYYMM, YYYYMMDD and decimal years."""
    t = text.strip().strip('"').replace("/", "-")
    t = re.split(r"[T ]", t, maxsplit=1)[0].rstrip("Z")
    for fmt, has_day in (("%Y-%m-%d", True), ("%Y-%m", False),
                         ("%Y%m%d", True), ("%Y%m", False)):
        try:
            d = dt.datetime.strptime(t, fmt)
        except ValueError:
            continue
        if 1800 <= d.year <= 2100:
            return d.year, d.month, (d.day if has_day else None)
    if re.fullmatch(r"\d{4}\.\d+", t):                       # decimal year
        year = int(t[:4])
        month = min(12, int(float("0" + t[4:]) * 12.0) + 1)
        return year, month, None
    return None


def _to_float(cell: str) -> float | None:
    try:
        v = float(cell.strip().strip('"'))
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def _split(line: str, delimiter: str | None) -> list[str]:
    if delimiter is None:
        return line.split()
    return [c.strip() for c in line.split(delimiter)]


def _detect_delimiter(lines: list[str]) -> str | None:
    sample = lines[-min(len(lines), 20):]
    for d in (",", "\t", ";"):
        if sum(d in ln for ln in sample) >= max(1, len(sample) // 2):
            return d
    return None  # whitespace


def _declared_fills(lines: list[str]) -> list[float]:
    """Missing-value codes announced in metadata / comment lines."""
    fills = []
    for ln in lines:
        low = ln.lower()
        if any(k in low for k in ("fill", "missing", "undef", "nodata",
                                  "no data")):
            for tok in re.findall(_NUM, ln):
                v = float(tok)
                if abs(v) >= 99:
                    fills.append(v)
    return fills


def _is_fill(v: float, fills: tuple[float, ...]) -> bool:
    return any(abs(v - f) <= 1e-6 * max(1.0, abs(f)) for f in fills)


def parse_series(path: Path, var: dict) -> tuple[dict[int, float], dict]:
    """Read one file -> ({YYYYMM: monthly value in delivered units}, info)."""
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    all_lines = [ln.rstrip("\r") for ln in text.split("\n") if ln.strip()]
    comments = [ln for ln in all_lines if ln.lstrip().startswith("#")]
    lines = [ln for ln in all_lines if not ln.lstrip().startswith("#")]
    info: dict = {"file": path.name, "layout": None, "rows": 0, "fill_rows": 0}
    if not lines:
        return {}, info
    delimiter = _detect_delimiter(lines)

    # The table starts at the first two consecutive rows that carry a
    # parsable timestamp in the same column. The row just above it is the
    # header if that cell is text. Metadata lines above (for example
    # "Title:,Time Series" or "User Start Date:,2001-01-01") never qualify.
    header_idx, time_col = None, 0
    for i in range(min(len(lines) - 1, 400)):
        a, b = _split(lines[i], delimiter), _split(lines[i + 1], delimiter)
        col = next((j for j in range(min(len(a), len(b)))
                    if parse_timestamp(a[j]) is not None
                    and parse_timestamp(b[j]) is not None), None)
        if col is None:
            continue
        if i > 0:
            above = _split(lines[i - 1], delimiter)
            if (len(above) > col and parse_timestamp(above[col]) is None
                    and re.search(r"[A-Za-z]", above[col])):
                header_idx, time_col = i - 1, col
        break

    fills = tuple(COMMON_FILLS) + tuple(var.get("fill_values", [])) + tuple(
        _declared_fills(comments + lines[: (header_idx or 0)]))
    daily: dict[int, list[float]] = {}
    has_day = False

    def add(year: int, month: int, v: float | None):
        info["rows"] += 1
        if v is None or _is_fill(v, fills):
            info["fill_rows"] += 1
            return
        daily.setdefault(year * 100 + month, []).append(v)

    if header_idx is not None:
        info["layout"] = "table-with-header"
        header = [c.strip().strip('"') for c in _split(lines[header_idx], delimiter)]
        header_l = [h.lower() for h in header]
        value_col = None
        want = (var.get("csv_value_column") or "").strip().lower()
        if want:
            value_col = next((j for j, h in enumerate(header_l)
                              if j != time_col and want in h), None)
        if value_col is None:
            value_col = next((j for j, h in enumerate(header_l)
                              if j != time_col and h in
                              ("value", "mean", "avg", "average", "area_mean")),
                             None)
        if value_col is None:                      # last non-time column
            value_col = max(j for j in range(len(header)) if j != time_col)
        info["value_column"] = header[value_col]
        for ln in lines[header_idx + 1:]:
            cells = _split(ln, delimiter)
            if len(cells) <= max(time_col, value_col):
                continue
            ts = parse_timestamp(cells[time_col])
            if ts is None:
                continue
            has_day = has_day or ts[2] is not None
            add(ts[0], ts[1], _to_float(cells[value_col]))
    else:
        info["layout"] = "headerless"
        for ln in lines:
            cells = _split(ln, delimiter)
            nums = [_to_float(c) for c in cells]
            if (len(cells) == 13 and re.fullmatch(r"\d{4}", cells[0].strip())):
                info["layout"] = "year-row-12-months"
                for m in range(1, 13):
                    add(int(cells[0]), m, nums[m])
                continue
            if (len(cells) >= 3 and re.fullmatch(r"\d{4}", cells[0].strip())
                    and re.fullmatch(r"\d{1,2}", cells[1].strip())
                    and 1 <= int(cells[1]) <= 12):
                add(int(cells[0]), int(cells[1]), nums[-1])
                continue
            if len(cells) >= 2:
                ts = parse_timestamp(cells[0])
                if ts is None:
                    continue
                has_day = has_day or ts[2] is not None
                add(ts[0], ts[1], nums[-1])

    scale = float(var.get("scale", 1.0))
    offset = float(var.get("offset", 0.0))
    min_frac = float(var.get("min_days_fraction", 0.5))
    series: dict[int, float] = {}
    is_daily = has_day and any(len(v) > 1 for v in daily.values())
    info["input_resolution"] = "daily" if is_daily else "monthly"
    for ym, vals in daily.items():
        if is_daily and len(vals) < min_frac * days_in_month(ym // 100, ym % 100):
            continue                              # too few days: month missing
        series[ym] = float(np.mean(vals)) * scale + offset
    return series, info


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def monthly_cube(series: dict[int, float], var: dict) -> tuple[np.ndarray, np.ndarray]:
    """Continuous month axis (gaps = NaN) -> (months[YYYYMM], cube[1,1,n]).

    For "sum" variables the values are converted to a per-day rate, which is
    what aggregate_season multiplies by the days in each month.
    """
    first, last = min(series), max(series)
    months = []
    y, m = first // 100, first % 100
    while y * 100 + m <= last:
        months.append(y * 100 + m)
        m += 1
        if m == 13:
            y, m = y + 1, 1
    kind = var.get("monthly_value_kind", "total_per_month")
    if var["aggregation"] == "sum" and kind not in RATE_TO_PER_DAY:
        raise ValueError(f"{var['id']}: unknown monthly_value_kind {kind!r}")
    cube = np.full((1, 1, len(months)), np.nan)
    for k, ym in enumerate(months):
        v = series.get(ym)
        if v is None:
            continue
        if var["aggregation"] == "sum":
            v = RATE_TO_PER_DAY[kind](v, ym // 100, ym % 100)
        cube[0, 0, k] = v
    return np.array(months, dtype=int), cube


def build_region(series: dict[int, float], var: dict, cfg: dict) -> dict | None:
    """-> {season: {years, values}} or None when the annual record is too short."""
    months, cube = monthly_cube(series, var)
    out = {}
    for season in cfg["seasons"]:
        years, vals = aggregate_season(cube, months, season, var["aggregation"])
        out[season] = {
            "years": [int(y) for y in years],
            "values": [None if v != v else round(float(v), 5) for v in vals[0, 0]],
        }
    # count only years inside the app's analysis period (the frozen windows)
    y0, y1 = cfg["power"]["start_year"], cfg["power"]["end_year"]
    annual = out.get("annual", {"years": [], "values": []})
    n_annual = sum(v is not None and y0 <= y <= y1
                   for y, v in zip(annual["years"], annual["values"]))
    if n_annual < int(var.get("min_years", cfg["methods"]["min_years"])):
        return None
    return out


def build_variable(var: dict, cfg: dict) -> tuple[dict, list[dict]]:
    var_dir = RAW / var["id"]
    built: dict = {}
    log: list[dict] = []
    if not var_dir.is_dir():
        return built, log
    region_ids = {r["id"] for r in cfg["regions"]}
    files = sorted(p for p in var_dir.iterdir()
                   if p.is_file() and p.suffix.lower() in EXTENSIONS)
    for path in files:
        rid = path.stem
        entry = {"variable": var["id"], "region": rid, "file": path.name}
        if rid not in region_ids:
            log.append({**entry, "status": "skipped", "why": "not a preset region id"})
            continue
        series, info = parse_series(path, var)
        entry.update(info)
        if not series:
            log.append({**entry, "status": "skipped", "why": "no parsable rows"})
            continue
        seasons = build_region(series, var, cfg)
        if seasons is None:
            log.append({**entry, "status": "skipped",
                        "why": "fewer than %d complete years in %d-%d" % (int(var.get("min_years", cfg["methods"]["min_years"])), cfg["power"]["start_year"], cfg["power"]["end_year"])})
            continue
        for season, payload in seasons.items():
            built.setdefault(season, {})[rid] = {
                **payload, "n_cells": 0,
                "source": {"instrument": var.get("instrument", ""),
                           "url": var.get("source", "")},
            }
        annual = [v for v in seasons["annual"]["values"] if v is not None]
        log.append({**entry, "status": "ingested",
                    "months": len(series),
                    "span": [min(series), max(series)],
                    "annual_years": len(annual),
                    "annual_mean": round(float(np.mean(annual)), 5)})
    return built, log


def main():
    cfg = load_config()
    missions = json.loads(CONFIG_SRC.read_text(encoding="utf-8"))
    doc: dict = {}
    log: list[dict] = []
    for var in missions["variables"]:
        built, entries = build_variable(var, cfg)
        log += entries
        n_ok = sum(e["status"] == "ingested" for e in entries)
        if built:
            doc[var["id"]] = built
        print(f"missions {var['id']}: {n_ok} region(s) ingested, "
              f"{len(entries) - n_ok} skipped" if entries
              else f"missions {var['id']}: no files in {RAW / var['id']}")
        for e in entries:
            if e["status"] != "ingested":
                print(f"    skip {e['file']}: {e['why']}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    shutil.copyfile(CONFIG_SRC, CONFIG_PUBLIC)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "manifest.json").write_text(json.dumps({
        "built_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "variables": sorted(doc),
        "series": log,
    }, indent=1), encoding="utf-8")
    print(f"missions.json: {len(doc)} variable(s), "
          f"{sum(e['status'] == 'ingested' for e in log)} region series")


if __name__ == "__main__":
    main()
