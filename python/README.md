# ARVIL Python analyzers

Run from this directory (`python/`):

```bash
pip install -r requirements.txt
```

| Module | Command |
|--------|---------|
| **RAG** (LangChain + FAISS) | `python -m rag workflow/example.log` |
| **Agentic** (recommended) | `python -m agentic workflow/example.log --tool-only` |
| **Workflow** | `python workflow/log_analyzer.py workflow/example.log` |
| **Simple** | `python simple/log_analyzer_simple.py` (if present) |

Agent package: `agentic/` — LangGraph ReAct + RAG (`lookup_known_failure`).

RAG package: `rag/` — LangChain chain with FAISS + keyword retrieval. See [rag/README.md](rag/README.md).

Tests (offline, no API key): `python -m pytest tests -q`
