"""Grounded copilot orchestration and safe fallback behavior."""

from __future__ import annotations

import json
import re
from typing import Any

from .config import Settings
from .tellus import (analyze_preset, build_context, compare_presets, gpcp_cross_check,
                          variable_cross_check)
from .retrieval import retrieval_context
from .concepts import concept_answer
from .provider import ProviderUnavailable, generate_json, generate_chat
from .schemas import CopilotRequest, CopilotResponse

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": ["answer", "analysis_action", "clarification", "abstain"]},
        "message": {"type": "string"},
        "action": {
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "variableId": {"type": "string"},
                        "regionId": {"type": "string"},
                        "season": {"type": "string"},
                        "windowId": {"type": "string"},
                    },
                    "required": ["variableId", "regionId", "season", "windowId"],
                },
                {"type": "null"},
            ]
        },
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "text": {"type": "string"},
                    "evidenceType": {"type": "string", "enum": ["computed_result", "project_source", "external_source"]},
                    "evidenceId": {"type": "string"},
                    "sourceUrl": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                },
                "required": ["text", "evidenceType", "evidenceId", "sourceUrl"],
            },
        },
        "limitations": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["supported", "needs-context", "abstain"]},
    },
    "required": ["kind", "message", "action", "claims", "limitations", "confidence"],
}

SYSTEM_PROMPT = """You are the Tellus scientific copilot.
Use only the supplied Tellus context. You are an interface and explanation
layer, not the statistical engine. Never invent numbers, sources, or datasets.
Do not claim causation or make forecasts. If evidence is missing, ask for
context or abstain. A statistically detected trend is not proof of cause.
Any numeric statement must cite a computed_result evidenceId. Any external
claim must cite a source URL. Return only a single JSON object matching the
requested schema, with no markdown fences or commentary.
Variables come from three kinds of source (sourceType): NASA POWER MERRA-2
reanalysis ("model"), satellite missions ("mission", e.g. GPM IMERG, OMI, AIRS)
and land models or station records ("model"/"station", e.g. GLDAS, NCEI). When
you answer about a mission, model or station variable, name its instrument or
source from the evidence and repeat any caution text it carries. Use the
get_variable_cross_check tool to compare a variable with its counterpart
datasets (for example satellite rainfall versus MERRA-2 rainfall); agreement
is about verdict direction only and the datasets have different units and
periods, so never subtract their slopes.
Write the "message" for a curious student or citizen scientist: two to four
plain sentences, verdict first ("Yes, the Arctic is warming faster..."), trend
rates per decade rounded to two significant figures, and no internal field
names (never write mk_z, p_adj, n_eff or lag1_r). Mention the persistence
adjustment in words only when it changes the verdict. Put the precise numbers
in "claims", each citing its evidenceId."""

TOOLS = [
    {"type": "function", "function": {"name": "run_preset_analysis", "description": "Run a validated analysis for one preset region. variableId may be a MERRA-2 variable or a satellite/model/station variable listed in selectionOptions.", "parameters": {"type": "object", "additionalProperties": False, "properties": {"variableId": {"type": "string"}, "regionId": {"type": "string"}, "season": {"type": "string"}, "windowId": {"type": "string"}}, "required": ["variableId", "regionId", "season", "windowId"]}}},
    {"type": "function", "function": {"name": "compare_regions", "description": "Compare two preset regions using the validated analysis engine.", "parameters": {"type": "object", "additionalProperties": False, "properties": {"variableId": {"type": "string"}, "regionA": {"type": "string"}, "regionB": {"type": "string"}, "season": {"type": "string"}, "windowId": {"type": "string"}}, "required": ["variableId", "regionA", "regionB", "season", "windowId"]}}},
    {"type": "function", "function": {"name": "get_variable_cross_check", "description": "Cross-check a variable (MERRA-2, satellite mission, land model or station) against its counterpart datasets for one region, using the same persistence-adjusted analysis.", "parameters": {"type": "object", "additionalProperties": False, "properties": {"variableId": {"type": "string"}, "regionId": {"type": "string"}, "season": {"type": "string"}, "windowId": {"type": "string"}}, "required": ["variableId", "regionId", "season", "windowId"]}}},
    {"type": "function", "function": {"name": "get_gpcp_cross_check", "description": "Get observed GPCP precipitation evidence for a preset region.", "parameters": {"type": "object", "additionalProperties": False, "properties": {"regionId": {"type": "string"}, "windowId": {"type": "string"}}, "required": ["regionId", "windowId"]}}},
]


