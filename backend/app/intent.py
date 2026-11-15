"""Deterministic reading of a copilot question: which regions, variable,
season and window does it name?

The copilot must answer the question that was asked, not whatever happens to
be selected on screen. These rules run before (and independently of) the LLM,
so even when the free model fails or returns an invalid reply, the fallback
answer is about the place and quantity in the question. Anything the question
does not name falls back to the current selection.
"""

from __future__ import annotations

import re
from typing import Any

# Order matters: more specific (satellite / mission) phrasings come first so
# "satellite rainfall" picks IMERG rather than MERRA-2 precipitation.
VARIABLE_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bimerg\b|\bgpm\b|satellite\s+(rain|precip)", re.I), "IMERG_PRECIP"),
    (re.compile(r"\bcmorph\b", re.I), "KNMI_CMORPH_PRECIP"),
    (re.compile(r"\bno2\b|\bno₂\b|nitrogen\s+dioxide|air\s+pollution|traffic\s+pollution", re.I), "OMI_NO2"),
    (re.compile(r"aerosol|\baod\b|haz[ey]|smog|smoke|dust", re.I), "OMI_AOD_500"),
    (re.compile(r"chlorophyll|phytoplankton|algae|ocean\s+colou?r", re.I), "NOBM_TOTAL_CHL"),
    (re.compile(r"\bsst\b|sea[\s-]+surface\s+temp|ocean\s+temp|sea\s+temp|ocean(s)?\s+warm", re.I), "KNMI_OISSTV2_SST"),
    (re.compile(r"\bndvi\b|vegetation|greenness|greening|browning|plant\s+cover", re.I), "KNMI_NOAACDR_NDVI"),
    (re.compile(r"\bairs\b|satellite\s+(surface\s+)?temp", re.I), "AIRS_TSURF"),
    (re.compile(r"runoff|river\s+flow|streamflow", re.I), "GLDAS_RUNOFF"),
    (re.compile(r"soil\s+moisture|\bgldas\b", re.I), "GLDAS_SOILM"),
    (re.compile(r"station\s+(rain|precip)", re.I), "NCEI_GSOM_PRCP"),
    (re.compile(r"station\s+temp|thermometer|de\s+bilt", re.I), "NCEI_GSOM_TAVG"),
    # MERRA-2 (NASA POWER) variables, mirroring the Laya router's keywords
    (re.compile(r"night|nighttime|minimum\s+temp|\bfrost", re.I), "T2M_MIN"),
    (re.compile(r"day(\s?time)?\s+max|hottest\s+days|extreme\s+heat|heat\s?waves?", re.I), "T2M_MAX"),
    (re.compile(r"humidit|humid|moist\s+air|mugg", re.I), "RH2M"),
    (re.compile(r"monsoon|rain|precip|wet\s+season|snowfall", re.I), "PRECTOTCORR"),
    (re.compile(r"evaporat|evapotranspiration|water\s+loss", re.I), "EVLAND"),
    (re.compile(r"\bdr(y|ying|ier|iest)\b|drought|soil\s+wet|arid", re.I), "GWETTOP"),
    (re.compile(r"wind|breeze", re.I), "WS10M"),
    (re.compile(r"hotter|warm|heat|temperature|cool(ing)?\b|cold", re.I), "T2M"),
]

