import { getAnalysisById, listPolledRuns, listRecentAnalyses } from "@/lib/db";
import type { WorkflowPreset } from "@/lib/types";
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
      const row = await getAnalysisById(id);
      if (!row) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json(row);
    }
    const workflowParam = req.nextUrl.searchParams.get("workflow");
    const preset = VALID_WORKFLOWS.includes(workflowParam as WorkflowPreset)
      ? (workflowParam as WorkflowPreset)
      : undefined;

    const [allItems, polledRuns] = await Promise.all([
      listRecentAnalyses(40),
      listPolledRuns(10, preset),
    ]);

    const items =
      preset && preset !== "custom"
        ? allItems.filter((h) => h.workflow === preset)
        : preset === "custom"
          ? allItems.slice(0, 25)
          : [];

    return NextResponse.json({ items, polledRuns, workflow: preset ?? null });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Database unavailable",
        hint: "Set DATABASE_URL in .env.local or Vercel env",
      },
      { status: 500 }
    );
  }
}