_CAUSE_OR_FORECAST = re.compile(
    r"\b(why|cause[sd]?|causing|because of|blame|attribut\w*|forecast\w*|predict\w*|projection\w*"
    r"|future|will\s+(?:the|it|there|we|rainfall|temperature|monsoon)|next\s+(?:year|decade|season)"
    r"|20[3-9]\d|21\d\d)\b", re.I)
_UNSUPPORTED_TOPIC = re.compile(r"\b(groundwater|aquifer\w*|water\s+table)\b", re.I)


_ABOUT_THE_TOOL = re.compile(
    r"\b(map|cells?|chart|colou?rs?|amber|shading|labels?|legend|verdict|tool|app|tellus"
    r"|method\w*|test\w*|statistic\w*|significan\w*|p-?value|confidence|interval|fdr|caution"
    r"|autocorrel\w*|persisten\w*|adjust\w*|missing|mann|kendall|you|your)\b", re.I)


def scope_guard(message: str) -> CopilotResponse | None:
    """Deterministic out-of-scope check, applied BEFORE any model call.

    "Why" about the tool itself ("why does the map show amber cells?") is
    allowed; "why" about the Earth (a causal question) is not.
    """
    hits = {m.group(1).lower() for m in _CAUSE_OR_FORECAST.finditer(message)}
    if hits == {"why"} and _ABOUT_THE_TOOL.search(message):
        hits = set()
    if hits:
        return CopilotResponse(
            kind="abstain",
            message="Tellus can analyse the recorded data, but this copilot does not infer causes or forecast the future.",
            limitations=["Causality and forecasting are outside the supported evidence workflow."],
            confidence="abstain",
        )
    if _UNSUPPORTED_TOPIC.search(message):
        return CopilotResponse(
            kind="abstain",
            message="Groundwater is not in Tellus's variable set (it needs GRACE-type data). Soil moisture and runoff are the closest supported variables.",
            limitations=["Unsupported variable: groundwater."],
            confidence="abstain",
        )
    return None


def _fallback(message: str, context: dict[str, Any] | None = None) -> CopilotResponse:
    guarded = scope_guard(message)
    if guarded is not None:
        return guarded
    concept = _concept_if_unspecific(message, context)
    if concept is not None:
        return concept
    if context and (context.get("evidence") or context.get("resolved")):
        return _question_answer(
            context,
            note="AI unavailable: this answer was assembled directly from the validated "
                 "analysis for the places and variable your question names.",
        )
    return CopilotResponse(
        kind="unavailable",
        message="The AI copilot is not configured yet. You can still use Laya and the full Tellus analysis without AI.",
        limitations=["Set LLM_API_KEY_1 on the backend to enable the grounded copilot."],
        confidence="unavailable",
    )


