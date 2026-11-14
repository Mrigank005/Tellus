"""Lightweight request protections for the public copilot endpoint."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock
from typing import Protocol


class RateLimitStore(Protocol):
    """Small store boundary for replacing process-local state in deployment."""

    def consume(self, key: str, limit: int, window_seconds: int, now: float) -> bool:
        ...


class SlidingWindowLimiter:
    def __init__(
        self,
        limit: int,
        window_seconds: int,
        store: RateLimitStore | None = None,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._store = store
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        if self._store is not None:
            return self._store.consume(key, self.limit, self.window_seconds, now)
        cutoff = now - self.window_seconds
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True
