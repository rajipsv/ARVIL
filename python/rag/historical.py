"""
Live historical-failure retrieval against Neon (pgvector), for Deep Analyze only.

Unlike the static patterns.json knowledge base, this corpus is grown live:
every error a user Deep-Analyzes gets embedded and upserted here, so future
similar errors can be matched against real recurrence history, not just the
curated KB. Coupled into the same prompt as KB pattern retrieval (chain.py),
not a side channel - that's what makes this "similar past occurrences"
section actually RAG rather than a side panel the LLM never sees.

Every function here is defensive: a Neon hiccup degrades to "no historical
context" (empty list / no-op), never fails the whole Deep Analyze request.
This is the one module in python/rag with a live DB dependency, deliberately
scoped to the opt-in Deep Analyze path only - see historical.py's caller in
chain.py and the design rationale in DESIGN.md / the session that added this.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from .config import Settings
from .schema import SimilarFailure

if TYPE_CHECKING:
    import psycopg
    from langchain_core.embeddings import Embeddings

_connection: "psycopg.Connection | None" = None
_schema_ready = False


def _connect(settings: Settings) -> "psycopg.Connection | None":
    global _connection
    if not settings.database_url:
        return None
    if _connection is not None and not _connection.closed:
        return _connection
    try:
        import psycopg

        _connection = psycopg.connect(settings.database_url, prepare_threshold=None, autocommit=True)
    except Exception:
        _connection = None
    return _connection


def embed_normalized(embeddings: "Embeddings", text: str) -> list[float]:
    """Embed then L2-normalize, so pgvector cosine distance (<=>) is a true
    cosine similarity - same convention python/rag/index.py uses for FAISS."""
    vec = embeddings.embed_query(text)
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def ensure_history_schema(conn: "psycopg.Connection", embeddings: "Embeddings") -> bool:
    """Idempotent create-extension/table/index. Resolves the vector dimension
    by actually embedding a probe string - never hardcoded, since different
    embedding providers/models have different output dimensions."""
    global _schema_ready
    if _schema_ready:
        return True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM information_schema.tables WHERE table_name = 'error_embeddings'")
            if cur.fetchone() is None:
                dim = len(embed_normalized(embeddings, "dimension probe"))
                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
                cur.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS error_embeddings (
                        signature TEXT PRIMARY KEY,
                        message TEXT NOT NULL,
                        embedding VECTOR({dim}) NOT NULL,
                        embed_model TEXT NOT NULL,
                        github_run_id BIGINT,
                        html_url TEXT,
                        occurrence_count INT NOT NULL DEFAULT 1,
                        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_error_embeddings_vector
                    ON error_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
                    """
                )
        _schema_ready = True
        return True
    except Exception:
        return False


def find_similar_failures(
    conn: "psycopg.Connection",
    vector: list[float],
    embed_model: str,
    *,
    top_k: int = 3,
    min_cosine: float = 0.8,
) -> list[SimilarFailure]:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT message, github_run_id, html_url, occurrence_count,
                       1 - (embedding <=> %(vec)s::vector) AS cosine
                FROM error_embeddings
                WHERE embed_model = %(embed_model)s
                ORDER BY embedding <=> %(vec)s::vector
                LIMIT %(top_k)s
                """,
                {"vec": vector, "embed_model": embed_model, "top_k": top_k},
            )
            rows = cur.fetchall()
        return [
            SimilarFailure(
                message=message,
                cosine=round(float(cosine), 4),
                github_run_id=github_run_id,
                html_url=html_url,
                occurrence_count=occurrence_count,
            )
            for message, github_run_id, html_url, occurrence_count, cosine in rows
            if cosine >= min_cosine
        ]
    except Exception:
        return []


def upsert_embedding(
    conn: "psycopg.Connection",
    *,
    signature: str,
    message: str,
    vector: list[float],
    embed_model: str,
    github_run_id: int | None,
    html_url: str | None,
) -> None:
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO error_embeddings
                    (signature, message, embedding, embed_model, github_run_id, html_url)
                VALUES (%(signature)s, %(message)s, %(vector)s::vector, %(embed_model)s, %(run_id)s, %(url)s)
                ON CONFLICT (signature) DO UPDATE SET
                    occurrence_count = error_embeddings.occurrence_count + 1,
                    last_seen_at = NOW(),
                    github_run_id = COALESCE(EXCLUDED.github_run_id, error_embeddings.github_run_id),
                    html_url = COALESCE(EXCLUDED.html_url, error_embeddings.html_url)
                """,
                {
                    "signature": signature,
                    "message": message[:2000],
                    "vector": vector,
                    "embed_model": embed_model,
                    "run_id": github_run_id,
                    "url": html_url,
                },
            )
    except Exception:
        pass


def get_connection(settings: Settings) -> "psycopg.Connection | None":
    return _connect(settings)
