# Qwen3 Embedding Service (shared, GCP Cloud Run + L4 GPU)

FastAPI service that embeds query text with **Qwen3-Embedding-8B** into **1024-d** vectors that
match the CDI Factory hub's stored catalog vectors. Deployed once to GCP project
`ccsj-catalog-production` (scale-to-zero) and **shared by every spoke** — embeddings are
tenant-agnostic. See `BUILD_PLAN.md` §7 + P3.

## The vector-space invariant (why this matters)
Stored vectors and query vectors **must** come from the same recipe or pgvector cosine search
silently degrades. This service replicates the hub exactly:
`vllm.LLM(model="Qwen/Qwen3-Embedding-8B", task="embed").embed(text)` → **slice to first 1024
dims** (zero-pad if shorter), no re-normalization. Matches `cdi-factory` `providers.py:get_embedding`.

## API
```
GET  /healthz                      → {"ok":true,"model":...,"dimension":1024,"loaded":bool}
POST /embed   Authorization: Bearer <EMBED_TOKEN>
     body:  {"input": ["text", ...]}
     resp:  {"model":"Qwen/Qwen3-Embedding-8B","dimension":1024,"embeddings":[[...1024...]]}
```
Model loads lazily on the first `/embed` (~30-60s cold start on L4) so the Cloud Run startup
probe passes fast; the spoke UI shows a "warming up" state on first call.

## Files
- `app.py` — the service (hub-matching embed recipe).
- `Dockerfile` — base `vllm/vllm-openai`; bakes the model for fast cold-start (`--build-arg BAKE=false` to download at runtime).
- `requirements.txt` — FastAPI wrapper deps (vllm/torch from the base image).
- `deploy.sh` — Cloud Run deploy (Artifact Registry build → L4 GPU service, scale-to-zero, token via Secret Manager).
- `.env.example` — env template.

## Deploy
```bash
gcloud auth login                 # token must be valid (non-interactive runs cannot reauth)
cd services/embed
./deploy.sh                        # PROJECT/REGION/SERVICE overridable via env
```
Requires L4 GPU quota in `REGION` (default `us-central1`). The script creates the Artifact
Registry repo + `embed-token` secret if missing, builds, and deploys.

## Verify (the P3 acceptance gate)
After deploy, confirm the **shared vector space** — an on-topic query must score high cosine vs
a known SJFU chunk embedding:
```bash
TOKEN=$(gcloud secrets versions access latest --secret=embed-token --project=ccsj-catalog-production)
URL=$(gcloud run services describe embed-qwen3 --region=us-central1 --format='value(status.url)')
curl -s -X POST "$URL/embed" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"input":["nursing program prerequisites"]}' | head -c 200
```
Then store `URL` → spoke secret `SJFU_EMBED_URL` and the token → `EMBED_TOKEN`.
