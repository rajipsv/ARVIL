"""
ARVIL Agentic Log Analyzer — Phase 1 + Phase 2 (RAG)

Tool-using LangGraph ReAct agent that explores logs via grep, windows,
stack-trace extraction, and failure knowledge base lookup.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

from .failure_kb import FailureKnowledgeBase, get_default_kb
from .log_tools import LogSession, create_log_tools, run_tool_only_analysis
from .rag_tools import create_rag_tools

load_dotenv()

SYSTEM_PROMPT = """You are ARVIL, an expert log qualification agent for software test and CI pipelines.

You MUST use tools to analyze logs. Never guess file contents.

Workflow:
1. Call get_log_stats first.
2. For large logs, call chunk_overview then read_log_window on suspicious regions.
3. Use grep_error_keyword and grep_log to find failures (ERROR, CRITICAL, FATAL, EXCEPTION).
4. Call extract_stack_traces for root-cause context.
5. For each distinct error line, call lookup_known_failure with the exact error signature.
6. Use search_failure_knowledge for ROCm/GPU/install failures if category is unclear.
7. Enrich recommendations using knowledge base solutions (do not invent fixes).
8. Produce a final answer with:
   - Executive summary (2-4 sentences)
   - JSON block with schema:
     {"errors": [{"type": str, "line_number": int, "message": str, "severity": str, "category": str, "recommendation": str, "kb_pattern_id": str|null}], "total_errors": int, "summary": str}
   - Top 3 recommended actions for validation engineers

