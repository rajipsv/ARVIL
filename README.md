# ARVIL

**AI log qualification** for [TheRock](https://github.com/ROCm/TheRock) / ROCm CI — LangGraph agent, RAG knowledge base, web UI on Vercel, history in [Neon](https://neon.tech).

Repository: https://github.com/rajipsv/ARVIL

## Structure (no `langgraph` folder name)

```
ARVIL/
  python/
    agentic/       # Phase 1–2: ReAct agent + RAG tools
    workflow/      # Multi-stage workflow analyzer + MCP stub
    simple/        # LangChain single-chain analyzer
  web/             # Next.js UI (Vercel)
  scripts/         # Neon SQL schema
```

## Web UI (Vercel + Neon)

```bash
cd web
cp .env.example .env.local   # set DATABASE_URL
npm install
npm run dev
```

Deploy on Vercel with **Root Directory** = `web`. Add env var `DATABASE_URL` (Neon connection string).

### TheRock workflow

1. Open [TheRock Actions](https://github.com/ROCm/TheRock/actions)
2. Failed job → Download log
3. Paste/upload in ARVIL web → **Analyze**
4. Results saved to Neon `log_analyses` table

## Python CLI (full agent)

```bash
cd python
pip install -r requirements.txt
python -m agentic workflow/example.log --tool-only
python -m agentic workflow/example.log   # needs OPENAI_API_KEY
```

See [python/agentic/AGENTIC_QUICKSTART.md](python/agentic/AGENTIC_QUICKSTART.md).

## Neon database

Run once in [Neon SQL Editor](https://console.neon.tech): [scripts/schema.sql](scripts/schema.sql)

Or let the app auto-create tables on first analyze.

| Column | Purpose |
|--------|---------|
| `log_preview` | Truncated log text |
| `result_json` | Full ARVIL analysis JSON |
| `workflow` | TheRock preset id |

## Security

- Never commit `.env.local` or database passwords.
- If a connection string was shared in chat, **rotate the Neon password** in the Neon console.

## License

MIT
