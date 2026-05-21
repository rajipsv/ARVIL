/**
 * Poll failed GitHub Actions runs from ROCm/TheRock and ingest into Neon.
 */

import { createHash } from "crypto";
import { analyzeLog } from "./analyzer";
import {
  chunkLogContent,
  getKnownGithubRunIds,
  insertArtifact,
  saveAnalysisV2,
  upsertCiRun,
} from "./db";
import type { WorkflowPreset } from "./types";

const GITHUB_API = "https://api.github.com";
const LOG_PREVIEW_MAX = 32_000;
const MAX_NEW_RUNS_PER_SYNC = 2;
const MAX_JOBS_PER_RUN = 1;

export interface SyncResult {
  ok: boolean;
  runs_checked: number;
  runs_ingested: number;
  artifacts_created: number;
  analyses_created: number;
  errors: string[];
}

interface GhRun {
  id: number;
  name?: string;
  head_branch?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  event?: string;
  run_started_at?: string;
  html_url?: string;
  workflow_id?: number;
}

interface GhJob {
  id: number;
  name?: string;
  conclusion?: string;
  started_at?: string;
  completed_at?: string;
}

function repoParts(repo: string) {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

async function ghFetch(
  path: string,
  token: string,
  accept = "application/vnd.github+json",
  redirect: RequestRedirect = "follow"
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect,
  });
}

async function ghErrorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: string; documentation_url?: string };
    return j.message ? `${j.message}` : "";
  } catch {
    return "";
  }
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function workflowNameToPreset(name: string): WorkflowPreset {
  const n = name.toLowerCase();
  if (n.includes("multi-arch") && n.includes("asan")) return "therock_multi_arch";
  if (n.includes("multi-arch")) return "therock_multi_arch";
  if (n.includes("pytorch") || n.includes("wheel")) return "therock_pytorch";
  if (n.includes("unit test") || n.includes("ctest")) return "therock_unit_tests";
  if (n.includes("install") || n.includes("native linux")) return "therock_install";
  return "custom";
}

async function downloadJobLogText(
  owner: string,
  repo: string,
  jobId: number,
  token: string
): Promise<string> {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
    token,
    "application/vnd.github+json",
    "manual"
  );

  let logRes: Response;
  if (res.status === 302 || res.status === 301) {
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`Job logs ${jobId}: redirect without Location`);
    }
    logRes = await fetch(location);
  } else if (res.ok) {
    logRes = res;
  } else {
    const detail = await ghErrorDetail(res);
    throw new Error(
      `Job logs ${jobId}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`
    );
  }

  if (!logRes.ok) {
    throw new Error(`Job logs ${jobId} download: HTTP ${logRes.status}`);
  }

  const buf = Buffer.from(await logRes.arrayBuffer());
  // GitHub returns a zip archive
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const parts: string[] = [];
    for (const [fname, file] of Object.entries(zip.files)) {
      if (!file.dir && (fname.endsWith(".txt") || !fname.includes("/"))) {
        parts.push(await file.async("string"));
      }
    }
    return parts.join("\n") || buf.toString("utf-8", 0, Math.min(buf.length, 500000));
  } catch {
    return buf.toString("utf-8", 0, Math.min(buf.length, 500000));
  }
}

export async function pollTheRock(options?: {
  perPage?: number;
  maxRuns?: number;
}): Promise<SyncResult> {
  const token = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO || "ROCm/TheRock";
  const result: SyncResult = {
    ok: false,
    runs_checked: 0,
    runs_ingested: 0,
    artifacts_created: 0,
    analyses_created: 0,
    errors: [],
  };

  if (!token) {
    result.errors.push("GITHUB_TOKEN is not set");
    return result;
  }

  const { owner, name } = repoParts(githubRepo);
  const perPage = options?.perPage ?? 20;
  const maxRuns = options?.maxRuns ?? MAX_NEW_RUNS_PER_SYNC;

  const runsRes = await ghFetch(
    `/repos/${owner}/${name}/actions/runs?status=failure&per_page=${perPage}`,
    token
  );
  if (!runsRes.ok) {
    const detail = await ghErrorDetail(runsRes);
    result.errors.push(
      `List runs failed: HTTP ${runsRes.status}${detail ? ` — ${detail}` : ""} (check GITHUB_TOKEN: Actions read for ${githubRepo})`
    );
    return result;
  }

  const data = (await runsRes.json()) as { workflow_runs?: GhRun[] };
  const runs = data.workflow_runs ?? [];
  result.runs_checked = runs.length;

  const knownIds = await getKnownGithubRunIds(500);
  const knownSet = new Set(knownIds);
  let ingested = 0;

  for (const run of runs) {
    if (ingested >= maxRuns) break;
    if (knownSet.has(run.id)) continue;

    try {
      const workflowName = run.name || "unknown";
      const runId = await upsertCiRun({
        github_repo: githubRepo,
        workflow_name: workflowName,
        github_run_id: run.id,
        event: run.event,
        branch: run.head_branch,
        head_sha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion,
        run_started_at: run.run_started_at,
        html_url: run.html_url,
      });

      const jobsRes = await ghFetch(
        `/repos/${owner}/${name}/actions/runs/${run.id}/jobs`,
        token
      );
      if (!jobsRes.ok) {
        result.errors.push(`Jobs for run ${run.id}: HTTP ${jobsRes.status}`);
        ingested++;
        continue;
      }

      const jobsData = (await jobsRes.json()) as { jobs?: GhJob[] };
      const failedJobs = (jobsData.jobs ?? []).filter(
        (j) => j.conclusion === "failure" || j.conclusion === "cancelled"
      );
      const jobsToProcess = failedJobs.slice(0, MAX_JOBS_PER_RUN);
      if (jobsToProcess.length === 0 && (jobsData.jobs ?? []).length > 0) {
        jobsToProcess.push((jobsData.jobs ?? [])[0]);
      }

      const preset = workflowNameToPreset(workflowName);

      for (const job of jobsToProcess) {
        try {
          let logText = "";
          try {
            logText = await downloadJobLogText(owner, name, job.id, token);
          } catch (e) {
            result.errors.push(
              `Log download job ${job.id}: ${e instanceof Error ? e.message : String(e)}`
            );
            logText = `Log download failed for job ${job.name} (${job.id}). See ${run.html_url}`;
          }

          const preview =
            logText.length > LOG_PREVIEW_MAX
              ? logText.slice(0, LOG_PREVIEW_MAX) + "\n... [truncated]"
              : logText;

          const artifactId = await insertArtifact({
            run_id: runId,
            job_name: job.name ?? "unknown",
            github_job_id: job.id,
            ingestion_source: "poll",
            content_preview: preview,
            content_hash: hashContent(logText),
            byte_size: logText.length,
            line_count: logText.split(/\r?\n/).length,
          });

          if (artifactId) {
            result.artifacts_created++;
            await chunkLogContent(artifactId, logText);
            const analysis = analyzeLog(logText, preset, `poll-run-${run.id}-job-${job.id}`);
            const analysisId = await saveAnalysisV2(analysis, logText, artifactId);
            if (analysisId) result.analyses_created++;
          }
        } catch (e) {
          result.errors.push(
            `Job ${job.id}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      ingested++;
      result.runs_ingested++;
    } catch (e) {
      result.errors.push(`Run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  result.ok = result.errors.length === 0 || result.runs_ingested > 0;
  return result;
}
