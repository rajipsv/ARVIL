-- ARVIL Neon schema — run once in Neon SQL Editor
CREATE TABLE IF NOT EXISTS log_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workflow TEXT NOT NULL DEFAULT 'custom',
  source_label TEXT,
  line_count INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  summary TEXT,
  log_preview TEXT,
  result_json JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_log_analyses_created
  ON log_analyses (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_log_analyses_workflow
  ON log_analyses (workflow);
