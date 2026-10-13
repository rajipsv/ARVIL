"""Environment-driven settings for the RAG pipeline."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PYTHON_DIR = Path(__file__).resolve().parents[1]
load_dotenv(PYTHON_DIR / ".env")
load_dotenv(PYTHON_DIR.parent / ".env")  # repo-root .env as a fallback

DEFAULT_MODELS = {
    "google": ("gemini-3.8-flash", "models/gemini-embedding-001"),
    "openai": ("gpt-4o-mini", "text-embedding-3-small"),
}


def _api_key(provider: str) -> str | None:
    if provider == "google":
        return os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    return os.getenv("OPENAI_API_KEY")


@dataclass(frozen=True)
class Settings:
    provider: str
    chat_model: str
    embed_model: str
    api_key: str | None
    # Cosine similarity needed to accept a FAISS hit when keywords do not match.
    min_cosine: float
    requests_per_minute: float
    cache_dir: Path

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)


def get_settings() -> Settings:
    provider = os.getenv("ARVIL_LLM_PROVIDER", "google").strip().lower()
    if provider not in DEFAULT_MODELS:
        raise ValueError(f"ARVIL_LLM_PROVIDER must be one of {sorted(DEFAULT_MODELS)}, got '{provider}'")
    chat_default, embed_default = DEFAULT_MODELS[provider]
    return Settings(
        provider=provider,
        chat_model=os.getenv("ARVIL_LLM_MODEL", "").strip() or chat_default,
        embed_model=os.getenv("ARVIL_EMBED_MODEL", "").strip() or embed_default,
        api_key=_api_key(provider),
        min_cosine=float(os.getenv("ARVIL_MIN_COSINE", "0.6")),
        requests_per_minute=float(os.getenv("ARVIL_LLM_RPM", "10")),
        cache_dir=Path(os.getenv("ARVIL_RAG_CACHE_DIR", "") or PYTHON_DIR / "rag" / ".cache"),
    )
