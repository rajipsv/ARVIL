"""
Deterministic error extraction: failure window, error hits, root-cause grouping.

Python port of lib/failure-window.ts, lib/analyzer.ts (collectHits) and
lib/root-cause.ts, so retrieval runs once per root cause and not per log line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

ANCHOR_MARKERS = [
    re.compile(r"##\[error\]", re.I),
    re.compile(r"CalledProcessError", re.I),
    re.compile(r"returned non-zero exit status", re.I),
    re.compile(r"subprocess\.", re.I),
    re.compile(r"fatal:", re.I),
    re.compile(r"ninja: build stopped", re.I),
    re.compile(r"cmake error", re.I),
]

GHA_WRAPPER = re.compile(r"##\[error\]|process completed with exit code [1-9]", re.I)
CALLED_PROCESS = re.compile(r"CalledProcessError", re.I)
SUBPROCESS = re.compile(r"CalledProcessError|subprocess\.|exit status \d+", re.I)
RAISE_ONLY = re.compile(r"\braise\s+\w*Error", re.I)
HAS_COMMAND = re.compile(r"Command\s*\[|returned non-zero exit status", re.I)

# Leading timestamps: GitHub Actions ISO form and "2024-12-10 10:15:25" form.
_TIMESTAMP = re.compile(r"^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\s*")


@dataclass
class RootCause:
    line: int
    message: str
    type: str
    related: list[tuple[int, str, str]] = field(default_factory=list)  # (line, message, role)

    @property
    def evidence_lines(self) -> list[int]:
        return sorted({self.line, *(ln for ln, _, _ in self.related)})


def extract_failure_window(lines: list[str]) -> tuple[int, int]:
    """Return 0-based [lo, hi) around the last failure marker, or the whole log."""
    for i in range(len(lines) - 1, -1, -1):
        if any(m.search(lines[i]) for m in ANCHOR_MARKERS):
            return max(0, i - 100), min(len(lines), i + 30)
    return 0, len(lines)


def _collect_hits(lines: list[str], lo: int, hi: int) -> list[tuple[int, str, str]]:
    hits: dict[int, tuple[int, str, str]] = {}

    def add(i: int, kind: str) -> None:
        hits.setdefault(i, (i + 1, lines[i].strip(), kind))

    for kind in ("ERROR", "CRITICAL", "FATAL"):
        count = 0
        for i in range(lo, hi):
            if kind in lines[i].upper() and not GHA_WRAPPER.search(lines[i]):
                add(i, "CRITICAL" if SUBPROCESS.search(lines[i]) else kind)
                count += 1
                if count >= 20:
                    break
    for i in range(lo, hi):
        if SUBPROCESS.search(lines[i]) and not GHA_WRAPPER.search(lines[i]):
            add(i, "CRITICAL")
    wrappers = [(i + 1, lines[i].strip(), "WRAPPER") for i in range(lo, hi) if GHA_WRAPPER.search(lines[i])][:5]

    seen_text: set[str] = set()
    out: list[tuple[int, str, str]] = []
    for _, hit in sorted(hits.items()):
        if hit[1] in seen_text:
            continue
        seen_text.add(hit[1])
        out.append(hit)
    return sorted(out + wrappers)[:55]


def _is_stack_only_raise(text: str) -> bool:
    return bool(RAISE_ONLY.search(text)) and not HAS_COMMAND.search(text)


def _is_chain_line(text: str) -> bool:
    return bool(
        CALLED_PROCESS.search(text)
        or _is_stack_only_raise(text)
        or (re.search(r"\braise\s", text, re.I) and re.search(r"Error", text, re.I))
    )


def _primary_score(text: str) -> int:
    s = 0
    if HAS_COMMAND.search(text):
        s += 10
    if re.search(r"exit status \d+", text):
        s += 8
    if len(text) > 80:
        s += 5
    if _is_stack_only_raise(text):
        s -= 5
    return s


def normalize_for_dedupe(msg: str) -> str:
    msg = re.sub(r"[a-f0-9]{40}", "<sha>", msg, flags=re.I)
    return re.sub(r"\d{10,}", "<n>", msg)[:200]


def normalize_query(message: str) -> str:
    """Strip volatile tokens so the same failure embeds the same way across runs."""
    msg = _TIMESTAMP.sub("", message)
    msg = re.sub(r"\b[a-f0-9]{40}\b", "<sha>", msg, flags=re.I)
    msg = re.sub(r"\b0x[0-9a-f]+\b", "<hex>", msg, flags=re.I)
    msg = re.sub(r"\d{10,}", "<n>", msg)
    return re.sub(r"\s+", " ", msg).strip()


def _group(hits: list[tuple[int, str, str]]) -> list[RootCause]:
    errors = [h for h in hits if h[2] != "WRAPPER"]
    wrappers = [h for h in hits if h[2] == "WRAPPER"]
    used: set[int] = set()
    groups: list[RootCause] = []

    def build(cluster: list[int]) -> None:
        primary = max(cluster, key=lambda k: _primary_score(errors[k][1]))
        line, msg, kind = errors[primary]
        rc = RootCause(line=line, message=msg, type=kind)
        for k in cluster:
            if k != primary:
                role = "stack" if _is_stack_only_raise(errors[k][1]) else "root"
                rc.related.append((errors[k][0], errors[k][1], role))
        groups.append(rc)

    # Subprocess / CalledProcessError chains within 15 log lines.
    for i, (line, msg, _) in enumerate(errors):
        if i in used or not _is_chain_line(msg):
            continue
        cluster = [i]
        for j in range(i + 1, len(errors)):
            if errors[j][0] > line + 15:
                break
            if j not in used and _is_chain_line(errors[j][1]):
                cluster.append(j)
        used.update(cluster)
        build(cluster)

    # Remaining lines: merge adjacent repeats of the same normalized message.
    for i, (line, msg, _) in enumerate(errors):
        if i in used:
            continue
        cluster = [i]
        norm = normalize_for_dedupe(msg)
        for j in range(i + 1, len(errors)):
            if errors[j][0] - line > 5:
                break
            if j not in used and normalize_for_dedupe(errors[j][1]) == norm:
                cluster.append(j)
        used.update(cluster)
        build(cluster)

    groups.sort(key=lambda g: g.line)

    # Merge groups that belong to the same job failure (close line numbers).
    merged: list[RootCause] = []
    for g in groups:
        if merged and g.line - merged[-1].line <= 40 and _is_chain_line(g.message) and _is_chain_line(merged[-1].message):
            cur = merged[-1]
            if _primary_score(g.message) > _primary_score(cur.message):
                g.related = cur.related + [(cur.line, cur.message, "root")] + g.related
                merged[-1] = g
            else:
                cur.related += [(g.line, g.message, "root")] + g.related
        else:
            merged.append(g)

    # GitHub Actions wrapper lines attach to the nearest upstream group.
    for line, msg, _ in wrappers:
        upstream = [g for g in merged if g.line < line and line - g.line <= 40]
        target = max(upstream, key=lambda g: g.line) if upstream else None
        if target is not None:
            target.related.append((line, msg, "wrapper"))
    return merged


def extract_root_causes(content: str) -> list[RootCause]:
    lines = content.splitlines()
    if not lines:
        return []
    lo, hi = extract_failure_window(lines)
    return _group(_collect_hits(lines, lo, hi))


def context_window(content: str, line: int, before: int = 6, after: int = 4) -> str:
    lines = content.splitlines()
    lo = max(0, line - 1 - before)
    hi = min(len(lines), line + after)
    return "\n".join(f"{i + 1}: {lines[i].rstrip()[:400]}" for i in range(lo, hi))
