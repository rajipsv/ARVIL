import { neon } from "@neondatabase/serverless";
import type { AnalysisResult } from "./types";

let _sql: ReturnType<typeof neon> | null = null;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!_sql) _sql = neon(url);
  return _sql;
}

const LOG_PREVIEW_MAX = 32_000;
const CHUNK_LINES = 500;

export async function ensureSchemaV2() {
  const sql = getDb();
  if (!sql) return false;

  await sql`
    CREATE TABLE IF NOT EXISTS ci_workflows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      github_repo TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      workflow_path TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_workflows_repo_name
    ON ci_workflows (github_repo, workflow_name)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ci_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id UUID REFERENCES ci_workflows(id),
      github_run_id BIGINT NOT NULL UNIQUE,
      event TEXT, branch TEXT, head_sha TEXT, status TEXT, conclusion TEXT,
      run_started_at TIMESTAMPTZ, html_url TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS log_artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID REFERENCES ci_runs(id) ON DELETE SET NULL,
      job_name TEXT, github_job_id BIGINT, step_name TEXT,
      ingestion_source TEXT NOT NULL DEFAULT 'manual',
      storage_kind TEXT DEFAULT 'inline_preview',
      content_preview TEXT, content_hash TEXT,
      byte_size INTEGER DEFAULT 0, line_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS log_chunks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID NOT NULL REFERENCES log_artifacts(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL, content TEXT NOT NULL,
      error_hit_count INTEGER DEFAULT 0
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS log_analyses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID REFERENCES log_artifacts(id) ON DELETE CASCADE,
      workflow TEXT, source_label TEXT,
      analysis_mode TEXT NOT NULL DEFAULT 'tool_rag',
      llm_provider TEXT DEFAULT 'none', llm_model TEXT,
      line_count INTEGER DEFAULT 0, errors_count INTEGER DEFAULT 0,
      summary TEXT, log_preview TEXT, result_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS analysis_errors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      analysis_id UUID NOT NULL REFERENCES log_analyses(id) ON DELETE CASCADE,
      line_number INTEGER, error_type TEXT, severity TEXT, category TEXT,
      message TEXT NOT NULL, recommendation TEXT, kb_pattern_id TEXT
    )
  `;

  const seeds = [
    ["ROCm/TheRock", "Multi-Arch CI"],
    ["ROCm/TheRock", "Multi-Arch CI ASAN"],
    ["ROCm/TheRock", "CI"],
    ["ROCm/TheRock", "Unit Tests"],
    ["ROCm/TheRock", "Test Native Linux Packages Install"],
    ["ROCm/TheRock", "Test PyTorch Wheels (Full Suite)"],
    ["ROCm/TheRock", "pre-commit"],
  ];
  for (const [repo, wf] of seeds) {
    await sql`
      INSERT INTO ci_workflows (github_repo, workflow_name)
      VALUES (${repo}, ${wf})
      ON CONFLICT (github_repo, workflow_name) DO NOTHING
    `;
  }
  return true;
}

export async function ensureSchema() {
  return ensureSchemaV2();
}

export async function getKnownGithubRunIds(limit = 500): Promise<number[]> {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchemaV2();
  const rows = (await sql`
    SELECT github_run_id FROM ci_runs ORDER BY synced_at DESC LIMIT ${limit}
  `) as { github_run_id: string }[];
  return rows.map((r) => Number(r.github_run_id));
}

export async function upsertCiRun(data: {
  github_repo: string;
  workflow_name: string;
  github_run_id: number;
  event?: string;
  branch?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  run_started_at?: string;
  html_url?: string;
}): Promise<string> {
  const sql = getDb();
  if (!sql) throw new Error("DATABASE_URL not set");
  await ensureSchemaV2();

  const wfRows = (await sql`
    INSERT INTO ci_workflows (github_repo, workflow_name)
    VALUES (${data.github_repo}, ${data.workflow_name})
    ON CONFLICT (github_repo, workflow_name) DO UPDATE SET workflow_name = EXCLUDED.workflow_name
    RETURNING id::text
  `) as { id: string }[];

  let wfId = wfRows[0]?.id;
  if (!wfId) {
    const existing = (await sql`
      SELECT id::text FROM ci_workflows
      WHERE github_repo = ${data.github_repo} AND workflow_name = ${data.workflow_name}
    `) as { id: string }[];
    wfId = existing[0]?.id;
  }

  const runRows = (await sql`
    INSERT INTO ci_runs (
      workflow_id, github_run_id, event, branch, head_sha,
      status, conclusion, run_started_at, html_url
    ) VALUES (
      ${wfId}::uuid, ${data.github_run_id}, ${data.event ?? null},
      ${data.branch ?? null}, ${data.head_sha ?? null},
      ${data.status ?? null}, ${data.conclusion ?? null},
      ${data.run_started_at ?? null}, ${data.html_url ?? null}
    )
    ON CONFLICT (github_run_id) DO UPDATE SET
      status = EXCLUDED.status,
      conclusion = EXCLUDED.conclusion,
      synced_at = NOW()
    RETURNING id::text
  `) as { id: string }[];

  return runRows[0].id;
}

