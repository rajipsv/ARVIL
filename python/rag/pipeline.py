"""End-to-end log triage: extract root causes, run the RAG chain on each, log every request."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain_core.embeddings import Embeddings

from .chain import GenerateFn, build_chain, make_generate_fn
from .config import Settings, get_settings
from .extract import context_window, extract_root_causes
from .index import build_or_load_index, make_embeddings
from .knowledge import load_patterns
from .retriever import HybridRetriever
from .schema import TriageResult


def build_retriever(
    settings: Settings,
    mode: str = "hybrid",
    *,
    patterns: list[dict] | None = None,
    embeddings: Embeddings | None = None,
) -> HybridRetriever:
    patterns = patterns if patterns is not None else load_patterns()
    store = None
    if mode != "keyword":
        embeddings = embeddings or make_embeddings(settings)
        store = build_or_load_index(
            patterns, embeddings, settings.embed_model, settings.cache_dir, settings.index_dir
        )
    return HybridRetriever(patterns, store=store, mode=mode, min_cosine=settings.min_cosine)


def _single_error_input(content: str, line: int, message: str | None) -> dict[str, Any]:
    """Input for one error chosen in the UI; `message` relocates it if line numbers drifted."""
    lines = content.splitlines()
    text = lines[line - 1].strip() if 1 <= line <= len(lines) else ""
    if message and message.strip() and message.strip() != text:
        for i, ln in enumerate(lines):
            if ln.strip() == message.strip():
                line, text = i + 1, ln.strip()
                break
        else:
            text = message.strip()
    upper = text.upper()
    kind = "FATAL" if "FATAL" in upper else "CRITICAL" if "CRITICAL" in upper else "ERROR"
    return {
        "error_line": line,
        "error_message": text,
        "error_type": kind,
        "context": context_window(content, line) if 1 <= line <= len(lines) else text,
        "evidence_lines": [line],
    }


def _log_record(x: dict[str, Any], source: str) -> dict[str, Any]:
    """Raw error, transformed query, retrieved ids with scores, final prompt, output."""
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "error_line": x["error_line"],
        "raw_error": x["error_message"],
        "query": x["query"],
        "retrieved": [m.model_dump() for m in x["retrieval"].matches],
        "accepted": x["retrieval"].accepted,
        "prompt": [{"role": m.type, "content": m.content} for m in x.get("messages", [])],
        "output": x["result"].model_dump(),
        "latency_ms": x["latency_ms"],
    }


def analyze_log(
    content: str,
    *,
    source: str = "log",
    settings: Settings | None = None,
    retriever_mode: str = "hybrid",
    use_rag: bool = True,
    use_llm: bool = True,
    top_k: int = 3,
    max_causes: int = 3,
    run_log: Path | None = None,
    retriever: HybridRetriever | None = None,
    generate: GenerateFn | None = None,
    llm_fallback: bool = False,
    max_concurrency: int = 1,
    line: int | None = None,
    message: str | None = None,
) -> list[TriageResult]:
    """
    Triage the log's root causes (up to max_causes), or only the error at `line`
    when it is given: one retrieval and at most one LLM call.
    """
    settings = settings or get_settings()
    if use_rag and retriever is None:
        retriever = build_retriever(settings, retriever_mode)
    if use_llm and generate is None:
        generate = make_generate_fn(settings)
    chain = build_chain(
        retriever if use_rag else None,
        generate if use_llm else None,
        use_rag=use_rag,
        top_k=top_k,
        llm_fallback=llm_fallback,
    )

    if line is not None:
        inputs = [_single_error_input(content, line, message)]
    else:
        inputs = [
            {
                "error_line": rc.line,
                "error_message": rc.message,
                "error_type": rc.type,
                "context": context_window(content, rc.line),
                "evidence_lines": rc.evidence_lines,
            }
            for rc in extract_root_causes(content)[:max_causes]
        ]
    # Root causes are independent; max_concurrency > 1 runs their LLM calls in parallel.
    outputs = chain.batch(inputs, config={"max_concurrency": max_concurrency}) if inputs else []

    results: list[TriageResult] = []
    for out in outputs:
        results.append(out["result"])
        if run_log is not None:
            run_log.parent.mkdir(parents=True, exist_ok=True)
            with run_log.open("a", encoding="utf-8") as f:
                f.write(json.dumps(_log_record(out, source)) + "\n")
    return results
