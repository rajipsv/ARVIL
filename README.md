# ARVIL

**AI log qualification** for [TheRock](https://github.com/ROCm/TheRock) / ROCm CI — agentic tools, RAG knowledge base, Neon Postgres, Vercel web UI.

https://github.com/rajipsv/ARVIL

## Structure

```
ARVIL/
  app/ lib/            Next.js UI (Vercel deploys repo root)
  python/agentic/     LangGraph ReAct + RAG (Phase 1–2)
  python/workflow/    Multi-stage workflow analyzer
  scripts/            schema.sql (v1), schema_v2.sql (TheRock stream)
  .github/workflows/  poll-therock.yml (scheduled sync — no Vercel Cron)
```

## Deploy on Vercel

Import **rajipsv/ARVIL** with default settings (Root Directory = **empty** / repo root). Vercel should detect **Next.js** and run `npm run build`.

If you previously set Root Directory to `web`, clear it: **Settings → General → Root Directory** → leave blank → Save → **Redeploy**.

## Quick start (web UI)

```bash
cp .env.example .env.local
# Set DATABASE_URL, GITHUB_TOKEN (for Sync now)
npm install
npm run dev
```

Open http://localhost:3000 → **Sync now from TheRock Actions** or paste a log manually.

## Executive dashboard (AMD / leadership)

| URL | Purpose |
|-----|---------|
| `/dashboard` | KPI tiles, TheRock stream breakdown, trends, repeat ROCm signatures |
| `/report?period=7d` | Print-friendly summary (Save as PDF) |

Set `ARVIL_MANUAL_TRIAGE_MINUTES=45` (optional) for hours-saved ROI. See [DESIGN.md](DESIGN.md) §15 for KPI definitions.

## Database schema v2

Run [scripts/schema_v2.sql](scripts/schema_v2.sql) in Neon SQL Editor, or let the app auto-create on first request.

| Table | Purpose |
|-------|---------|
| `ci_workflows` | TheRock workflow names (seeded) |
| `ci_runs` | One row per GitHub Actions run |
| `log_artifacts` | Job logs (poll or manual) |
| `log_chunks` | Large log windows |
| `log_analyses` | ARVIL triage JSON |
| `analysis_errors` | Normalized errors + KB links |

## TheRock poll (primary ingestion)

**Vercel Hobby does not support Cron.** Use:

1. **Sync now** button → `POST /api/sync`
2. **GitHub Actions** [poll-therock.yml](.github/workflows/poll-therock.yml) every 30 minutes

### Vercel environment variables

| Variable | Required |
|----------|----------|
| `DATABASE_URL` | Yes |
| `GITHUB_TOKEN` | Yes for poll (read Actions on public repos) |
| `GITHUB_REPO` | `ROCm/TheRock` |
| `POLL_CRON_SECRET` | Recommended |

### GitHub repo secrets (for scheduled poll)

| Secret | Example |
|--------|---------|
| `ARVIL_SYNC_URL` | `https://your-app.vercel.app/api/sync` (no trailing slash) |
| `POLL_CRON_SECRET` | **Exact same string** as on Vercel |

**GITHUB_TOKEN (Vercel):** Fine-grained PAT → Repository access → `ROCm/TheRock` (or all public) → Permissions → **Actions: Read-only**. Classic PAT: `public_repo` or `repo` scope.

### Sync troubleshooting

1. Open `https://YOUR-APP.vercel.app/api/sync?diag=1` — should show `github_token_set: true` and `database_set: true`.
2. In the app, click **Sync now** — errors now show in the UI (401 = secret mismatch; 503 = missing `GITHUB_TOKEN`).
3. GitHub → **Actions** → **Poll TheRock CI** → **Run workflow** — check log for HTTP code and JSON body.
4. Hobby Vercel limits functions to **10s**; sync processes at most 2 runs × 1 job per request.

## Python CLI

```bash
cd python
pip install -r requirements.txt
python -m agentic workflow/example.log --tool-only
# With NVIDIA NIM:
# set NVIDIA_API_KEY in .env
python -m agentic workflow/example.log
```

## LLM providers

| Provider | Env | Used by |
|----------|-----|---------|
| None | — | Web UI tool+RAG, `--tool-only` |
| NVIDIA NIM | `NVIDIA_API_KEY` | Python ReAct agent |
| OpenAI | `OPENAI_API_KEY` | Fallback for Python agent |

## Security

Never commit `.env.local`. Rotate any credentials shared in chat.

## License

MIT
