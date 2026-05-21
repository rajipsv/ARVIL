"use client";

import { ExecutiveMetricsView } from "@/components/executive-metrics";
import type { ExecutiveMetrics } from "@/lib/metrics";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

function ReportContent() {
  const searchParams = useSearchParams();
  const periodParam = searchParams.get("period") === "30d" ? "30d" : "7d";
  const [metrics, setMetrics] = useState<ExecutiveMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/report?period=${periodParam}`);
      const data = await res.json();
      if (res.ok) setMetrics(data as ExecutiveMetrics);
    } finally {
      setLoading(false);
    }
  }, [periodParam]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!loading && metrics) {
      const t = setTimeout(() => window.print(), 600);
      return () => clearTimeout(t);
    }
  }, [loading, metrics]);

  if (loading || !metrics) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        Preparing report…
      </div>
    );
  }

  return (
    <div className="print-report">
      <div className="hidden print:block text-center text-xs text-gray-500 mb-4">
        ARVIL Executive Summary — use browser Print → Save as PDF
      </div>
      <div className="no-print fixed top-4 right-4 z-50 flex gap-2">
        <button
          type="button"
          onClick={() => window.print()}
          className="px-4 py-2 rounded-lg bg-orange-600 text-white text-sm font-medium shadow"
        >
          Print / Save PDF
        </button>
        <button
          type="button"
          onClick={() => window.close()}
          className="px-4 py-2 rounded-lg border border-gray-300 text-sm"
        >
          Close
        </button>
      </div>
      <ExecutiveMetricsView metrics={metrics} showNav={false} printMode />
    </div>
  );
}

export default function ReportPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">Loading…</div>
      }
    >
      <ReportContent />
    </Suspense>
  );
}
