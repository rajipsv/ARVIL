"use client";

import { WORKFLOW_HINTS } from "@/lib/analyzer";
import type { AnalysisResult, HistoryItem, WorkflowPreset } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

const WORKFLOWS = Object.keys(WORKFLOW_HINTS) as WorkflowPreset[];

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
  const fileRef = useRef<HTMLInputElement>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/history");
      const data = await res.json();
      if (res.ok && data.items) setHistory(data.items);
    } catch {
      /* Neon optional */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

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

  const analyze = useCallback(async () => {
    if (!logContent.trim()) {
      setError("Paste a log or upload a file from TheRock Actions.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          logContent,
          workflow,
          sourceLabel: fileName ?? "paste",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setResult(data);
      loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }, [logContent, workflow, fileName, loadHistory]);

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
          <a
            href="https://github.com/rajipsv/ARVIL"
            className="text-sm text-arvil-muted hover:text-white"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8 grid lg:grid-cols-2 gap-8">
        <section className="space-y-4">
          <label className="block text-sm font-medium text-arvil-muted">
            TheRock workflow preset
          </label>
          <select
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value as WorkflowPreset)}
            className="w-full bg-arvil-panel border border-arvil-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-arvil-accent"
          >
            {WORKFLOWS.map((w) => (
              <option key={w} value={w}>
                {WORKFLOW_HINTS[w].label}
              </option>
            ))}
          </select>
          <p className="text-xs text-arvil-muted">{hint.hint}</p>

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
            onChange={(e) => setLogContent(e.target.value)}
            placeholder="Paste GitHub Actions job log here (failed step)..."
            className="w-full h-80 font-mono text-xs bg-arvil-panel border border-arvil-border rounded-lg p-4 focus:outline-none focus:ring-2 focus:ring-arvil-accent resize-y"
          />

          <button
            type="button"
            onClick={analyze}
            disabled={loading}
            className="w-full py-3 rounded-lg bg-arvil-accent hover:bg-orange-600 text-white font-semibold disabled:opacity-50 transition"
          >
            {loading ? "Analyzing..." : "Analyze log"}
          </button>

          {error && (
            <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-3">
              {error}
            </p>
          )}

          {history.length > 0 && (
            <div className="rounded-lg border border-arvil-border bg-arvil-panel p-3 max-h-40 overflow-y-auto">
              <p className="text-xs font-medium text-arvil-muted mb-2">
                Recent analyses (Neon)
              </p>
              <ul className="space-y-1">
                {history.slice(0, 8).map((h) => (
                  <li key={h.id} className="text-xs text-gray-400 truncate">
                    {new Date(h.created_at).toLocaleString()} — {h.errors_count}{" "}
                    err — {h.workflow}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ol className="text-xs text-arvil-muted space-y-1 list-decimal list-inside border-t border-arvil-border pt-4">
            <li>
              Open{" "}
              <a
                href="https://github.com/ROCm/TheRock/actions"
                className="text-orange-400"
                target="_blank"
                rel="noreferrer"
              >
                TheRock Actions
              </a>
            </li>
            <li>Failed run → failed job → Download log</li>
            <li>Upload or paste → Analyze</li>
          </ol>
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
