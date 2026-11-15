"""Honest rewordings of computed numbers verify; wrong numbers never do.
Method questions get the fixed explanation."""

from backend.app.copilot import _fallback, _validate_grounding
from backend.app.schemas import CopilotResponse
from backend.app.tellus import build_context

HIMALAYA = {"variableId": "T2M", "regionId": "himalaya", "season": "annual", "windowId": "full"}
Q = "Is the Arctic warming faster than the tropics?"


def _response(*claims):
    return CopilotResponse(kind="answer", message="m", confidence="supported", claims=[
        {"text": text, "evidenceType": "computed_result", "evidenceId": eid, "sourceUrl": None}
        for text, eid in claims])


def test_rounded_slopes_ci_levels_and_nested_evidence_verify():
    ctx = build_context(HIMALAYA, Q)
    r = _response(
        ("Arctic Sen's slope is 0.46 °C per decade (95% CI 0.36–0.56).", "analysis:T2M:arctic:annual:full"),
        ("Tropics slope is 0.19 °C per decade (95% CI 0.12–0.24).", "analysis:T2M:tropics:annual:full"),
        ("Arctic minus tropics is 0.27 °C per decade (95% CI 0.16–0.37, p ≈ 8.7×10⁻⁶).",
         "comparison:T2M:arctic:tropics:annual:full"),
    )
    assert _validate_grounding(r, ctx) is r


def test_a_wrong_number_is_still_rejected():
    ctx = build_context(HIMALAYA, Q)
    r = _response(("Arctic warms at 0.52 °C per decade.", "analysis:T2M:arctic:annual:full"))
    assert _validate_grounding(r, ctx).kind == "abstain"


def test_method_questions_get_the_fixed_explanation():
    for q, word in [("What does statistically significant mean here?", "Statistical significance"),
                    ("How does Tellus handle missing months?", "Missing data"),
                    ("Why do you adjust for autocorrelation?", "Persistence")]:
        r = _fallback(q, build_context(HIMALAYA, q))
        assert r.message.startswith(word), (q, r.message[:60])
        assert r.claims[0].evidenceType == "project_source" and r.claims[0].sourceUrl


def test_data_questions_mentioning_significance_still_get_data():
    q = "Is the Arctic warming trend significant?"
    r = _fallback(q, build_context(HIMALAYA, q))
    assert "The Arctic" in r.message


def test_per_year_number_labelled_per_decade_is_rejected():
    """Bengal IMERG: -10.1 mm/yr is -101 mm/decade. Writing '-10 mm per decade'
    must fail verification (it did pass before the decade-only evidence)."""
    from backend.app.copilot import _decade_only
    q = "Is satellite rainfall changing in the Bengal delta?"
    ctx = build_context(HIMALAYA, q)
    shown = {**ctx, "evidence": _decade_only(ctx["evidence"])}
    eid = "analysis:IMERG_PRECIP:bengal-delta:annual:full"
    wrong = _response(("Sen's slope is about -10 mm per decade (95% CI -24 to 6.6).", eid))
    right = _response(("Sen's slope is about -101 mm per decade (95% CI -237 to 66).", eid))
    assert _validate_grounding(wrong, shown).kind == "abstain"
    assert _validate_grounding(right, shown) is right
