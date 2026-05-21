"use client";

import { ExecutiveMetricsView, PeriodToggle } from "@/components/executive-metrics";
import type { ExecutiveMetrics } from "@/lib/metrics";
import { useCallback, useEffect, useState } from "react";

export default function DashboardPage() {
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const [metrics, setMetrics] = useState<ExecutiveMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/metrics?period=${period}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load metrics");
      setMetrics(data as ExecutiveMetrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setMetrics(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !metrics) {
    return (
      <div className="min-h-screen bg-arvil-bg flex items-center justify-center text-arvil-muted">
        Loading validation intelligence…
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="min-h-screen bg-arvil-bg flex items-center justify-center p-4">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <>
      <div className="max-w-5xl mx-auto px-4 pt-4 flex flex-wrap items-center justify-between gap-3">
        <PeriodToggle period={period} onChange={setPeriod} />
        <button
          type="button"
          onClick={() => window.open(`/report?period=${period}`, "_blank")}
          className="px-4 py-2 rounded-lg bg-arvil-accent text-white text-sm font-medium hover:bg-orange-600"
        >
          Download executive summary
        </button>
      </div>
      <ExecutiveMetricsView metrics={metrics} />
    </>
  );
}
