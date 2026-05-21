/**
 * Rule-based clustering: merge traceback lines and GHA wrappers into root causes.
 */

import type { LogError, RelatedLine, RootCauseGroup } from "./types";

export type { LineRole, RelatedLine, RootCauseGroup } from "./types";

const GHA_WRAPPER =
  /##\[error\]|process completed with exit code [1-9]/i;
const CALLED_PROCESS = /CalledProcessError/i;
/** GitHub Actions timestamps precede Python traceback lines. */
const RAISE_ONLY = /\braise\s+\w*Error/i;
const HAS_COMMAND = /Command\s*\[|returned non-zero exit status/i;

function normalizeForDedupe(msg: string): string {
  return msg
    .replace(/[a-f0-9]{40}/gi, "<sha>")
    .replace(/\d{10,}/g, "<n>")
    .slice(0, 200);
}

function isGhaWrapper(text: string): boolean {
  return GHA_WRAPPER.test(text);
}

function isCalledProcessLine(text: string): boolean {
  return CALLED_PROCESS.test(text);
}

function isStackOnlyRaise(text: string): boolean {
  return RAISE_ONLY.test(text) && !HAS_COMMAND.test(text);
}

function scorePrimaryCandidate(text: string): number {
  let s = 0;
  if (HAS_COMMAND.test(text)) s += 10;
  if (/exit status \d+/.test(text)) s += 8;
  if (text.length > 80) s += 5;
  if (isStackOnlyRaise(text)) s -= 5;
  return s;
}

function pickPrimary(indices: number[], errors: LogError[]): number {
  let best = indices[0];
  let bestScore = -1;
  for (const i of indices) {
    const sc = scorePrimaryCandidate(errors[i].message);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  }
  return best;
}

export function groupRootCauses(lineErrors: LogError[]): RootCauseGroup[] {
  if (lineErrors.length === 0) return [];

  const sorted = [...lineErrors].sort((a, b) => a.line_number - b.line_number);
  const used = new Set<number>();

  const groups: RootCauseGroup[] = [];

  function isChainLine(text: string): boolean {
    return (
      isCalledProcessLine(text) ||
      isStackOnlyRaise(text) ||
      isGhaWrapper(text) ||
      (/\braise\s/i.test(text) && /Error/i.test(text))
    );
  }

  // Phase 1: subprocess / CalledProcessError chains (within 15 log lines)
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    if (!isChainLine(sorted[i].message)) continue;
    if (isGhaWrapper(sorted[i].message)) continue;

    const clusterIdx = [i];
    const endLine = sorted[i].line_number + 15;
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (sorted[j].line_number > endLine) break;
      if (isChainLine(sorted[j].message)) clusterIdx.push(j);
    }

    for (const idx of clusterIdx) used.add(idx);

    const primaryIdx = pickPrimary(clusterIdx, sorted);
    const related: RelatedLine[] = [];
    for (const idx of clusterIdx) {
      if (idx === primaryIdx) continue;
      related.push({
        line_number: sorted[idx].line_number,
        message: sorted[idx].message,
        role: isStackOnlyRaise(sorted[idx].message) ? "stack" : "root",
      });
    }

    const p = sorted[primaryIdx];
    groups.push({
      id: `rc-${groups.length + 1}`,
      primary_line: p.line_number,
      primary_message: p.message,
      severity: p.severity,
      category: p.category,
      recommendation: p.recommendation,
      kb_pattern_id: p.kb_pattern_id,
      type: p.type,
      related_lines: related,
    });
  }

  // Phase 2: Remaining non-wrapper lines → own groups (merge adjacent same-normalized)
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    if (isGhaWrapper(sorted[i].message)) continue;

    const clusterIdx = [i];
    const norm = normalizeForDedupe(sorted[i].message);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (isGhaWrapper(sorted[j].message)) break;
      if (sorted[j].line_number - sorted[i].line_number > 5) break;
      if (normalizeForDedupe(sorted[j].message) === norm) clusterIdx.push(j);
    }
    for (const idx of clusterIdx) used.add(idx);

    const primaryIdx = pickPrimary(clusterIdx, sorted);
    const p = sorted[primaryIdx];
    const related: RelatedLine[] = clusterIdx
      .filter((idx) => idx !== primaryIdx)
      .map((idx) => ({
        line_number: sorted[idx].line_number,
        message: sorted[idx].message,
        role: "stack" as const,
      }));

    groups.push({
      id: `rc-${groups.length + 1}`,
      primary_line: p.line_number,
      primary_message: p.message,
      severity: p.severity,
      category: p.category,
      recommendation: p.recommendation,
      kb_pattern_id: p.kb_pattern_id,
      type: p.type,
      related_lines: related,
    });
  }

  // Phase 3: Attach GHA wrappers to nearest upstream group
  for (let i = 0; i < sorted.length; i++) {
    if (!isGhaWrapper(sorted[i].message)) continue;
    let target: RootCauseGroup | null = null;
    let bestDist = Infinity;
    for (const g of groups) {
      if (sorted[i].line_number <= g.primary_line) continue;
      const dist = sorted[i].line_number - g.primary_line;
      if (dist <= 40 && dist < bestDist) {
        bestDist = dist;
        target = g;
      }
    }
    if (!target) {
      for (const g of groups) {
        const dist = Math.abs(sorted[i].line_number - g.primary_line);
        if (dist <= 40 && dist < bestDist) {
          bestDist = dist;
          target = g;
        }
      }
    }
    if (target) {
      target.related_lines.push({
        line_number: sorted[i].line_number,
        message: sorted[i].message,
        role: "wrapper",
      });
    }
  }

  return groups;
}

