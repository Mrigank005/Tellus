"""Instant, fixed answers to questions about the method itself.

"What does statistically significant mean?" has one correct answer for this
tool, so it is written once here (from the methods the engine actually uses)
instead of waiting on a free LLM that may time out or wander. Every answer
cites the project's methods source.
"""

from __future__ import annotations

import re

from .schemas import CopilotResponse

METHODS_SOURCE = "source:methods"
METHODS_URL = "https://github.com/Mrigank005/Tellus#readme"

# (pattern, short title, explanation). First match wins, so specific terms
# come before general ones.
CONCEPTS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"missing\s+(months?|data|values?)|gaps?\s+in\s+the\s+data|incomplete\s+years?", re.I),
     "Missing data",
     "Missing months are never filled in or interpolated. A season or year is only used when enough of its "
     "months are present; otherwise that year is left out, and the record must still have at least 20 usable "
     "years (18 for ocean chlorophyll) before any verdict is given. Short records are labelled "
     "'insufficient data' instead of being forced into a trend."),
    (re.compile(r"persisten|autocorrel|lag[\s-]?1|red\s+noise|n[_\s]?eff|effective\s+sample", re.I),
     "Persistence (autocorrelation)",
     "Climate years resemble their neighbours (a warm year tends to follow a warm year), which makes random "
     "wobbles look like trends. Tellus measures this lag-1 persistence in the residuals, shrinks the effective "
     "number of independent years accordingly, and widens the uncertainty before deciding. Without this step "
     "many 'trends' would be false alarms."),
    (re.compile(r"sen'?s?\s+slope|theil|how\s+fast|rate\s+of\s+change|per\s+decade", re.I),
     "Sen's slope",
     "The trend rate is Sen's slope: the median of the slopes between every pair of years. Because it is a "
     "median, one extreme year (an El Niño, a volcanic eruption) cannot drag it around the way it would an "
     "ordinary straight-line fit. It is reported per decade with a 95% confidence interval."),
    (re.compile(r"mann[\s-]?kendall|which\s+test|what\s+test|statistical\s+test", re.I),
     "Mann-Kendall test",
     "The trend test is Mann-Kendall: it asks whether later years are consistently higher (or lower) than "
     "earlier ones, using only their order, so it does not assume the data are bell-shaped. Tellus applies it "
     "with tie correction and the persistence adjustment, and cross-checks the direction with an ordinary "
     "least-squares fit."),
    (re.compile(r"confidence\s+interval|\bci\b|error\s+bars?|uncertaint", re.I),
     "Confidence interval",
     "The 95% confidence interval is the range of trend rates the data are consistent with. If it includes "
     "zero, the data cannot rule out 'no change'. Tellus widens it for year-to-year persistence, so it is "
     "deliberately cautious."),
    (re.compile(r"false\s+discovery|\bfdr\b|benjamini|multiple\s+(testing|comparisons)|so\s+many\s+(cells|tests)", re.I),
     "False discovery rate",
     "The global maps test about 200,000 grid cells at once, so by pure chance thousands would look "
     "'significant'. Tellus controls the false discovery rate (Benjamini-Hochberg), which keeps the expected "
     "share of false alarms among the highlighted cells at 5%."),
    (re.compile(r"emergence|when\s+would\s+we\s+have\s+known|became\s+clear", re.I),
     "Time of emergence",
     "Time of emergence is the first year from which the trend has been statistically detected, in the same "
     "direction, every year since. A trend that appeared early and then faded does not count. It shows how "
     "many years of data it took for the signal to rise above the noise."),
    (re.compile(r"change[\s-]?point|pettitt|sudden\s+shift|step\s+change", re.I),
     "Change point",
     "The change-point marker uses the Pettitt test to find the single most likely year where the average "
     "shifted. It is exploratory: a real shift and a data artefact (such as a new satellite sensor) look the "
     "same to the test, and a steady trend can also trigger it, which the app says when a straight line fits "
     "just as well."),
    (re.compile(r"significan|p[\s-]?value|by\s+chance|real\s+trend|is\s+it\s+real", re.I),
     "Statistical significance",
     "'Statistically detected' means the trend would be unlikely (less than a 5% chance) to appear in data "
     "that had no real trend, after correcting for year-to-year persistence. It says the change is probably "
     "real, not how important it is, and never why it happened. Tellus needs at least 20 years of data before "
     "it gives any verdict."),
]


def concept_answer(question: str) -> CopilotResponse | None:
    for pattern, title, text in CONCEPTS:
        if pattern.search(question):
            return CopilotResponse(
                kind="answer",
                message=f"{title}: {text}",
                claims=[{
                    "text": f"How Tellus handles {title.lower()}.",
                    "evidenceType": "project_source",
                    "evidenceId": METHODS_SOURCE,
                    "sourceUrl": METHODS_URL,
                }],
                limitations=["This explains the method; ask about a place and a variable to see a computed result."],
                confidence="supported",
            )
    return None
