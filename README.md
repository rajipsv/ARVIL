# ARVIL

**AI log qualification** for [TheRock](https://github.com/ROCm/TheRock) / ROCm CI — agentic tools, RAG knowledge base, Neon Postgres, Vercel web UI.

https://github.com/rajipsv/ARVIL

## Structure

```
ARVIL/
  python/agentic/     LangGraph ReAct + RAG (Phase 1–2)
  python/workflow/    Multi-stage workflow analyzer
  web/                Next.js UI (deploy root on Vercel)
  scripts/            schema.sql (v1), schema_v2.sql (TheRock stream)
  .github/workflows/  poll-therock.yml (scheduled sync — no Vercel Cron)
```

## Deploy on Vercel

**Root Directory must be `web`** (the Next.js app is not at repo root).

1. Vercel → Project → **Settings** → **General** → **Root Directory** → `web` → Save  
2. Or use root [vercel.json](vercel.json) with `"rootDirectory": "web"` (already in repo)  
3. **Redeploy** — build should show `next build`, not “no frameworks detected”

## Quick start (web)

```bash
cd web
cp .env.example .env.local
# Set DATABASE_URL, GITHUB_TOKEN (for Sync now)
npm install
npm run dev
```

Open http://localhost:3000 → **Sync now from TheRock Actions** or paste a log manually.

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
| `ARVIL_SYNC_URL` | `https://your-app.vercel.app/api/sync` |
| `POLL_CRON_SECRET` | Same as Vercel |

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
