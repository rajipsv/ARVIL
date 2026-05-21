import patterns from "./data/patterns.json";
import type { FailureMatch, FailurePattern } from "./types";

const PATTERN_LIST = patterns as FailurePattern[];

/** Minimum keyword score to attach a KB pattern (avoids weak token hits like "status"). */
export const KB_MIN_SCORE = 10;

const GPU_PATTERN_IDS = new Set([
  "rocm_hsa_status",
  "rocm_hip_error",
  "rocm_rccl_nccl",
  "pytorch_cuda_rocm",
]);

function patternDocument(p: FailurePattern): string {
  return [
    p.pattern,
    p.category,
    p.severity,
    ...p.signatures,
    p.causes,
    p.solutions,
    p.similar_errors,
  ]
    .join(" ")
    .toLowerCase();
}

export function keywordScore(query: string, p: FailurePattern): number {
  const q = query.toLowerCase();
  const tokens = new Set(q.match(/[a-z0-9_./-]+/g) ?? []);
  let score = 0;

  for (const sig of p.signatures) {
    const s = sig.toLowerCase();
    if (q.includes(s)) score += 15;
    else {
      for (const t of tokens) {
        if (t.length > 3 && (s.includes(t) || t.includes(s))) score += 5;
      }
    }
  }

  const blob = patternDocument(p);
  for (const t of tokens) {
    if (t.length > 3 && blob.includes(t)) score += 1.5;
  }
  if (p.pattern.toLowerCase().includes(q) || q.includes(p.pattern.toLowerCase())) {
    score += 8;
  }
  return score;
}

/** Git/subprocess lines should not match GPU driver KB patterns. */
export function isNonGpuCiLine(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("git diff") ||
    m.includes("git ") ||
    m.includes("subprocess") ||
    m.includes("calledprocesserror") ||
    m.includes("diff --name-only") ||
    m.includes("exit status 128")
  );
}

function patternAllowed(patternId: string, message: string): boolean {
  if (GPU_PATTERN_IDS.has(patternId) && isNonGpuCiLine(message)) {
    return false;
  }
  return true;
}

export function lookupKnownFailure(
  errorSignature: string,
  topK = 3,
  minScore = KB_MIN_SCORE
): FailureMatch[] {
  const ranked = PATTERN_LIST.map((p) => ({
    pattern_id: p.id,
    pattern: p.pattern,
    category: p.category,
    severity: p.severity,
    score: keywordScore(errorSignature, p),
    causes: p.causes,
    solutions: p.solutions,
    similar_errors: p.similar_errors,
    source: "keyword",
  }))
    .filter(
      (m) =>
        m.score >= minScore && patternAllowed(m.pattern_id, errorSignature)
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked;
}

export function listCategories(): string {
  const cats = Array.from(new Set(PATTERN_LIST.map((p) => p.category))).sort();
  return `Categories: ${cats.join(", ")} (${PATTERN_LIST.length} patterns)`;
}
