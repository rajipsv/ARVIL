"""CLI: python -m rag <logfile> [--retriever keyword|faiss|hybrid] [--no-rag] [--no-llm]"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import get_settings
from .pipeline import analyze_log, build_retriever
from .retriever import MODES


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m rag",
        description="ARVIL RAG triage (LangChain + FAISS over the failure knowledge base)",
    )
    parser.add_argument("log_file", nargs="?", help="Path to a log file")
    parser.add_argument("--retriever", choices=MODES, default="hybrid")
    parser.add_argument("--no-rag", action="store_true", help="LLM only, no retrieval (evaluation baseline)")
    parser.add_argument("--no-llm", action="store_true", help="Retrieval only, answer from the top pattern")
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--max-causes", type=int, default=3, help="Root causes to triage per log")
    parser.add_argument("-o", "--output", default="rag_results.json")
    parser.add_argument("--run-log", default="rag_runs.jsonl", help="Per-request JSONL log")
    parser.add_argument("--build-index", action="store_true", help="Build the FAISS index and exit")
    args = parser.parse_args()

    settings = get_settings()

    if args.build_index:
        retriever = build_retriever(settings, "faiss")
        print(f"FAISS index ready: {len(retriever.patterns)} patterns, model={settings.embed_model}")
        return

    if not args.log_file:
        parser.error("log_file is required unless --build-index is given")
    path = Path(args.log_file)
    if not path.is_file():
        parser.error(f"Log file not found: {args.log_file}")
    if args.no_rag and args.no_llm:
        parser.error("--no-rag and --no-llm cannot be combined")

    try:
        results = analyze_log(
            path.read_text(encoding="utf-8", errors="replace"),
            source=path.name,
            settings=settings,
            retriever_mode=args.retriever,
            use_rag=not args.no_rag,
            use_llm=not args.no_llm,
            top_k=args.top_k,
            max_causes=args.max_causes,
            run_log=Path(args.run_log),
        )
    except RuntimeError as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(2)

    payload = [r.model_dump() for r in results]
    Path(args.output).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    for r in results:
        print(f"L{r.error_line} [{r.severity}] {r.mode} pattern={r.pattern_id} conf={r.confidence:.2f}")
        print(f"  {r.error_message[:140]}")
        print(f"  -> {r.recommendation[:200]}")
    print(f"\n{len(results)} root cause(s). Saved: {args.output}; request log: {args.run_log}")


if __name__ == "__main__":
    main()
