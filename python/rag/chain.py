"""
LangChain (LCEL) RAG chain for one root cause:

    normalize -> retrieve -> RunnableBranch(strong match -> prompt | LLM -> validate,
                                            weak match   -> no_match)
"""

from __future__ import annotations

import time
from typing import Any, Callable

from langchain_core.messages import BaseMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable, RunnableBranch, RunnableLambda, RunnablePassthrough

from .config import Settings
from .extract import normalize_query
from .retriever import HybridRetriever, Retrieval
from .schema import LLMTriage, SimilarFailure, TriageResult

GenerateFn = Callable[[list[BaseMessage]], LLMTriage]

SYSTEM_RAG = """You are ARVIL, a CI log triage assistant for ROCm / TheRock validation engineers.
Diagnose the error using ONLY the known failure patterns provided.
Rules:
- Set pattern_id to the id of the pattern that explains the error, or null if none fits.
- Take the recommendation from that pattern's solutions; do not invent fixes.
- If no pattern fits, say the failure is unknown and recommend what to inspect next.
- GitHub Actions '##[error] Process completed with exit code' lines are wrappers, not causes.
- "Similar past occurrences" shows recurrence history, not a verified fix. Use it only to
  note whether this looks like a recurring/systemic issue; recommendation must still come
  from a retrieved pattern's solutions, or say the fix is unknown if no pattern matched."""

SYSTEM_NO_RAG = """You are ARVIL, a CI log triage assistant for ROCm / TheRock validation engineers.
Diagnose the error from the log lines alone. Set pattern_id to null."""

HUMAN_RAG = """Error line {error_line}:
{error_message}

Log context:
{context}

Known failure patterns (retrieved):
{patterns}

Similar past occurrences (recurrence evidence only - NOT verified fixes):
{historical}"""

HUMAN_NO_RAG = """Error line {error_line}:
{error_message}

Log context:
{context}"""


INTERACTIVE_TIMEOUT_S = 25.0


def make_generate_fn(settings: Settings, *, interactive: bool = False) -> GenerateFn:
    """
    Chat model with structured output.

    Batch use (CLI, evaluation): rate limiting, retries with back-off and a response cache,
    so long runs respect free-tier quotas and re-runs don't spend them twice.
    Interactive use (web request): no rate limiter, one attempt with a timeout and no
    cache, so a click returns well inside the serverless time limit.
    """
    if not settings.has_key:
        raise RuntimeError(
            f"No API key for provider '{settings.provider}'. Set GOOGLE_API_KEY in python/.env "
            "or run with --no-llm."
        )

    kwargs: dict = {"temperature": 0}
    if interactive:
        kwargs.update(timeout=INTERACTIVE_TIMEOUT_S, max_retries=0)
    else:
        from langchain_community.cache import SQLiteCache
        from langchain_core.globals import set_llm_cache
        from langchain_core.rate_limiters import InMemoryRateLimiter

        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        set_llm_cache(SQLiteCache(database_path=str(settings.cache_dir / "llm_cache.sqlite")))
        kwargs.update(
            rate_limiter=InMemoryRateLimiter(requests_per_second=settings.requests_per_minute / 60.0),
            max_retries=2,
        )

    if settings.provider == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI

        llm = ChatGoogleGenerativeAI(model=settings.chat_model, google_api_key=settings.api_key, **kwargs)
    else:
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=settings.chat_model, api_key=settings.api_key, **kwargs)

    structured = llm.with_structured_output(LLMTriage)
    if not interactive:
        structured = structured.with_retry(stop_after_attempt=3)
    return lambda messages: structured.invoke(messages)


def _format_patterns(retrieval: Retrieval, retriever: HybridRetriever) -> str:
    blocks = []
    for m in retrieval.matches:
        p = retriever.patterns[m.pattern_id]
        blocks.append(
            f"id: {m.pattern_id}\n"
            f"pattern: {p.get('pattern', '')}\n"
            f"category: {p.get('category', '')} | severity: {p.get('severity', '')}\n"
            f"causes: {p.get('causes', '')}\n"
            f"solutions: {p.get('solutions', '')}\n"
            f"similar errors: {p.get('similar_errors', '')}"
        )
    return "\n\n".join(blocks)


