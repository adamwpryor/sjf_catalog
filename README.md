# 🎓 St. John Fisher University — Catalog Platform (SJF Spoke)

The SJF catalog spoke: a lift-and-adapt of the CCSJ catalog platform, built on data ingested
from PDF by the **CDI Factory hub** (NVIDIA Spark) and served from a per-tenant Supabase edge.
This is the **first spoke** of a repeatable spoke-generation process (see `BUILD_PLAN.md`).

- **Tenant:** `SJFU` · **Institution:** St. John Fisher University
- **Spoke DB:** Supabase project `zkoimkcctqigisfeqlpv` (us-east-2) — fresh/empty
- **Brand:** Cardinal Red `#993333`, Gold `#FFCC33` (see `institution.config.yaml`)

## Architecture (dual stack, all runtime hosts decoupled from Spark)

| Host | Stack | Role |
|---|---|---|
| Web | Next.js 16 / React 19 / Tailwind v4 | Gated catalog UI, corrections, assistant |
| Swarm | FastAPI (Python/Conda) | Catalog-production agent, remediation |
| Embedding | Hosted `gemini-embedding-001` API (no GPU) | 1536-d chunk + query embeddings (CCSJ pattern) |
| DB | Supabase Postgres + pgvector(1536) + RLS | Catalog data + corrections |

Upstream: the **CDI Factory hub** ingests catalog PDFs and pushes data to the spoke DB via
`deploy_client_db.py`. The running spoke has **no runtime dependency on Spark**.

## Planning docs (read these first)
- `BUILD_PLAN.md` — the step-by-step execution runbook (phases P0–P10, acceptance gates).
- `IMPLEMENTATION_PLAN.md` — strategy / decisions / root-cause record.
- `docs/AIP_BENCHMARK.md` — the accuracy/structure benchmark for ingestion.
- `docs/HUB_UPGRADE_AIP_PARITY.md` — hub-side ingestion upgrade spec.
- `institution.config.yaml` — the single per-spoke config (brand, tenant, hosts).

## Setup (Conda-First, Zero-Trust)

### 1. Secrets — never committed
Copy `.env.example` → `.env.local` (git-ignored) and fill real values, **or** set them in the
Conda env:
```bash
conda env config vars set -n sjfu-catalog DATABASE_URL="..."
```
The repo never contains real credentials. `.env.local` is untracked by design.

### 2. Python (FastAPI swarm, scripts, generator)
```bash
conda env create -f environment.yml
conda activate sjfu-catalog
```

### 3. Web
```bash
npm install
npm run dev        # http://localhost:3000
```

> **Status:** project scaffolding (P0). The application code is lifted/adapted from CCSJ in
> later phases; the spoke schema + data load wait on the hub AIP-parity upgrade
> (`docs/HUB_UPGRADE_AIP_PARITY.md`) so we provision the final shape once.
