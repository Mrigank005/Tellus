"""Backend copilot contract tests that do not call the external provider."""

from __future__ import annotations

from backend.app.config import load_settings
from backend.app.copilot import _evidence_fallback
from backend.app.copilot import _validate_grounding
from backend.app.anomaly import analyze_preset_anomalies
from backend.app.tellus import analyze_preset, gpcp_cross_check
from backend.app.prithvi import experiment_status
from backend.app.retrieval import search_sources
from backend.app.schemas import CopilotRequest
from backend.app.schemas import CopilotResponse
from backend.app.security import SlidingWindowLimiter


def test_preset_analysis_has_stable_grounded_evidence():
    result = analyze_preset("T2M", "arctic", "annual", "full")
    assert result["evidenceId"] == "analysis:T2M:arctic:annual:full"
    assert result["result"]["n"] == 45
    assert result["result"]["label"] in {
        "detected-increase", "detected-decrease", "no-detected-trend",
    }


def test_fallback_claims_reference_the_analysis():
    evidence = analyze_preset("T2M", "arctic", "annual", "full")
    response = _evidence_fallback(evidence)
    assert response.confidence == "supported"
    assert response.claims
    assert all(claim.evidenceId == evidence["evidenceId"] for claim in response.claims)
    assert "per decade per decade" not in " ".join(claim.text for claim in response.claims)


def test_source_search_is_bounded_and_relevant():
    results = search_sources("NASA POWER precipitation", limit=20)
    assert 1 <= len(results) <= 8
    assert any(source["id"] == "source:power" for source in results)


def test_rate_limiter_rejects_after_limit():
    limiter = SlidingWindowLimiter(limit=2, window_seconds=60)
    assert limiter.allow("test-client")
    assert limiter.allow("test-client")
    assert not limiter.allow("test-client")


def test_request_schema_rejects_unknown_fields():
    try:
        CopilotRequest.model_validate({"message": "test", "unexpected": True})
    except ValueError:
        pass
    else:
        raise AssertionError("unknown request fields must be rejected")


def test_openrouter_defaults_are_loaded_without_printing_secrets():
    settings = load_settings()
    assert settings.llm_base_url == "https://openrouter.ai/api/v1"
    assert settings.llm_model.endswith(":free")


def test_gpcp_cross_check_returns_observed_evidence():
    result = gpcp_cross_check("western-ghats", "full")
    assert result["evidenceId"] == "gpcp:western-ghats:full"
    assert result["dataset"].startswith("GPCP")


def test_anomaly_adapter_is_explicitly_exploratory():
    result = analyze_preset_anomalies("T2M", "arctic", "annual", "full")
    assert result["exploratory"] is True
    assert result["evidenceId"].startswith("anomalies:")
    assert result["limitations"]


def test_prithvi_status_waits_for_input_data():
    result = experiment_status()
    assert result["state"] == "awaiting-input-data"


def test_numeric_claim_must_match_computed_evidence():
    evidence = analyze_preset("T2M", "arctic", "annual", "full")
    response = CopilotResponse(
        kind="answer",
        message="The result is supported.",
        claims=[{
            "text": "The slope is 9999.",
            "evidenceType": "computed_result",
            "evidenceId": evidence["evidenceId"],
        }],
        confidence="supported",
    )
    checked = _validate_grounding(response, {"evidence": [evidence], "sources": [], "selectionOptions": {"variables": [], "regions": [], "seasons": [], "windows": []}})
    assert checked.confidence == "abstain"
