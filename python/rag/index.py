"""FAISS index over the failure knowledge base (LangChain vector store)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings

from .config import Settings
from .knowledge import pattern_document


def make_embeddings(settings: Settings) -> Embeddings:
    if not settings.has_key:
        raise RuntimeError(
            f"No API key for provider '{settings.provider}'. Set GOOGLE_API_KEY in python/.env "
            "or run with --retriever keyword."
        )
    if settings.provider == "google":
        from langchain_google_genai import GoogleGenerativeAIEmbeddings

        return GoogleGenerativeAIEmbeddings(model=settings.embed_model, google_api_key=settings.api_key)
    from langchain_openai import OpenAIEmbeddings

    return OpenAIEmbeddings(model=settings.embed_model, api_key=settings.api_key)


def index_key(patterns: list[dict], embed_model: str) -> str:
    blob = json.dumps(patterns, sort_keys=True) + "|" + embed_model
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def build_or_load_index(
    patterns: list[dict],
    embeddings: Embeddings,
    embed_model: str,
    cache_dir: Path | None,
    prebuilt_dir: Path | None = None,
) -> FAISS:
    """
    Embed patterns once; the index is rebuilt only when patterns or the model change.
    A matching index under prebuilt_dir (committed with the code) is used first, so a
    serverless cold start does not re-embed the knowledge base.
    """
    key = index_key(patterns, embed_model)
    candidates = [Path(d) / key for d in (prebuilt_dir,) if d is not None]
    index_dir = Path(cache_dir) / "faiss" / key if cache_dir is not None else None
    if index_dir is not None:
        candidates.append(index_dir)
    for d in candidates:
        if (d / "index.faiss").is_file():
            # Index files are written by this module only, never downloaded.
            return FAISS.load_local(
                str(d), embeddings, allow_dangerous_deserialization=True, normalize_L2=True
            )

    docs = [
        Document(page_content=pattern_document(p), metadata={"id": p.get("id", "")})
        for p in patterns
    ]
    # Unit-length vectors: the squared L2 distance FAISS returns maps to cosine (see retriever).
    store = FAISS.from_documents(docs, embeddings, normalize_L2=True)
    if index_dir is not None:
        index_dir.mkdir(parents=True, exist_ok=True)
        store.save_local(str(index_dir))
    return store