/** Map groups to primary-only LogError list for backward compatibility. */
export function rootCausesToErrors(groups: RootCauseGroup[]): LogError[] {
  return groups.map((g) => ({
    type: g.type,
    line_number: g.primary_line,
    message: g.primary_message,
    severity: g.severity,
    category: g.category,
    recommendation: g.recommendation,
    kb_pattern_id: g.kb_pattern_id,
  }));
}

export function buildSummaryFromGroups(
  groups: RootCauseGroup[],
  statsLines: number,
  workflowLabel: string
): string {
  if (groups.length === 0) {
    return `ARVIL analyzed ${statsLines} lines. No root causes identified — check ##[error] lines or paste the failed step. Context: ${workflowLabel}.`;
  }
  const critical = groups.filter((g) => g.severity === "CRITICAL").length;
  const relatedTotal = groups.reduce((s, g) => s + g.related_lines.length, 0);
  const top = groups[0];
  const parts = [
    `ARVIL analyzed ${statsLines} lines.`,
    `Found ${groups.length} root cause(s)${relatedTotal > 0 ? ` (${relatedTotal} related log line(s) grouped)` : ""}${critical > 0 ? `, ${critical} critical` : ""}.`,
    `Context: ${workflowLabel}.`,
    `Top issue: ${top.primary_message.slice(0, 120)}`,
  ];
  return parts.join(" ");
}

/** Self-test for L157–L159 style chain (returns true if pass). */
export function selfTestRootCause(): boolean {
  const sample: LogError[] = [
    {
      type: "ERROR",
      line_number: 157,
      message:
        "2026-05-21T14:39:09.0065514Z raise CalledProcessError(retcode, process.args,",
      severity: "HIGH",
      category: "Runtime",
      recommendation: "generic",
      kb_pattern_id: null,
    },
    {
      type: "CRITICAL",
      line_number: 158,
      message:
        "2026-05-21T14:39:09.0068130Z subprocess.CalledProcessError: Command '['git', 'diff', '--name-only', 'bb1c030b66709b958a09596ff1bc76923024d497']' returned non-zero exit status 128.",
      severity: "CRITICAL",
      category: "GPU/Driver",
      recommendation: "wrong",
      kb_pattern_id: "rocm_hsa_status",
    },
    {
      type: "ERROR",
      line_number: 159,
      message:
        "2026-05-21T14:39:09.0251367Z ##[error]Process completed with exit code 1.",
      severity: "MEDIUM",
      category: "Other",
      recommendation: "wrapper",
      kb_pattern_id: "github_actions_fail",
    },
  ];
  const groups = groupRootCauses(sample);
  if (groups.length !== 1) return false;
  if (!groups[0].primary_message.includes("git")) return false;
  const roles = groups[0].related_lines.map((r) => r.role);
  return roles.includes("stack") || roles.includes("wrapper");
}
