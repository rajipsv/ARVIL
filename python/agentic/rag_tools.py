"""RAG tools for ARVIL agentic analyzer (Phase 2)."""

from __future__ import annotations

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from .failure_kb import FailureKnowledgeBase


class LookupInput(BaseModel):
    error_signature: str = Field(
        description="Error message, stack line, or signature to match against known failures"
    )
    top_k: int = Field(default=3, ge=1, le=10)


class SearchKBInput(BaseModel):
    query: str = Field(description="Free-text search across failure patterns and learned resolutions")
    top_k: int = Field(default=5, ge=1, le=15)


class RecordResolutionInput(BaseModel):
    error_signature: str = Field(description="Exact or representative error text from the log")
    resolution: str = Field(description="What fixed it or next steps for validation engineers")
    category: str = Field(default="Other", description="Database, GPU/Driver, Memory, etc.")
    severity: str = Field(default="MEDIUM", description="CRITICAL, HIGH, MEDIUM, LOW")


def create_rag_tools(kb: FailureKnowledgeBase) -> list[StructuredTool]:
    def lookup_known_failure(error_signature: str, top_k: int = 3) -> str:
        """Match an error signature to known failure patterns and prior triage resolutions."""
        matches = kb.lookup_known_failure(error_signature, top_k=top_k)
        header = f"lookup_known_failure: {error_signature[:200]}\n{'-' * 40}\n"
        return header + kb.format_matches(matches)

    def search_failure_knowledge(query: str, top_k: int = 5) -> str:
        """Semantic/keyword search over the qualification knowledge base."""
        matches = kb.search(query, top_k=top_k)
        header = f"search_failure_knowledge: {query[:200]}\n{'-' * 40}\n"
        return header + kb.format_matches(matches)

    def list_kb_categories() -> str:
        """List categories and counts in the failure knowledge base."""
        return kb.list_categories()

    def record_resolution(
        error_signature: str,
        resolution: str,
        category: str = "Other",
        severity: str = "MEDIUM",
    ) -> str:
        """Save a triage outcome to the knowledge base for future lookups (self-improving KB)."""
        entry = kb.record_resolution(error_signature, resolution, category, severity)
        return f"Recorded resolution id={entry['id']} for future lookup_known_failure calls."

    return [
        StructuredTool.from_function(
            func=lookup_known_failure,
            name="lookup_known_failure",
            description=(
                "RAG: Match error text to known patterns (ROCm, DB, memory, CI). "
                "Call after grep/stack trace with the exact error line."
            ),
            args_schema=LookupInput,
        ),
        StructuredTool.from_function(
            func=search_failure_knowledge,
            name="search_failure_knowledge",
            description="RAG: Broad search across patterns and learned resolutions.",
            args_schema=SearchKBInput,
        ),
        StructuredTool.from_function(
            func=list_kb_categories,
            name="list_kb_categories",
            description="List knowledge base categories and pattern counts.",
        ),
        StructuredTool.from_function(
            func=record_resolution,
            name="record_resolution",
            description="Store a confirmed fix/triage note for future automated lookup (human-approved learning).",
            args_schema=RecordResolutionInput,
        ),
    ]
