"""The out-of-scope guard runs before any model call and must match the
expectations in evaluation/golden_questions.json."""
import json
from pathlib import Path

import pytest

from backend.app.copilot import scope_guard

GOLDEN = json.loads((Path(__file__).resolve().parents[2] / "evaluation" / "golden_questions.json")
                    .read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", GOLDEN, ids=[c["question"] for c in GOLDEN])
def test_guard_matches_golden_expectation(case):
    guarded = scope_guard(case["question"]) is not None
    assert guarded == (case["expected"] == "abstain")


@pytest.mark.parametrize("question", [
    "Why is it hotter in the Sahel?",
    "Will the rainfall increase next decade?",
    "What will the Arctic look like in 2075?",
    "Is the aquifer under Punjab shrinking?",
])
def test_causal_forecast_and_unsupported_topics_abstain(question):
    response = scope_guard(question)
    assert response is not None and response.kind == "abstain"


@pytest.mark.parametrize("question", [
    "Why is this cell amber on the map?",
    "What does a p-value mean?",
    "Is rainfall changing in Kerala?",
])
def test_questions_about_data_or_tool_pass(question):
    assert scope_guard(question) is None