def _format_historical(similar: list[SimilarFailure]) -> str:
    if not similar:
        return "(none found)"
    return "\n".join(
        f'- "{s.message[:200]}" - seen {s.occurrence_count}x'
        + (f", most recently run #{s.github_run_id}" if s.github_run_id else "")
        + f" (cosine {s.cosine})"
        for s in similar
    )


def _recurrence_note(similar: list[SimilarFailure]) -> str:
    if not similar:
        return ""
    top = similar[0]
    run_ref = f" (most recently run #{top.github_run_id})" if top.github_run_id else ""
    return f" This signature has recurred {top.occurrence_count}x before{run_ref}."


def _retrieval_only(x: dict, retriever: HybridRetriever) -> LLMTriage:
    """Deterministic answer straight from the top retrieved pattern (no LLM)."""
    top = x["retrieval"].matches[0]
    p = retriever.patterns[top.pattern_id]
    return LLMTriage(
        pattern_id=top.pattern_id,
        category=p.get("category", "Other"),
        severity=p.get("severity", "MEDIUM") if p.get("severity") in ("CRITICAL", "HIGH", "MEDIUM", "LOW") else "MEDIUM",
        root_cause=p.get("causes", ""),
        recommendation=p.get("solutions", ""),
        confidence=0.5,
    )


def _no_match(x: dict) -> dict:
    x["mode"] = "no_match"
    x["messages"] = []
    similar: list[SimilarFailure] = x.get("similar_failures", [])
    x["llm"] = LLMTriage(
        pattern_id=None,
        category="Other",
        severity="CRITICAL" if x.get("error_type") in ("CRITICAL", "FATAL") else "HIGH",
        root_cause="No known failure pattern matched this error.",
        recommendation=(
            "Inspect the surrounding context and stack trace; check recent CI changes. "
            "Record the fix in the knowledge base once triaged."
            + _recurrence_note(similar)  # deterministic string, not LLM-generated - no hallucination risk
        ),
        confidence=0.0,
    )
    return x


def _finalize(x: dict) -> dict:
    llm: LLMTriage = x["llm"]
    retrieval: Retrieval = x["retrieval"]
    retrieved_ids = {m.pattern_id for m in retrieval.matches}
    # Grounding guard: the model may only cite a pattern that was actually retrieved.
    # similar_failures never participates in this check - it's recurrence evidence, not a fix source.
    pattern_id = llm.pattern_id if llm.pattern_id in retrieved_ids else None
    x["result"] = TriageResult(
        error_line=x["error_line"],
        error_message=x["error_message"],
        evidence_lines=x.get("evidence_lines", []),
        pattern_id=pattern_id,
        category=llm.category,
        severity=llm.severity,
        root_cause=llm.root_cause,
        recommendation=llm.recommendation,
        confidence=llm.confidence,
        mode=x["mode"],
        retrieved=retrieval.matches,
        similar_failures=x.get("similar_failures", []),
        llm_error=x.get("llm_error"),
    )
    x["latency_ms"] = round((time.perf_counter() - x["_t0"]) * 1000)
    return x


