import { lookupKnownFailure } from "./knowledge";
import { refineRootCausesWithLlm } from "./llm-group";
import {
  buildSummaryFromGroups,
  groupRootCauses,
  rootCausesToErrors,
} from "./root-cause";
import type {
  AnalysisResult,
  LogError,
  RagLookup,
  RootCauseGroup,
  WorkflowPreset,
} from "./types";

const ERROR_KEYWORDS = ["ERROR", "EXCEPTION", "CRITICAL", "FATAL", "WARNING"];
const GITHUB_ERROR = /##\[error\]/i;

export const WORKFLOW_HINTS: Record<
  WorkflowPreset,
  { label: string; hint: string; extraPatterns: string[] }
> = {
  therock_multi_arch: {
    label: "TheRock — Multi-Arch CI",
    hint: "Paste log from ROCm/TheRock Multi-Arch CI failed job",
    extraPatterns: ["therock", "ninja", "cmake", "gfx"],
  },
  therock_install: {
    label: "TheRock — Native Package Install",
    hint: "Install test logs (ubuntu2404, dpkg/rpm)",
    extraPatterns: ["apt", "dpkg", "install test", "therock"],
  },
  therock_pytorch: {
    label: "TheRock — PyTorch Wheels",
    hint: "PyTorch full suite / GPU wheel test logs",
    extraPatterns: ["pytorch", "rocm", "gfx94", "hip"],
  },
  therock_unit_tests: {
    label: "TheRock — Unit Tests / ctest",
    hint: "Unit Tests or ctest shard output",
    extraPatterns: ["ctest", "assertion", "not ok"],
  },
  custom: {
    label: "Custom / Other CI",
    hint: "Any CI or application log",
    extraPatterns: [],
  },
};

function getLogStats(content: string) {
  const lines = content.split(/\r?\n/);
  const stats: Record<string, number> = { lines: lines.length, bytes: content.length };
  for (const kw of ERROR_KEYWORDS) {
    stats[kw] = lines.filter((ln) => ln.toUpperCase().includes(kw)).length;
  }
  stats["github_error"] = lines.filter((ln) => GITHUB_ERROR.test(ln)).length;
  return stats;
}

function grepKeyword(
  content: string,
  keyword: string,
  maxMatches: number,
  contextLines: number
): { line: number; text: string }[] {
  const lines = content.split(/\r?\n/);
  const kw = keyword.toUpperCase();
  const rx = new RegExp(`\\b${keyword}\\b`, "i");
  const hits: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!rx.test(lines[i]) && !lines[i].toUpperCase().includes(kw)) continue;
    const lo = Math.max(0, i - contextLines);
    const hi = Math.min(lines.length, i + contextLines + 1);
    hits.push({ line: i + 1, text: lines[i].trim() });
    if (hits.length >= maxMatches) break;
  }
  return hits;
}

function grepGithubErrors(content: string, maxMatches: number) {
  const lines = content.split(/\r?\n/);
  const hits: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!GITHUB_ERROR.test(lines[i]) && !/exit code [1-9]/.test(lines[i])) continue;
    hits.push({ line: i + 1, text: lines[i].trim() });
    if (hits.length >= maxMatches) break;
  }
  return hits;
}

function grepSubprocessFailures(content: string, maxMatches: number) {
  const lines = content.split(/\r?\n/);
  const rx = /CalledProcessError|subprocess\.|exit status \d+/i;
  const hits: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!rx.test(lines[i])) continue;
    hits.push({ line: i + 1, text: lines[i].trim() });
    if (hits.length >= maxMatches) break;
  }
  return hits;
}

