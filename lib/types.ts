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
  /** How many times this same normalized error signature occurred before, and where. */
  prior_occurrences?: {
    count: number;
    recent: Array<{
      github_run_id: number | null;
      html_url: string | null;
      created_at: string;
    }>;
  };
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
  /** ISO timestamp of latest saved analysis (if any). */
  analysis_at?: string | null;
  /** Total log_analyses rows for this artifact (>1 = legacy duplicate rows before upsert). */
  analysis_revision_count?: number;
}

/** Response from the Python RAG service (FAISS + Gemini) via /api/deep-analyze. */
export interface DeepRetrievedPattern {
  pattern_id: string;
  pattern: string;
  category: string;
  severity: string;
  rrf_score: number;
  keyword_score: number;
  cosine: number | null;
  sources: string[];
}

export interface DeepTriageResult {
  error_line: number;
  error_message: string;
  evidence_lines: number[];
  pattern_id: string | null;
  category: string;
  severity: string;
  root_cause: string;
  recommendation: string;
  confidence: number;
  mode: "rag" | "no_match" | "no_rag" | "retrieval_only";
  retrieved: DeepRetrievedPattern[];
  llm_error?: string | null;
}

export interface DeepTriageResponse {
  results: DeepTriageResult[];
  retriever: string;
  embed_model: string;
  chat_model: string | null;
  llm_used: boolean;
  llm_error: string | null;
  latency_ms: number;
}
