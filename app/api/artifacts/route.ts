import {
  getArtifactDetail,
  listIngestedArtifacts,
} from "@/lib/db";
import type { WorkflowPreset } from "@/lib/types";
import { PRESET_LABELS } from "@/lib/workflow-map";
import { NextRequest, NextResponse } from "next/server";

const VALID_WORKFLOWS: WorkflowPreset[] = [
  "therock_multi_arch",
  "therock_install",
  "therock_pytorch",
  "therock_unit_tests",
  "custom",
];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id");
    if (id) {
      const detail = await getArtifactDetail(id);
      if (!detail) {
        return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
      }
      return NextResponse.json(detail);
    }

    const workflowParam = req.nextUrl.searchParams.get("workflow");
    if (
      !workflowParam ||
      !VALID_WORKFLOWS.includes(workflowParam as WorkflowPreset)
    ) {
      return NextResponse.json({ artifacts: [], workflow: null });
    }
    const preset = workflowParam as WorkflowPreset;

    if (preset === "custom") {
      return NextResponse.json({
        artifacts: [],
        workflow: preset,
        hint: "Select a category (Multi-Arch, PyTorch Wheels, etc.) to list synced logs.",
      });
    }

    const artifacts = await listIngestedArtifacts(30, preset);
    const uniqueRunIds = new Set(
      artifacts.map((a) =>
        a.github_run_id != null ? String(a.github_run_id) : a.artifact_id
      )
    );
    return NextResponse.json({
      artifacts,
      workflow: preset,
      category: PRESET_LABELS[preset],
      log_count: artifacts.length,
      unique_run_count: uniqueRunIds.size,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to load artifacts",
        hint: "Set DATABASE_URL in Vercel (Production) and redeploy.",
      },
      { status: 500 }
    );
  }
}
