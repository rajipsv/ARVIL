import { getAnalysisById, listPolledRuns, listRecentAnalyses } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

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
    const [items, polledRuns] = await Promise.all([
      listRecentAnalyses(25),
      listPolledRuns(15),
    ]);
    return NextResponse.json({ items, polledRuns });
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