def build_chain(
    retriever: HybridRetriever | None,
    generate: GenerateFn | None,
    *,
    use_rag: bool = True,
    top_k: int = 3,
    llm_fallback: bool = False,
    historical_conn: Any = None,
    historical_embeddings: Any = None,
    embed_model: str = "",
    history_min_cosine: float = 0.8,
    github_run_id: int | None = None,
    html_url: str | None = None,
) -> Runnable:
    """
    Input:  {error_line, error_message, error_type, context, evidence_lines}
    Output: the same dict plus query, retrieval, messages, result (TriageResult), latency_ms.

    generate=None gives a retrieval-only chain (no LLM call).
    use_rag=False is the no-retrieval baseline used by the evaluation.
    llm_fallback=True turns an LLM failure into a retrieval-only answer for that root
    cause (web use) instead of failing the whole request.

    historical_conn/historical_embeddings: optional live Neon connection for "similar
    past occurrences" (Deep Analyze only). None disables the feature entirely, not an
    error - every historical.py call already degrades gracefully, this is belt-and-braces.
    """
    if use_rag and retriever is None:
        raise ValueError("use_rag=True needs a retriever")
    if not use_rag and generate is None:
        raise ValueError("the no-RAG baseline needs an LLM")

    start = RunnablePassthrough.assign(
        _t0=lambda _: time.perf_counter(),
        query=lambda x: normalize_query(x["error_message"]),
    )

    def find_historical(x: dict) -> list[SimilarFailure]:
        if historical_conn is None or historical_embeddings is None:
            return []
        from .historical import ensure_history_schema, embed_normalized, find_similar_failures

        if not ensure_history_schema(historical_conn, historical_embeddings):
            return []
        vector = embed_normalized(historical_embeddings, x["query"])
        return find_similar_failures(
            historical_conn, vector, embed_model, top_k=3, min_cosine=history_min_cosine
        )

    def write_back_historical(x: dict) -> dict:
        # Recomputes the embedding rather than threading it through from find_historical:
        # RunnablePassthrough.assign does not guarantee an in-place mutation on the input
        # dict survives into later steps (confirmed by a failed write-back in local testing
        # with a stashed x["_historical_vector"]). One extra embed call on an already
        # accepted double-embed path is a small, bounded cost for correctness here.
        if historical_conn is not None and historical_embeddings is not None:
            from .historical import embed_normalized, upsert_embedding

            vector = embed_normalized(historical_embeddings, x["query"])
            upsert_embedding(
                historical_conn,
                signature=x["query"],
                message=x["error_message"],
                vector=vector,
                embed_model=embed_model,
                github_run_id=github_run_id,
                html_url=html_url,
            )
        return x

    finalize_and_write_back = RunnableLambda(_finalize) | RunnableLambda(write_back_historical)

    if not use_rag:
        prompt = ChatPromptTemplate.from_messages([("system", SYSTEM_NO_RAG), ("human", HUMAN_NO_RAG)])
        return (
            start
            | RunnablePassthrough.assign(retrieval=lambda x: Retrieval(query=x["query"]), mode=lambda _: "no_rag")
            | RunnablePassthrough.assign(messages=prompt | RunnableLambda(lambda pv: pv.to_messages()))
            | RunnablePassthrough.assign(llm=lambda x: generate(x["messages"]))
            | RunnableLambda(_finalize)
        )

    retrieve = RunnablePassthrough.assign(
        retrieval=lambda x: retriever.retrieve(x["query"], top_k=top_k),
        similar_failures=find_historical,
    )

    if generate is None:
        answer = RunnablePassthrough.assign(
            mode=lambda _: "retrieval_only",
            messages=lambda _: [],
            llm=lambda x: _retrieval_only(x, retriever),
        )
    else:
        prompt = ChatPromptTemplate.from_messages([("system", SYSTEM_RAG), ("human", HUMAN_RAG)])
        def generate_step(x: dict) -> dict:
            x = dict(x)
            try:
                x["llm"] = generate(x["messages"])
            except Exception as e:
                if not llm_fallback:
                    raise
                x["llm"] = _retrieval_only(x, retriever)
                x["mode"] = "retrieval_only"
                x["llm_error"] = f"{type(e).__name__}: {e}"[:300]
            return x

        answer = (
            RunnablePassthrough.assign(
                mode=lambda _: "rag",
                patterns=lambda x: _format_patterns(x["retrieval"], retriever),
                historical=lambda x: _format_historical(x["similar_failures"]),
            )
            | RunnablePassthrough.assign(messages=prompt | RunnableLambda(lambda pv: pv.to_messages()))
            | RunnableLambda(generate_step)
        )

    branch = RunnableBranch(
        (lambda x: x["retrieval"].accepted, answer),
        RunnableLambda(_no_match),
    )
    return start | retrieve | branch | finalize_and_write_back
