"""Parser and unit handling of pipeline/build_missions.py.

The files written here are synthetic test fixtures in a temp directory; no
synthetic value ever reaches data/raw/missions or the app.
"""
import calendar

import pytest

from pipeline.build_missions import build_region, parse_series
from pipeline.config_loader import load_config

CFG = load_config()


def _write(tmp_path, name, text):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def _monthly_rows(y0, y1, value, fmt="{y}-{m:02d}-01"):
    return [f"{fmt.format(y=y, m=m)},{value(y, m)}"
            for y in range(y0, y1 + 1) for m in range(1, 13)]


def test_metadata_lines_header_and_fill_value(tmp_path):
    rows = _monthly_rows(2001, 2022, lambda y, m: -9999.9 if (y, m) == (2005, 7) else 30.0)
    text = "\n".join([
        "Title:,Time Series, Area-Averaged",
        "User Start Date:,2001-01-01T00:00:00Z",
        "Fill Value:,-9999.9",
        "time,mean_GPM_3IMERGM_07_precipitation",
        *rows])
    var = {"id": "X", "aggregation": "sum", "csv_value_column": "GPM_3IMERGM"}
    series, info = parse_series(_write(tmp_path, "r.csv", text), var)
    assert info["layout"] == "table-with-header"
    assert info["value_column"] == "mean_GPM_3IMERGM_07_precipitation"
    assert 200507 not in series and info["fill_rows"] == 1
    assert len(series) == 22 * 12 - 1

    seasons = build_region(series, var, CFG)
    annual = dict(zip(seasons["annual"]["years"], seasons["annual"]["values"]))
    assert annual[2005] is None                      # a missing month voids the total
    assert annual[2006] == pytest.approx(360.0)      # 12 x 30 mm, not 30 x days


def test_rate_per_hour_becomes_annual_total(tmp_path):
    text = "time,precip\n" + "\n".join(_monthly_rows(2001, 2021, lambda y, m: 0.1))
    var = {"id": "X", "aggregation": "sum", "monthly_value_kind": "rate_per_hour"}
    series, _ = parse_series(_write(tmp_path, "r.csv", text), var)
    annual = build_region(series, var, CFG)["annual"]
    by_year = dict(zip(annual["years"], annual["values"]))
    assert by_year[2001] == pytest.approx(0.1 * 24 * 365)
    assert by_year[2004] == pytest.approx(0.1 * 24 * 366)


def test_daily_rows_are_averaged_and_sparse_months_dropped(tmp_path):
    lines = ["time,no2"]
    for y in range(2005, 2026):
        for m in range(1, 13):
            n_days = calendar.monthrange(y, m)[1]
            days = range(1, 4) if (y, m) == (2010, 3) else range(1, n_days + 1)
            lines += [f"{y}-{m:02d}-{d:02d},{2.0 if d % 2 else 4.0}" for d in days]
    var = {"id": "X", "aggregation": "mean", "scale": 10.0}
    series, info = parse_series(_write(tmp_path, "r.csv", "\n".join(lines)), var)
    assert info["input_resolution"] == "daily"
    assert 201003 not in series                      # 3 of 31 days is not a month
    assert series[200501] == pytest.approx(10.0 * (16 * 2.0 + 15 * 4.0) / 31)


def test_short_record_is_skipped_not_repaired(tmp_path):
    text = "time,v\n" + "\n".join(_monthly_rows(2010, 2025, lambda y, m: 1.0))
    var = {"id": "X", "aggregation": "mean"}
    series, _ = parse_series(_write(tmp_path, "r.csv", text), var)
    assert build_region(series, var, CFG) is None


def test_headerless_year_row_layout_with_comments(tmp_path):
    lines = ["# box average, monthly", "# missing value: -999.9"]
    for y in range(2000, 2022):
        vals = ["-999.9" if (y, m) == (2003, 2) else f"{m:.1f}" for m in range(1, 13)]
        lines.append(f"{y} " + " ".join(vals))
    var = {"id": "X", "aggregation": "mean"}
    series, info = parse_series(_write(tmp_path, "r.dat", "\n".join(lines)), var)
    assert info["layout"] == "year-row-12-months"
    assert 200302 not in series and series[200312] == 12.0
