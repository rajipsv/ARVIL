import { neon } from "@neondatabase/serverless";
import type { AnalysisResult } from "./types";

let _sql: ReturnType<typeof neon> | null = null;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!_sql) _sql = neon(url);
  return _sql;
}

export async function ensureSchema() {
  const sql = getDb();
  if (!sql) return false;
  await sql`
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
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_log_analyses_created
    ON log_analyses (created_at DESC)
  `;
  return true;
}

const LOG_PREVIEW_MAX = 32_000;

export async function saveAnalysis(
  result: AnalysisResult,
  logContent: string
): Promise<string | null> {
  const sql = getDb();
  if (!sql) return null;

  await ensureSchema();

  const preview =
    logContent.length > LOG_PREVIEW_MAX
      ? logContent.slice(0, LOG_PREVIEW_MAX) + "\n... [truncated for storage]"
      : logContent;

  const rows = (await sql`
    INSERT INTO log_analyses (
      workflow, source_label, line_count, errors_count,
      summary, log_preview, result_json
    ) VALUES (
      ${result.workflow},
      ${result.source_label},
      ${result.line_count},
      ${result.errors_count},
      ${result.summary},
      ${preview},
      ${JSON.stringify(result)}
    )
    RETURNING id::text
  `) as { id: string }[];

  return rows[0]?.id ?? null;
}

export async function listRecentAnalyses(limit = 20) {
  const sql = getDb();
  if (!sql) return [];

  await ensureSchema();

  const rows = (await sql`
    SELECT id::text, created_at, workflow, source_label,
           line_count, errors_count, summary
    FROM log_analyses
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as Array<{
    id: string;
    created_at: string;
    workflow: string;
    source_label: string | null;
    line_count: number;
    errors_count: number;
    summary: string | null;
  }>;
}

export async function getAnalysisById(id: string) {
  const sql = getDb();
  if (!sql) return null;

  const rows = (await sql`
    SELECT id::text, created_at, workflow, source_label,
           line_count, errors_count, summary, log_preview, result_json
    FROM log_analyses WHERE id = ${id}::uuid
  `) as Record<string, unknown>[];
  return rows[0] ?? null;
}
