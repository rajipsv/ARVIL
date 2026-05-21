-- ARVIL schema v2 — TheRock CI log stream (Neon Postgres)
-- Run in Neon SQL Editor or via ensureSchemaV2() in web app

-- Workflows tracked (TheRock)
CREATE TABLE IF NOT EXISTS ci_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_repo TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (github_repo, workflow_name)
);

-- One row per GitHub Actions run
CREATE TABLE IF NOT EXISTS ci_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID REFERENCES ci_workflows(id),
  github_run_id BIGINT NOT NULL UNIQUE,
  event TEXT,
  branch TEXT,
  head_sha TEXT,
  status TEXT,
  conclusion TEXT,
  run_started_at TIMESTAMPTZ,
  html_url TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raw log per job (or manual paste)
CREATE TABLE IF NOT EXISTS log_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES ci_runs(id) ON DELETE SET NULL,
  job_name TEXT,
  github_job_id BIGINT,
  step_name TEXT,
  ingestion_source TEXT NOT NULL DEFAULT 'manual',
  storage_kind TEXT DEFAULT 'inline_preview',
  content_preview TEXT,
  content_hash TEXT,
  byte_size INTEGER DEFAULT 0,
  line_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Large log windows
CREATE TABLE IF NOT EXISTS log_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES log_artifacts(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  error_hit_count INTEGER DEFAULT 0
);

-- Analysis results (replaces flat v1 usage)
CREATE TABLE IF NOT EXISTS log_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID REFERENCES log_artifacts(id) ON DELETE CASCADE,
  workflow TEXT,
  source_label TEXT,
  analysis_mode TEXT NOT NULL DEFAULT 'tool_rag',
  llm_provider TEXT DEFAULT 'none',
  llm_model TEXT,
  line_count INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  summary TEXT,
  log_preview TEXT,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Normalized errors
CREATE TABLE IF NOT EXISTS analysis_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id UUID NOT NULL REFERENCES log_analyses(id) ON DELETE CASCADE,
  line_number INTEGER,
  error_type TEXT,
  severity TEXT,
  category TEXT,
  message TEXT NOT NULL,
  recommendation TEXT,
  kb_pattern_id TEXT
);

-- Knowledge base (optional DB mirror of patterns.json)
CREATE TABLE IF NOT EXISTS kb_patterns (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  category TEXT,
  severity TEXT,
  signatures JSONB,
  causes TEXT,
  solutions TEXT,
  similar_errors TEXT
);

CREATE TABLE IF NOT EXISTS kb_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_signature TEXT NOT NULL,
  resolution TEXT NOT NULL,
  category TEXT DEFAULT 'Other',
  severity TEXT DEFAULT 'MEDIUM',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ci_runs_workflow_started
  ON ci_runs (workflow_id, run_started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ci_runs_failed
  ON ci_runs (conclusion, run_started_at DESC)
  WHERE conclusion = 'failure';
CREATE INDEX IF NOT EXISTS idx_log_artifacts_run
  ON log_artifacts (run_id, job_name);
CREATE INDEX IF NOT EXISTS idx_log_artifacts_hash
  ON log_artifacts (content_hash);
CREATE INDEX IF NOT EXISTS idx_log_analyses_artifact
  ON log_analyses (artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_errors_analysis
  ON analysis_errors (analysis_id);

-- Seed TheRock workflows
INSERT INTO ci_workflows (github_repo, workflow_name, workflow_path) VALUES
  ('ROCm/TheRock', 'Multi-Arch CI', '.github/workflows/multi_arch_ci.yml'),
  ('ROCm/TheRock', 'Multi-Arch CI ASAN', '.github/workflows/multi_arch_ci_asan.yml'),
  ('ROCm/TheRock', 'CI', '.github/workflows/ci.yml'),
  ('ROCm/TheRock', 'Unit Tests', '.github/workflows/test_unit.yml'),
  ('ROCm/TheRock', 'Test Native Linux Packages Install', '.github/workflows/test_native_linux_packages_install.yml'),
  ('ROCm/TheRock', 'Test PyTorch Wheels (Full Suite)', '.github/workflows/release_portable_linux_pytorch_wheels.yml'),
  ('ROCm/TheRock', 'pre-commit', '.github/workflows/pre-commit.yml')
ON CONFLICT (github_repo, workflow_name) DO NOTHING;

-- Views
CREATE OR REPLACE VIEW v_failed_runs_pending_analysis AS
SELECT
  r.id AS run_id,
  r.github_run_id,
  r.html_url,
  r.branch,
  r.run_started_at,
  w.workflow_name,
  COUNT(a.id) AS artifact_count,
  COUNT(la.id) AS analysis_count
FROM ci_runs r
LEFT JOIN ci_workflows w ON w.id = r.workflow_id
LEFT JOIN log_artifacts a ON a.run_id = r.id
LEFT JOIN log_analyses la ON la.artifact_id = a.id
WHERE r.conclusion = 'failure'
GROUP BY r.id, r.github_run_id, r.html_url, r.branch, r.run_started_at, w.workflow_name
HAVING COUNT(la.id) = 0;
