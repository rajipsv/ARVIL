# ARVIL RAG pipeline

Retrieval-augmented triage for CI logs, built with **LangChain** and a **FAISS** vector store.
It runs from the command line, or as an HTTP service that powers **Deep analyze** in the web console.

## Pipeline

```
log
 └─ extract        failure window → error hits → root-cause grouping   (extract.py)
     └─ normalize  strip timestamps, SHAs, long numbers                 (extract.py)
         └─ retrieve   FAISS similarity + keyword score, fused by RRF   (retriever.py)
             ├─ strong match → prompt + retrieved patterns → LLM → Pydantic TriageResult
             └─ weak match   → "no known pattern" (no LLM call)         (chain.py)
```

- **Knowledge base:** `lib/data/patterns.json`, the same file the web app ships.
- **Index:** one document per pattern, embedded once and cached under `rag/.cache/faiss/`.
  It is rebuilt only when the patterns or the embedding model change.
- **Grounding:** the model may only cite a pattern that was retrieved; any other id is dropped.
- **Request log:** every triage appends the raw error, the normalized query, retrieved
  pattern ids with scores, the final prompt and the output to `rag_runs.jsonl`.

## Setup

```bash
cd python
pip install -r requirements.txt
cp env_template.txt .env      # then set GOOGLE_API_KEY
```

Gemini is the default provider. Set `ARVIL_LLM_PROVIDER=openai` and `OPENAI_API_KEY` to switch.
Free-tier Gemini requests may be used to improve Google's models, so send public logs only.

## Run

```bash
python -m rag --build-index                         # embed the patterns once
python -m rag workflow/example.log                  # hybrid retrieval + LLM
python -m rag workflow/example.log --retriever faiss
python -m rag workflow/example.log --retriever keyword --no-llm   # no API key needed
python -m rag workflow/example.log --no-rag         # LLM only: the evaluation baseline
```

| Flag | Effect |
|------|--------|
| `--retriever keyword\|faiss\|hybrid` | Which retriever feeds the chain (default `hybrid`) |
| `--no-llm` | Answer straight from the top retrieved pattern |
| `--no-rag` | Skip retrieval; the model sees only the log lines |
| `--max-causes N` | Root causes triaged per log (default 3) |

## Tests

```bash
python -m pytest tests -q
```

The tests are offline: a hashing embedding stands in for Gemini and a stub stands in for the LLM.

## HTTP service

```bash
uvicorn rag.server:app --port 8000      # from python/
```

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Provider, models, pattern count, whether the FAISS index is ready |
| `POST /triage` | `{"log": "...", "max_causes": 3, "use_llm": true}` → triage results with retrieved patterns and scores |

Set `ARVIL_RAG_SECRET` to require `Authorization: Bearer <secret>`. If the LLM call fails
(for example a free-tier rate limit), `/triage` falls back to retrieval-only answers and
reports `llm_error`. The FAISS index is built once at startup.

On Vercel the same app is exposed as a Python function at `/api/rag`
([api/rag.py](../../api/rag.py)). The FAISS index ships prebuilt in `rag/index/`; refresh it
after changing the patterns with `python -m rag --export-index`.

## Not done yet

- No evaluation set or accuracy numbers. `ARVIL_MIN_COSINE` (default 0.6) is a placeholder
  until it is tuned on labelled cases.
