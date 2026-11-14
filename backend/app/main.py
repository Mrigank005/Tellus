"""Tellus copilot HTTP service."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import load_settings, validate_model_or_warn
from .copilot import answer
from .anomaly import analyze_preset_anomalies
from .tellus import analyze_preset, compare_presets, gpcp_cross_check, selection_options
from .provider import key_status
from .prithvi import experiment_status
from .retrieval import search_sources
from .security import SlidingWindowLimiter
from .telemetry import Telemetry
from .schemas import CopilotRequest

settings = load_settings()
copilot_limiter = SlidingWindowLimiter(settings.rate_limit_requests, settings.rate_limit_window_seconds)
telemetry = Telemetry()
app = FastAPI(title="Tellus Copilot", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

MODEL_STATUS = validate_model_or_warn(settings)


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    """Bad selection parameters are client errors, not server crashes."""
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(KeyError)
async def key_error_handler(request: Request, exc: KeyError):
    return JSONResponse(status_code=404, content={"detail": f"unknown id: {exc.args[0]}"})


@app.api_route("/health", methods=["GET", "HEAD"])
def health() -> dict[str, object]:
    """Liveness probe (Render / UptimeRobot, GET or HEAD). Never calls the LLM."""
    return {"ok": True, "aiConfigured": bool(settings.llm_api_keys),
            "model": settings.llm_model, "modelStatus": MODEL_STATUS,
            **key_status(settings)}


@app.get("/api/telemetry")
def telemetry_snapshot() -> dict[str, object]:
    return telemetry.snapshot()


@app.get("/api/catalog/options")
def catalog_options() -> dict[str, object]:
    return selection_options()


@app.get("/api/sources/search")
def source_search(query: str, limit: int = 4) -> dict[str, object]:
    return {"query": query, "sources": search_sources(query, limit)}


@app.get("/api/analysis/preset")
def preset_analysis(
    variableId: str,
    regionId: str,
    season: str = "annual",
    windowId: str = "full",
) -> dict[str, object]:
    return analyze_preset(variableId, regionId, season, windowId)


@app.get("/api/analysis/compare")
def compare_analysis(
    variableId: str,
    regionA: str,
    regionB: str,
    season: str = "annual",
    windowId: str = "full",
) -> dict[str, object]:
    return compare_presets(variableId, regionA, regionB, season, windowId)


@app.get("/api/analysis/gpcp")
def gpcp_analysis(regionId: str, windowId: str = "full") -> dict[str, object]:
    return gpcp_cross_check(regionId, windowId)


@app.get("/api/analysis/anomalies")
def anomaly_analysis(
    variableId: str,
    regionId: str,
    season: str = "annual",
    windowId: str = "full",
) -> dict[str, object]:
    return analyze_preset_anomalies(variableId, regionId, season, windowId)


@app.get("/api/research/prithvi/status")
def prithvi_status() -> dict[str, object]:
    return experiment_status()


@app.post("/api/copilot/message")
async def copilot_message(request: Request, body: CopilotRequest) -> JSONResponse:
    forwarded = request.headers.get("x-forwarded-for")
    client_key = (forwarded.split(",")[0].strip() if forwarded
                  else (request.client.host if request.client else "unknown"))
    if not copilot_limiter.allow(client_key):
        telemetry.record("rate_limited")
        return JSONResponse(
            status_code=429,
            content={"detail": "Copilot rate limit exceeded. Try again shortly."},
            headers={"Retry-After": str(settings.rate_limit_window_seconds)},
        )
    if len(body.message.strip()) > settings.max_message_chars:
        telemetry.record("message_rejected")
        return JSONResponse(status_code=413, content={"detail": "Message is too long."})
    result = answer(body, settings, {})
    telemetry.record(f"response:{result.kind}")
    return JSONResponse(content=result.model_dump(by_alias=True))
