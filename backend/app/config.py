"""Environment-backed configuration for the Tellus copilot service."""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)

DEFAULT_MODEL = "google/gemma-4-31b-it:free"


@dataclass(frozen=True)
class Settings:
    llm_api_keys: tuple[str, ...]
    llm_base_url: str
    llm_model: str
    llm_structured_outputs: bool
    request_timeout_seconds: float
    max_message_chars: int
    max_tool_calls: int
    rate_limit_requests: int
    rate_limit_window_seconds: int
    allowed_origins: tuple[str, ...]

    @property
    def llm_api_key(self) -> str | None:
        """First configured key (backward-compatible accessor); never logged."""
        return self.llm_api_keys[0] if self.llm_api_keys else None


def load_api_keys() -> tuple[str, ...]:
    """Ordered failover keys: LLM_API_KEY_1, _2, _3... then legacy LLM_API_KEY.

    Duplicates and blanks are dropped. Key values are never printed.
    """
    keys: list[str] = []
    for index in range(1, 10):
        value = (os.getenv(f"LLM_API_KEY_{index}") or "").strip()
        if value and value not in keys:
            keys.append(value)
    legacy = (os.getenv("LLM_API_KEY") or "").strip()
    if legacy and legacy not in keys:
        keys.append(legacy)
    return tuple(keys)


def load_settings() -> Settings:
    configured = [
        origin.strip()
        for origin in (os.getenv("TELLUS_ALLOWED_ORIGINS") or os.getenv("EARTHSIGNAL_ALLOWED_ORIGINS")
                   or "http://localhost:5173").split(",")
        if origin.strip()
    ]
    # "localhost" and "127.0.0.1" are the same machine but different browser
    # origins; allow both spellings so the dev server works either way.
    expanded: list[str] = []
    for origin in configured:
        for variant in (origin,
                        origin.replace("://localhost", "://127.0.0.1"),
                        origin.replace("://127.0.0.1", "://localhost")):
            if variant not in expanded:
                expanded.append(variant)
    origins = tuple(expanded)
    return Settings(
        llm_api_keys=load_api_keys(),
        llm_base_url=os.getenv("LLM_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/"),
        llm_model=os.getenv("LLM_MODEL", DEFAULT_MODEL),
        llm_structured_outputs=os.getenv("LLM_STRUCTURED_OUTPUTS", "false").lower() in {"1", "true", "yes"},
        request_timeout_seconds=float(os.getenv("LLM_TIMEOUT_SECONDS", "30")),
        max_message_chars=int(os.getenv("COPILOT_MAX_MESSAGE_CHARS", "2000")),
        max_tool_calls=int(os.getenv("COPILOT_MAX_TOOL_CALLS", "4")),
        rate_limit_requests=int(os.getenv("COPILOT_RATE_LIMIT_REQUESTS", "20")),
        rate_limit_window_seconds=int(os.getenv("COPILOT_RATE_LIMIT_WINDOW_SECONDS", "60")),
        allowed_origins=origins,
    )


def known_models(base_url: str) -> set[str] | None:
    """Slugs the provider currently advertises (public endpoint, no auth).

    Returns None if the check itself fails — never blocks startup.
    """
    if "openrouter" not in base_url:
        return None
    try:
        req = urllib.request.Request(f"{base_url}/models", headers={"User-Agent": "tellus/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        return {m["id"] for m in data.get("data", [])}
    except Exception:
        return None


def validate_model_or_warn(settings: Settings) -> str:
    """Loud, honest startup check: provider model lists rotate, so verify the
    configured slug exists. Warns (never raises) and returns a status string."""
    known = known_models(settings.llm_base_url)
    if known is None:
        return "unknown (provider list unavailable)"
    if settings.llm_model in known:
        return "ok"
    print(f"[tellus] WARNING: model '{settings.llm_model}' is not in the "
          f"provider's current list; LLM calls will fail and the copilot will "
          f"fall back to deterministic answers. Set LLM_MODEL to one of the "
          f"{len(known)} advertised models.")
    return "MISSING from provider list"
