import { analyzeLog } from "@/lib/analyzer";
import { saveAnalysis } from "@/lib/db";
import type { WorkflowPreset } from "@/lib/types";
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
    const logContent = typeof body.logContent === "string" ? body.logContent : "";
    const workflow = VALID_WORKFLOWS.includes(body.workflow)
      ? body.workflow
      : "therock_multi_arch";
    const sourceLabel =
      typeof body.sourceLabel === "string" ? body.sourceLabel : "upload";

    if (!logContent.trim()) {
      return NextResponse.json(
        { error: "Log content is empty. Paste or upload a log file." },
        { status: 400 }
      );
    }

    if (logContent.length > 5_000_000) {
      return NextResponse.json(
        { error: "Log exceeds 5MB limit. Paste the failed job step only." },
        { status: 413 }
      );
    }

    const result = analyzeLog(logContent, workflow, sourceLabel);
    let savedId: string | null = null;
    try {
      savedId = await saveAnalysis(result, logContent);
    } catch (dbErr) {
      console.error("Neon save failed:", dbErr);
    }
    return NextResponse.json({ ...result, saved_id: savedId });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
