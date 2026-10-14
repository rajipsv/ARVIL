"""Offline tests for the RAG HTTP service (stub embeddings and LLM)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from rag import server
from rag.config import Settings
from rag.index import build_or_load_index
from rag.knowledge import load_patterns
from rag.retriever import HybridRetriever
from rag.schema import LLMTriage

from .test_rag import GIT_DIFF_LOG, HashEmbeddings


def _engine(tmp_path, generate=None) -> server.Engine:
    patterns = load_patterns()
    store = build_or_load_index(patterns, HashEmbeddings(), "hash-test", tmp_path)
    retriever = HybridRetriever(patterns, store=store, mode="hybrid", min_cosine=2.0)
    settings = Settings("google", "test-chat", "hash-test", None, 2.0, 60, tmp_path)
    return server.Engine(settings, retriever, generate)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("ARVIL_RAG_SECRET", raising=False)
    holder = {"engine": _engine(tmp_path)}
    server.app.dependency_overrides[server.get_engine] = lambda: holder["engine"]
    yield TestClient(server.app), holder, tmp_path
    server.app.dependency_overrides.clear()


def test_triage_retrieval_only(client):
    c, _, _ = client
    r = c.post("/triage", json={"log": GIT_DIFF_LOG})
    assert r.status_code == 200
    body = r.json()
    assert body["llm_used"] is False and body["retriever"] == "hybrid"
    first = body["results"][0]
    assert first["pattern_id"] == "git_diff_ci_fail"
    assert first["retrieved"][0]["sources"] == ["keyword", "faiss"]


def test_triage_with_llm(client):
    c, holder, tmp_path = client
    holder["engine"] = _engine(
        tmp_path,
        lambda _: LLMTriage(
            pattern_id="git_diff_ci_fail",
            category="Configuration",
            severity="HIGH",
            root_cause="shallow clone",
            recommendation="fetch-depth: 0",
            confidence=0.8,
        ),
    )
    body = c.post("/triage", json={"log": GIT_DIFF_LOG}).json()
    assert body["llm_used"] is True and body["chat_model"] == "test-chat"
    assert body["results"][0]["mode"] == "rag"


def test_llm_failure_falls_back_to_retrieval(client):
    c, holder, tmp_path = client

    def broken(_):
        raise RuntimeError("429 quota exceeded")

    holder["engine"] = _engine(tmp_path, broken)
    body = c.post("/triage", json={"log": GIT_DIFF_LOG}).json()
    assert body["llm_used"] is False
    assert "429" in body["llm_error"]
    assert body["results"][0]["mode"] == "retrieval_only"


def test_secret_is_enforced(client, monkeypatch):
    c, _, _ = client
    monkeypatch.setenv("ARVIL_RAG_SECRET", "s3cret")
    assert c.post("/triage", json={"log": GIT_DIFF_LOG}).status_code == 401
    ok = c.post("/triage", json={"log": GIT_DIFF_LOG}, headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_empty_log_rejected(client):
    c, _, _ = client
    assert c.post("/triage", json={"log": ""}).status_code == 422


def test_same_origin_browser_call_allowed(client, monkeypatch):
    c, _, _ = client
    monkeypatch.setenv("ARVIL_RAG_SECRET", "s3cret")
    r = c.post("/triage", json={"log": GIT_DIFF_LOG}, headers={"Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 200
    cross = c.post("/triage", json={"log": GIT_DIFF_LOG}, headers={"Sec-Fetch-Site": "cross-site"})
    assert cross.status_code == 401


def test_vercel_entry_point_routes(tmp_path, monkeypatch):
    """api/rag.py serves GET (health) and POST (triage) at /api/rag and at the function root."""
    import importlib.util
    from pathlib import Path

    monkeypatch.delenv("ARVIL_RAG_SECRET", raising=False)
    spec = importlib.util.spec_from_file_location(
        "vercel_rag", Path(__file__).resolve().parents[2] / "api" / "rag.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    engine = _engine(tmp_path)
    mod.app.dependency_overrides[server.get_engine] = lambda: engine
    monkeypatch.setattr(server, "get_engine", lambda: engine)  # health() calls it directly
    c = TestClient(mod.app)
    for path in ("/api/rag", "/"):
        assert c.get(path).json()["index_ready"] is True
        body = c.post(path, json={"log": GIT_DIFF_LOG}).json()
        assert body["results"][0]["pattern_id"] == "git_diff_ci_fail"


def test_committed_index_matches_shared_patterns():
    """rag/index must hold an index for the current patterns, or Vercel re-embeds on cold start."""
    from rag.config import get_settings
    from rag.index import index_key

    s = get_settings()
    key = index_key(load_patterns(), s.embed_model)
    assert (s.index_dir / key / "index.faiss").is_file(), (
        "Run `python -m rag --export-index` after changing lib/data/patterns.json"
    )
