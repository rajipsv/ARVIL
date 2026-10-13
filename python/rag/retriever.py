"""Hybrid retrieval: FAISS similarity + keyword scoring, fused with reciprocal rank fusion."""

from __future__ import annotations

from dataclasses import dataclass, field

from langchain_community.vectorstores import FAISS

from .knowledge import KB_MIN_SCORE, keyword_score, pattern_allowed
from .schema import RetrievedPattern

RRF_K = 60
MODES = ("keyword", "faiss", "hybrid")


@dataclass
class Retrieval:
    query: str
    matches: list[RetrievedPattern] = field(default_factory=list)
    accepted: bool = False


class HybridRetriever:
    def __init__(
        self,
        patterns: list[dict],
        store: FAISS | None = None,
        mode: str = "hybrid",
        min_cosine: float = 0.6,
        min_keyword: float = KB_MIN_SCORE,
    ):
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if mode != "keyword" and store is None:
            raise ValueError(f"mode '{mode}' needs a FAISS index")
        self.patterns = {p["id"]: p for p in patterns if p.get("id")}
        self.store = store
        self.mode = mode
        self.min_cosine = min_cosine
        self.min_keyword = min_keyword

    def _keyword_ranking(self, query: str) -> dict[str, float]:
        scores = {pid: keyword_score(query, p) for pid, p in self.patterns.items()}
        return {pid: s for pid, s in scores.items() if s > 0}

    def _faiss_ranking(self, query: str, k: int) -> dict[str, float]:
        hits = self.store.similarity_search_with_score(query, k=k)
        # Index holds unit vectors, so squared L2 distance d2 gives cosine = 1 - d2 / 2.
        return {doc.metadata.get("id", ""): 1.0 - float(d2) / 2.0 for doc, d2 in hits}

    def retrieve(self, query: str, top_k: int = 3) -> Retrieval:
        kw = self._keyword_ranking(query) if self.mode in ("keyword", "hybrid") else {}
        cos = self._faiss_ranking(query, max(top_k * 3, 6)) if self.mode in ("faiss", "hybrid") else {}

        # Scores from the two retrievers are on different scales, so fuse by rank.
        rrf: dict[str, float] = {}
        for ranking in (kw, cos):
            ordered = sorted(ranking, key=ranking.get, reverse=True)
            for rank, pid in enumerate(ordered, start=1):
                rrf[pid] = rrf.get(pid, 0.0) + 1.0 / (RRF_K + rank)

        matches: list[RetrievedPattern] = []
        for pid in sorted(rrf, key=rrf.get, reverse=True):
            p = self.patterns.get(pid)
            if p is None or not pattern_allowed(pid, query):
                continue
            sources = [name for name, ranking in (("keyword", kw), ("faiss", cos)) if pid in ranking]
            matches.append(
                RetrievedPattern(
                    pattern_id=pid,
                    pattern=p.get("pattern", ""),
                    category=p.get("category", "Other"),
                    severity=p.get("severity", "MEDIUM"),
                    rrf_score=round(rrf[pid], 5),
                    keyword_score=round(kw.get(pid, 0.0), 2),
                    cosine=round(cos[pid], 4) if pid in cos else None,
                    sources=sources,
                )
            )
            if len(matches) >= top_k:
                break

        # Accept only if some retrieved pattern clears a per-retriever threshold;
        # otherwise the error is treated as unknown rather than weakly guessed.
        accepted = any(
            m.keyword_score >= self.min_keyword or (m.cosine is not None and m.cosine >= self.min_cosine)
            for m in matches
        )
        return Retrieval(query=query, matches=matches, accepted=accepted)