function buildErrors(
  hits: { line: number; text: string; type: string }[]
): LogError[] {
  const errors: LogError[] = [];
  const seen = new Set<string>();

  for (const h of hits) {
    if (seen.has(h.text)) continue;
    seen.add(h.text);
    const matches = lookupKnownFailure(h.text, 1);
    const m0 = matches[0];
    errors.push({
      type: h.type,
      line_number: h.line,
      message: h.text,
      severity:
        h.type === "CRITICAL" || h.type === "FATAL"
          ? "CRITICAL"
          : m0?.severity ?? "HIGH",
      category: m0?.category ?? "Runtime",
      recommendation:
        m0?.solutions ??
        "Inspect context and stack traces; check recent CI changes.",
      kb_pattern_id: m0?.pattern_id ?? null,
    });
  }
  return errors.slice(0, 50);
}

function enrichGroupsWithKb(groups: RootCauseGroup[]): RootCauseGroup[] {
  return groups.map((g) => {
    const matches = lookupKnownFailure(g.primary_message, 1);
    const m0 = matches[0];
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

function collectHits(trimmed: string): { line: number; text: string; type: string }[] {
  const hits: { line: number; text: string; type: string }[] = [];

  for (const kw of ["ERROR", "CRITICAL", "FATAL"] as const) {
    for (const h of grepKeyword(trimmed, kw, 25, 2)) {
      hits.push({ ...h, type: kw });
    }
  }

  for (const h of grepGithubErrors(trimmed, 15)) {
    hits.push({ ...h, type: "ERROR" });
  }

  for (const h of grepSubprocessFailures(trimmed, 20)) {
    hits.push({ ...h, type: "CRITICAL" });
  }

  return hits;
}

export function analyzeLog(
  content: string,
  workflow: WorkflowPreset = "therock_multi_arch",
  sourceLabel = "pasted-log"
): AnalysisResult {
  const maxSize = 4_000_000;
  const trimmed =
    content.length > maxSize
      ? content.slice(0, maxSize) + "\n... [truncated for serverless limit]"
      : content;

  const stats = getLogStats(trimmed);
  const lineErrors = buildErrors(collectHits(trimmed));
  const root_causes = enrichGroupsWithKb(groupRootCauses(lineErrors));
  const errors = rootCausesToErrors(root_causes);

  const signatures = Array.from(new Set(errors.map((e) => e.message))).slice(0, 8);
  const rag_lookups: RagLookup[] = signatures.map((sig) => ({
    error_signature: sig,
    matches: lookupKnownFailure(sig, 2),
  }));

  const wf = WORKFLOW_HINTS[workflow];
  const summary = buildSummaryFromGroups(root_causes, stats.lines, wf.label);

  return {
    timestamp: new Date().toISOString(),
    mode: "arvil_web_tool_rag",
    workflow,
    source_label: sourceLabel,
    line_count: stats.lines,
    errors_count: root_causes.length,
    summary,
    errors,
    root_causes,
    rag_lookups,
    stats,
    analysis_mode: "tool_rag",
    llm_provider: "none",
  };
}

export async function analyzeLogDeep(
  content: string,
  workflow: WorkflowPreset = "therock_multi_arch",
  sourceLabel = "pasted-log"
): Promise<AnalysisResult> {
  const base = analyzeLog(content, workflow, sourceLabel);
  const snippet = content.slice(0, 50_000);

  try {
    const llm = await refineRootCausesWithLlm(snippet, base.root_causes);
    if (!llm) {
      return {
        ...base,
        summary:
          base.summary +
          " Deep analyze skipped (set NVIDIA_API_KEY or OPENAI_API_KEY on Vercel).",
      };
    }

    const root_causes = enrichGroupsWithKb(llm.groups);
    const errors = rootCausesToErrors(root_causes);
    const wf = WORKFLOW_HINTS[workflow];
    const summary = [
      buildSummaryFromGroups(root_causes, base.line_count, wf.label),
      llm.narrative,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      ...base,
      mode: "arvil_web_tool_rag_llm",
      summary,
      errors,
      root_causes,
      errors_count: root_causes.length,
      analysis_mode: "tool_rag_llm",
      llm_provider: llm.provider,
      deep_narrative: llm.narrative,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "LLM failed";
    return {
      ...base,
      summary: `${base.summary} Deep analyze failed: ${msg}`,
    };
  }
}