export async function insertArtifact(data: {
  run_id: string | null;
  job_name?: string;
  github_job_id?: number;
  ingestion_source: string;
  content_preview: string;
  content_hash: string;
  byte_size: number;
  line_count: number;
}): Promise<string | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchemaV2();

  const rows = (await sql`
    INSERT INTO log_artifacts (
      run_id, job_name, github_job_id, ingestion_source,
      content_preview, content_hash, byte_size, line_count
    ) VALUES (
      ${data.run_id ? data.run_id : null}::uuid,
      ${data.job_name ?? null}, ${data.github_job_id ?? null},
      ${data.ingestion_source}, ${data.content_preview},
      ${data.content_hash}, ${data.byte_size}, ${data.line_count}
    )
    RETURNING id::text
  `) as { id: string }[];

  return rows[0]?.id ?? null;
}

export async function chunkLogContent(artifactId: string, logContent: string) {
  const sql = getDb();
  if (!sql) return;
  const lines = logContent.split(/\r?\n/);
  const keywords = ["ERROR", "CRITICAL", "FATAL", "EXCEPTION", "##[error]"];
  let chunkIndex = 0;
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const slice = lines.slice(start, end);
    const hits = slice.filter((ln) =>
      keywords.some((k) => ln.toUpperCase().includes(k))
    ).length;
    if (hits === 0 && lines.length > CHUNK_LINES * 2) continue;
    await sql`
      INSERT INTO log_chunks (artifact_id, chunk_index, start_line, end_line, content, error_hit_count)
      VALUES (
        ${artifactId}::uuid, ${chunkIndex}, ${start + 1}, ${end},
        ${slice.join("\n")}, ${hits}
      )
    `;
    chunkIndex++;
    if (chunkIndex >= 20) break;
  }
}

export async function saveAnalysisV2(
  result: AnalysisResult,
  logContent: string,
  artifactId?: string | null
): Promise<string | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchemaV2();

  const preview =
    logContent.length > LOG_PREVIEW_MAX
      ? logContent.slice(0, LOG_PREVIEW_MAX) + "\n... [truncated for storage]"
      : logContent;

  let artId = artifactId;
  if (!artId) {
    artId = await insertArtifact({
      run_id: null,
      ingestion_source: "manual",
      content_preview: preview,
      content_hash: "",
      byte_size: logContent.length,
      line_count: result.line_count,
    });
  }

  const rows = (await sql`
    INSERT INTO log_analyses (
      artifact_id, workflow, source_label, analysis_mode, llm_provider,
      line_count, errors_count, summary, log_preview, result_json
    ) VALUES (
      ${artId}::uuid, ${result.workflow}, ${result.source_label},
      ${result.mode}, 'none', ${result.line_count}, ${result.errors_count},
      ${result.summary}, ${preview}, ${JSON.stringify(result)}
    )
    RETURNING id::text
  `) as { id: string }[];

  const analysisId = rows[0]?.id;
  if (!analysisId) return null;

  for (const err of result.errors) {
    await sql`
      INSERT INTO analysis_errors (
        analysis_id, line_number, error_type, severity, category,
        message, recommendation, kb_pattern_id
      ) VALUES (
        ${analysisId}::uuid, ${err.line_number}, ${err.type}, ${err.severity},
        ${err.category}, ${err.message}, ${err.recommendation},
        ${err.kb_pattern_id ?? null}
      )
    `;
  }

  return analysisId;
}

export async function saveAnalysis(
  result: AnalysisResult,
  logContent: string
): Promise<string | null> {
  return saveAnalysisV2(result, logContent, null);
}

