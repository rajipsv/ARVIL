import { analyzeLog, analyzeLogDeep } from "@/lib/analyzer";
import { upgradeLegacyAnalysis, isLegacyAnalysis } from "@/lib/upgrade-analysis";
import {
  getArtifactDetail,
  getArtifactLogText,
  saveAnalysisV2,
} from "@/lib/db";
import type { AnalysisResult, WorkflowPreset } from "@/lib/types";
import { workflowNameToPreset } from "@/lib/workflow-map";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const runtime = "nodejs";

const VALID_WORKFLOWS: WorkflowPreset[] = [
  "therock_multi_arch",
  "therock_install",
  "therock_pytorch",
  "therock_unit_tests",
  "custom",
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const artifactId =
      typeof body.artifactId === "string" ? body.artifactId.trim() : "";
    const reanalyze = Boolean(body.reanalyze);
    const viewOnly = Boolean(body.viewOnly);
    const deep = Boolean(body.deep);

    let logContent = typeof body.logContent === "string" ? body.logContent : "";
    let workflow: WorkflowPreset = VALID_WORKFLOWS.includes(body.workflow)
      ? body.workflow
      : "therock_multi_arch";
    let sourceLabel =
      typeof body.sourceLabel === "string" ? body.sourceLabel : "upload";
    let linkedArtifactId: string | null = null;

    if (artifactId) {
      const detail = await getArtifactDetail(artifactId);
      if (!detail) {
        return NextResponse.json({ error: "Synced log not found" }, { status: 404 });
      }
      const meta = detail as Record<string, unknown>;

      linkedArtifactId = artifactId;
      const wfName = String(meta.workflow_name ?? "");
      if (wfName) workflow = workflowNameToPreset(wfName);
      sourceLabel = `synced-${String(meta.github_run_id ?? "run")}-${String(meta.job_name ?? "job")}`;

      const latest = meta.latest_analysis as Record<string, unknown> | null;

      if (viewOnly && latest?.result_json) {
        const raw = latest.result_json as AnalysisResult;
        const upgraded = isLegacyAnalysis(raw);
        const existing = upgraded ? upgradeLegacyAnalysis(raw) : raw;
        return NextResponse.json({
          ...existing,
          saved_id: String(latest.id),
          artifact_id: artifactId,
          from_cache: true,
          upgraded,
        });
      }

      const fromDb = await getArtifactLogText(artifactId);
      if (!fromDb?.trim()) {
        return NextResponse.json(
          { error: "No log text stored for this artifact" },
          { status: 400 }
        );
      }
      logContent = fromDb;

      if (!reanalyze && latest?.result_json) {
        const raw = latest.result_json as AnalysisResult;
        if (!isLegacyAnalysis(raw)) {
          return NextResponse.json({
            ...raw,
            saved_id: String(latest.id),
            artifact_id: artifactId,
            from_cache: true,
          });
        }
        // Legacy cache missing root_causes — recompute below
      }
    }

    if (!logContent.trim()) {
      return NextResponse.json(
        {
          error:
            "Select a synced log, or paste / upload a log file.",
        },
        { status: 400 }
      );
    }

    if (logContent.length > 5_000_000) {
      return NextResponse.json(
        { error: "Log exceeds 5MB limit. Paste the failed job step only." },
        { status: 413 }
      );
    }

    const result = deep
      ? await analyzeLogDeep(logContent, workflow, sourceLabel)
      : analyzeLog(logContent, workflow, sourceLabel);
    let savedId: string | null = null;
    try {
      savedId = await saveAnalysisV2(
        result,
        logContent,
        linkedArtifactId
      );
    } catch (dbErr) {
      console.error("Neon save failed:", dbErr);
    }
    return NextResponse.json({
      ...result,
      saved_id: savedId,
      artifact_id: linkedArtifactId,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