def answer(request: CopilotRequest, settings: Settings, context: dict[str, Any]) -> CopilotResponse:
    guarded = scope_guard(request.message)
    if guarded is not None:
        return guarded
    context = build_context(
        request.selection.model_dump() if request.selection else None,
        request.message,
    )
    context["retrievedSources"] = retrieval_context(request.message)["sources"]
    concept = _concept_if_unspecific(request.message, context)
    if concept is not None:
        return concept
    try:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({
                "question": request.message,
                "answerAbout": context.get("resolved", {}).get("selection"),
                "note": "Answer about answerAbout (the places/variable the question names), not the on-screen selection. Evidence is listed most relevant first.",
                "context": _llm_context(context)})},
        ]
        tool_context = dict(context)
        if settings.llm_structured_outputs:
            # the question has already been resolved and its evidence computed,
            # so one schema-constrained call is enough (and halves latency)
            raw = generate_json(
                settings,
                system=SYSTEM_PROMPT,
                user=messages[1]["content"],
                schema=RESPONSE_SCHEMA,
            )
            response = CopilotResponse.model_validate(raw)
            checked = _validate_grounding(response, tool_context)
            if checked is not response and context.get("evidence"):
                return _question_answer(context, note="The AI's wording could not be verified against the "
                                                      "computed evidence, so this is the validated result itself.")
            return checked
        for _ in range(settings.max_tool_calls):
            message = generate_chat(settings, messages=messages, tools=TOOLS)
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                break
            messages.append(message)
            for call in tool_calls:
                name = call.get("function", {}).get("name")
                try:
                    args = json.loads(call.get("function", {}).get("arguments", "{}"))
                    result = _run_tool(name, args)
                except (ValueError, TypeError, json.JSONDecodeError) as exc:
                    result = {"error": str(exc)}
                messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(result)})
                for item in _flatten_evidence(result):
                    tool_context.setdefault("evidence", []).append(item)
        if 'message' in locals() and not message.get("tool_calls"):
            raw = _parse_model_message(message)
        else:
            raw = generate_json(
                settings,
                system=SYSTEM_PROMPT,
                user=json.dumps({"question": request.message, "context": tool_context}),
                schema=RESPONSE_SCHEMA,
            )
        response = CopilotResponse.model_validate(raw)
        checked = _validate_grounding(response, tool_context)
        if checked is not response and context.get("evidence"):
            # the AI's wording could not be verified: give the validated result instead
            return _question_answer(context, note="The AI's wording could not be verified against the "
                                                  "computed evidence, so this is the validated result itself.")
        return checked
    except ProviderUnavailable:
        return _fallback(request.message, context)
    except ValueError:
        if context.get("evidence") or context.get("resolved"):
            return _question_answer(context, note="The AI reply did not follow the evidence contract, "
                                                  "so this is the validated result itself.")
        return CopilotResponse(
            kind="abstain",
            message="I could not validate that AI response against Tellus's evidence contract.",
            limitations=["Try a more specific question about a supported variable, region, season, or time window."],
            confidence="abstain",
        )


def _parse_model_message(message: dict[str, Any]) -> dict[str, Any]:
    content = message.get("content", "")
    if isinstance(content, dict):
        return content
    from .provider import _parse_json_object
    return _parse_json_object(str(content))


def _flatten_evidence(result: Any) -> list[dict[str, Any]]:
    """A tool result and any nested analyses it carries (cross-checks), so
    claims may cite either the bundle or an individual analysis."""
    if not isinstance(result, dict) or "evidenceId" not in result:
        return []
    items = [result]
    nested = ([result.get("primary"), result.get("a"), result.get("b")]
              + list(result.get("counterparts") or []))
    items += [n for n in nested if isinstance(n, dict) and "evidenceId" in n]
    return items


def _run_tool(name: str | None, args: dict[str, Any]) -> dict[str, Any]:
    if name == "run_preset_analysis":
        return analyze_preset(args["variableId"], args["regionId"], args["season"], args["windowId"])
    if name == "compare_regions":
        return compare_presets(args["variableId"], args["regionA"], args["regionB"], args["season"], args["windowId"])
    if name == "get_variable_cross_check":
        return variable_cross_check(args["variableId"], args["regionId"], args["season"], args["windowId"])
    if name == "get_gpcp_cross_check":
        return gpcp_cross_check(args["regionId"], args["windowId"])
    raise ValueError("Unsupported Tellus tool.")


