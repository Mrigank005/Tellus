"""Read-only adapters over Tellus's generated catalog and preset data."""

from __future__ import annotations

import json
import math
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DATA = ROOT / "frontend" / "public" / "data"
sys.path.insert(0, str(ROOT / "pipeline"))

from stats import slope_difference, summarize  # noqa: E402

from .intent import resolve  # noqa: E402


@lru_cache(maxsize=1)
def catalog() -> dict[str, Any]:
    return json.loads((FRONTEND_DATA / "catalog.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def presets() -> dict[str, Any]:
    return json.loads((FRONTEND_DATA / "presets.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def missions_data() -> dict[str, Any]:
    """Regional satellite/model/station series: {variableId: {season: {regionId: entry}}}."""
    path = FRONTEND_DATA / "missions.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


@lru_cache(maxsize=1)
def mission_variables() -> dict[str, dict[str, Any]]:
    """Mission variable metadata, limited to variables that actually have data."""
    for path in (FRONTEND_DATA.parent / "config-missions.json", ROOT / "config" / "missions.json"):
        if path.exists():
            config = json.loads(path.read_text(encoding="utf-8"))
            data = missions_data()
            return {v["id"]: v for v in config.get("variables", []) if v["id"] in data}
    return {}


def _mission_url(variable_id: str) -> str:
    if variable_id.startswith("KNMI_"):
        return "https://climexp.knmi.nl/"
    if variable_id.startswith("NCEI_"):
        return "https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-monthly"
    return "https://giovanni.gsfc.nasa.gov/giovanni/"


def _find(items: list[dict[str, Any]], key: str, value: str) -> dict[str, Any] | None:
    return next((item for item in items if item.get(key) == value), None)


def variable_info(variable_id: str) -> dict[str, Any] | None:
    """Unified variable metadata for MERRA-2 preset and mission variables."""
    cat = catalog()
    variable = _find(cat["variables"], "id", variable_id)
    if variable is not None:
        return {
            "id": variable_id, "short_name": variable["short_name"], "units": variable["units"],
            "trend_units": variable["trend_units"], "source_type": "model",
            "instrument": "NASA POWER (MERRA-2 reanalysis)",
            "source": "NASA POWER monthly/annual API, MERRA-2",
            "caution": None, "counters": [], "min_years": None, "mission": False,
        }
    mission = mission_variables().get(variable_id)
    if mission is not None:
        return {
            "id": variable_id, "short_name": mission["short_name"], "units": mission["units"],
            "trend_units": mission["trend_units"], "source_type": mission.get("source_type", "mission"),
            "instrument": mission.get("instrument"), "source": mission.get("source"),
            "caution": mission.get("caution"), "counters": list(mission.get("counters") or []),
            "min_years": mission.get("min_years"), "mission": True,
        }
    return None


def selection_options() -> dict[str, Any]:
    cat = catalog()
    variables = [
        {"id": v["id"], "name": v["short_name"], "units": v["units"], "suitableFor": v["suitable_for"],
         "sourceType": "model"}
        for v in cat["variables"]
    ]
    for vid, m in mission_variables().items():
        regions = sorted(missions_data().get(vid, {}).get("annual", {}))
        variables.append({
            "id": vid, "name": m["short_name"], "units": m["units"],
            "suitableFor": m.get("suitable_for", ""), "sourceType": m.get("source_type", "mission"),
            "instrument": m.get("instrument"), "counters": list(m.get("counters") or []),
            "regions": regions,
        })
    return {
        "variables": variables,
        "regions": [{"id": r["id"], "name": r["name"]} for r in cat["regions"]],
        "seasons": [{"id": key, "label": value["label"]} for key, value in cat["seasons"].items()],
        "windows": [{"id": w["id"], "label": w["label"], "start": w["start"], "end": w["end"]} for w in cat["windows"]],
    }


def _series(variable_id: str, season: str, region_id: str) -> dict[str, Any]:
    cat = catalog()
    variable = _find(cat["variables"], "id", variable_id)
    if variable is None:
        if variable_id in mission_variables():
            entry = missions_data().get(variable_id, {}).get(season, {}).get(region_id)
            if entry is None:
                raise ValueError(f"No {variable_id} series for {region_id} ({season}); "
                                 "the record was too short or the region is not covered.")
            return entry
        raise ValueError(f"Unsupported variable: {variable_id}")
    entry = presets().get(variable["power_parameter"], {}).get(season, {}).get(region_id)
    if entry is None:
        raise ValueError(f"No preset series for {variable_id}/{season}/{region_id}")
    return entry


def window_series(entry: dict[str, Any], window: dict[str, Any]) -> tuple[list[int], list[float]]:
    """Years/values inside the window; missing (null/NaN) years are dropped, never filled."""
    years: list[int] = []
    values: list[float] = []
    for year, value in zip(entry["years"], entry["values"]):
        if window["start"] <= year <= window["end"] and value is not None and not math.isnan(value):
            years.append(year)
            values.append(value)
    return years, values


def analyze_preset(
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
    methods = cat.get("methods") or _default_methods()
    min_years = variable["min_years"] or methods.get("min_years", 20)
    result = summarize(
        years,
        values,
        alpha=methods.get("alpha", 0.05),
        min_years=min_years,
        caution_years=max(methods.get("caution_years", 25), min_years),
        conf=methods.get("confidence_level", 0.95),
    )
    evidence_id = f"analysis:{variable_id}:{region_id}:{season}:{window_id}"
    output: dict[str, Any] = {
        "evidenceId": evidence_id,
        "variable": {
            "id": variable_id, "name": variable["short_name"], "units": variable["trend_units"],
            "sourceType": variable["source_type"], "instrument": variable["instrument"],
            "source": variable["source"],
        },
        "region": {"id": region_id, "name": region["name"]},
        "season": {"id": season, "label": cat["seasons"][season]["label"]},
        "window": {"id": window_id, "label": window["label"], "start": window["start"], "end": window["end"]},
        "nCells": entry.get("n_cells", 0),
        "minYears": min_years,
        "result": _json_safe(result),
    }
    # per-decade restatements (the units shown to people) so answers can quote
    # them and the grounding check can still verify every number
    if result.get("sen_slope") is not None:
        output["perDecade"] = _json_safe({
            "senSlope": result["sen_slope"] * 10,
            "ciLow": (result.get("ci_adj_low") if result.get("ci_adj_low") is not None else result.get("ci_low", float("nan"))) * 10,
            "ciHigh": (result.get("ci_adj_high") if result.get("ci_adj_high") is not None else result.get("ci_high", float("nan"))) * 10,
            "units": variable["trend_units"],
        })
    if variable["caution"]:
        output["caution"] = variable["caution"]
    if variable["counters"]:
        output["counters"] = variable["counters"]
    return output


def _default_methods() -> dict[str, Any]:
    path = ROOT / "config" / "methods.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def compare_presets(
    variable_id: str,
    region_a: str,
    region_b: str,
    season: str,
    window_id: str,
) -> dict[str, Any]:
    first = analyze_preset(variable_id, region_a, season, window_id)
    second = analyze_preset(variable_id, region_b, season, window_id)
    out: dict[str, Any] = {
        "evidenceId": f"comparison:{variable_id}:{region_a}:{region_b}:{season}:{window_id}",
        "a": first,
        "b": second,
    }
    # persistence-adjusted test of whether the two trends differ (same engine
    # as the browser's A <-> B card); overlap between regions is flagged
    try:
        window = _find(catalog()["windows"], "id", window_id)
        ya, va = window_series(_series(variable_id, season, region_a), window)
        yb, vb = window_series(_series(variable_id, season, region_b), window)
        d = slope_difference(ya, va, yb, vb, min_years=first["minYears"])
        if d.get("label") != "insufficient-data":
            out["difference"] = _json_safe({
                "label": d["label"], "diffPerDecade": d["diff"] * 10,
                "ciLowPerDecade": d["ci_low"] * 10, "ciHighPerDecade": d["ci_high"] * 10,
                "p": d["p"], "nShared": d["n"], "units": first["variable"]["units"],
            })
    except (ValueError, KeyError, TypeError):
        pass
    return out


def _direction(label: str | None) -> int | None:
    return {"detected-increase": 1, "detected-decrease": -1, "no-detected-trend": 0}.get(label or "")


def _agreement(first: dict[str, Any], second: dict[str, Any]) -> str:
    a, b = _direction(first["result"].get("label")), _direction(second["result"].get("label"))
    if a is None or b is None:
        return "not-comparable"
    if a == b:
        return "agree"
    if a == 0 or b == 0:
        return "partial"
    return "disagree"


def variable_cross_check(
    variable_id: str,
    region_id: str,
    season: str,
    window_id: str,
) -> dict[str, Any]:
    """Compare a variable with its counterparts (e.g. IMERG vs MERRA-2 rainfall)
    for one region. Counterparts come from the mission config `counters`, in
    either direction. Each counterpart is analysed with the same persistence-
    adjusted engine; datasets with different units are never subtracted."""
    primary = analyze_preset(variable_id, region_id, season, window_id)
    counter_ids: list[str] = []
    info = variable_info(variable_id)
    for cid in (info or {}).get("counters", []):
        if cid not in counter_ids:
            counter_ids.append(cid)
    for mid, m in mission_variables().items():
        if variable_id in (m.get("counters") or []) and mid not in counter_ids:
            counter_ids.append(mid)
    counterparts: list[dict[str, Any]] = []
    unavailable: list[dict[str, str]] = []
    for cid in counter_ids:
        try:
            other = analyze_preset(cid, region_id, season, window_id)
        except ValueError as exc:
            unavailable.append({"variableId": cid, "reason": str(exc)})
            continue
        counterparts.append({**other, "agreement": _agreement(primary, other)})
    if not counter_ids:
        note = "No counterpart dataset is configured for this variable."
    elif not counterparts:
        note = "Counterpart datasets exist but have no series for this region/season."
    else:
        note = ("Agreement compares verdict direction only; datasets differ in sensor/model, "
                "period and units, so slopes are not subtracted.")
    return {
        "evidenceId": f"crosscheck:{variable_id}:{region_id}:{season}:{window_id}",
        "primary": primary,
        "counterparts": counterparts,
        "unavailable": unavailable,
        "note": note,
    }


def gpcp_cross_check(region_id: str, window_id: str) -> dict[str, Any]:
    """Return observed precipitation trend for a preset region."""
    cat = catalog()
    region = _find(cat["regions"], "id", region_id)
    window = _find(cat["windows"], "id", window_id)
    gpcp_path = FRONTEND_DATA / "gpcp_series.json"
    if region is None or window is None or not gpcp_path.exists():
        raise ValueError("GPCP cross-check is unavailable for this selection.")
    data = json.loads(gpcp_path.read_text(encoding="utf-8"))
    entry = data.get("regions", {}).get(region_id)
    if entry is None:
        raise ValueError("GPCP cross-check is unavailable for this region.")
    years = [
        year for year in data["years"]
        if window["start"] <= year <= window["end"]
    ]
    values = [
        value for year, value in zip(data["years"], entry["values"])
        if window["start"] <= year <= window["end"]
    ]
    result = summarize(years, values, conf=0.95)
    return {
        "evidenceId": f"gpcp:{region_id}:{window_id}",
        "dataset": "GPCP V2.3 observed precipitation",
        "region": {"id": region_id, "name": region["name"]},
        "window": {"id": window_id, "label": window["label"]},
        "units": data.get("units", "mm"),
        "result": _json_safe(result),
    }


def source_records() -> list[dict[str, str]]:
    provenance = json.loads((FRONTEND_DATA / "provenance.json").read_text(encoding="utf-8"))
    records = [
        {
            "id": "source:readme",
            "title": "Tellus project documentation",
            "url": "https://github.com/Mrigank005/Tellus#readme",
            "text": "Tellus analyses NASA POWER MERRA-2 data and uses GPCP V2.3 as an observed precipitation cross-check.",
        },
        {
            "id": "source:power",
            "title": "NASA POWER Monthly and Annual API",
            "url": "https://power.larc.nasa.gov/docs/services/api/temporal/monthly/",
            "text": "NASA POWER provides analysis-ready meteorological time series derived from MERRA-2 for the meteorological parameters used here.",
        },
        {
            "id": "source:gpcp",
            "title": "GPCP V2.3 Combined Precipitation Dataset",
            "url": "https://psl.noaa.gov/data/gridded/data.gpcp.html",
            "text": "GPCP is used as the observed precipitation cross-check.",
        },
        {
            "id": "source:methods",
            "title": "Tellus statistical methods",
            "url": "https://github.com/Mrigank005/Tellus#readme",
            "text": json.dumps(provenance["methods"], ensure_ascii=False),
        },
    ]
    for vid, m in mission_variables().items():
        records.append({
            "id": f"source:mission:{vid}",
            "title": f"{m['short_name']} ({m.get('instrument') or vid})",
            "url": _mission_url(vid),
            "text": " ".join(filter(None, [m.get("long_name"), m.get("definition"),
                                           f"Source: {m.get('source')}." if m.get("source") else None,
                                           f"Caution: {m['caution']}" if m.get("caution") else None])),
        })
    return records


def build_context(selection: dict[str, str | None] | None, question: str) -> dict[str, Any]:
    cat = catalog()
    context: dict[str, Any] = {
        "selectionOptions": selection_options(),
        "methods": cat.get("methods", {}),
        "sources": source_records(),
        "evidence": [],
    }
    # answer the QUESTION: places / variables it names override the selection
    resolution = resolve(question, selection)
    context["resolved"] = resolution
    selection = resolution["selection"]
    if resolution["compare"]:
        try:
            context["evidence"].append(compare_presets(
                selection["variableId"], selection["regionId"], resolution["compareWith"],
                selection["season"], selection["windowId"]))
        except ValueError:
            pass
    if selection and all(selection.get(key) for key in ("variableId", "regionId", "season", "windowId")):
        try:
            analysis = analyze_preset(
                selection["variableId"], selection["regionId"], selection["season"], selection["windowId"],
            )
            context["evidence"].append(analysis)
            if analysis.get("counters"):
                try:
                    context["evidence"].append(variable_cross_check(
                        selection["variableId"], selection["regionId"],
                        selection["season"], selection["windowId"]))
                except ValueError:
                    pass
        except ValueError:
            pass
    context["question"] = question
    return context


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value
