"""Generate the aggregation parity fixture: a random monthly grid, aggregated
by the Python reference implementation. The TypeScript port must reproduce
every output value exactly (inputs are rounded so JSON round-trips are exact).
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aggregate import aggregate_season  # noqa: E402

OUT = Path(__file__).resolve().parent / "agg_fixture.json"


def main():
    rng = np.random.default_rng(2026)
    n_lat, n_lon = 4, 5
    months = np.array([y * 100 + m for y in (2021, 2022, 2023) for m in range(1, 13)],
                      dtype=int)
    monthly = np.round(rng.normal(20, 5, (n_lat, n_lon, months.size)), 6)
    # inject realistic pathologies
    monthly[1, 2, 4] = np.nan        # one month missing
    monthly[2, :, 14] = np.nan       # a whole row of one month
    monthly[3, 4, 0] = np.nan
    monthly[0, 0, :] = np.round(monthly[0, 0, :])  # ties (aggregation-irrelevant but harmless)

    cases = {}
    for season in ("annual", "JJAS", "DJF"):
        for agg in ("mean", "sum"):
            years, vals = aggregate_season(monthly, months, season, agg)
            cases[f"{season}|{agg}"] = {
                "years": [int(y) for y in years],
                "values": [[None if v != v else round(float(v), 9) for v in row]
                           for row in vals.reshape(-1, vals.shape[-1])],
            }

    doc = {
        "n_lat": n_lat, "n_lon": n_lon,
        "months": [int(m) for m in months],
        "monthly": [[None if v != v else float(v) for v in cell]
                    for cell in monthly.reshape(-1, months.size)],
        "cases": cases,
    }
    OUT.write_text(json.dumps(doc))
    print(f"wrote {OUT} ({len(cases)} cases, {n_lat * n_lon} cells)")


if __name__ == "__main__":
    main()
