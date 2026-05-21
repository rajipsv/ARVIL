import {
  getArtifactDetail,
  listIngestedArtifacts,
} from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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

    const artifacts = await listIngestedArtifacts(40);
    return NextResponse.json({ artifacts });
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
