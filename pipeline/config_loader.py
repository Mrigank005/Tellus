"""Shared configuration loader for pipeline scripts."""
import functools
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@functools.lru_cache(maxsize=None)
def load_config():
    domain = json.loads((ROOT / "config" / "domain.json").read_text(encoding="utf-8"))
    methods = json.loads((ROOT / "config" / "methods.json").read_text(encoding="utf-8"))
    return {**domain, "methods": methods}