REGION_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"whole\s+earth|entire\s+(planet|earth)|global\s+(mean|average)|globally|world\s?wide|the\s+(whole\s+)?planet|everywhere", re.I), "whole-earth"),
    (re.compile(r"southern\s+ocean", re.I), "southern-ocean"),
    (re.compile(r"ni[nñ]o|el\s+nino|equatorial\s+pacific|\benso\b", re.I), "nino34"),
    (re.compile(r"antarctic|south\s+pole", re.I), "antarctica"),
    (re.compile(r"arctic|north\s+pole|polar", re.I), "arctic"),
    (re.compile(r"greenland", re.I), "greenland"),
    (re.compile(r"siberia|russia|taiga", re.I), "siberia"),
    (re.compile(r"europe|germany|france|netherlands|britain|\buk\b", re.I), "western-europe"),
    (re.compile(r"sahara|north\s+africa", re.I), "sahara"),
    (re.compile(r"sahel", re.I), "sahel"),
    (re.compile(r"congo|central\s+africa", re.I), "congo-basin"),
    (re.compile(r"amazon|brazil|rainforest", re.I), "amazon"),
    (re.compile(r"andes|patagonia|peru|chile", re.I), "andes"),
    (re.compile(r"great\s+plains|midwest|united\s+states|\bu\.?s\.?a\b|kansas|nebraska", re.I), "us-great-plains"),
    (re.compile(r"tropic|equator", re.I), "tropics"),
    (re.compile(r"indonesia|maritime\s+south|philippines|malaysia", re.I), "maritime-southeast-asia"),
    (re.compile(r"australia|outback", re.I), "australian-outback"),
    (re.compile(r"himalaya|karakoram|tibet|nepal", re.I), "himalaya"),
    (re.compile(r"gangetic|ganges|punjab|delhi|north(ern)?\s+india", re.I), "indo-gangetic-plain"),
    (re.compile(r"ghats|kerala|konkan|malabar|goa", re.I), "western-ghats"),
    (re.compile(r"thar|rajasthan", re.I), "thar-northwest"),
    (re.compile(r"bengal|bangladesh|kolkata|sundarbans", re.I), "bengal-delta"),
]

SEASON_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"monsoon|\bjjas\b|june|summer\s+rain", re.I), "JJAS"),
    (re.compile(r"winter|\bdjf\b|december", re.I), "DJF"),
    (re.compile(r"whole\s+year|annual|all\s+year|year[\s-]round", re.I), "annual"),
]

WINDOW_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(last|past|recent)\s+20\s+years|since\s+2006", re.I), "w20"),
    (re.compile(r"(last|past|recent)\s+30\s+years|since\s+1996", re.I), "w30"),
    (re.compile(r"full\s+record|since\s+1981|all\s+years|45\s+years", re.I), "full"),
]

def _first_match(rules: list[tuple[re.Pattern[str], str]], text: str) -> str | None:
    hits = [(m.start(), value) for pattern, value in rules if (m := pattern.search(text))]
    return min(hits)[1] if hits else None


def regions_in(text: str) -> list[str]:
    """Distinct region ids in the order they appear in the question."""
    hits: list[tuple[int, str]] = []
    for pattern, region_id in REGION_RULES:
        m = pattern.search(text)
        if m:
            hits.append((m.start(), region_id))
    # "Antarctic" also matches the "arctic" rule; keep only the longer name
    names = {r for _, r in hits}
    if "antarctica" in names and "arctic" in names and not re.search(r"(?<!ant)arctic", text, re.I):
        hits = [h for h in hits if h[1] != "arctic"]
    ordered: list[str] = []
    for _, region_id in sorted(hits):
        if region_id not in ordered:
            ordered.append(region_id)
    return ordered


def variable_in(text: str) -> str | None:
    """First matching rule in priority order (specific mission phrasings win)."""
    for pattern, variable_id in VARIABLE_RULES:
        if pattern.search(text):
            return variable_id
    return None


def resolve(question: str, selection: dict[str, Any] | None) -> dict[str, Any]:
    """Selection to analyse for this question, plus what came from the text.

    Returns {"selection": {...}, "regions": [...], "compare": bool,
    "fromQuestion": {field: value}}. Fields the question does not name come
    from the current selection (or sensible defaults).
    """
    base = {"variableId": "T2M", "regionId": "whole-earth", "season": "annual", "windowId": "full"}
    for key in base:
        if selection and selection.get(key):
            base[key] = selection[key]
    found: dict[str, Any] = {}
    regions = regions_in(question)
    variable = variable_in(question)
    season = _first_match(SEASON_RULES, question)
    window = _first_match(WINDOW_RULES, question)
    if variable:
        found["variableId"] = variable
    if regions:
        found["regionId"] = regions[0]
    if season:
        found["season"] = season
    if window:
        found["windowId"] = window
    resolved = {**base, **found}
    # monsoon wording implies the JJAS season for rainfall questions
    if season is None and variable == "PRECTOTCORR" and re.search(r"monsoon", question, re.I):
        resolved["season"] = "JJAS"
    # compare only when the question itself names two places
    second = regions[1] if len(regions) >= 2 else None
    return {
        "selection": resolved,
        "regions": regions,
        "compare": bool(second and second != resolved["regionId"]),
        "compareWith": second,
        "fromQuestion": found,
    }