def _evidence_fallback(evidence: dict[str, Any]) -> CopilotResponse:
    """Provide a useful answer when a free endpoint ignores the JSON contract."""
    result = evidence.get("result", {})
    label = result.get("label", "insufficient-data")
    label_text = {
        "detected-increase": "a statistically detected increase",
        "detected-decrease": "a statistically detected decrease",
        "no-detected-trend": "no statistically detected trend",
        "insufficient-data": "insufficient data for a reliable trend verdict",
    }.get(label, label)
    message = (
        f"{evidence['region']['name']} shows {label_text} in {evidence['variable']['name']} "
        f"for {evidence['window']['label']} ({evidence['season']['label']})."
    )
    variable = evidence["variable"]
    instrument = variable.get("instrument")
    source_type = variable.get("sourceType")
    limitations = [
        "This describes the analysed record; it is not a forecast or causal explanation.",
    ]
    if source_type in {"mission", "station"} or (source_type == "model" and evidence.get("caution")):
        kind = {"mission": "satellite mission", "station": "station record", "model": "land-model"}[source_type]
        limitations.append(
            f"Data source: {instrument or variable['id']} ({kind}); region series are area averages "
            "analysed with the Tellus persistence-adjusted trend engine."
        )
    else:
        limitations.append(
            "The result uses NASA POWER MERRA-2-derived data and the Tellus validated trend engine."
        )
    if evidence.get("caution"):
        limitations.append(f"Dataset caution: {evidence['caution']}")
    if result.get("caution") and result.get("caution_reasons"):
        limitations.append("Statistical caution: " + "; ".join(result["caution_reasons"]) + ".")
    claims: list[dict[str, Any]] = []
    if result.get("n") is not None:
        claims.append({
            "text": f"The analysis used {result['n']} valid observations.",
            "evidenceType": "computed_result",
            "evidenceId": evidence["evidenceId"],
            "sourceUrl": None,
        })
    per = evidence.get("perDecade") or {}
    if per.get("senSlope") is not None:
        ci = ""
        if per.get("ciLow") is not None and per.get("ciHigh") is not None:
            ci = f" (95% CI {_signed(per['ciLow'])} to {_signed(per['ciHigh'])})"
        claims.append({
            "text": f"Trend: {_signed(per['senSlope'])} {evidence['variable']['units']}{ci}.",
            "evidenceType": "computed_result",
            "evidenceId": evidence["evidenceId"],
            "sourceUrl": None,
        })
    if instrument and source_type in {"mission", "station"}:
        message += f" Source: {instrument}."
    return CopilotResponse(
        kind="answer",
        message=message,
        claims=claims,
        limitations=limitations,
        confidence="supported",
    )


def _concept_if_unspecific(message: str, context: dict[str, Any] | None) -> CopilotResponse | None:
    """Method questions that name no place and no variable get the fixed explanation."""
    asked = ((context or {}).get("resolved") or {}).get("fromQuestion") or {}
    if "regionId" in asked or "variableId" in asked:
        return None
    return concept_answer(message)


def _llm_context(context: dict[str, Any]) -> dict[str, Any]:
    """Only what the model needs: the evidence (most relevant first), what the
    question resolved to, the methods, and sources relevant to this question.
    A small prompt keeps reasoning models inside their token budget."""
    evidence = context.get("evidence", [])
    wanted = {"source:methods", "source:power", "source:readme"}
    for item in evidence:
        for e in _flatten_evidence(item) + [item.get("a"), item.get("b")]:
            if isinstance(e, dict) and isinstance(e.get("variable"), dict):
                wanted.add(f"source:mission:{e['variable'].get('id')}")
    wanted |= {s.get("id") for s in context.get("retrievedSources", []) if isinstance(s, dict)}
    return {
        "resolved": (context.get("resolved") or {}).get("selection"),
        "evidence": evidence,
        "methods": context.get("methods", {}),
        "sources": [s for s in context.get("sources", []) if s.get("id") in wanted],
    }


def _signed(x: float | None) -> str:
    """Compact signed number for people: +0.46, -101, +0.0021."""
    if x is None:
        return "?"
    mag = abs(x)
    if mag >= 100:
        return f"{x:+.0f}"
    if mag >= 10:
        return f"{x:+.1f}"
    return f"{x:+.2f}" if mag >= 0.01 else f"{x:+.2g}"


_LABEL_TEXT = {
    "detected-increase": "a statistically detected increase",
    "detected-decrease": "a statistically detected decrease",
    "no-detected-trend": "no statistically detected trend",
    "insufficient-data": "too little data for a verdict",
}


