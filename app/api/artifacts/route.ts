import {
  getArtifactDetail,
  listIngestedArtifacts,
} from "@/lib/db";
import type { WorkflowPreset } from "@/lib/types";
import { presetMatchesWorkflowName } from "@/lib/workflow-map";
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
    const preset = VALID_WORKFLOWS.includes(workflowParam as WorkflowPreset)
      ? (workflowParam as WorkflowPreset)
      : null;

    let artifacts = await listIngestedArtifacts(60);
    if (preset && preset !== "custom") {
      artifacts = artifacts.filter((a) =>
        presetMatchesWorkflowName(
          preset,
          String(a.workflow_name ?? ""),
          String(a.job_name ?? "")
        )
      );
    }
    return NextResponse.json({ artifacts, workflow: preset });
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
