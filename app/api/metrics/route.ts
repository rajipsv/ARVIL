import { getExecutiveMetrics, parsePeriodDays } from "@/lib/metrics";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const period = parsePeriodDays(req.nextUrl.searchParams.get("period"));
    const metrics = await getExecutiveMetrics(period);
    return NextResponse.json(metrics);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to load metrics",
        hint: "Set DATABASE_URL in Vercel for live TheRock CI data.",
      },
      { status: 500 }
    );
  }
}
