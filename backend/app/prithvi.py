"""Data-ready boundary for the optional Prithvi-WxC research experiment.

The experiment is intentionally not imported into the request path. This
module validates a future input manifest and reports readiness without
silently downloading weights or running an unvalidated model.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PrithviInputSpec:
    data_path: Path
    variables: tuple[str, ...]
    start_year: int
    end_year: int
    spatial_reference: str | None = None


def validate_input_spec(spec: PrithviInputSpec) -> list[str]:
    errors: list[str] = []
    if not spec.data_path.exists():
        errors.append(f"Input data does not exist: {spec.data_path}")
    if not spec.variables:
        errors.append("At least one input variable is required.")
    if spec.start_year > spec.end_year:
        errors.append("start_year must not be after end_year.")
    if not spec.spatial_reference:
        errors.append("A spatial reference is required for reproducible evaluation.")
    return errors


def experiment_status(data_path: str | None = None) -> dict[str, Any]:
    path = Path(data_path) if data_path else None
    return {
        "experiment": "prithvi-wxc",
        "ready": bool(path and path.exists()),
        "inputPath": str(path) if path else None,
        "state": "awaiting-input-data" if not path or not path.exists() else "input-present",
        "message": (
            "Provide the dated input manifest and held-out evaluation split before enabling inference."
            if not path or not path.exists()
            else "Input data is present; validate the manifest before running the experiment."
        ),
    }
