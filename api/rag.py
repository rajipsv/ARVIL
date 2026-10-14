"""
Vercel Python function: FAISS RAG triage at /api/rag (same deployment as the Next.js app).

GET  /api/rag   health: provider, models, whether the FAISS index is loaded
POST /api/rag   {"log": "...", "max_causes": 3, "use_llm": true}  →  triage results

The pipeline lives in python/rag; this file only exposes it on Vercel.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from fastapi import Depends, FastAPI  # noqa: E402

from rag import server  # noqa: E402

app = FastAPI(title="ARVIL RAG (Vercel)", docs_url=None, redoc_url=None, openapi_url=None)

# Register both paths: Vercel may pass the full /api/rag path or the function root.
for path in ("/api/rag", "/"):
    app.add_api_route(path, server.health, methods=["GET"])
    app.add_api_route(
        path,
        server.triage,
        methods=["POST"],
        response_model=server.TriageResponse,
        dependencies=[Depends(server.check_auth)],
    )
