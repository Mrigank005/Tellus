"""The copilot must answer the question asked, not the on-screen selection."""

import pytest

from backend.app.copilot import _fallback
from backend.app.intent import resolve
from backend.app.tellus import build_context

HIMALAYA = {"variableId": "T2M", "regionId": "himalaya", "season": "annual", "windowId": "full"}


@pytest.mark.parametrize("question, variable, region, season, window", [
    ("Is the Arctic warming faster than the tropics?", "T2M", "arctic", "annual", "full"),
    ("Is satellite rainfall changing in the Bengal delta?", "IMERG_PRECIP", "bengal-delta", "annual", "full"),
    ("Has monsoon rain changed in Kerala?", "PRECTOTCORR", "western-ghats", "JJAS", "full"),
    ("Is NO2 falling in Europe over the last 20 years?", "OMI_NO2", "western-europe", "annual", "w20"),
    ("Is Antarctica warming?", "T2M", "antarctica", "annual", "full"),
    ("Are nights getting warmer in Siberia?", "T2M_MIN", "siberia", "annual", "full"),
])
def test_resolve_reads_the_question(question, variable, region, season, window):
    sel = resolve(question, HIMALAYA)["selection"]
    assert (sel["variableId"], sel["regionId"], sel["season"], sel["windowId"]) == (variable, region, season, window)


@pytest.mark.parametrize("question", ["Is global warming affecting us?", "Is it getting warmer?",
                                      "How does the tool handle missing months?"])
def test_unnamed_places_keep_the_selection(question):
    r = resolve(question, HIMALAYA)
    assert r["selection"]["regionId"] == "himalaya"
    assert not r["compare"]


def test_two_named_regions_trigger_a_comparison_with_difference_test():
    q = "Is the Arctic warming faster than the tropics?"
    ctx = build_context(HIMALAYA, q)
    first = ctx["evidence"][0]
    assert first["evidenceId"] == "comparison:T2M:arctic:tropics:annual:full"
    assert first["difference"]["label"] == "differ"
    response = _fallback(q, ctx)
    assert "The Arctic" in response.message and "The Tropics" in response.message
    assert "Himalaya" not in response.message
    assert "statistically significant" in response.message
    assert response.action is not None and response.action.regionId == "arctic"


def test_fallback_answers_the_named_place_not_the_selection():
    q = "Is satellite rainfall changing in the Bengal delta?"
    response = _fallback(q, build_context(HIMALAYA, q))
    assert "Bengal Delta" in response.message and "Himalaya" not in response.message
    assert "GPM IMERG" in response.message
    assert response.action.variableId == "IMERG_PRECIP"


def test_unavailable_combination_asks_for_clarification_without_numbers():
    q = "Is chlorophyll changing in the Sahara?"
    response = _fallback(q, build_context(HIMALAYA, q))
    assert response.kind == "clarification"
    assert not response.claims
