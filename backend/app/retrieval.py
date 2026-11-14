"""Small deterministic source index for grounded copilot context."""

from __future__ import annotations

import re
from typing import Any

from .tellus import source_records


def search_sources(query: str, limit: int = 4) -> list[dict[str, str]]:
    terms = [term.lower() for term in re.findall(r"[a-z0-9]{3,}", query, flags=re.IGNORECASE)]
    scored: list[tuple[int, dict[str, str]]] = []
    for source in source_records():
        haystack = " ".join(source.values()).lower()
        score = sum(haystack.count(term) for term in terms)
        if score:
            scored.append((score, source))
    scored.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [source for _, source in scored[:max(1, min(limit, 8))]]


def retrieval_context(question: str) -> dict[str, Any]:
    return {"sources": search_sources(question), "query": question}
