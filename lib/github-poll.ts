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
import {
  presetMatchesWorkflowName,
  workflowNameToPreset,
} from "./workflow-map";
import type { WorkflowPreset } from "./types";

const GITHUB_API = "https://api.github.com";
const LOG_PREVIEW_MAX = 32_000;
const MAX_NEW_RUNS_PER_SYNC = 2;
const MAX_JOBS_PER_RUN = 1;

export interface SyncResult {
  ok: boolean;
  workflow_preset: WorkflowPreset | null;
  runs_checked: number;
  runs_matched: number;
  runs_skipped_filter: number;
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

interface GhWorkflow {
  id: number;
  name?: string;
  path?: string;
}

async function workflowIdsForPreset(
  owner: string,
  repo: string,
  token: string,
  preset: WorkflowPreset
): Promise<Set<number>> {
  const ids = new Set<number>();
  const res = await ghFetch(`/repos/${owner}/${repo}/actions/workflows`, token);
  if (!res.ok) return ids;

  const data = (await res.json()) as { workflows?: GhWorkflow[] };
  for (const wf of data.workflows ?? []) {
    if (
      presetMatchesWorkflowName(preset, wf.name ?? "", wf.path ?? "")
    ) {
      ids.add(wf.id);
    }
  }
  return ids;
}

function runMatchesPreset(
  run: GhRun,
  preset: WorkflowPreset | undefined,
  workflowIds: Set<number>
): boolean {
  if (!preset || preset === "custom") return true;
  if (run.workflow_id && workflowIds.size > 0 && workflowIds.has(run.workflow_id)) {
    return true;
  }
  return presetMatchesWorkflowName(preset, run.name ?? "");
}

/** Accept `ROCm/TheRock` or `https://github.com/ROCm/TheRock` (common misconfiguration). */
export function normalizeGithubRepo(repo: string): string {
  let s = repo.trim();
  s = s.replace(/^https?:\/\/github\.com\//i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return s;
}

function repoParts(repo: string) {
  const normalized = normalizeGithubRepo(repo);
  const [owner, name] = normalized.split("/");
  if (!owner || !name) {
    throw new Error(
      `Invalid GITHUB_REPO "${repo}" — use owner/repo (e.g. ROCm/TheRock), not a full URL`
    );
  }
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
  workflowPreset?: WorkflowPreset;
}): Promise<SyncResult> {
  const token = process.env.GITHUB_TOKEN;
  const githubRepo = normalizeGithubRepo(
    process.env.GITHUB_REPO || "ROCm/TheRock"
  );
  const preset = options?.workflowPreset;
  const result: SyncResult = {
    ok: false,
    workflow_preset: preset ?? null,
    runs_checked: 0,
    runs_matched: 0,
    runs_skipped_filter: 0,
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
  const filtering = preset && preset !== "custom";
  const perPage = options?.perPage ?? (filtering ? 50 : 20);
  const maxRuns = options?.maxRuns ?? MAX_NEW_RUNS_PER_SYNC;

  const workflowIds =
    filtering && preset
      ? await workflowIdsForPreset(owner, name, token, preset)
      : new Set<number>();

  const runsRes = await ghFetch(
    `/repos/${owner}/${name}/actions/runs?status=failure&per_page=${perPage}`,
    token
  );
  if (!runsRes.ok) {
    const detail = await ghErrorDetail(runsRes);
    const apiPath = `/repos/${owner}/${name}/actions/runs`;
    const envHint =
      process.env.GITHUB_REPO &&
      process.env.GITHUB_REPO.trim() !== githubRepo
        ? ` GITHUB_REPO env was "${process.env.GITHUB_REPO}" — use owner/repo only (e.g. ROCm/TheRock).`
        : "";
    result.errors.push(
      `List runs failed: HTTP ${runsRes.status}${detail ? ` — ${detail}` : ""} (GET ${apiPath}; token needs Actions read on ${githubRepo}).${envHint}`
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

  if (filtering && result.runs_matched === 0 && result.runs_checked > 0) {
    result.errors.push(
      `No failed runs matched preset "${preset}" in the last ${result.runs_checked} failures — try "All workflows" or another category.`
    );
  }

  result.ok =
    result.runs_ingested > 0 ||
    (result.errors.length === 0 && result.runs_matched > 0);
  return result;
}
