"""
Shared failure knowledge base for the Python analyzers.

Single source of truth is lib/data/patterns.json (the file the web app ships).
Scoring and guards mirror lib/knowledge.ts so web and Python rank the same way.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_PATTERNS_FILE = REPO_ROOT / "lib" / "data" / "patterns.json"

# Minimum keyword score to attach a KB pattern (avoids weak token hits like "status").
KB_MIN_SCORE = 10.0

GPU_PATTERN_IDS = {
    "rocm_hsa_status",
    "rocm_hip_error",
    "rocm_rccl_nccl",
    "pytorch_cuda_rocm",
}

_TOKEN = re.compile(r"[a-z0-9_./-]+")


def load_patterns(extra_file: Path | None = None) -> list[dict]:
    """Load shared patterns; entries in extra_file are added only if their id is new."""
    patterns: list[dict] = []
    if SHARED_PATTERNS_FILE.is_file():
        patterns = json.loads(SHARED_PATTERNS_FILE.read_text(encoding="utf-8"))
    if extra_file is not None and Path(extra_file).is_file():
        seen = {p.get("id") for p in patterns}
        for p in json.loads(Path(extra_file).read_text(encoding="utf-8")):
            if p.get("id") not in seen:
                patterns.append(p)
    return patterns


def pattern_document(p: dict) -> str:
    return (
        f"Pattern: {p.get('pattern', '')}\n"
        f"Category: {p.get('category', '')}\n"
        f"Severity: {p.get('severity', '')}\n"
        f"Signatures: {', '.join(p.get('signatures', []))}\n"
        f"Causes: {p.get('causes', '')}\n"
        f"Solutions: {p.get('solutions', '')}\n"
        f"Similar: {p.get('similar_errors', '')}"
    )


def keyword_score(query: str, p: dict) -> float:
    q = query.lower()
    tokens = set(_TOKEN.findall(q))
    score = 0.0

    for sig in p.get("signatures", []):
        s = sig.lower()
        if s in q:
            score += 15.0
        else:
            for t in tokens:
                if len(t) > 3 and (t in s or s in t):
                    score += 5.0

    blob = pattern_document(p).lower()
    for t in tokens:
        if len(t) > 3 and t in blob:
            score += 1.5

    name = p.get("pattern", "").lower()
    if name and (name in q or q in name):
        score += 8.0
    return score


def is_non_gpu_ci_line(message: str) -> bool:
    """Git/subprocess lines should not match GPU driver KB patterns."""
    m = message.lower()
    return (
        "git diff" in m
        or "git " in m
        or "subprocess" in m
        or "calledprocesserror" in m
        or "diff --name-only" in m
        or "exit status 128" in m
    )


def pattern_allowed(pattern_id: str, message: str) -> bool:
    return not (pattern_id in GPU_PATTERN_IDS and is_non_gpu_ci_line(message))
