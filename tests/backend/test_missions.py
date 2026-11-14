"""Mission / satellite variables flow through the same validated engine."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from backend.app import copilot, tellus
from backend.app.anomaly import analyze_preset_anomalies
from backend.app.copilot import TOOLS, _fallback, _run_tool, _validate_grounding
from backend.app.tellus import (analyze_preset, build_context, compare_presets, mission_variables,
                                     selection_options, variable_cross_check)
from backend.app.schemas import CopilotResponse

pytestmark = pytest.mark.skipif(not mission_variables(), reason="mission data not shipped")

BENGAL = {"variableId": "IMERG_PRECIP", "regionId": "bengal-delta", "season": "annual", "windowId": "full"}


def test_selection_options_list_mission_variables_with_source_type():
    variables = {v["id"]: v for v in selection_options()["variables"]}
    assert variables["T2M"]["sourceType"] == "model"
    assert variables["IMERG_PRECIP"]["sourceType"] == "mission"
    assert "bengal-delta" in variables["IMERG_PRECIP"]["regions"]
    assert variables["IMERG_PRECIP"]["counters"] == ["PRECTOTCORR"]


def test_mission_analysis_carries_instrument_source_and_caution():
    ev = analyze_preset("IMERG_PRECIP", "bengal-delta", "annual", "full")
    assert ev["evidenceId"] == "analysis:IMERG_PRECIP:bengal-delta:annual:full"
    assert "IMERG" in ev["variable"]["instrument"]
    assert ev["variable"]["sourceType"] == "mission"
    assert ev["variable"]["source"].startswith("Giovanni")
    assert ev["caution"]
    assert ev["result"]["n"] >= 20
    assert ev["result"]["label"] in {"detected-increase", "detected-decrease", "no-detected-trend"}
    assert "mk_p_adj" in ev["result"]  # persistence-adjusted statistics


def test_missing_values_are_dropped_not_filled():
    entry = tellus.missions_data()["OMI_NO2"]["annual"]["indo-gangetic-plain"]
    ev = analyze_preset("OMI_NO2", "indo-gangetic-plain", "annual", "full")
    valid = [v for v in entry["values"] if v is not None and not math.isnan(v)]
    assert ev["result"]["n"] == len(valid)


def test_min_years_override_is_honoured(monkeypatch):
    base = analyze_preset("NOBM_TOTAL_CHL", "southern-ocean", "annual", "full")
    assert base["minYears"] == 18 and base["result"]["label"] != "insufficient-data"
    patched = {k: dict(v) for k, v in mission_variables().items()}
    patched["NOBM_TOTAL_CHL"]["min_years"] = 40
    monkeypatch.setattr(tellus, "mission_variables", lambda: patched)
    strict = analyze_preset("NOBM_TOTAL_CHL", "southern-ocean", "annual", "full")
    assert strict["minYears"] == 40
    assert strict["result"]["label"] in {"insufficient-data", "interpretation-caution"}


def test_unknown_region_or_variable_is_a_value_error():
    covered = set(tellus.missions_data()["NCEI_GSOM_TAVG"]["annual"])
    missing = next(r["id"] for r in tellus.catalog()["regions"] if r["id"] not in covered)
    with pytest.raises(ValueError):
        analyze_preset("NCEI_GSOM_TAVG", missing, "annual", "full")
    with pytest.raises(ValueError):
        analyze_preset("NOT_A_VARIABLE", "arctic", "annual", "full")


def test_compare_and_anomalies_accept_mission_variables():
    cmp = compare_presets("AIRS_TSURF", "arctic", "tropics", "annual", "full")
    assert cmp["a"]["variable"]["id"] == "AIRS_TSURF"
    an = analyze_preset_anomalies("AIRS_TSURF", "arctic", "annual", "full")
    assert an["variable"]["id"] == "AIRS_TSURF"


def test_cross_check_pairs_mission_with_merra2_counterpart():
    cc = variable_cross_check("IMERG_PRECIP", "bengal-delta", "annual", "full")
    assert cc["evidenceId"] == "crosscheck:IMERG_PRECIP:bengal-delta:annual:full"
    assert "PRECTOTCORR" in [c["variable"]["id"] for c in cc["counterparts"]]
    assert cc["counterparts"][0]["agreement"] in {"agree", "partial", "disagree", "not-comparable"}
    # reverse direction: a MERRA-2 variable finds the mission datasets that counter it
    rev = variable_cross_check("PRECTOTCORR", "sahel", "annual", "full")
    assert {"IMERG_PRECIP", "KNMI_CMORPH_PRECIP"} <= {c["variable"]["id"] for c in rev["counterparts"]}


def test_cross_check_without_counterparts_is_explicit():
    cc = variable_cross_check("OMI_NO2", "indo-gangetic-plain", "annual", "full")
    assert cc["counterparts"] == [] and "No counterpart" in cc["note"]


def test_cross_check_tool_is_registered_and_runs():
    assert "get_variable_cross_check" in {t["function"]["name"] for t in TOOLS}
    out = _run_tool("get_variable_cross_check", BENGAL)
    assert out["evidenceId"].startswith("crosscheck:")
    flat = copilot._flatten_evidence(out)
    assert flat[0]["evidenceId"] == out["evidenceId"]
    assert len(flat) == 2 + len(out["counterparts"])  # bundle + primary + counterparts


def test_context_for_mission_selection_has_evidence_and_sources():
    ctx = build_context(BENGAL, "Is satellite rainfall changing?")
    ids = [e["evidenceId"] for e in ctx["evidence"]]
    assert ids[0] == "analysis:IMERG_PRECIP:bengal-delta:annual:full"
    assert any(i.startswith("crosscheck:") for i in ids)
    assert any(s["id"] == "source:mission:IMERG_PRECIP" and s["url"] for s in ctx["sources"])


def test_deterministic_fallback_for_mission_selection_cites_instrument_and_caution():
    question = "Is satellite rainfall changing in the Bengal Delta?"
    ctx = build_context(BENGAL, question)
    response = _fallback(question, ctx)
    assert response.kind == "answer"
    assert "GPM IMERG" in response.message
    assert "Cross-check" in response.message
    assert any("Dataset caution" in lim for lim in response.limitations)
    assert all(c.evidenceId.startswith("analysis:IMERG_PRECIP") for c in response.claims)


def test_scope_guard_still_blocks_causal_questions_about_mission_variables():
    for q in ("Why is NO2 rising over the Indo-Gangetic Plain?",
              "What will satellite rainfall be in 2050?"):
        assert copilot.scope_guard(q).kind == "abstain"
    assert copilot.scope_guard("Is satellite rainfall changing in the Bengal Delta?") is None


def test_grounding_validates_mission_actions():
    ctx = build_context(BENGAL, "q")
    action = {"variableId": "OMI_NO2", "regionId": "indo-gangetic-plain", "season": "annual", "windowId": "full"}
    ok = CopilotResponse(kind="analysis_action", message="Open NO2", action=action, confidence="supported")
    assert _validate_grounding(ok, ctx).kind == "analysis_action"
    bad = CopilotResponse(kind="analysis_action", message="x", confidence="supported",
                          action={**action, "variableId": "FAKE"})
    assert _validate_grounding(bad, ctx).kind == "abstain"


def test_api_serves_mission_variables():
    from backend.app.main import app
    client = TestClient(app)
    r = client.get("/api/analysis/preset", params={"variableId": "IMERG_PRECIP", "regionId": "bengal-delta"})
    assert r.status_code == 200 and r.json()["variable"]["sourceType"] == "mission"
    r = client.get("/api/analysis/preset", params={"variableId": "NOPE", "regionId": "bengal-delta"})
    assert r.status_code == 400
    assert any(v["id"] == "OMI_NO2" for v in client.get("/api/catalog/options").json()["variables"])
