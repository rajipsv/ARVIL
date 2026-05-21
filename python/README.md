# ARVIL Python analyzers

Run from this directory (`python/`):

```bash
pip install -r requirements.txt
```

| Module | Command |
|--------|---------|
| **Agentic** (recommended) | `python -m agentic workflow/example.log --tool-only` |
| **Workflow** | `python workflow/log_analyzer.py workflow/example.log` |
| **Simple** | `python simple/log_analyzer_simple.py` (if present) |

Agent package: `agentic/` — LangGraph ReAct + RAG (`lookup_known_failure`).
