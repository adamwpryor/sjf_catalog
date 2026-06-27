"""Qwen3-1024 embedding service (shared, GCP Cloud Run + L4 GPU).

Embeds query text into the SAME vector space as the CDI Factory hub's stored catalog
vectors. The hub embeds with vLLM `LLM(model="Qwen/Qwen3-Embedding-8B", task="embed").embed()`
and truncates to the first 1024 dims (zero-padding if shorter), with no re-normalization
(pgvector cosine is scale-invariant). This service replicates that recipe exactly so query
and stored vectors are comparable — the single most important runtime invariant.
"""
from __future__ import annotations

import os
from typing import List, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

EMBED_MODEL: str = os.environ.get("EMBED_MODEL", "Qwen/Qwen3-Embedding-8B")
EMBED_DIM: int = int(os.environ.get("EMBED_DIM", "1024"))
EMBED_TOKEN: Optional[str] = os.environ.get("EMBED_TOKEN")  # required for /embed

app = FastAPI(title="Qwen3 Embedding Service", version="1.0.0")
_model = None  # lazy-loaded on first /embed so Cloud Run startup probe passes fast


def _get_model():
    """Lazily initialize the vLLM embedding model (≈30-60s cold start on L4)."""
    global _model
    if _model is None:
        from vllm import LLM  # imported lazily so /healthz works pre-load
        _model = LLM(
            model=EMBED_MODEL,
            task="embed",
            dtype="bfloat16",
            trust_remote_code=True,
            enforce_eager=True,
            gpu_memory_utilization=float(os.environ.get("GPU_MEM_UTIL", "0.85")),
        )
    return _model


def _to_dim(vec: List[float]) -> List[float]:
    """Match the hub: slice to the first EMBED_DIM dims, zero-pad if shorter."""
    vec = list(vec)
    if len(vec) < EMBED_DIM:
        vec.extend([0.0] * (EMBED_DIM - len(vec)))
    elif len(vec) > EMBED_DIM:
        vec = vec[:EMBED_DIM]
    return vec


class EmbedRequest(BaseModel):
    input: List[str]


class EmbedResponse(BaseModel):
    model: str
    dimension: int
    embeddings: List[List[float]]


@app.get("/healthz")
def healthz() -> dict:
    """Liveness/readiness probe (does not force model load)."""
    return {"ok": True, "model": EMBED_MODEL, "dimension": EMBED_DIM, "loaded": _model is not None}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest, authorization: str = Header(default="")) -> EmbedResponse:
    """Embed one or more strings into EMBED_DIM-d Qwen3 vectors (hub-compatible)."""
    if not EMBED_TOKEN:
        raise HTTPException(status_code=500, detail="Service misconfigured: EMBED_TOKEN unset")
    if authorization != f"Bearer {EMBED_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not req.input:
        raise HTTPException(status_code=400, detail="input must be a non-empty list of strings")

    outputs = _get_model().embed(req.input, use_tqdm=False)
    embeddings = [_to_dim(o.outputs.embedding) for o in outputs]
    return EmbedResponse(model=EMBED_MODEL, dimension=EMBED_DIM, embeddings=embeddings)
