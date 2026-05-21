import type { AnalysisResult } from "./types";

/** Remove stale "skipped" deep fields (e.g. saved before API keys were on Vercel). */
export function stripStaleDeepFields(result: AnalysisResult): AnalysisResult {
  if (result.deep_status !== "skipped") return result;
  const { deep_status, deep_message, deep_narrative, ...rest } = result;
  return rest;
}

/** Only show deep UI for real LLM runs or actionable failures. */
export function shouldShowDeepPanel(result: AnalysisResult): boolean {
  if (result.analysis_mode === "tool_rag_llm") return true;
  if (result.deep_status === "ok" || result.deep_status === "failed") return true;
  return false;
}
