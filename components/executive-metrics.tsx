"use client";

import type { ExecutiveMetrics } from "@/lib/metrics";
import Link from "next/link";

function BarChart({
  items,
  max,
}: {
  items: { label: string; count: number }[];
  max: number;
}) {
  const m = max || 1;
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-gray-300 truncate pr-2">{item.label}</span>
            <span className="text-arvil-muted shrink-0">{item.count}</span>
          </div>
          <div className="h-2 rounded-full bg-arvil-bg overflow-hidden">
            <div
              className="h-full rounded-full bg-arvil-accent transition-all"
              style={{ width: `${Math.min(100, (item.count / m) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function TrendSparkline({ points }: { points: { date: string; count: number }[] }) {
  if (points.length === 0) {
    return <p className="text-xs text-arvil-muted">No trend data yet.</p>;
  }
  const max = Math.max(...points.map((p) => p.count), 1);
  const w = 280;
  const h = 48;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const coords = points
    .map((p, i) => {
      const x = i * step;
      const y = h - (p.count / max) * (h - 8) - 4;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div>
      <svg width={w} height={h} className="text-arvil-accent" aria-hidden>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          points={coords}
        />
      </svg>
      <div className="flex justify-between text-xs text-arvil-muted mt-1">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}

export function ExecutiveMetricsView({
  metrics,
  showNav = true,
  printMode = false,
}: {
  metrics: ExecutiveMetrics;
  showNav?: boolean;
  printMode?: boolean;
}) {
  const wfMax = Math.max(...metrics.workflow_breakdown.map((w) => w.count), 1);
  const catMax = Math.max(...metrics.top_categories.map((c) => c.count), 1);

  return (
    <div className={printMode ? "bg-white text-gray-900 p-8" : "min-h-screen bg-arvil-bg text-gray-100"}>
      <header
        className={
          printMode
            ? "border-b border-gray-300 pb-4 mb-6"
            : "border-b border-arvil-border bg-arvil-panel/80"
        }
      >
        <div className="max-w-5xl mx-auto px-4 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className={`text-2xl font-bold ${printMode ? "text-gray-900" : ""}`}>
                ARVIL
                <span
                  className={
                    printMode
                      ? "text-orange-600 font-normal text-lg ml-2"
                      : "text-arvil-accent font-normal text-lg ml-2"
                  }
                >
                  Validation Intelligence
                </span>
              </h1>
              <p className={`text-sm mt-1 ${printMode ? "text-gray-600" : "text-arvil-muted"}`}>
                TheRock CI — ROCm/TheRock GitHub Actions · Last {metrics.period_days} days
              </p>
              {metrics.demo_mode && (
                <p className="text-xs text-amber-600 mt-1">Demo data (DATABASE_URL not configured)</p>
              )}
            </div>
            {showNav && !printMode && (
              <div className="flex flex-wrap gap-3 text-sm">
                <Link href="/" className="text-arvil-muted hover:text-white">
                  Engineer console
                </Link>
                <Link
                  href={`/report?period=${metrics.period_days === 30 ? "30d" : "7d"}`}
                  className="text-arvil-accent hover:underline"
                >
                  Print report
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              label: "Failures qualified",
              value: metrics.kpis.failures_qualified,
              sub: "Distinct CI runs triaged (latest analysis per log)",
            },
            {
              label: "Known ROCm signatures",
              value: `${metrics.kpis.known_issue_rate_pct}%`,
              sub: "KB match rate",
            },
            {
              label: "Critical errors",
              value: `${metrics.kpis.critical_concentration_pct}%`,
              sub: "Of all error signatures",
            },
            {
              label: "Est. hours saved",
              value: metrics.kpis.estimated_hours_saved,
              sub: `${metrics.assumptions.manual_triage_minutes} min/failure`,
            },
          ].map((tile) => (
            <div
              key={tile.label}
              className={
                printMode
                  ? "rounded-lg border border-gray-200 p-4"
                  : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
              }
            >
              <p className={`text-xs uppercase tracking-wide ${printMode ? "text-gray-500" : "text-arvil-muted"}`}>
                {tile.label}
              </p>
              <p className={`text-3xl font-bold mt-1 ${printMode ? "text-gray-900" : "text-white"}`}>
                {tile.value}
              </p>
              <p className={`text-xs mt-1 ${printMode ? "text-gray-500" : "text-arvil-muted"}`}>
                {tile.sub}
              </p>
            </div>
          ))}
        </section>

        <section
          className={
            printMode
              ? "rounded-lg border border-gray-200 p-4"
              : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
          }
        >
          <h2 className="text-sm font-semibold mb-3">Executive summary</h2>
          <ul className="list-disc list-inside space-y-2 text-sm text-gray-300 print:text-gray-800">
            {metrics.executive_summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>

        <div className="grid lg:grid-cols-2 gap-6">
          <section
            className={
              printMode
                ? "rounded-lg border border-gray-200 p-4"
                : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
            }
          >
            <h2 className="text-sm font-semibold mb-1">TheRock validation streams</h2>
            <p className="text-xs text-arvil-muted mb-3">
              Distinct triaged runs in the last {metrics.period_days} days (matches
              engineer console when filtered to 7d).
            </p>
            <BarChart
              items={metrics.workflow_breakdown.map((w) => ({
                label: w.label,
                count: w.count,
              }))}
              max={wfMax}
            />
          </section>

          <section
            className={
              printMode
                ? "rounded-lg border border-gray-200 p-4"
                : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
            }
          >
            <h2 className="text-sm font-semibold mb-3">Top failure categories</h2>
            <BarChart
              items={metrics.top_categories.map((c) => ({
                label: c.category,
                count: c.count,
              }))}
              max={catMax}
            />
          </section>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          <section
            className={
              printMode
                ? "rounded-lg border border-gray-200 p-4"
                : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
            }
          >
            <h2 className="text-sm font-semibold mb-3">Qualified failures trend (14d)</h2>
            <TrendSparkline points={metrics.daily_trend} />
          </section>

          <section
            className={
              printMode
                ? "rounded-lg border border-gray-200 p-4"
                : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
            }
          >
            <h2 className="text-sm font-semibold mb-1">Operational KPIs</h2>
            <dl className="text-sm space-y-2 mt-3">
              <div className="flex justify-between">
                <dt className="text-arvil-muted">Auto-triage coverage</dt>
                <dd>{metrics.kpis.auto_triage_coverage_pct}%</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-arvil-muted">Median time to qualification</dt>
                <dd>
                  {metrics.kpis.median_time_to_qualification_hours != null
                    ? `${metrics.kpis.median_time_to_qualification_hours}h`
                    : "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-arvil-muted">Last CI intake</dt>
                <dd className="text-xs">
                  {metrics.last_sync_at
                    ? new Date(metrics.last_sync_at).toLocaleString()
                    : "—"}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <section
          className={
            printMode
              ? "rounded-lg border border-gray-200 p-4"
              : "rounded-lg border border-arvil-border bg-arvil-panel p-4"
          }
        >
          <h2 className="text-sm font-semibold mb-3">Recurring ROCm signatures (≥2 runs)</h2>
          {metrics.repeat_issues.length === 0 ? (
            <p className="text-sm text-arvil-muted">No recurring KB patterns in this window.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className={`text-left text-xs ${printMode ? "text-gray-500" : "text-arvil-muted"}`}>
                  <th className="pb-2">Signature</th>
                  <th className="pb-2">Runs</th>
                  <th className="pb-2">Last run</th>
                </tr>
              </thead>
              <tbody>
                {metrics.repeat_issues.map((r) => (
                  <tr key={r.kb_pattern_id} className="border-t border-arvil-border/50">
                    <td className="py-2 font-mono text-orange-400 print:text-orange-700">
                      {r.kb_pattern_id}
                    </td>
                    <td className="py-2">{r.count}</td>
                    <td className="py-2">
                      {r.last_html_url ? (
                        <a
                          href={r.last_html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-arvil-accent hover:underline print:text-orange-700"
                        >
                          #{r.last_github_run_id}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <footer
          className={`text-xs pb-8 ${printMode ? "text-gray-500" : "text-arvil-muted"}`}
        >
          <p>
            Hours saved = {metrics.assumptions.hours_saved_formula}. Baseline: manual
            GitHub Actions log review by validation engineers.
          </p>
          <p className="mt-1">
            Generated {new Date(metrics.generated_at).toLocaleString()} · ARVIL
          </p>
        </footer>
      </main>
    </div>
  );
}

export function PeriodToggle({
  period,
  onChange,
}: {
  period: "7d" | "30d";
  onChange: (p: "7d" | "30d") => void;
}) {
  return (
    <div className="flex gap-2">
      {(["7d", "30d"] as const).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`px-3 py-1 rounded-lg text-sm border transition ${
            period === p
              ? "border-arvil-accent bg-orange-950/40 text-orange-200"
              : "border-arvil-border text-arvil-muted hover:text-white"
          }`}
        >
          {p === "7d" ? "7 days" : "30 days"}
        </button>
      ))}
    </div>
  );
}