Severity: CRITICAL > HIGH > MEDIUM > LOW.
Categories: Database, Network, Authentication, GPU/Driver, Configuration, Runtime, Memory, Security, Other.
"""


def _extract_json_from_text(text: str) -> dict | None:
    """Pull JSON object from agent response."""
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0]
    elif "```" in text:
        parts = text.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("{"):
                text = part
                break
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


def _messages_to_trace(messages: list) -> list[dict]:
    trace = []
    for m in messages:
        role = getattr(m, "type", type(m).__name__)
        content = getattr(m, "content", str(m))
        tool_calls = getattr(m, "tool_calls", None)
        entry: dict[str, Any] = {"role": role}
        if content:
            entry["content"] = content if isinstance(content, str) else str(content)[:2000]
        if tool_calls:
            entry["tool_calls"] = [
                {"name": tc.get("name", getattr(tc, "name", "")), "args": tc.get("args", getattr(tc, "args", {}))}
                for tc in tool_calls
            ]
        trace.append(entry)
    return trace


class ARVILAgent:
    """Tool-using ReAct agent for log qualification."""

    def __init__(
        self,
        model_name: str = "gpt-4o-mini",
        max_iterations: int = 16,
        kb: FailureKnowledgeBase | None = None,
    ):
        self.model_name = model_name
        self.max_iterations = max_iterations
        self.kb = kb or get_default_kb()
        self._graph = None

    def _all_tools(self, session: LogSession) -> list:
        return create_log_tools(session) + create_rag_tools(self.kb)

    def _build_graph(self, tools: list):
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            return None
        llm = ChatOpenAI(model=self.model_name, temperature=0, api_key=api_key)
        return create_react_agent(
            llm,
            tools,
            prompt=SystemMessage(content=SYSTEM_PROMPT),
        )

    def analyze(
        self,
        log_path: str | Path,
        *,
        use_llm: bool = True,
    ) -> dict:
        path = Path(log_path).resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Log file not found: {path}")

        session = LogSession(path=path)
        timestamp = datetime.now().isoformat()

        if not use_llm or not os.getenv("OPENAI_API_KEY"):
            print("[INFO] Running tool-only mode (no OPENAI_API_KEY or --tool-only flag).")
            tool_data = run_tool_only_analysis(session, kb=self.kb)
            return {
                "file": str(path),
                "timestamp": timestamp,
                "mode": "tool_only",
                "tool_analysis": tool_data,
                "errors": _errors_from_tool_only(tool_data, self.kb),
                "errors_count": _count_errors_from_tool_only(tool_data),
                "summary": _summary_from_tool_only(tool_data),
                "rag_lookups": tool_data.get("rag_lookups", []),
                "agent_trace": [],
            }

        tools = self._all_tools(session)
        graph = self._build_graph(tools)
        if graph is None:
            raise RuntimeError("Failed to build agent graph")

        user_msg = (
            f"Analyze this log file for qualification triage: {path}\n"
            "Use tools systematically. Return structured JSON errors plus summary."
        )

        print(f"\n{'=' * 72}\nARVIL Agentic Analysis: {path.name}\n{'=' * 72}\n")

        result = graph.invoke(
            {"messages": [HumanMessage(content=user_msg)]},
            config={"recursion_limit": self.max_iterations},
        )

        messages = result.get("messages", [])
        final_text = ""
        for m in reversed(messages):
            if isinstance(m, AIMessage) and m.content:
                final_text = m.content if isinstance(m.content, str) else str(m.content)
                break

        parsed = _extract_json_from_text(final_text) or {}
        errors = parsed.get("errors", [])
        if not isinstance(errors, list):
            errors = []

        return {
            "file": str(path),
            "timestamp": timestamp,
            "mode": "agentic_react",
            "model": self.model_name,
            "errors": errors,
            "errors_count": parsed.get("total_errors", len(errors)),
            "summary": parsed.get("summary", final_text[:1500]),
            "raw_agent_response": final_text,
            "agent_trace": _messages_to_trace(messages),
        }

    def save_results(self, results: dict, output_path: str = "agentic_results.json") -> None:
        Path(output_path).write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"Saved: {output_path}")

    def generate_report(self, results: dict, output_path: str = "agentic_report.txt") -> None:
        lines = [
            "=" * 80,
            "ARVIL AGENTIC LOG QUALIFICATION REPORT",
            "=" * 80,
            "",
            f"File: {results.get('file')}",
            f"Time: {results.get('timestamp')}",
            f"Mode: {results.get('mode')}",
            f"Model: {results.get('model', 'n/a')}",
            f"Errors: {results.get('errors_count', 0)}",
            "",
            "SUMMARY",
            "-" * 80,
            str(results.get("summary", "")),
            "",
        ]

        if results.get("mode") == "tool_only":
            ta = results.get("tool_analysis", {})
            for key in ("stats", "chunk_overview", "error_samples", "critical_samples", "fatal_samples", "stack_traces"):
                if ta.get(key):
                    lines.extend([key.upper(), "-" * 40, ta[key], ""])

        rag = results.get("rag_lookups") or []
        if rag:
            lines.extend(["RAG KNOWLEDGE BASE LOOKUPS", "=" * 80, ""])
            for item in rag:
                lines.append(f"Signature: {item.get('error_signature', '')}")
                lines.append(item.get("formatted", ""))
                lines.append("")

        errors = results.get("errors") or []
        if errors:
            lines.extend(["DETAILED ERRORS", "=" * 80, ""])
            for i, err in enumerate(errors, 1):
                lines.append(f"#{i}")
                if isinstance(err, dict):
                    for k, v in err.items():
                        lines.append(f"  {k}: {v}")
                else:
                    lines.append(f"  {err}")
                lines.append("")

        lines.extend(["=" * 80, "End of report", "=" * 80])
        Path(output_path).write_text("\n".join(lines), encoding="utf-8")
        print(f"Report: {output_path}")


def _count_errors_from_tool_only(tool_data: dict) -> int:
    text = tool_data.get("error_samples", "") + tool_data.get("critical_samples", "") + tool_data.get("fatal_samples", "")
    return len(re.findall(r"^>>\s+\d+:", text, re.MULTILINE))


def _errors_from_tool_only(tool_data: dict, kb: FailureKnowledgeBase | None = None) -> list[dict]:
    """Build minimal error list from grep output lines marked with >>."""
    rag_by_sig = {}
    for item in tool_data.get("rag_lookups", []):
        rag_by_sig[item.get("error_signature", "")] = item.get("matches", [])

    errors = []
    for field, default_type in (
        ("error_samples", "ERROR"),
        ("critical_samples", "CRITICAL"),
        ("fatal_samples", "FATAL"),
    ):
        block = tool_data.get(field, "")
        for match in re.finditer(r">>\s+(\d+):\s*(.+)", block):
            msg = match.group(2).strip()
            rec = "Inspect surrounding context and stack traces; check recent CI changes."
            category = "Runtime"
            kb_id = None
            matches = rag_by_sig.get(msg) or []
            if not matches and kb is not None:
                top = kb.lookup_known_failure(msg, top_k=1)
                matches = [m.to_dict() for m in top]
            if matches:
                m0 = matches[0]
                rec = m0.get("solutions", rec)
                category = m0.get("category", category)
                kb_id = m0.get("pattern_id")
            errors.append(
                {
                    "type": default_type,
                    "line_number": int(match.group(1)),
                    "message": msg,
                    "severity": "CRITICAL" if default_type in ("CRITICAL", "FATAL") else "HIGH",
                    "category": category,
                    "recommendation": rec,
                    "kb_pattern_id": kb_id,
                }
            )
    return errors[:50]


def _summary_from_tool_only(tool_data: dict) -> str:
    stats = tool_data.get("stats", "")
    n = _count_errors_from_tool_only(tool_data)
    return f"Tool-only qualification pass found {n} highlighted error lines. Stats: {stats.replace(chr(10), '; ')}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ARVIL agentic log analyzer (LangGraph ReAct + tools)",
    )
    parser.add_argument("log_file", nargs="?", default="example.log", help="Path to log file")
    parser.add_argument("-o", "--output", default="agentic_results.json")
    parser.add_argument("-r", "--report", default="agentic_report.txt")
    parser.add_argument("--model", default="gpt-4o-mini")
    parser.add_argument("--max-iterations", type=int, default=12)
    parser.add_argument(
        "--tool-only",
        action="store_true",
        help="Run deterministic tool pipeline without LLM (no API key required)",
    )
    parser.add_argument(
        "--kb-dir",
        default=None,
        help="Path to knowledge base directory (patterns.json, resolutions.jsonl)",
    )
    parser.add_argument(
        "--record-resolution",
        nargs=2,
        metavar=("SIGNATURE", "RESOLUTION"),
        help="Add a learned resolution to the KB and exit",
    )
    args = parser.parse_args()

    kb = get_default_kb(args.kb_dir)

    if args.record_resolution:
        sig, res = args.record_resolution
        entry = kb.record_resolution(sig, res)
        print(f"Recorded: {entry}")
        return

    log_path = Path(args.log_file)
    if not log_path.is_file():
        alt = Path(__file__).parent.parent / args.log_file
        if alt.is_file():
            log_path = alt
        else:
            parser.error(f"Log file not found: {args.log_file}")

    agent = ARVILAgent(model_name=args.model, max_iterations=args.max_iterations, kb=kb)
    results = agent.analyze(log_path, use_llm=not args.tool_only)
    agent.save_results(results, args.output)
    agent.generate_report(results, args.report)

    print(f"\nDone - {results.get('errors_count', 0)} errors, mode={results.get('mode')}\n")


if __name__ == "__main__":
    main()
