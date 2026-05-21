/**
 * Re-group analyses saved before root_causes existed (Neon cache / sync poll).
 */

import { lookupKnownFailure } from "./knowledge";
import {
  buildSummaryFromGroups,
  groupRootCauses,
  rootCausesToErrors,
} from "./root-cause";
import type { AnalysisResult, RootCauseGroup } from "./types";
import { WORKFLOW_HINTS } from "./analyzer";

function enrichGroupsWithKb(groups: RootCauseGroup[]): RootCauseGroup[] {
  return groups.map((g) => {
    const m0 = lookupKnownFailure(g.primary_message, 1)[0];
    if (!m0) return g;
    return {
      ...g,
      severity: m0.severity,
      category: m0.category,
      recommendation: m0.solutions,
      kb_pattern_id: m0.pattern_id,
    };
  });
}

export function isLegacyAnalysis(result: AnalysisResult): boolean {
  return !result.root_causes?.length && (result.errors?.length ?? 0) > 0;
}

/** Apply root-cause grouping to a pre-grouping analysis JSON. */
export function upgradeLegacyAnalysis(result: AnalysisResult): AnalysisResult {
  if (result.root_causes?.length) return result;
  const lineErrors = result.errors ?? [];
  if (lineErrors.length === 0) {
    return { ...result, root_causes: [], errors_count: 0 };
  }

  const root_causes = enrichGroupsWithKb(groupRootCauses(lineErrors));
  const errors = rootCausesToErrors(root_causes);
  const wf = WORKFLOW_HINTS[result.workflow];
  const summary = buildSummaryFromGroups(
    root_causes,
    result.line_count,
    wf?.label ?? result.workflow
  );

  return {
    ...result,
    root_causes,
    errors,
    errors_count: root_causes.length,
    summary,
    analysis_mode: result.analysis_mode ?? "tool_rag",
    llm_provider: result.llm_provider ?? "none",
  };
}
