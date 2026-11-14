"""Validated request and response contracts for the copilot API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AnalysisSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variableId: str | None = None
    regionId: str | None = None
    season: str | None = None
    windowId: str | None = None


class CopilotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=2000)
    selection: AnalysisSelection | None = None


class CopilotAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    variableId: str
    regionId: str
    season: str
    windowId: str


class EvidenceClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    evidenceType: Literal["computed_result", "project_source", "external_source"]
    evidenceId: str
    sourceUrl: str | None = None


class CopilotResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["answer", "analysis_action", "clarification", "abstain", "unavailable"]
    message: str
    action: CopilotAction | None = None
    claims: list[EvidenceClaim] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
    confidence: Literal["supported", "needs-context", "abstain", "unavailable"]
