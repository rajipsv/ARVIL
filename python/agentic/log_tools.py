"""
Deterministic log tools for the ARVIL agentic analyzer.

Tools are created per log file session so the ReAct agent can explore
large logs without loading everything into a single prompt.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

ERROR_KEYWORDS = ("ERROR", "EXCEPTION", "CRITICAL", "FATAL", "WARNING")
STACK_START = re.compile(
    r"^\s*(at\s+[\w.$]+\(|Traceback|Caused by:|---\s*Crash)",
    re.IGNORECASE,
)


@dataclass
class LogSession:
    """Active log file for a single analysis run."""

    path: Path

    def read_lines(self) -> list[str]:
        with self.path.open("r", encoding="utf-8", errors="replace") as f:
            return f.readlines()


class GrepInput(BaseModel):
    pattern: str = Field(description="Regex or plain text to search for in the log")
    max_matches: int = Field(default=20, ge=1, le=100, description="Maximum matches to return")
    context_lines: int = Field(default=2, ge=0, le=10, description="Lines of context before/after each match")


class WindowInput(BaseModel):
    start_line: int = Field(ge=1, description="First line number (1-based)")
    end_line: int = Field(ge=1, description="Last line number (1-based, inclusive)")


class GrepKeywordInput(BaseModel):
    keyword: str = Field(description="One of ERROR, WARNING, CRITICAL, FATAL, EXCEPTION")
    max_matches: int = Field(default=15, ge=1, le=50)


def _truncate(text: str, limit: int = 12000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [truncated, {len(text) - limit} more chars]"


def create_log_tools(session: LogSession) -> list[StructuredTool]:
    """Build LangChain tools bound to a single log file."""

    def get_log_stats() -> str:
        """Return line count, file size, and counts of common error keywords."""
        lines = session.read_lines()
        size = session.path.stat().st_size
        counts = {kw: sum(1 for ln in lines if kw in ln.upper()) for kw in ERROR_KEYWORDS}
        counts_str = ", ".join(f"{k}={v}" for k, v in counts.items())
        return (
            f"path={session.path}\n"
            f"lines={len(lines)}\n"
            f"bytes={size}\n"
            f"keyword_hits: {counts_str}"
        )

    def read_log_window(start_line: int, end_line: int) -> str:
        """Read a 1-based inclusive slice of the log file."""
        lines = session.read_lines()
        if not lines:
            return "Log file is empty."
        start = max(1, start_line)
        end = min(len(lines), end_line)
        if start > end:
            return f"Invalid range: start_line={start_line} > end_line={end_line} (file has {len(lines)} lines)"
        chunk = "".join(lines[start - 1 : end])
        header = f"Lines {start}-{end} of {len(lines)} from {session.path.name}\n{'-' * 40}\n"
        return _truncate(header + chunk)

    def grep_log(pattern: str, max_matches: int = 20, context_lines: int = 2) -> str:
        """Search the log with regex; return match windows with line numbers."""
        lines = session.read_lines()
        try:
            rx = re.compile(pattern, re.IGNORECASE)
        except re.error as e:
            return f"Invalid regex '{pattern}': {e}"

        blocks: list[str] = []
        for i, line in enumerate(lines):
            if not rx.search(line):
                continue
            lo = max(0, i - context_lines)
            hi = min(len(lines), i + context_lines + 1)
            block_lines = []
            for j in range(lo, hi):
                prefix = ">>" if j == i else "  "
                block_lines.append(f"{prefix} {j + 1}: {lines[j].rstrip()}")
            blocks.append("\n".join(block_lines))
            if len(blocks) >= max_matches:
                break

        if not blocks:
            return f"No matches for pattern: {pattern}"
        return _truncate(
            f"Matches for /{pattern}/ (showing up to {max_matches}):\n\n" + "\n\n---\n\n".join(blocks)
        )

    def grep_error_keyword(keyword: str, max_matches: int = 15) -> str:
        """Grep for a standard log level keyword (ERROR, WARNING, CRITICAL, FATAL, EXCEPTION)."""
        kw = keyword.upper().strip()
        if kw not in ERROR_KEYWORDS:
            return f"Unsupported keyword '{keyword}'. Use one of: {', '.join(ERROR_KEYWORDS)}"
        return grep_log(rf"\b{re.escape(kw)}\b", max_matches=max_matches, context_lines=3)

    def extract_stack_traces(max_traces: int = 10) -> str:
        """Extract exception/stack trace blocks from the log."""
        lines = session.read_lines()
        traces: list[str] = []
        i = 0
        while i < len(lines) and len(traces) < max_traces:
            line = lines[i]
            if not any(k in line.upper() for k in ("ERROR", "EXCEPTION", "FATAL", "TRACE")):
                i += 1
                continue
            start = i
            j = i + 1
            while j < len(lines) and (
                STACK_START.match(lines[j])
                or lines[j].startswith((" ", "\t"))
                or "Caused by:" in lines[j]
            ):
                j += 1
            block = "".join(f"{idx + 1}: {lines[idx]}" for idx in range(start, min(j + 1, len(lines))))
            traces.append(block.strip())
            i = j + 1

        if not traces:
            return "No stack traces detected."
        return _truncate(f"Stack traces ({len(traces)}):\n\n" + "\n\n---\n\n".join(traces))

    def chunk_overview(lines_per_chunk: int = 500) -> str:
        """Summarize how the log splits into chunks for large-file analysis."""
        lines = session.read_lines()
        n = len(lines)
        if n == 0:
            return "Empty log."
        chunk_count = (n + lines_per_chunk - 1) // lines_per_chunk
        parts = []
        for c in range(min(chunk_count, 20)):
            start = c * lines_per_chunk + 1
            end = min((c + 1) * lines_per_chunk, n)
            window = lines[start - 1 : end]
            hits = sum(1 for ln in window if any(k in ln.upper() for k in ERROR_KEYWORDS))
            parts.append(f"chunk {c + 1}: lines {start}-{end}, keyword_hits={hits}")
        if chunk_count > 20:
            parts.append(f"... {chunk_count - 20} more chunks")
        return f"total_lines={n}, chunk_size={lines_per_chunk}, chunks={chunk_count}\n" + "\n".join(parts)

    return [
        StructuredTool.from_function(
            func=get_log_stats,
            name="get_log_stats",
            description="Get log file metadata: path, line count, size, and error keyword hit counts. Call this first.",
        ),
        StructuredTool.from_function(
            func=chunk_overview,
            name="chunk_overview",
            description="Overview of log chunks for large files; shows which regions have errors.",
        ),
        StructuredTool.from_function(
            func=read_log_window,
            name="read_log_window",
            description="Read a specific line range from the log (1-based line numbers).",
            args_schema=WindowInput,
        ),
        StructuredTool.from_function(
            func=grep_log,
            name="grep_log",
            description="Regex search with line numbers and context windows.",
            args_schema=GrepInput,
        ),
        StructuredTool.from_function(
            func=grep_error_keyword,
            name="grep_error_keyword",
            description="Search for standard severity keywords: ERROR, WARNING, CRITICAL, FATAL, EXCEPTION.",
            args_schema=GrepKeywordInput,
        ),
        StructuredTool.from_function(
            func=extract_stack_traces,
            name="extract_stack_traces",
            description="Pull exception and stack trace blocks for root-cause analysis.",
        ),
    ]


def _extract_highlight_messages(grep_output: str, limit: int = 5) -> list[str]:
    """Pull >> marked lines from grep tool output for RAG lookup."""
    messages = []
    for match in re.finditer(r">>\s+\d+:\s*(.+)", grep_output):
        msg = match.group(1).strip()
        if msg and msg not in messages:
            messages.append(msg)
        if len(messages) >= limit:
            break
    return messages


def run_tool_only_analysis(session: LogSession, kb=None) -> dict:
    """
    Deterministic analysis when OPENAI_API_KEY is not set.
    Runs the same tools in a fixed order (agentic workflow without LLM).
    """
    tools = {t.name: t for t in create_log_tools(session)}
    stats = tools["get_log_stats"].invoke({})
    overview = tools["chunk_overview"].invoke({})
    errors = tools["grep_error_keyword"].invoke({"keyword": "ERROR", "max_matches": 25})
    critical = tools["grep_error_keyword"].invoke({"keyword": "CRITICAL", "max_matches": 10})
    fatal = tools["grep_error_keyword"].invoke({"keyword": "FATAL", "max_matches": 10})
    stacks = tools["extract_stack_traces"].invoke({})

    rag_lookups: list[dict] = []
    if kb is not None:
        signatures = (
            _extract_highlight_messages(errors, 3)
            + _extract_highlight_messages(critical, 2)
            + _extract_highlight_messages(fatal, 2)
        )
        for sig in signatures[:5]:
            matches = kb.lookup_known_failure(sig, top_k=2)
            rag_lookups.append(
                {
                    "error_signature": sig,
                    "matches": [m.to_dict() for m in matches],
                    "formatted": kb.format_matches(matches),
                }
            )

    return {
        "mode": "tool_only",
        "stats": stats,
        "chunk_overview": overview,
        "error_samples": errors,
        "critical_samples": critical,
        "fatal_samples": fatal,
        "stack_traces": stacks,
        "rag_lookups": rag_lookups,
    }
