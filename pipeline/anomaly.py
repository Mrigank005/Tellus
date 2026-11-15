"""Exploratory anomaly and change-point diagnostics.

These diagnostics are deliberately separate from Tellus's inferential
trend verdict. They identify candidate events for investigation; they do not
establish causation or statistical significance.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np


def robust_anomalies(
    years: Sequence[float],
    values: Sequence[float],
    *,
    window: int = 7,
    threshold: float = 3.5,
) -> list[dict[str, float | str]]:
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    valid = np.isfinite(x) & np.isfinite(y)
    x, y = x[valid], y[valid]
    if window < 3 or y.size < window:
        return []
    events: list[dict[str, float | str]] = []
    half = window // 2
    # fallback spread when a local neighbourhood has none (identical values):
    # dividing by zero produced score=Infinity, which is not valid JSON and
    # broke the "Exploratory events" tab
    global_scale = 1.4826 * float(np.median(np.abs(y - np.median(y))))
    if global_scale <= 0:
        global_scale = float(np.std(y))
    for i in range(y.size):
        lo, hi = max(0, i - half), min(y.size, i + half + 1)
        neighbourhood = np.delete(y[lo:hi], i - lo)
        if neighbourhood.size < 2:
            continue
        median = float(np.median(neighbourhood))
        mad = float(np.median(np.abs(neighbourhood - median)))
        scale = 1.4826 * mad
        if scale <= 0:
            if y[i] == median or global_scale <= 0:
                continue
            scale = global_scale
        score = abs(float(y[i]) - median) / scale
        if score >= threshold:
            events.append({
                "year": float(x[i]),
                "value": float(y[i]),
                "score": score,
                "kind": "high" if y[i] > median else "low",
            })
    return events


def candidate_change_points(
    years: Sequence[float],
    values: Sequence[float],
    *,
    min_segment: int = 5,
    threshold: float = 2.5,
) -> list[dict[str, float | str]]:
    """Return mean-shift candidates using a transparent split diagnostic."""
    x = np.asarray(years, dtype=float)
    y = np.asarray(values, dtype=float)
    valid = np.isfinite(x) & np.isfinite(y)
    x, y = x[valid], y[valid]
    if y.size < 2 * min_segment:
        return []
    candidates: list[dict[str, float | str]] = []
    for i in range(min_segment, y.size - min_segment + 1):
        left, right = y[:i], y[i:]
        mean_shift = float(np.mean(right) - np.mean(left))
        if abs(mean_shift) <= 1e-12:
            continue
        left_scale = float(np.std(left))
        right_scale = float(np.std(right))
        scale = max((left_scale + right_scale) / 2.0, 1e-12)
        score = abs(mean_shift) / scale
        if score >= threshold:
            candidates.append({
                "year": float(x[i]),
                "meanBefore": float(np.mean(left)),
                "meanAfter": float(np.mean(right)),
                "score": score,
                "kind": "upward-shift" if np.mean(right) > np.mean(left) else "downward-shift",
            })
    candidates.sort(key=lambda item: float(item["score"]), reverse=True)
    return candidates[:10]
