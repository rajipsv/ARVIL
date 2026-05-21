/**
 * Executive KPI aggregates for AMD / TheRock CI leadership dashboard.
 */

import { ensureSchemaV2, getDb } from "./db";
import { CATEGORY_PRESETS, PRESET_LABELS } from "./workflow-map";
import type { WorkflowPreset } from "./types";

export interface ExecutiveMetrics {
  period_days: number;
  generated_at: string;
  demo_mode: boolean;
  assumptions: {
    manual_triage_minutes: number;
    hours_saved_formula: string;
  };
  kpis: {
    failures_qualified: number;
    auto_triage_coverage_pct: number;
    known_issue_rate_pct: number;
    critical_concentration_pct: number;
    estimated_hours_saved: number;
    median_time_to_qualification_hours: number | null;
  };
  workflow_breakdown: Array<{ preset: string; label: string; count: number }>;
  top_categories: Array<{ category: string; count: number }>;
  repeat_issues: Array<{
    kb_pattern_id: string;
    count: number;
    last_html_url: string | null;
    last_github_run_id: number | null;
  }>;
  daily_trend: Array<{ date: string; count: number }>;
  executive_summary: string[];
  last_sync_at: string | null;
}

function manualTriageMinutes(): number {
  const v = parseInt(process.env.ARVIL_MANUAL_TRIAGE_MINUTES ?? "45", 10);
  return Number.isFinite(v) && v > 0 ? v : 45;
}

function sinceIso(periodDays: number): string {
  return new Date(Date.now() - periodDays * 86400000).toISOString();
}

/** Portfolio / no-DB fallback for leadership demos. */
export function getDemoExecutiveMetrics(periodDays: number): ExecutiveMetrics {
  const mins = manualTriageMinutes();
  const qualified = 24;
  return {
    period_days: periodDays,
    generated_at: new Date().toISOString(),
    demo_mode: true,
    assumptions: {
      manual_triage_minutes: mins,
      hours_saved_formula: `qualified_failures × ${mins} min ÷ 60`,
    },
    kpis: {
      failures_qualified: qualified,
      auto_triage_coverage_pct: 92,
      known_issue_rate_pct: 68,
      critical_concentration_pct: 22,
      estimated_hours_saved: Math.round((qualified * mins) / 60),
      median_time_to_qualification_hours: 1.2,
    },
    workflow_breakdown: [
      { preset: "therock_multi_arch", label: PRESET_LABELS.therock_multi_arch, count: 11 },
      { preset: "therock_pytorch", label: PRESET_LABELS.therock_pytorch, count: 8 },
      { preset: "therock_install", label: PRESET_LABELS.therock_install, count: 3 },
      { preset: "therock_unit_tests", label: PRESET_LABELS.therock_unit_tests, count: 2 },
    ],
    top_categories: [
      { category: "GPU/Driver", count: 18 },
      { category: "Runtime", count: 12 },
      { category: "Configuration", count: 9 },
      { category: "Memory", count: 6 },
      { category: "Other", count: 4 },
    ],
    repeat_issues: [
      {
        kb_pattern_id: "rocm_hip_oob",
        count: 5,
        last_html_url: "https://github.com/ROCm/TheRock/actions",
        last_github_run_id: 26245198141,
      },
      {
        kb_pattern_id: "cmake_ninja_fail",
        count: 3,
        last_html_url: "https://github.com/ROCm/TheRock/actions",
        last_github_run_id: 26242953143,
      },
    ],
    daily_trend: Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (13 - i));
      return {
        date: d.toISOString().slice(0, 10),
        count: 1 + (i % 4),
      };
    }),
    executive_summary: [
      "PyTorch Wheels accounted for 33% of qualified failures in the demo window; Multi-Arch CI led at 46%.",
      "68% of extracted errors matched known ROCm knowledge-base signatures (less rediscovery).",
      "Estimated 18 engineer-hours saved vs manual GitHub Actions log review (45 min/failure assumption).",
    ],
    last_sync_at: new Date().toISOString(),
  };
}

