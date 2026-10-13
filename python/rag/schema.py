"""Pydantic schemas for RAG triage output."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Severity = Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]


class LLMTriage(BaseModel):
    """What the model is asked to return for one root cause."""

    pattern_id: Optional[str] = Field(
        default=None,
        description="id of the retrieved pattern that explains this error, or null if none fits",
    )
    category: str = Field(description="Failure category, e.g. GPU/Driver, Configuration, Runtime, Memory")
    severity: Severity
    root_cause: str = Field(description="One or two sentences on the most likely cause")
    recommendation: str = Field(description="Concrete next action for a validation engineer")
    confidence: float = Field(ge=0.0, le=1.0, description="0 to 1 confidence in this diagnosis")


class RetrievedPattern(BaseModel):
    pattern_id: str
    pattern: str
    category: str
    severity: str
    rrf_score: float
    keyword_score: float
    cosine: Optional[float] = None
    sources: list[str] = Field(default_factory=list)


class TriageResult(BaseModel):
    """Validated triage for one root cause."""

    error_line: int
    error_message: str
    evidence_lines: list[int] = Field(default_factory=list)
    pattern_id: Optional[str] = None
    category: str
    severity: Severity
    root_cause: str
    recommendation: str
    confidence: float = Field(ge=0.0, le=1.0)
    mode: Literal["rag", "no_match", "no_rag", "retrieval_only"]
    retrieved: list[RetrievedPattern] = Field(default_factory=list)
