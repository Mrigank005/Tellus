"""Generate the shared synthetic series for Python<->TypeScript parity tests."""
import json
import sys
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent / "series.json"


def make_series() -> list[dict]:
    series = []
    for s in range(300):
        r = np.random.default_rng(10_000 + s)
        n = int(r.choice([20, 24, 25, 30, 44, 45]))
        slope = float(r.choice([0.0, 0.02, -0.02, 0.05, -0.01, 0.1]))
        noise = float(r.choice([0.05, 0.2, 0.5, 1.0, 2.0]))
        x = np.arange(1981, 1981 + n, dtype=float)
        y = slope * (x - 1981) + r.normal(0, noise, n)
        if s % 7 == 0:                       # inject ties
            y[::5] = np.round(y[::5])
        if s % 11 == 0:                      # inject an outlier
            y[-1] += 6.0
        mask = np.ones(n, dtype=bool)
        if s % 13 == 0:                      # inject missing years
            mask[3:6] = False
        series.append({
            "id": f"synthetic_{s}",
            "x": x[mask].tolist(),
            "y": y[mask].tolist(),
        })
    return series


def main():
    series = make_series()
    # plus one FDR stress vector: 250 uniform-ish p-values with structure
    r = np.random.default_rng(777)
    pvals = np.concatenate([
        r.uniform(0, 0.001, 20),      # strong signals
        r.uniform(0, 1, 200),         # nulls
        [0.0, 1.0, 0.5, 0.25],
    ]).tolist()
    OUT.write_text(json.dumps({"series": series, "pvals": pvals}))
    print(f"wrote {len(series)} series + {len(pvals)} p-values -> {OUT}")


if __name__ == "__main__":
    main()