function buildExecutiveSummary(m: Omit<ExecutiveMetrics, "executive_summary">): string[] {
  const bullets: string[] = [];
  const { kpis, workflow_breakdown, top_categories, repeat_issues } = m;

  if (kpis.failures_qualified === 0) {
    return [
      "No qualified failures in this period — run Sync from the engineer console or widen the date range.",
      "TheRock validation streams: Multi-Arch, PyTorch Wheels, Native Install, Unit Tests.",
    ];
  }

  const totalWf = workflow_breakdown.reduce((s, w) => s + w.count, 0);
  if (totalWf > 0) {
    const top = [...workflow_breakdown].sort((a, b) => b.count - a.count)[0];
    const pct = Math.round((top.count / totalWf) * 100);
    bullets.push(
      `${top.label} accounted for ${pct}% of qualified failures (${top.count} of ${totalWf}) in the last ${m.period_days} days.`
    );
  }

  bullets.push(
    `${kpis.known_issue_rate_pct}% of error signatures matched known ROCm KB patterns — repeat issues are visible earlier.`
  );

  bullets.push(
    `Estimated ${kpis.estimated_hours_saved} engineer-hours saved (${m.assumptions.manual_triage_minutes} min manual triage per failure).`
  );

  if (top_categories[0]) {
    bullets.push(
      `Top failure category: ${top_categories[0].category} (${top_categories[0].count} occurrences) — use for fix prioritization.`
    );
  }

  if (repeat_issues.length > 0) {
    bullets.push(
      `${repeat_issues.length} recurring ROCm signature(s) detected (≥2 runs) — candidate flake/regression reviews.`
    );
  }

  return bullets.slice(0, 4);
}

