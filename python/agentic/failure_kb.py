"""
Failure knowledge base for ARVIL Phase 2 RAG.

Uses signature + keyword retrieval (always available). Optionally builds
FAISS embeddings when OPENAI_API_KEY and langchain-community are present.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_KB_DIR = Path(__file__).parent / "knowledge"
PATTERNS_FILE = "patterns.json"
RESOLUTIONS_FILE = "resolutions.jsonl"
FAISS_INDEX_DIR = "faiss_index"


@dataclass
class FailureMatch:
    pattern_id: str
    pattern: str
    category: str
    severity: str
    score: float
    causes: str
    solutions: str
    similar_errors: str
    source: str = "patterns"
    resolution_notes: str = ""

    def to_dict(self) -> dict:
        return {
            "pattern_id": self.pattern_id,
            "pattern": self.pattern,
            "category": self.category,
            "severity": self.severity,
            "score": self.score,
            "causes": self.causes,
            "solutions": self.solutions,
            "similar_errors": self.similar_errors,
            "source": self.source,
            "resolution_notes": self.resolution_notes,
        }


@dataclass
class FailureKnowledgeBase:
    """Searchable failure patterns + learned resolutions."""

    kb_dir: Path = field(default_factory=lambda: DEFAULT_KB_DIR)
    patterns: list[dict] = field(default_factory=list)
    resolutions: list[dict] = field(default_factory=list)
    _vectorstore: Any = field(default=None, repr=False)

    def __post_init__(self) -> None:
        self.kb_dir = Path(self.kb_dir)
        self.kb_dir.mkdir(parents=True, exist_ok=True)
        self._load_patterns()
        self._load_resolutions()
        self._maybe_init_embeddings()

    def _load_patterns(self) -> None:
        path = self.kb_dir / PATTERNS_FILE
        if path.is_file():
            self.patterns = json.loads(path.read_text(encoding="utf-8"))
        else:
            self.patterns = []

    def _load_resolutions(self) -> None:
        path = self.kb_dir / RESOLUTIONS_FILE
        self.resolutions = []
        if not path.is_file():
            return
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    self.resolutions.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    def _maybe_init_embeddings(self) -> None:
        if os.getenv("ARVIL_DISABLE_EMBEDDINGS", "").lower() in ("1", "true", "yes"):
            return
        if not os.getenv("OPENAI_API_KEY"):
            return
        try:
            from langchain_community.vectorstores import FAISS
            from langchain_core.documents import Document
            from langchain_openai import OpenAIEmbeddings
        except ImportError:
            return

        index_path = self.kb_dir / FAISS_INDEX_DIR
        embeddings = OpenAIEmbeddings()
        docs = []
        for p in self.patterns:
            text = self._pattern_document(p)
            docs.append(
                Document(
                    page_content=text,
                    metadata={"id": p.get("id", ""), "category": p.get("category", "")},
                )
            )
        for r in self.resolutions:
            text = f"Resolved: {r.get('error_signature', '')}\nNotes: {r.get('resolution', '')}"
            docs.append(Document(page_content=text, metadata={"id": r.get("id", "resolution")}))

        if not docs:
            return

        try:
            if index_path.is_dir():
                self._vectorstore = FAISS.load_local(
                    str(index_path), embeddings, allow_dangerous_deserialization=True
                )
            else:
                self._vectorstore = FAISS.from_documents(docs, embeddings)
                self._vectorstore.save_local(str(index_path))
        except Exception:
            self._vectorstore = None

    @staticmethod
    def _pattern_document(p: dict) -> str:
        return (
            f"Pattern: {p.get('pattern', '')}\n"
            f"Category: {p.get('category', '')}\n"
            f"Severity: {p.get('severity', '')}\n"
            f"Signatures: {', '.join(p.get('signatures', []))}\n"
            f"Causes: {p.get('causes', '')}\n"
            f"Solutions: {p.get('solutions', '')}\n"
            f"Similar: {p.get('similar_errors', '')}"
        )

    def _keyword_score(self, query: str, p: dict) -> float:
        q = query.lower()
        tokens = set(re.findall(r"[a-z0-9_./-]+", q))
        score = 0.0
        for sig in p.get("signatures", []):
            s = sig.lower()
            if s in q:
                score += 15.0
            elif any(t in s or s in t for t in tokens if len(t) > 3):
                score += 5.0
        blob = self._pattern_document(p).lower()
        overlap = sum(1 for t in tokens if len(t) > 3 and t in blob)
        score += overlap * 1.5
        if p.get("pattern", "").lower() in q:
            score += 8.0
        return score

    def _search_resolutions(self, query: str, top_k: int) -> list[FailureMatch]:
        matches: list[FailureMatch] = []
        for r in self.resolutions:
            sig = r.get("error_signature", "")
            blob = f"{sig} {r.get('resolution', '')}".lower()
            q = query.lower()
            score = 0.0
            if sig.lower() in q or q in sig.lower():
                score += 20.0
            tokens = set(re.findall(r"[a-z0-9_./-]+", q))
            score += sum(2.0 for t in tokens if len(t) > 3 and t in blob)
            if score > 0:
                matches.append(
                    FailureMatch(
                        pattern_id=r.get("id", "learned"),
                        pattern=sig[:120] or "Learned resolution",
                        category=r.get("category", "Other"),
                        severity=r.get("severity", "MEDIUM"),
                        score=score,
                        causes="Prior triage",
                        solutions=r.get("resolution", ""),
                        similar_errors="",
                        source="resolution",
                        resolution_notes=r.get("resolution", ""),
                    )
                )
        matches.sort(key=lambda m: m.score, reverse=True)
        return matches[:top_k]

    def search(self, query: str, top_k: int = 3) -> list[FailureMatch]:
        """Hybrid search: embeddings if available, else keyword scoring."""
        results: list[FailureMatch] = []

        if self._vectorstore is not None:
            try:
                for doc, dist in self._vectorstore.similarity_search_with_score(query, k=top_k):
                    meta = doc.metadata or {}
                    pid = meta.get("id", "")
                    pat = next((p for p in self.patterns if p.get("id") == pid), None)
                    if pat:
                        results.append(
                            FailureMatch(
                                pattern_id=pid,
                                pattern=pat.get("pattern", ""),
                                category=pat.get("category", ""),
                                severity=pat.get("severity", ""),
                                score=round(max(0, 100 - dist * 50), 1),
                                causes=pat.get("causes", ""),
                                solutions=pat.get("solutions", ""),
                                similar_errors=pat.get("similar_errors", ""),
                                source="faiss",
                            )
                        )
            except Exception:
                pass

        keyword_matches: list[FailureMatch] = []
        for p in self.patterns:
            s = self._keyword_score(query, p)
            if s > 0:
                keyword_matches.append(
                    FailureMatch(
                        pattern_id=p.get("id", ""),
                        pattern=p.get("pattern", ""),
                        category=p.get("category", ""),
                        severity=p.get("severity", ""),
                        score=s,
                        causes=p.get("causes", ""),
                        solutions=p.get("solutions", ""),
                        similar_errors=p.get("similar_errors", ""),
                        source="keyword",
                    )
                )
        keyword_matches.sort(key=lambda m: m.score, reverse=True)

        res_matches = self._search_resolutions(query, top_k)
        merged = {m.pattern_id: m for m in results}
        for m in keyword_matches + res_matches:
            prev = merged.get(m.pattern_id)
            if prev is None or m.score > prev.score:
                merged[m.pattern_id] = m

        final = sorted(merged.values(), key=lambda m: m.score, reverse=True)[:top_k]
        return final

    def lookup_known_failure(self, error_signature: str, top_k: int = 3) -> list[FailureMatch]:
        return self.search(error_signature, top_k=top_k)

    def record_resolution(
        self,
        error_signature: str,
        resolution: str,
        category: str = "Other",
        severity: str = "MEDIUM",
    ) -> dict:
        """Append a learned triage note to resolutions.jsonl (self-improving KB)."""
        entry = {
            "id": f"res_{len(self.resolutions) + 1}",
            "error_signature": error_signature.strip(),
            "resolution": resolution.strip(),
            "category": category,
            "severity": severity,
        }
        path = self.kb_dir / RESOLUTIONS_FILE
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        self.resolutions.append(entry)
        self._vectorstore = None
        self._maybe_init_embeddings()
        return entry

    def format_matches(self, matches: list[FailureMatch]) -> str:
        if not matches:
            return "No known failure patterns matched. Consider record_resolution after triage."
        lines = []
        for i, m in enumerate(matches, 1):
            lines.append(
                f"Match {i} [{m.source}] score={m.score} id={m.pattern_id}\n"
                f"  Pattern: {m.pattern}\n"
                f"  Category: {m.category} | Severity: {m.severity}\n"
                f"  Causes: {m.causes}\n"
                f"  Solutions: {m.solutions}\n"
                f"  Similar: {m.similar_errors}"
            )
            if m.resolution_notes:
                lines.append(f"  Prior resolution: {m.resolution_notes}")
        return "\n\n".join(lines)

    def list_categories(self) -> str:
        cats = sorted({p.get("category", "Other") for p in self.patterns})
        return "Knowledge base categories: " + ", ".join(cats) + f"\nTotal patterns: {len(self.patterns)}, learned resolutions: {len(self.resolutions)}"


def get_default_kb(kb_dir: str | Path | None = None) -> FailureKnowledgeBase:
    return FailureKnowledgeBase(kb_dir=Path(kb_dir) if kb_dir else DEFAULT_KB_DIR)
