import { extractFailureWindow } from "./failure-window";
import { lookupKnownFailure } from "./knowledge";
import { getLlmDiag } from "./llm-config";
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

function isGhaWrapperLine(text: string): boolean {
  return (
    GITHUB_ERROR.test(text) ||
    /process completed with exit code [1-9]/i.test(text)
  );
}

function grepGithubErrors(content: string, maxMatches: number) {
  const lines = content.split(/\r?\n/);
  const hits: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!isGhaWrapperLine(ln)) continue;
    hits.push({ line: i + 1, text: ln.trim() });
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
  const seenLines = new Set<number>();
  const seenText = new Set<string>();

  for (const h of hits) {
    if (seenLines.has(h.line) || seenText.has(h.text)) continue;
    seenLines.add(h.line);
    seenText.add(h.text);
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

function collectHits(
  trimmed: string,
  lineOffset = 0
): { line: number; text: string; type: string }[] {
  const hits: { line: number; text: string; type: string }[] = [];
  const seenLines = new Set<number>();

  const add = (h: { line: number; text: string }, type: string) => {
    const line = h.line + lineOffset;
    if (seenLines.has(line) || isGhaWrapperLine(h.text)) return;
    seenLines.add(line);
    hits.push({ line, text: h.text, type });
  };

  for (const kw of ["ERROR", "CRITICAL", "FATAL"] as const) {
    for (const h of grepKeyword(trimmed, kw, 20, 1)) {
      if (/CalledProcessError|subprocess\./i.test(h.text)) {
        add(h, "CRITICAL");
      } else {
        add(h, kw);
      }
    }
  }

  for (const h of grepSubprocessFailures(trimmed, 15)) {
    add(h, "CRITICAL");
  }

  for (const h of grepGithubErrors(trimmed, 5)) {
    add(h, "ERROR");
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
  const fw = extractFailureWindow(trimmed);
  const lineErrors = buildErrors(
    collectHits(fw.text, fw.startLine - 1)
  );
  const root_causes = enrichGroupsWithKb(groupRootCauses(lineErrors));
  const errors = rootCausesToErrors(root_causes);

  const signatures = Array.from(new Set(errors.map((e) => e.message))).slice(0, 8);
  const rag_lookups: RagLookup[] = signatures.map((sig) => ({
    error_signature: sig,
    matches: lookupKnownFailure(sig, 2),
  }));

  const wf = WORKFLOW_HINTS[workflow];
  let summary = buildSummaryFromGroups(root_causes, stats.lines, wf.label);
  if (fw.focused) {
    summary += ` Focused on lines ${fw.startLine}–${fw.endLine} (last failure region).`;
  }

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
    analysis_focus: fw.focused
      ? { start_line: fw.startLine, end_line: fw.endLine }
      : undefined,
  };
}

export async function analyzeLogDeep(
  content: string,
  workflow: WorkflowPreset = "therock_multi_arch",
  sourceLabel = "pasted-log"
): Promise<AnalysisResult> {
  const base = analyzeLog(content, workflow, sourceLabel);
  const fw = extractFailureWindow(content);
  const snippet = fw.text.slice(0, 24_000);

  try {
    const llm = await refineRootCausesWithLlm(snippet, base.root_causes);
    if (!llm) {
      const diag = getLlmDiag();
      if (diag.llm_ready) {
        return {
          ...base,
          deep_status: "failed",
          deep_message:
            base.root_causes.length === 0
              ? "No root causes to send to the LLM. Try Re-analyze first."
              : "LLM call did not return a result. Check Vercel function logs or try again.",
        };
      }
      return {
        ...base,
        mode: "arvil_web_tool_rag",
        analysis_mode: "tool_rag",
        deep_status: "skipped",
        deep_message:
          "Deep analyze needs NVIDIA_API_KEY or OPENAI_API_KEY in Vercel (then redeploy).",
      };
    }

    const validGroups = llm.groups.filter((g) => g.primary_message?.trim());
    const root_causes = enrichGroupsWithKb(
      validGroups.length > 0 ? validGroups : base.root_causes
    );
    const errors = rootCausesToErrors(root_causes);
    const wf = WORKFLOW_HINTS[workflow];
    const narrative =
      llm.narrative?.trim() ||
      "LLM refined root causes (no narrative returned).";
    const summary = [
      buildSummaryFromGroups(root_causes, base.line_count, wf.label),
      narrative,
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
      deep_status: "ok",
      deep_narrative: narrative,
      deep_message: narrative,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "LLM failed";
    return {
      ...base,
      deep_status: "failed",
      deep_message: msg,
      deep_narrative: undefined,
    };
  }
}
