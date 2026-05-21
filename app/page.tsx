"use client";

import { WORKFLOW_HINTS } from "@/lib/analyzer";
import type {
  AnalysisResult,
  HistoryItem,
  SyncedLogArtifact,
  WorkflowPreset,
} from "@/lib/types";
import { CATEGORY_PRESETS, PRESET_LABELS } from "@/lib/workflow-map";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

const SAMPLE_LOG = `2024-12-10 10:15:25 ERROR [Database] Connection failed: Connection timeout after 30s
2024-12-10 10:22:00 FATAL [Application] Out of memory error - shutting down
    java.lang.OutOfMemoryError: Java heap space
##[error]Process completed with exit code 1.
`;

export default function Home() {
  const [logContent, setLogContent] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowPreset>("therock_multi_arch");
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [syncedLogs, setSyncedLogs] = useState<SyncedLogArtifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const [loadingArtifact, setLoadingArtifact] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadCategoryData = useCallback(async () => {
    setSyncedLogs([]);
    try {
      const q = encodeURIComponent(workflow);
      const [histRes, artRes] = await Promise.all([
        fetch(`/api/history?workflow=${q}`),
        fetch(`/api/artifacts?workflow=${q}`),
      ]);
      const histData = await histRes.json();
      if (histRes.ok) {
        setHistory(histData.items ?? []);
      } else {
        setHistory([]);
      }
      const artData = await artRes.json();
      if (artRes.ok && Array.isArray(artData.artifacts)) {
        setSyncedLogs(artData.artifacts as SyncedLogArtifact[]);
      } else {
        setSyncedLogs([]);
      }
    } catch {
      setSyncedLogs([]);
      setHistory([]);
    }
  }, [workflow]);

  useEffect(() => {
    if (
      selectedArtifactId &&
      !syncedLogs.some((a) => a.artifact_id === selectedArtifactId)
    ) {
      setSelectedArtifactId("");
      setResult(null);
    }
  }, [workflow, syncedLogs, selectedArtifactId]);

  const syncTheRock = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxRuns: 2, workflow }),
      });
      const data = await res.json();
      if (!res.ok) {
        const parts = [data.error, data.hint, ...(data.errors ?? [])].filter(Boolean);
        throw new Error(parts.join(" — ") || "Sync failed");
      }
      const label = PRESET_LABELS[workflow];
      const parts = [
        `[${label}]`,
        `${data.runs_ingested ?? 0} new run(s)`,
        `${data.artifacts_created ?? 0} log(s)`,
        `${data.analyses_created ?? 0} analysis`,
      ];
      if (data.runs_skipped_filter > 0) {
        parts.push(`(${data.runs_skipped_filter} other workflow(s) skipped)`);
      }
      if (data.runs_matched > 0 && data.runs_ingested === 0) {
        parts.push("— matched failures already in database");
      }
      setSyncMsg(parts.join(" · "));
      if (data.errors?.length) {
        setSyncMsg((m) => `${m}. ${data.errors.slice(0, 2).join("; ")}`);
      }
      loadCategoryData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [loadCategoryData, workflow]);

  useEffect(() => {
    loadCategoryData();
  }, [loadCategoryData]);

  const selectCategory = (preset: WorkflowPreset) => {
    setWorkflow(preset);
    setSelectedArtifactId("");
    setSyncMsg(null);
    setResult(null);
    setLogContent("");
    setFileName(null);
  };

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5_000_000) {
      setError("File exceeds 5MB. Upload the failed step log only.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setLogContent(String(reader.result ?? ""));
      setFileName(file.name);
      setError(null);
    };
    reader.readAsText(file);
  }, []);

  const loadSelectedArtifact = useCallback(
    async (artifactId: string, opts?: { viewOnly?: boolean }) => {
      if (!artifactId) return;
      setLoadingArtifact(true);
      setError(null);
      try {
        const detailRes = await fetch(`/api/artifacts?id=${artifactId}`);
        const detail = await detailRes.json();
        if (!detailRes.ok) throw new Error(detail.error ?? "Failed to load log");

        setSelectedArtifactId(artifactId);
        setLogContent(detail.log_text ?? "");
        setFileName(
          `run-${detail.github_run_id ?? "?"} — ${detail.job_name ?? "job"}`
        );

        if (opts?.viewOnly && detail.latest_analysis?.result_json) {
          setResult(detail.latest_analysis.result_json as AnalysisResult);
          return;
        }

        if (detail.latest_analysis?.result_json && !opts?.viewOnly) {
          setResult(detail.latest_analysis.result_json as AnalysisResult);
        } else {
          setResult(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load synced log");
      } finally {
        setLoadingArtifact(false);
      }
    },
    []
  );

  const analyze = useCallback(
    async (opts?: { reanalyze?: boolean }) => {
      const useArtifact = Boolean(selectedArtifactId);
      if (!useArtifact && !logContent.trim()) {
        setError("Select a synced log, or paste / upload a log file.");
        return;
      }
      setLoading(true);
      setError(null);
      if (opts?.reanalyze) setResult(null);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            useArtifact
              ? {
                  artifactId: selectedArtifactId,
                  workflow,
                  reanalyze: opts?.reanalyze ?? false,
                }
              : {
                  logContent,
                  workflow,
                  sourceLabel: fileName ?? "paste",
                }
          ),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed");
        setResult(data);
        loadCategoryData();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Analysis failed");
      } finally {
        setLoading(false);
      }
    },
    [logContent, workflow, fileName, selectedArtifactId, loadCategoryData]
  );

  const downloadJson = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `arvil-${workflow}-${Date.now()}.json`;
    a.click();
  };

  const hint = WORKFLOW_HINTS[workflow];
  const categoryLabel = PRESET_LABELS[workflow];

  return (
    <main className="min-h-screen">
      <header className="border-b border-arvil-border bg-arvil-panel/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              ARVIL
              <span className="text-arvil-accent font-normal text-lg ml-2">
                Log Qualification
              </span>
            </h1>
            <p className="text-sm text-arvil-muted mt-1">
              Triage{" "}
              <a
                href="https://github.com/ROCm/TheRock/actions"
                className="text-orange-400 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                TheRock CI
              </a>{" "}
              logs — RAG + Neon history
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Link
              href="/dashboard"
              className="text-arvil-accent font-medium hover:underline"
            >
              Executive dashboard
            </Link>
            <a
              href="https://github.com/rajipsv/ARVIL"
              className="text-arvil-muted hover:text-white"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8 grid lg:grid-cols-2 gap-8">
        <section className="space-y-5">
          <div>
            <p className="text-sm font-medium text-arvil-muted mb-2">
              1. Choose TheRock category
            </p>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORY_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => selectCategory(preset)}
                  className={`px-3 py-2.5 rounded-lg text-left text-sm border transition ${
                    workflow === preset
                      ? "border-arvil-accent bg-orange-950/40 text-orange-200"
                      : "border-arvil-border bg-arvil-panel text-gray-300 hover:border-arvil-accent/60"
                  }`}
                >
                  <span className="font-medium block">{PRESET_LABELS[preset]}</span>
                  <span className="text-xs text-arvil-muted block mt-0.5">
                    {WORKFLOW_HINTS[preset].label.split("—")[1]?.trim() ??
                      WORKFLOW_HINTS[preset].label}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-arvil-muted mt-2">{hint.hint}</p>
          </div>

          <div className="rounded-lg border border-arvil-border bg-arvil-panel p-4 space-y-2">
            <p className="text-sm font-medium">
              2. Sync failed <span className="text-arvil-accent">{categoryLabel}</span> runs
            </p>
            <button
              type="button"
              onClick={syncTheRock}
              disabled={syncing || loading}
              className="w-full py-2.5 rounded-lg bg-arvil-accent text-white text-sm font-semibold hover:bg-orange-600 disabled:opacity-50 transition"
            >
              {syncing ? `Syncing ${categoryLabel}…` : `Sync ${categoryLabel} from GitHub`}
            </button>
            {syncMsg && <p className="text-xs text-green-400">{syncMsg}</p>}
          </div>

          <div className="rounded-lg border border-arvil-border bg-arvil-panel p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                3. {categoryLabel} logs
                <span className="text-arvil-muted font-normal ml-1">
                  ({syncedLogs.length})
                </span>
              </p>
            </div>

            {syncedLogs.length === 0 ? (
              <div className="text-center py-8 px-4 rounded-lg border border-dashed border-arvil-border">
                <p className="text-sm text-gray-400">
                  No <strong className="text-orange-300">{categoryLabel}</strong> logs
                  in Neon yet.
                </p>
                <p className="text-xs text-arvil-muted mt-2">
                  Sync this category above. Only {categoryLabel} failures are stored
                  and listed here.
                </p>
              </div>
            ) : (
              <ul className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {syncedLogs.map((a) => {
                  const selected = selectedArtifactId === a.artifact_id;
                  return (
                    <li key={a.artifact_id}>
                      <button
                        type="button"
                        onClick={() => loadSelectedArtifact(a.artifact_id)}
                        className={`w-full text-left rounded-lg border px-3 py-2.5 transition ${
                          selected
                            ? "border-arvil-accent bg-orange-950/30"
                            : "border-arvil-border bg-arvil-bg hover:border-arvil-accent/50"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-orange-400">
                            Run #{a.github_run_id}
                          </span>
                          <span className="text-xs px-1.5 py-0.5 rounded bg-arvil-panel text-arvil-muted">
                            {categoryLabel}
                          </span>
                          {a.errors_count != null && a.errors_count > 0 && (
                            <span className="text-xs text-red-300">
                              {a.errors_count} errors
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-200 truncate">
                          {a.job_name ?? "Job log"}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {a.line_count.toLocaleString()} lines ·{" "}
                          {new Date(a.created_at).toLocaleString()}
                        </p>
                        {a.summary && (
                          <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                            {a.summary}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {selectedArtifactId && (
              <div className="flex flex-wrap gap-2 pt-2 border-t border-arvil-border">
                <button
                  type="button"
                  disabled={loading || loadingArtifact}
                  onClick={() =>
                    loadSelectedArtifact(selectedArtifactId, { viewOnly: true })
                  }
                  className="px-3 py-1.5 rounded-lg border border-arvil-border text-xs hover:border-arvil-accent disabled:opacity-50"
                >
                  View analysis
                </button>
                <button
                  type="button"
                  disabled={loading || loadingArtifact}
                  onClick={() => analyze({ reanalyze: true })}
                  className="px-3 py-1.5 rounded-lg border border-arvil-accent text-arvil-accent text-xs hover:bg-arvil-accent hover:text-white disabled:opacity-50"
                >
                  Re-analyze
                </button>
              </div>
            )}
            {loadingArtifact && (
              <p className="text-xs text-arvil-muted animate-pulse">
                Loading log…
              </p>
            )}
          </div>

          <details className="rounded-lg border border-arvil-border bg-arvil-panel/50">
            <summary className="px-4 py-2 text-sm text-arvil-muted cursor-pointer hover:text-white">
              Manual paste / upload (optional)
            </summary>
            <div className="px-4 pb-4 space-y-3 border-t border-arvil-border pt-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="px-4 py-2 rounded-lg bg-arvil-panel border border-arvil-border text-sm hover:border-arvil-accent transition"
            >
              Upload .log / .txt
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".log,.txt,.out,.json"
              className="hidden"
              onChange={onFile}
            />
            <button
              type="button"
              onClick={() => {
                setLogContent(SAMPLE_LOG);
                setFileName("sample.log");
              }}
              className="px-4 py-2 rounded-lg text-sm text-arvil-muted hover:text-white"
            >
              Load sample
            </button>
          </div>
          {fileName && (
            <p className="text-xs text-green-400">File: {fileName}</p>
          )}

          <textarea
            value={logContent}
            onChange={(e) => {
              setLogContent(e.target.value);
              setSelectedArtifactId("");
            }}
            placeholder={`Paste a ${categoryLabel} log, or select a synced log above…`}
            className="w-full h-48 font-mono text-xs bg-arvil-bg border border-arvil-border rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-arvil-accent resize-y"
          />

          <button
            type="button"
            onClick={() => analyze()}
            disabled={loading || !logContent.trim()}
            className="w-full py-2 rounded-lg border border-arvil-border text-sm hover:border-arvil-accent disabled:opacity-50"
          >
            {loading ? "Analyzing…" : "Analyze pasted log"}
          </button>
            </div>
          </details>

          {error && (
            <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-3">
              {error}
            </p>
          )}

          {history.length > 0 && (
            <div className="rounded-lg border border-arvil-border bg-arvil-panel p-3 max-h-32 overflow-y-auto">
              <p className="text-xs font-medium text-arvil-muted mb-2">
                Recent {categoryLabel} analyses
              </p>
              <ul className="space-y-1">
                {history.slice(0, 5).map((h) => (
                  <li key={h.id} className="text-xs text-gray-400 truncate">
                    {new Date(h.created_at).toLocaleString()} — {h.errors_count}{" "}
                    errors
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="space-y-4">
          {!result && !loading && (
            <div className="h-full min-h-[320px] flex items-center justify-center rounded-lg border border-dashed border-arvil-border text-arvil-muted text-sm">
              Results appear here after analysis
            </div>
          )}

          {loading && (
            <div className="rounded-lg border border-arvil-border bg-arvil-panel p-8 text-center text-arvil-muted animate-pulse">
              Running grep + RAG knowledge base...
            </div>
          )}

          {result && (
            <>
              <div className="rounded-lg border border-arvil-border bg-arvil-panel p-4">
                <div className="flex justify-between items-start gap-2">
                  <h2 className="font-semibold text-lg">Summary</h2>
                  <button
                    type="button"
                    onClick={downloadJson}
                    className="text-xs px-2 py-1 rounded border border-arvil-border hover:border-arvil-accent"
                  >
                    Download JSON
                  </button>
                </div>
                <p className="text-sm mt-2 text-gray-300">{result.summary}</p>
                <div className="flex flex-wrap gap-3 mt-4 text-xs">
                  <span className="px-2 py-1 rounded bg-arvil-bg">
                    {result.errors_count} errors
                  </span>
                  <span className="px-2 py-1 rounded bg-arvil-bg">
                    {result.line_count} lines
                  </span>
                  <span className="px-2 py-1 rounded bg-arvil-bg">
                    {result.workflow}
                  </span>
                  {result.saved_id && (
                    <span className="px-2 py-1 rounded bg-green-950 text-green-400">
                      saved {result.saved_id.slice(0, 8)}…
                    </span>
                  )}
                  {"from_cache" in result && (result as AnalysisResult & { from_cache?: boolean }).from_cache && (
                    <span className="px-2 py-1 rounded bg-blue-950 text-blue-300">
                      from sync
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
                {result.errors.map((err, i) => (
                  <article
                    key={`${err.line_number}-${i}`}
                    className="rounded-lg border border-arvil-border bg-arvil-panel p-4 text-sm"
                  >
                    <div className="flex flex-wrap gap-2 mb-2">
                      <span className="text-xs font-mono text-arvil-muted">
                        L{err.line_number}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          err.severity === "CRITICAL"
                            ? "bg-red-900/50 text-red-300"
                            : "bg-amber-900/40 text-amber-200"
                        }`}
                      >
                        {err.severity}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded bg-arvil-bg">
                        {err.category}
                      </span>
                      {err.kb_pattern_id && (
                        <span className="text-xs px-2 py-0.5 rounded bg-orange-950 text-orange-300">
                          KB: {err.kb_pattern_id}
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-xs text-gray-400 break-all">
                      {err.message}
                    </p>
                    <p className="mt-2 text-green-300/90 text-xs">
                      {err.recommendation}
                    </p>
                  </article>
                ))}
              </div>

              {result.rag_lookups.length > 0 && (
                <details className="rounded-lg border border-arvil-border bg-arvil-panel p-4">
                  <summary className="cursor-pointer text-sm font-medium">
                    RAG knowledge matches ({result.rag_lookups.length})
                  </summary>
                  <pre className="mt-3 text-xs font-mono text-arvil-muted overflow-x-auto whitespace-pre-wrap">
                    {JSON.stringify(result.rag_lookups, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
        </section>
      </div>

      <footer className="max-w-6xl mx-auto px-4 py-6 text-center text-xs text-arvil-muted border-t border-arvil-border mt-8">
        ARVIL Web — Phase 1–2 analyzer (TypeScript) for Vercel. Python agent:{" "}
        <code className="text-orange-400">cd python && python -m agentic</code>
      </footer>
    </main>
  );
}
