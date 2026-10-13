"""
Offline tests for the RAG pipeline: no API key, no network.

Run from python/:  python -m pytest tests -q
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

import pytest
from langchain_core.embeddings import Embeddings

from rag.chain import build_chain
from rag.config import Settings
from rag.extract import extract_root_causes, normalize_query
from rag.index import build_or_load_index
from rag.knowledge import load_patterns
from rag.pipeline import analyze_log
from rag.retriever import HybridRetriever
from rag.schema import LLMTriage

GIT_DIFF_LOG = "\n".join(
    ["2026-05-21T14:38:00.0000000Z step ok"] * 150
    + [
        "2026-05-21T14:39:09.0060000Z Traceback (most recent call last):",
        "2026-05-21T14:39:09.0065514Z     raise CalledProcessError(retcode, process.args,",
        "2026-05-21T14:39:09.0068130Z subprocess.CalledProcessError: Command '['git', 'diff', '--name-only', "
        "'bb1c030b66709b958a09596ff1bc76923024d497']' returned non-zero exit status 128.",
        "2026-05-21T14:39:09.0251367Z ##[error]Process completed with exit code 1.",
    ]
)

UNKNOWN_LOG = "2026-05-21T10:00:00Z ERROR zorblax widget frobnication mismatch in quux stage"


class HashEmbeddings(Embeddings):
    """Bag-of-words hashing embedding: deterministic, and similar text gives similar vectors."""

    dim = 256

    def __init__(self) -> None:
        self.calls = 0

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        for tok in re.findall(r"[a-z0-9_]+", text.lower()):
            vec[int(hashlib.md5(tok.encode()).hexdigest(), 16) % self.dim] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


@pytest.fixture()
def patterns() -> list[dict]:
    return load_patterns()


@pytest.fixture()
def hybrid(patterns, tmp_path) -> HybridRetriever:
    store = build_or_load_index(patterns, HashEmbeddings(), "hash-test", tmp_path)
    # Cosine threshold out of reach: acceptance in these tests comes from keyword evidence.
    return HybridRetriever(patterns, store=store, mode="hybrid", min_cosine=2.0)


def _settings(tmp_path: Path) -> Settings:
    return Settings("google", "test-chat", "hash-test", None, 2.0, 60, tmp_path)


def test_shared_kb_is_single_source(patterns):
    ids = {p["id"] for p in patterns}
    assert "git_diff_ci_fail" in ids

    from agentic.failure_kb import FailureKnowledgeBase

    agent_ids = {p["id"] for p in FailureKnowledgeBase().patterns}
    assert ids <= agent_ids  # agent sees every shared pattern
    assert "payment_card_declined" in agent_ids  # plus its local extras


def test_normalize_query_strips_volatile_tokens():
    q = normalize_query(GIT_DIFF_LOG.splitlines()[152])
    assert not q.startswith("2026")
    assert "<sha>" in q and "bb1c030b" not in q
    assert "git" in q and "exit status 128" in q


def test_git_diff_chain_is_one_root_cause():
    causes = extract_root_causes(GIT_DIFF_LOG)
    assert len(causes) == 1
    rc = causes[0]
    assert "git" in rc.message and rc.line == 153
    roles = {role for _, _, role in rc.related}
    assert "wrapper" in roles and "stack" in roles


def test_hybrid_retrieval_finds_git_pattern_and_blocks_gpu(hybrid):
    r = hybrid.retrieve(normalize_query(GIT_DIFF_LOG.splitlines()[152]))
    assert r.accepted
    assert r.matches[0].pattern_id == "git_diff_ci_fail"
    assert set(r.matches[0].sources) == {"keyword", "faiss"}
    assert not {m.pattern_id for m in r.matches} & {"rocm_hsa_status", "rocm_hip_error"}


def test_faiss_only_retrieval_ranks_by_similarity(patterns, tmp_path):
    store = build_or_load_index(patterns, HashEmbeddings(), "hash-test", tmp_path)
    r = HybridRetriever(patterns, store=store, mode="faiss", min_cosine=0.1).retrieve(
        "rccl allreduce collective failed on rank 3 bootstrap"
    )
    assert r.accepted and r.matches[0].pattern_id == "rocm_rccl_nccl"
    assert r.matches[0].cosine is not None and r.matches[0].keyword_score == 0


def test_index_is_cached_on_disk(patterns, tmp_path):
    first = HashEmbeddings()
    build_or_load_index(patterns, first, "hash-test", tmp_path)
    assert first.calls == 1
    second = HashEmbeddings()
    build_or_load_index(patterns, second, "hash-test", tmp_path)
    assert second.calls == 0  # loaded, not re-embedded
    build_or_load_index(patterns + [{"id": "new", "pattern": "x"}], second, "hash-test", tmp_path)
    assert second.calls == 1  # patterns changed, so the index is rebuilt


def test_unknown_error_skips_llm(hybrid):
    def generate(_):
        raise AssertionError("LLM must not be called when retrieval is weak")

    out = build_chain(hybrid, generate).invoke(
        {"error_line": 1, "error_message": UNKNOWN_LOG, "error_type": "ERROR", "context": UNKNOWN_LOG}
    )
    assert out["result"].mode == "no_match"
    assert out["result"].pattern_id is None


def test_rag_prompt_contains_retrieved_patterns_and_grounding_guard(hybrid):
    seen = {}

    def generate(messages):
        seen["prompt"] = "\n".join(m.content for m in messages)
        return LLMTriage(
            pattern_id="made_up_pattern",
            category="Configuration",
            severity="HIGH",
            root_cause="git diff failed",
            recommendation="fetch full history",
            confidence=0.9,
        )

    line = GIT_DIFF_LOG.splitlines()[152]
    out = build_chain(hybrid, generate).invoke(
        {"error_line": 153, "error_message": line, "error_type": "CRITICAL", "context": line}
    )
    assert "id: git_diff_ci_fail" in seen["prompt"]
    assert out["result"].mode == "rag"
    assert out["result"].pattern_id is None  # the model cited a pattern that was not retrieved


def test_pipeline_writes_request_log(hybrid, tmp_path):
    def generate(_):
        return LLMTriage(
            pattern_id="git_diff_ci_fail",
            category="Configuration",
            severity="HIGH",
            root_cause="shallow clone",
            recommendation="use fetch-depth: 0",
            confidence=0.8,
        )

    run_log = tmp_path / "runs.jsonl"
    results = analyze_log(
        GIT_DIFF_LOG, settings=_settings(tmp_path), retriever=hybrid, generate=generate, run_log=run_log
    )
    assert len(results) == 1 and results[0].pattern_id == "git_diff_ci_fail"
    assert results[0].evidence_lines == [152, 153, 154]

    rec = json.loads(run_log.read_text(encoding="utf-8").splitlines()[0])
    assert rec["query"] and rec["raw_error"] != rec["query"]
    assert rec["retrieved"][0]["pattern_id"] == "git_diff_ci_fail"
    assert rec["prompt"] and rec["output"]["mode"] == "rag"


def test_retrieval_only_and_no_rag_modes(hybrid, tmp_path):
    only = analyze_log(GIT_DIFF_LOG, settings=_settings(tmp_path), retriever=hybrid, use_llm=False)
    assert only[0].mode == "retrieval_only" and only[0].pattern_id == "git_diff_ci_fail"

    def generate(messages):
        assert "Known failure patterns" not in "\n".join(m.content for m in messages)
        return LLMTriage(
            pattern_id=None, category="Other", severity="HIGH", root_cause="?", recommendation="?", confidence=0.2
        )

    base = analyze_log(GIT_DIFF_LOG, settings=_settings(tmp_path), use_rag=False, generate=generate)
    assert base[0].mode == "no_rag" and base[0].retrieved == []
