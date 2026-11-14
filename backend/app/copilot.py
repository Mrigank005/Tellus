"""Grounded copilot orchestration and safe fallback behavior."""

from __future__ import annotations

import json
import re
from typing import Any

from .config import Settings
from .tellus import (analyze_preset, build_context, compare_presets, gpcp_cross_check,
                          variable_cross_check)
from .retrieval import retrieval_context
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
periods, so never subtract their slopes."""

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
    r"|method\w*|test\w*|statistic\w*|significan\w*|p-?value|confidence|interval|fdr|caution)\b", re.I)


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
    evidence = (context or {}).get("evidence", [])
    if evidence:
        base = _evidence_fallback(evidence[0])
        extra = _crosscheck_sentence(context)
        if extra:
            base = base.model_copy(update={"message": base.message + " " + extra})
        # Be explicit: without the AI service this is the result for the
        # CURRENT SELECTION, not an answer to the question's own wording.
        return base.model_copy(update={
            "message": "The AI service is unavailable right now, so here is the validated "
                       "result for your current selection: " + base.message,
            "limitations": ["AI unavailable: this does not interpret your question; change the "
                            "selection or use Laya to investigate another place or variable."]
                           + list(base.limitations),
            "confidence": "needs-context",
        })
    return CopilotResponse(
        kind="unavailable",
        message="The AI copilot is not configured yet. You can still use Laya and the full Tellus analysis without AI.",
        limitations=["Set LLM_API_KEY on the backend to enable the grounded copilot."],
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
    try:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({"question": request.message, "selection": request.selection.model_dump() if request.selection else None, "context": context})},
        ]
        tool_context = dict(context)
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
        return _validate_grounding(response, tool_context)
    except ProviderUnavailable:
        return _fallback(request.message, context)
    except ValueError:
        if context.get("evidence"):
            base = _evidence_fallback(context["evidence"][0])
            extra = _crosscheck_sentence(context)
            return base.model_copy(update={"message": base.message + " " + extra}) if extra else base
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
    nested = [result.get("primary")] + list(result.get("counterparts") or [])
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
    if result.get("sen_slope") is not None:
        scale = 10
        claims.append({
            "text": f"Sen's slope is {result['sen_slope'] * scale:.4g} {evidence['variable']['units']}.",
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


def _numbers_match(a: float, b: float, rel_tol: float = 1e-3, abs_tol: float = 1e-4) -> bool:
    """Tolerant numeric equality so honest reformattings verify
    ('0.35' vs 0.3498, per-decade restatements, rounding)."""
    import math as _math
    return _math.isclose(a, b, rel_tol=rel_tol, abs_tol=abs_tol)


def _validate_grounding(response: CopilotResponse, context: dict[str, Any]) -> CopilotResponse:
    """Reject model claims/actions that cannot be tied to Tellus context."""
    evidence_ids = {
        evidence.get("evidenceId")
        for evidence in context.get("evidence", [])
        if isinstance(evidence, dict)
    }
    evidence_by_id = {
        evidence.get("evidenceId"): evidence
        for evidence in context.get("evidence", [])
        if isinstance(evidence, dict)
    }
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
            claim_numbers = re.findall(r"(?<![A-Za-z])[-+]?\d+(?:\.\d+)?", claim.text)
            evidence_numbers = [
                float(n) for n in re.findall(r"(?<![A-Za-z])[-+]?\d+(?:\.\d+)?", evidence_text)
            ]
            unmatched = [
                float(n) for n in claim_numbers
                if not any(_numbers_match(float(n), e) for e in evidence_numbers)
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
