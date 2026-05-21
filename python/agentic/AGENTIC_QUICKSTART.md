# ARVIL Agentic Analyzer — Phase 1 + Phase 2 (RAG)

Tool-using **LangGraph ReAct agent** with log exploration tools and a **failure knowledge base** (RAG).

## Setup

```bash
cd python
pip install -r requirements.txt
```

Optional `.env`:

```
OPENAI_API_KEY=sk-...          # Required for full ReAct agent + optional FAISS embeddings
ARVIL_DISABLE_EMBEDDINGS=1     # Force keyword-only RAG (no FAISS)
```

## Run

```bash
# Tool-only + RAG keyword lookup (no API key)
python -m agentic workflow/example.log --tool-only

# Full agent (tools + RAG + OpenAI)
python -m agentic workflow/example.log

# Custom knowledge base path
python -m agentic workflow/example.log --kb-dir ./my-knowledge

# Learn from triage (self-improving KB)
python -m agentic --record-resolution "Connection timeout" "Increased DB pool and fixed firewall rule"
```

## Phase 2 RAG tools

| Tool | Purpose |
|------|---------|
| `lookup_known_failure` | Match error line to known patterns (incl. ROCm/GPU) |
| `search_failure_knowledge` | Broad KB search |
| `list_kb_categories` | Pattern categories and counts |
| `record_resolution` | Append learned fix to `knowledge/resolutions.jsonl` |

## Knowledge base

- **Seed patterns:** `agentic/knowledge/patterns.json` (general + ROCm install/GPU/HIP/RCCL)
- **Learned fixes:** `agentic/knowledge/resolutions.jsonl` (append via agent or CLI)
- **Optional FAISS index:** `agentic/knowledge/faiss_index/` (built when `OPENAI_API_KEY` is set)

## Outputs

- `agentic_results.json` — includes `rag_lookups` in tool-only mode
- `agentic_report.txt` — human-readable report with KB matches

## Roadmap

- Phase 3: MCP server wired to these tools (Cursor / CI)
- Phase 4: `evals/` + GitHub Actions qualification gate