def _comparison_answer(cmp: dict[str, Any]) -> CopilotResponse:
    a, b = cmp["a"], cmp["b"]
    units = a["variable"]["units"]

    def part(e: dict[str, Any]) -> str:
        label = _LABEL_TEXT.get(e["result"].get("label"), "no verdict")
        per = e.get("perDecade") or {}
        slope = f" ({_signed(per['senSlope'])} {units})" if per.get("senSlope") is not None else ""
        return f"{e['region']['name']} shows {label}{slope}"

    message = (f"{a['variable']['name']}, {a['season']['label'].lower()}, {a['window']['label']}: "
               f"{part(a)}; {part(b)}.")
    claims: list[dict[str, Any]] = []
    for e in (a, b):
        per = e.get("perDecade") or {}
        if per.get("senSlope") is not None:
            claims.append({"text": f"{e['region']['name']}: {_signed(per['senSlope'])} {units}.",
                           "evidenceType": "computed_result", "evidenceId": e["evidenceId"], "sourceUrl": None})
    d = cmp.get("difference")
    limitations = ["This compares the analysed records; it is not a forecast or a causal explanation."]
    if d:
        rng = (f"{_signed(d['diffPerDecade'])} {units} (95% CI {_signed(d['ciLowPerDecade'])} "
               f"to {_signed(d['ciHighPerDecade'])})")
        if d["label"] == "differ":
            bigger = a if d["diffPerDecade"] > 0 else b
            message += (f" The difference, {rng}, is statistically significant: "
                        f"the trend in {bigger['region']['name']} is the larger one.")
        else:
            message += (f" The difference, {rng}, is not statistically significant, so the data "
                        f"cannot show that one trend is larger than the other.")
        claims.append({"text": f"Difference in trend (A minus B): {rng}, using {d['nShared']} shared years.",
                       "evidenceType": "computed_result", "evidenceId": cmp["evidenceId"], "sourceUrl": None})
        limitations.append("The difference test adjusts for year-to-year persistence and assumes the two "
                           "regions are independent; overlapping regions make it approximate.")
    return CopilotResponse(kind="answer", message=message, claims=claims,
                           limitations=limitations, confidence="supported")


def _question_answer(context: dict[str, Any], note: str | None = None) -> CopilotResponse:
    """Deterministic answer to the question, from the evidence its own wording selected."""
    resolved = context.get("resolved") or {}
    sel = resolved.get("selection")
    evidence = [e for e in context.get("evidence", []) if isinstance(e, dict)]
    first = evidence[0] if evidence else None
    if first and str(first.get("evidenceId", "")).startswith("comparison:"):
        base = _comparison_answer(first)
    elif first and "region" in first:
        base = _evidence_fallback(first)
        extra = _crosscheck_sentence(context)
        if extra:
            base = base.model_copy(update={"message": base.message + " " + extra})
    else:
        asked = resolved.get("fromQuestion") or {}
        detail = f" ({', '.join(f'{k}={v}' for k, v in asked.items())})" if asked else ""
        return CopilotResponse(
            kind="clarification",
            message=("There is no analysed series for that combination" + detail
                     + ". Satellite variables cover only some regions; try a MERRA-2 variable "
                       "such as temperature or precipitation, or another region."),
            limitations=["Nothing was computed, so no numbers are reported."],
            confidence="needs-context",
        )
    update: dict[str, Any] = {}
    if sel and all(sel.get(k) for k in ("variableId", "regionId", "season", "windowId")):
        update["action"] = {k: sel[k] for k in ("variableId", "regionId", "season", "windowId")}
    if note:
        update["limitations"] = [note] + list(base.limitations)
    if not update:
        return base
    data = base.model_dump()
    data.update(update)
    return CopilotResponse.model_validate(data)


def _crosscheck_sentence(context: dict[str, Any] | None) -> str | None:
    """One-line deterministic summary of a cross-check carried in the context."""
    for item in (context or {}).get("evidence", []):
        if not isinstance(item, dict) or not str(item.get("evidenceId", "")).startswith("crosscheck:"):
            continue
        parts = []
        for other in item.get("counterparts", []):
            label = other["result"].get("label", "insufficient-data").replace("-", " ")
            parts.append(f"{other['variable']['name']} ({other['variable'].get('instrument') or other['variable']['id']}): "
                         f"{label} [{other['agreement']}]")
        if parts:
            return "Cross-check with counterpart datasets: " + "; ".join(parts) + "."
    return None


