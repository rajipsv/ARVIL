/**
 * "Have we seen this exact failure before, and where?" - looked up live at
 * analyze time against everything already stored in Neon, regardless of
 * whether the error ever matched a KB pattern.
 */
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { normalizeForDedupe } from "./root-cause";
import type { RootCauseGroup } from "./types";

const RECENT_LIMIT = 5;

interface OccurrenceRow {
  github_run_id: string | null;
  html_url: string | null;
  created_at: string;
  total_count: number;
}

/**
 * Mutates each group's `prior_occurrences` in place. One query per distinct
 * normalized signature in this log (bounded by root-cause grouping, same as
 * the rest of the analyzer - not a scan over every error line).
 */
export async function attachPriorOccurrences(
  sql: NeonQueryFunction<boolean, boolean>,
  groups: RootCauseGroup[]
): Promise<void> {
  const seen = new Map<string, RootCauseGroup["prior_occurrences"]>();

  for (const g of groups) {
    const signature = normalizeForDedupe(g.primary_message);
    let result = seen.get(signature);
    if (!result) {
      const rows = (await sql`
        WITH matches AS (
          SELECT
            r.github_run_id::text AS github_run_id,
            r.html_url,
            la.created_at,
            COUNT(*) OVER()::int AS total_count
          FROM analysis_errors ae
          JOIN log_analyses la ON la.id = ae.analysis_id
          JOIN log_artifacts a ON a.id = la.artifact_id
          LEFT JOIN ci_runs r ON r.id = a.run_id
          WHERE regexp_replace(
                  regexp_replace(ae.message, '[a-f0-9]{40}', '<sha>', 'gi'),
                  '\\d{10,}', '<n>', 'g'
                ) = ${signature}
          ORDER BY la.created_at DESC
        )
        SELECT * FROM matches LIMIT ${RECENT_LIMIT}
      `) as OccurrenceRow[];

      result = {
        count: rows[0]?.total_count ?? 0,
        recent: rows.map((r) => ({
          github_run_id: r.github_run_id != null ? Number(r.github_run_id) : null,
          html_url: r.html_url,
          created_at: r.created_at,
        })),
      };
      seen.set(signature, result);
    }
    g.prior_occurrences = result;
  }
}
