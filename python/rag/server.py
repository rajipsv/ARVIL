"""
HTTP service around the RAG pipeline, so the web app can call FAISS retrieval.

    uvicorn rag.server:app --port 8000        (run from python/)

POST /triage   {"log": "...", "max_causes": 3, "use_llm": true, "source": "run-123"}
GET  /health   readiness, provider and model names (no secrets)
"""

from __future__ import annotations

import hmac
import os
import time
from functools import lru_cache
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .chain import GenerateFn, make_generate_fn
from .config import Settings, get_settings
from .historical import get_connection
from .index import make_embeddings
from .knowledge import load_patterns
from .pipeline import analyze_log, build_retriever
from .retriever import HybridRetriever
from .schema import TriageResult

MAX_LOG_CHARS = 2_000_000


class TriageRequest(BaseModel):
    log: str = Field(min_length=1, max_length=MAX_LOG_CHARS)
    # Triage only the error at this 1-based line (one LLM call); omit for the whole log.
    line: Optional[int] = Field(default=None, ge=1)
    message: Optional[str] = Field(default=None, max_length=4000)
    max_causes: int = Field(default=1, ge=1, le=5)
    use_llm: bool = True
    source: str = Field(default="web", max_length=200)
    # Best-effort: only known when the log came from a synced artifact with run
    # metadata. Used to link "similar past occurrences" back to a real run; absent
    # for manually pasted logs, which is fine - degrades to no link, not an error.
    github_run_id: Optional[int] = None
    html_url: Optional[str] = Field(default=None, max_length=500)


class TriageResponse(BaseModel):
    results: list[TriageResult]
    retriever: str
    embed_model: str
    chat_model: Optional[str]
    llm_used: bool
    llm_error: Optional[str] = None
    latency_ms: int


class Engine:
    """Retriever (FAISS index built once at startup) and optional LLM."""

    def __init__(
        self,
        settings: Settings,
        retriever: HybridRetriever,
        generate: GenerateFn | None,
        historical_conn: object | None = None,
        historical_embeddings: object | None = None,
    ):
        self.settings = settings
        self.retriever = retriever
        self.generate = generate
        self.historical_conn = historical_conn
        self.historical_embeddings = historical_embeddings


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    settings = get_settings()
    # Query embeddings need the API key; without it, degrade to keyword retrieval.
    mode = os.getenv("ARVIL_RAG_RETRIEVER") or ("hybrid" if settings.has_key else "keyword")
    retriever = build_retriever(settings, mode)
    generate = make_generate_fn(settings, interactive=True) if settings.has_key else None
    # Live Neon connection for "similar past occurrences" (Deep Analyze only). Both
    # None when DATABASE_URL/API key are unset - feature disables itself, not an error.
    historical_conn = get_connection(settings) if settings.has_key else None
    historical_embeddings = make_embeddings(settings) if historical_conn is not None else None
    return Engine(settings, retriever, generate, historical_conn, historical_embeddings)


def check_auth(
    authorization: str | None = Header(default=None),
    sec_fetch_site: str | None = Header(default=None),
) -> None:
    """
    Bearer secret for server-to-server calls; same-origin browser requests are allowed
    so the console can call the function directly (same rule as /api/sync).
    """
    secret = os.getenv("ARVIL_RAG_SECRET", "")
    if not secret:
        return
    if sec_fetch_site == "same-origin":
        return
    expected = f"Bearer {secret}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


app = FastAPI(title="ARVIL RAG service", version="1.0.0")


@app.get("/health")
def health() -> dict:
    settings = get_settings()
    body = {
        "ok": True,
        "provider": settings.provider,
        "embed_model": settings.embed_model,
        "chat_model": settings.chat_model,
        "api_key_set": settings.has_key,
        "patterns": len(load_patterns()),
        "auth_required": bool(os.getenv("ARVIL_RAG_SECRET")),
    }
    try:
        engine = get_engine()
        body["retriever"] = engine.retriever.mode
        body["index_ready"] = engine.retriever.store is not None
    except Exception as e:  # report, don't crash the health check
        body["ok"] = False
        body["error"] = str(e)[:300]
    return body


@app.post("/triage", response_model=TriageResponse, dependencies=[Depends(check_auth)])
def triage(req: TriageRequest, engine: Engine = Depends(get_engine)) -> TriageResponse:
    t0 = time.perf_counter()
    use_llm = req.use_llm and engine.generate is not None
    llm_error = None
    try:
        results = analyze_log(
            req.log,
            source=req.source,
            settings=engine.settings,
            use_llm=use_llm,
            max_causes=req.max_causes,
            retriever=engine.retriever,
            generate=engine.generate,
            llm_fallback=True,
            max_concurrency=req.max_causes,
            line=req.line,
            message=req.message,
            historical_conn=engine.historical_conn,
            historical_embeddings=engine.historical_embeddings,
            github_run_id=req.github_run_id,
            html_url=req.html_url,
        )
        failed = [r for r in results if r.llm_error]
        if use_llm and failed:
            llm_error = failed[0].llm_error
            use_llm = any(r.mode == "rag" for r in results)
    except Exception as e:
        if not use_llm:
            raise HTTPException(status_code=500, detail=f"Retrieval failed: {e}") from e
        # Rate limit or model error: fall back to retrieval-only answers.
        llm_error = str(e)[:300]
        use_llm = False
        results = analyze_log(
            req.log,
            source=req.source,
            settings=engine.settings,
            use_llm=False,
            max_causes=req.max_causes,
            retriever=engine.retriever,
            line=req.line,
            message=req.message,
            historical_conn=engine.historical_conn,
            historical_embeddings=engine.historical_embeddings,
            github_run_id=req.github_run_id,
            html_url=req.html_url,
        )
    return TriageResponse(
        results=results,
        retriever=engine.retriever.mode,
        embed_model=engine.settings.embed_model,
        chat_model=engine.settings.chat_model if use_llm else None,
        llm_used=use_llm,
        llm_error=llm_error,
        latency_ms=round((time.perf_counter() - t0) * 1000),
    )