_SCI = re.compile(r"\s*[x×]\s*10\s*(\^\s*[-+]?\d+|[⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)")
_CONF_LEVEL = re.compile(r"\b(90|95|99)\s*%")


def _claim_numbers(text: str) -> list[str]:
    """Numbers a claim asserts, ignoring confidence levels ("95%") and the
    "x10^-6" part of scientific notation (the mantissa is still checked)."""
    text = _CONF_LEVEL.sub(" ", text)
    text = _SCI.sub(" ", text)
    return re.findall(r"(?<![A-Za-z0-9.])[-+]?\d+(?:\.\d+)?", text)


def _rounds_to(claim: str, value: float) -> bool:
    """True when the claim is the evidence value rounded to the claim's own
    precision ("0.46" for 0.4605, "-101" for -101.3), never a different number."""
    decimals = len(claim.split(".")[1]) if "." in claim else 0
    c = float(claim)
    if decimals == 0 and abs(c) < 10:
        return False  # bare small integers would match too much
    if abs(c - value) <= 10 ** (-decimals) + 1e-12:  # rounding or truncation in the last digit
        return True
    # magnitude-only restatement of a negative value ("fell by 0.27")
    return value < 0 < c and abs(c + value) <= 10 ** (-decimals) + 1e-12


def _numbers_match(a: float, b: float, rel_tol: float = 1e-3, abs_tol: float = 1e-4) -> bool:
    """Tolerant numeric equality so honest reformattings verify
    ('0.35' vs 0.3498, per-decade restatements, rounding)."""
    import math as _math
    return _math.isclose(a, b, rel_tol=rel_tol, abs_tol=abs_tol)


def _validate_grounding(response: CopilotResponse, context: dict[str, Any]) -> CopilotResponse:
    """Reject model claims/actions that cannot be tied to Tellus context."""
    flat = [e for item in context.get("evidence", []) for e in _flatten_evidence(item)]
    evidence_ids = {e.get("evidenceId") for e in flat}
    evidence_by_id = {e.get("evidenceId"): e for e in flat}
    source_ids = {
        source.get("id")
        for source in context.get("sources", [])
        if isinstance(source, dict)
    }
    for claim in response.claims:
        valid_ids = evidence_ids if claim.evidenceType == "computed_result" else source_ids
        if claim.evidenceId not in valid_ids:
            return CopilotResponse(
                kind="abstain",
                message="I could not connect every claim to Tellus evidence or a documented source.",
                limitations=["The response was discarded because its evidence references could not be verified."],
                confidence="abstain",
            )
        if claim.evidenceType != "computed_result" and not claim.sourceUrl:
            return CopilotResponse(
                kind="abstain",
                message="I could not validate the source citation for that explanation.",
                limitations=["Source-backed claims require a visible URL."],
                confidence="abstain",
            )
        if claim.evidenceType == "computed_result":
            evidence_text = json.dumps(evidence_by_id.get(claim.evidenceId, {}), ensure_ascii=False)
            claim_numbers = _claim_numbers(claim.text)
            evidence_numbers = [
                float(n) for n in re.findall(r"(?<![A-Za-z0-9.])[-+]?\d+(?:\.\d+)?", evidence_text)  # mantissa of 8.7e-06 too
            ]
            unmatched = [
                n for n in claim_numbers
                if not any(_numbers_match(float(n), e) or _rounds_to(n, e) for e in evidence_numbers)
            ]
            if unmatched:
                return CopilotResponse(
                    kind="abstain",
                    message="I could not verify the numerical wording against the computed result.",
                    limitations=["Numerical claims must be traceable to the returned analysis evidence."],
                    confidence="abstain",
                )
    if response.action:
        options = context["selectionOptions"]
        if (
            response.action.variableId not in {item["id"] for item in options["variables"]}
            or response.action.regionId not in {item["id"] for item in options["regions"]}
            or response.action.season not in {item["id"] for item in options["seasons"]}
            or response.action.windowId not in {item["id"] for item in options["windows"]}
        ):
            return CopilotResponse(
                kind="abstain",
                message="I could not validate the suggested investigation against the Tellus catalogue.",
                limitations=["Unsupported selections are never applied automatically."],
                confidence="abstain",
            )
    return response
