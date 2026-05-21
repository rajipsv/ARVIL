import { normalizeGithubRepo, pollTheRock } from "@/lib/github-poll";
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bearer/query secret for GitHub Actions; same-origin allowed for "Sync now" in the UI. */
function authorize(req: NextRequest): boolean {
  const secret = process.env.POLL_CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const q = req.nextUrl.searchParams.get("secret");
  if (q === secret) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin") return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("diag") === "1") {
    return NextResponse.json({
      github_token_set: Boolean(process.env.GITHUB_TOKEN),
      database_set: Boolean(process.env.DATABASE_URL),
      poll_secret_set: Boolean(process.env.POLL_CRON_SECRET),
      github_repo: normalizeGithubRepo(
        process.env.GITHUB_REPO || "ROCm/TheRock"
      ),
      github_repo_raw: process.env.GITHUB_REPO || null,
      hint: !process.env.GITHUB_TOKEN
        ? "Add GITHUB_TOKEN in Vercel (fine-grained PAT: Actions read on public repos, or classic repo scope)."
        : undefined,
    });
  }
  if (!authorize(req)) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        hint: "GitHub Actions: set ARVIL_SYNC_URL + POLL_CRON_SECRET. Browser: open the app and use Sync now (same origin).",
      },
      { status: 401 }
    );
  }
  return runSync(req);
}

async function runSync(req: NextRequest) {
  try {
    if (!process.env.GITHUB_TOKEN) {
      return NextResponse.json(
        {
          ok: false,
          runs_checked: 0,
          runs_ingested: 0,
          artifacts_created: 0,
          analyses_created: 0,
          errors: ["GITHUB_TOKEN is not set"],
          error: "GITHUB_TOKEN is not set on the server",
          hint: "Vercel → Settings → Environment Variables → GITHUB_TOKEN (PAT with Actions read).",
        },
        { status: 503 }
      );
    }
    const body =
      req.method === "GET"
        ? {}
        : await req.json().catch(() => ({}));
    const maxRuns =
      typeof body.maxRuns === "number"
        ? Math.min(Math.max(1, body.maxRuns), 3)
        : 2;
    const result = await pollTheRock({ maxRuns });
    if (!result.ok && result.runs_ingested === 0) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        hint: "Match POLL_CRON_SECRET on Vercel and in GitHub repo secrets for scheduled sync.",
      },
      { status: 401 }
    );
  }
  return runSync(req);
}
