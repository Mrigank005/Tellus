"""API-facing adapter for exploratory anomaly diagnostics."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from anomaly import candidate_change_points, robust_anomalies  # noqa: E402
from .tellus import _series, catalog, _find, variable_info, window_series  # noqa: E402


def analyze_preset_anomalies(
    variable_id: str,
    region_id: str,
    season: str,
    window_id: str,
) -> dict[str, Any]:
    cat = catalog()
    variable = variable_info(variable_id)
    region = _find(cat["regions"], "id", region_id)
    window = _find(cat["windows"], "id", window_id)
    if variable is None or region is None or window is None or season not in cat["seasons"]:
        raise ValueError("Selection contains an unsupported variable, region, season, or window.")
    entry = _series(variable_id, season, region_id)
    years, values = window_series(entry, window)
    return {
        "evidenceId": f"anomalies:{variable_id}:{region_id}:{season}:{window_id}",
        "exploratory": True,
        "variable": {"id": variable_id, "name": variable["short_name"], "units": variable["trend_units"]},
        "region": {"id": region_id, "name": region["name"]},
        "window": {"id": window_id, "label": window["label"]},
        "anomalies": robust_anomalies(years, values),
        "changePoints": candidate_change_points(years, values),
        "limitations": [
            "Candidate events are diagnostic flags, not statistically significant climate findings.",
            "Interpret results alongside the authoritative trend analysis.",
        ],
    }