export async function listRecentAnalyses(limit = 20) {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchemaV2();

  const rows = (await sql`
    SELECT la.id::text, la.created_at, la.workflow, la.source_label,
           la.line_count, la.errors_count, la.summary
    FROM log_analyses la
    ORDER BY la.created_at DESC
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
  return rows;
}

export async function listPolledRuns(limit = 15) {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchemaV2();

  const rows = (await sql`
    SELECT r.id::text AS run_id, r.github_run_id, r.html_url, r.branch,
           r.run_started_at, r.conclusion, w.workflow_name,
           COUNT(DISTINCT a.id)::int AS artifacts,
           COUNT(DISTINCT la.id)::int AS analyses
    FROM ci_runs r
    LEFT JOIN ci_workflows w ON w.id = r.workflow_id
    LEFT JOIN log_artifacts a ON a.run_id = r.id
    LEFT JOIN log_analyses la ON la.artifact_id = a.id
    WHERE r.conclusion = 'failure'
    GROUP BY r.id, r.github_run_id, r.html_url, r.branch, r.run_started_at,
             r.conclusion, w.workflow_name
    ORDER BY r.run_started_at DESC NULLS LAST
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;

  return rows;
}

export async function getAnalysisById(id: string) {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchemaV2();

  const rows = (await sql`
    SELECT id::text, created_at, workflow, source_label,
           line_count, errors_count, summary, log_preview, result_json
    FROM log_analyses WHERE id = ${id}::uuid
  `) as Record<string, unknown>[];
  return rows[0] ?? null;
}

export async function listIngestedArtifacts(limit = 40) {
  const sql = getDb();
  if (!sql) return [];
  await ensureSchemaV2();

  const rows = (await sql`
    SELECT
      a.id::text AS artifact_id,
      r.id::text AS run_id,
      r.github_run_id,
      r.html_url,
      w.workflow_name,
      a.job_name,
      a.ingestion_source,
      a.line_count,
      a.byte_size,
      a.created_at,
      (
        SELECT la.id::text FROM log_analyses la
        WHERE la.artifact_id = a.id
        ORDER BY la.created_at DESC LIMIT 1
      ) AS analysis_id,
      (
        SELECT la.errors_count FROM log_analyses la
        WHERE la.artifact_id = a.id
        ORDER BY la.created_at DESC LIMIT 1
      ) AS errors_count,
      (
        SELECT la.summary FROM log_analyses la
        WHERE la.artifact_id = a.id
        ORDER BY la.created_at DESC LIMIT 1
      ) AS summary
    FROM log_artifacts a
    LEFT JOIN ci_runs r ON r.id = a.run_id
    LEFT JOIN ci_workflows w ON w.id = r.workflow_id
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;

  return rows;
}

export async function getArtifactLogText(artifactId: string): Promise<string | null> {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchemaV2();

  const arts = (await sql`
    SELECT content_preview, byte_size
    FROM log_artifacts WHERE id = ${artifactId}::uuid
  `) as { content_preview: string | null; byte_size: number }[];

  if (!arts[0]) return null;

  const chunks = (await sql`
    SELECT content FROM log_chunks
    WHERE artifact_id = ${artifactId}::uuid
    ORDER BY chunk_index ASC
  `) as { content: string }[];

  let text = arts[0].content_preview ?? "";
  if (chunks.length > 0) {
    const joined = chunks.map((c) => c.content).join("\n");
    if (joined.length > text.length) {
      text = text ? `${text}\n\n--- additional log windows ---\n\n${joined}` : joined;
    }
  }
  return text;
}

export async function getArtifactDetail(artifactId: string) {
  const sql = getDb();
  if (!sql) return null;
  await ensureSchemaV2();

  const rows = (await sql`
    SELECT
      a.id::text AS artifact_id,
      a.job_name,
      a.ingestion_source,
      a.line_count,
      a.byte_size,
      a.created_at,
      r.id::text AS run_id,
      r.github_run_id,
      r.html_url,
      r.branch,
      w.workflow_name
    FROM log_artifacts a
    LEFT JOIN ci_runs r ON r.id = a.run_id
    LEFT JOIN ci_workflows w ON w.id = r.workflow_id
    WHERE a.id = ${artifactId}::uuid
  `) as Array<Record<string, unknown>>;

  if (!rows[0]) return null;

  const analysisRows = (await sql`
    SELECT id::text, workflow, errors_count, summary, result_json, created_at
    FROM log_analyses
    WHERE artifact_id = ${artifactId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  const logText = await getArtifactLogText(artifactId);

  return {
    ...rows[0],
    log_text: logText,
    latest_analysis: analysisRows[0] ?? null,
  };
}
