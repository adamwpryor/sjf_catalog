# Qwen3 Embedding Service (shared, GCP Cloud Run + L4 GPU)

FastAPI service that embeds query text with **Qwen3-Embedding-8B**, MRL-truncated to **1024**
dims and L2-normalized — matching the stored catalog vectors. Deployed once to GCP project
`ccsj-catalog-production` (scale-to-zero) and **shared by all spokes** (embeddings are
tenant-agnostic). See `BUILD_PLAN.md` §7 + P3.

Contract: `POST /embed {"input": ["..."]}` → `{"dimension":1024,"embeddings":[[...]]}`,
bearer-auth, `GET /healthz`.

> To be implemented in P3. Has its own heavier `environment.yml` (torch/transformers/vllm).
