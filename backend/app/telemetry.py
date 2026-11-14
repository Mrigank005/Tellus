"""Privacy-preserving in-memory telemetry for copilot operations."""

from __future__ import annotations

from collections import Counter
from threading import Lock
from typing import Any, Protocol


class TelemetryStore(Protocol):
    """Store boundary for a shared metrics backend such as Redis or Postgres."""

    def increment(self, event: str) -> None:
        ...

    def snapshot(self) -> dict[str, int]:
        ...


class Telemetry:
    def __init__(self, store: TelemetryStore | None = None) -> None:
        self._store = store
        self._counts: Counter[str] = Counter()
        self._lock = Lock()

    def record(self, event: str) -> None:
        if self._store is not None:
            self._store.increment(event)
            return
        with self._lock:
            self._counts[event] += 1

    def snapshot(self) -> dict[str, Any]:
        if self._store is not None:
            return {"events": self._store.snapshot()}
        with self._lock:
            return {"events": dict(self._counts)}