export async function getExecutiveMetrics(
  periodDays: number
): Promise<ExecutiveMetrics> {
  const sql = getDb();
  const mins = manualTriageMinutes();
  const since = sinceIso(periodDays);
  const repeatSince = sinceIso(Math.max(periodDays, 14));

  if (!sql) {
    return getDemoExecutiveMetrics(periodDays);
  }

  await ensureSchemaV2();

  const qualifiedRows = (await sql`
    SELECT COUNT(DISTINCT la.id)::int AS cnt
    FROM log_analyses la
    LEFT JOIN log_artifacts a ON a.id = la.artifact_id
    WHERE la.created_at >= ${since}::timestamptz
  `) as { cnt: number }[];

  const failuresQualified = qualifiedRows[0]?.cnt ?? 0;

  const coverageRows = (await sql`
    SELECT
      COUNT(DISTINCT a.id)::int AS artifacts,
      COUNT(DISTINCT la.id)::int AS analyzed
    FROM log_artifacts a
    LEFT JOIN log_analyses la ON la.artifact_id = a.id
      AND la.created_at >= ${since}::timestamptz
    WHERE a.created_at >= ${since}::timestamptz
      AND a.ingestion_source = 'poll'
  `) as { artifacts: number; analyzed: number }[];

  const artifacts = coverageRows[0]?.artifacts ?? 0;
  const analyzed = coverageRows[0]?.analyzed ?? 0;
  const autoTriageCoveragePct =
    artifacts > 0 ? Math.round((analyzed / artifacts) * 100) : 0;

  const errorStats = (await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ae.kb_pattern_id IS NOT NULL)::int AS known,
      COUNT(*) FILTER (WHERE ae.severity = 'CRITICAL')::int AS critical
    FROM analysis_errors ae
    JOIN log_analyses la ON la.id = ae.analysis_id
    WHERE la.created_at >= ${since}::timestamptz
  `) as { total: number; known: number; critical: number }[];

  const totalErr = errorStats[0]?.total ?? 0;
  const knownErr = errorStats[0]?.known ?? 0;
  const criticalErr = errorStats[0]?.critical ?? 0;

  const knownIssueRatePct =
    totalErr > 0 ? Math.round((knownErr / totalErr) * 100) : 0;
  const criticalConcentrationPct =
    totalErr > 0 ? Math.round((criticalErr / totalErr) * 100) : 0;

  const workflowRows = (await sql`
    SELECT COALESCE(r.workflow_preset, 'custom') AS preset, COUNT(DISTINCT la.id)::int AS cnt
    FROM log_analyses la
    JOIN log_artifacts a ON a.id = la.artifact_id
    JOIN ci_runs r ON r.id = a.run_id
    WHERE la.created_at >= ${since}::timestamptz
    GROUP BY COALESCE(r.workflow_preset, 'custom')
    ORDER BY cnt DESC
  `) as { preset: string; cnt: number }[];

  const presetCounts = new Map<string, number>();
  for (const row of workflowRows) {
    presetCounts.set(row.preset, row.cnt);
  }

  const workflow_breakdown = CATEGORY_PRESETS.map((preset) => ({
    preset,
    label: PRESET_LABELS[preset],
    count: presetCounts.get(preset) ?? 0,
  })).filter((w) => w.count > 0);

  const legacy = presetCounts.get("custom") ?? 0;
  if (legacy > 0) {
    workflow_breakdown.push({
      preset: "custom",
      label: "Other / legacy",
      count: legacy,
    });
  }

  const categoryRows = (await sql`
    SELECT COALESCE(ae.category, 'Other') AS category, COUNT(*)::int AS cnt
    FROM analysis_errors ae
    JOIN log_analyses la ON la.id = ae.analysis_id
    WHERE la.created_at >= ${since}::timestamptz
    GROUP BY COALESCE(ae.category, 'Other')
    ORDER BY cnt DESC
    LIMIT 5
  `) as { category: string; cnt: number }[];

  const top_categories = categoryRows.map((r) => ({
    category: r.category,
    count: r.cnt,
  }));

  const repeatRows = (await sql`
    SELECT
      ae.kb_pattern_id,
      COUNT(DISTINCT r.github_run_id)::int AS run_count,
      MAX(r.html_url) AS last_html_url,
      MAX(r.github_run_id) AS last_github_run_id
    FROM analysis_errors ae
    JOIN log_analyses la ON la.id = ae.analysis_id
    JOIN log_artifacts a ON a.id = la.artifact_id
    JOIN ci_runs r ON r.id = a.run_id
    WHERE la.created_at >= ${repeatSince}::timestamptz
      AND ae.kb_pattern_id IS NOT NULL
    GROUP BY ae.kb_pattern_id
    HAVING COUNT(DISTINCT r.github_run_id) >= 2
    ORDER BY run_count DESC
    LIMIT 10
  `) as Array<{
    kb_pattern_id: string;
    run_count: number;
    last_html_url: string | null;
    last_github_run_id: string;
  }>;

  const repeat_issues = repeatRows.map((r) => ({
    kb_pattern_id: r.kb_pattern_id,
    count: r.run_count,
    last_html_url: r.last_html_url,
    last_github_run_id: Number(r.last_github_run_id),
  }));

  const trendRows = (await sql`
    SELECT
      DATE(la.created_at AT TIME ZONE 'UTC')::text AS day,
      COUNT(DISTINCT la.id)::int AS cnt
    FROM log_analyses la
    WHERE la.created_at >= ${sinceIso(14)}::timestamptz
    GROUP BY DATE(la.created_at AT TIME ZONE 'UTC')
    ORDER BY day ASC
  `) as { day: string; cnt: number }[];

  const daily_trend = trendRows.map((r) => ({ date: r.day, count: r.cnt }));

  const tqRows = (await sql`
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (la.created_at - r.run_started_at)) / 3600.0
      ) AS median_hours
    FROM log_analyses la
    JOIN log_artifacts a ON a.id = la.artifact_id
    JOIN ci_runs r ON r.id = a.run_id
    WHERE la.created_at >= ${since}::timestamptz
      AND r.run_started_at IS NOT NULL
  `) as { median_hours: number | null }[];

  const medianHours = tqRows[0]?.median_hours;
  const median_time_to_qualification_hours =
    medianHours != null && Number.isFinite(Number(medianHours))
      ? Math.round(Number(medianHours) * 10) / 10
      : null;

  const syncRows = (await sql`
    SELECT MAX(synced_at)::text AS last_sync FROM ci_runs
  `) as { last_sync: string | null }[];

  const base: Omit<ExecutiveMetrics, "executive_summary"> = {
    period_days: periodDays,
    generated_at: new Date().toISOString(),
    demo_mode: false,
    assumptions: {
      manual_triage_minutes: mins,
      hours_saved_formula: `qualified_failures × ${mins} min ÷ 60`,
    },
    kpis: {
      failures_qualified: failuresQualified,
      auto_triage_coverage_pct: autoTriageCoveragePct,
      known_issue_rate_pct: knownIssueRatePct,
      critical_concentration_pct: criticalConcentrationPct,
      estimated_hours_saved: Math.round((failuresQualified * mins) / 60),
      median_time_to_qualification_hours,
    },
    workflow_breakdown,
    top_categories,
    repeat_issues,
    daily_trend,
    last_sync_at: syncRows[0]?.last_sync ?? null,
  };

  return {
    ...base,
    executive_summary: buildExecutiveSummary(base),
  };
}

export function parsePeriodDays(param: string | null): number {
  if (param === "30d" || param === "30") return 30;
  return 7;
}
