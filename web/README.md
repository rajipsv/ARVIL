# ARVIL Web UI

Next.js app for analyzing **TheRock / ROCm CI logs** in the browser. Deploy on [Vercel](https://vercel.com).

## Features

- Paste or upload GitHub Actions job logs (`.log`, `.txt`)
- Presets: Multi-Arch CI, Install test, PyTorch wheels, Unit tests
- Tool-style grep + **RAG knowledge base** (ROCm/TheRock patterns)
- Download triage JSON

## Local dev

```bash
cd arvil-ui
npm install
npm run dev
```

Open http://localhost:3000

## Deploy to Vercel

1. Push `arvil-ui` folder to GitHub (or deploy from monorepo root with **Root Directory** = `arvil-ui`).

2. [Vercel](https://vercel.com) → **Add New Project** → import repo.

3. Settings:
   - **Framework Preset:** Next.js
   - **Root Directory:** `arvil-ui`
   - **Build Command:** `npm run build`
   - **Output:** default

4. Deploy. No env vars required for tool+RAG mode.

### Monorepo note

If the repo root is `ai-log-error-analyzer`, set Vercel **Root Directory** to `arvil-ui`.

## Using with TheRock Actions

1. Open https://github.com/ROCm/TheRock/actions
2. Failed workflow → failed job → **Download log**
3. Upload in ARVIL UI or paste the failed step section
4. Choose workflow preset → **Analyze log**

## Limits (Vercel serverless)

- Max log size: **5MB** per request (paste failed step only for huge logs)
- Analysis runs in `/api/analyze` (Node runtime, no Python)

For full LangGraph ReAct agent, use CLI: `langgraph-version` → `python -m agentic`.

## Optional: Neon (future)

Store analysis history in Neon Postgres via `DATABASE_URL` — not included in MVP.

## Resume

> Deployed **ARVIL Web** on Vercel for TheRock CI log qualification — upload/paste Actions logs, RAG triage, JSON export.
