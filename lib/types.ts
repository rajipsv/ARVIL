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
  errors_count: number;
  summary: string;
  errors: LogError[];
  rag_lookups: RagLookup[];
  stats: Record<string, number>;
  saved_id?: string | null;
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
