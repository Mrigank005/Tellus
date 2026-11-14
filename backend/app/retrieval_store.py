"""Optional retrieval backend boundary.

The current deterministic source index remains the default. A future vector
store can implement this protocol after the November data and corpus are
available, without changing copilot contracts.
"""

from __future__ import annotations

from typing import Protocol


class RetrievalStore(Protocol):
    def search(self, query: str, limit: int) -> list[dict[str, str]]:
        ...


class UnconfiguredRetrievalStore:
    def search(self, query: str, limit: int) -> list[dict[str, str]]:
        return []
