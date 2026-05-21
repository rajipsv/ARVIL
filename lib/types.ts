export type WorkflowPreset =
  | "therock_multi_arch"
  | "therock_install"
  | "therock_pytorch"
  | "therock_unit_tests"
  | "custom";

export interface FailurePattern {
  id: string;
  pattern: string;
  category: string;
  severity: string;
  signatures: string[];
  causes: string;
  solutions: string;
  similar_errors: string;
}

export interface FailureMatch {
  pattern_id: string;
  pattern: string;
  category: string;
  severity: string;
  score: number;
  causes: string;
  solutions: string;
  similar_errors: string;
  source: string;
}

export interface LogError {
  type: string;
  line_number: number;
  message: string;
  severity: string;
  category: string;
  recommendation: string;
  kb_pattern_id: string | null;
}

export type LineRole = "root" | "stack" | "wrapper";

export interface RelatedLine {
  line_number: number;
  message: string;
  role: LineRole;
}

export interface RootCauseGroup {
  id: string;
  primary_line: number;
  primary_message: string;
  severity: string;
  category: string;
  recommendation: string;
  kb_pattern_id: string | null;
  type: string;
  related_lines: RelatedLine[];
  one_line_summary?: string;
}

export interface RagLookup {
  error_signature: string;
  matches: FailureMatch[];
}

export interface AnalysisResult {
  timestamp: string;
  mode: string;
  workflow: WorkflowPreset;
  source_label: string;
  line_count: number;
  /** Count of root cause groups (not raw log line hits). */
  errors_count: number;
  summary: string;
  errors: LogError[];
  root_causes: RootCauseGroup[];
  rag_lookups: RagLookup[];
  stats: Record<string, number>;
  saved_id?: string | null;
  analysis_mode?: "tool_rag" | "tool_rag_llm";
  llm_provider?: "none" | "nvidia" | "openai";
  deep_narrative?: string;
  deep_status?: "ok" | "skipped" | "failed";
  deep_message?: string;
  analysis_focus?: { start_line: number; end_line: number };
}

export interface HistoryItem {
  id: string;
  created_at: string;
  workflow: string;
  source_label: string | null;
  line_count: number;
  errors_count: number;
  summary: string | null;
}

/** Synced job log available for select-and-analyze in the UI. */
export interface SyncedLogArtifact {
  artifact_id: string;
  run_id: string | null;
  github_run_id: number | null;
  html_url: string | null;
  workflow_name: string | null;
  workflow_preset: string | null;
  job_name: string | null;
  ingestion_source: string;
  line_count: number;
  byte_size: number;
  created_at: string;
  analysis_id: string | null;
  errors_count: number | null;
  summary: string | null;
}
