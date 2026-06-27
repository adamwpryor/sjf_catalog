#!/usr/bin/env bash
# Deploy the shared Qwen3-1024 embedding service to GCP Cloud Run (L4 GPU).
# Prereq: `gcloud auth login` (the SDK token must be valid — non-interactive runs
# fail with "Reauthentication failed"). Run from services/embed/.
set -euo pipefail

PROJECT="${PROJECT:-ccsj-catalog-production}"
REGION="${REGION:-us-central1}"          # Cloud Run GPU (L4) region; confirm quota
REPO="${REPO:-embed}"
SERVICE="${SERVICE:-embed-qwen3}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"

echo "==> Project=${PROJECT} Region=${REGION} Service=${SERVICE}"

# 0. APIs (idempotent)
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com --project="${PROJECT}"

# 1. Artifact Registry repo (idempotent)
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker --location="${REGION}" --project="${PROJECT}" \
  2>/dev/null || echo "    (repo exists)"

# 2. EMBED_TOKEN secret — create once with a strong random value if missing.
if ! gcloud secrets describe embed-token --project="${PROJECT}" >/dev/null 2>&1; then
  echo "==> Creating embed-token secret"
  openssl rand -hex 32 | gcloud secrets create embed-token --data-file=- --project="${PROJECT}"
fi

# 3. Build + push (Cloud Build). Model bake needs a roomy builder + long timeout.
gcloud builds submit --tag "${IMAGE}" --project="${PROJECT}" \
  --timeout=3600s --machine-type=e2-highcpu-32 .

# 4. Deploy to Cloud Run with an L4 GPU, scale-to-zero.
gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}" --project="${PROJECT}" --region="${REGION}" \
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy \
  --cpu=8 --memory=32Gi --no-cpu-throttling \
  --min-instances=0 --max-instances=3 --concurrency=8 --timeout=300 \
  --no-allow-unauthenticated \
  --port=8080 \
  --set-env-vars="EMBED_MODEL=Qwen/Qwen3-Embedding-8B,EMBED_DIM=1024" \
  --set-secrets="EMBED_TOKEN=embed-token:latest"

echo "==> Deployed. URL:"
gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" \
  --format="value(status.url)"
echo "==> Put that URL in the spoke secret store as SJFU_EMBED_URL, and the embed-token value as EMBED_TOKEN."
