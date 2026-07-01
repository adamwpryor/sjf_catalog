# FastAPI Swarm — catalog-production agent + remediation

The Python agent layer ported from CCSJ (`CatalogProductionWizard` + `/api/catalog/*` +
`src/server/main.py` lineage) that synthesizes a new year's catalog from a prior year + deltas
and answers registrar corrections. Generation LLM is **GCP-hosted Vertex Gemini (keyless)**.

## Layout (BUILD_PLAN §4A: vendor-with-lock)

- `vendor/` — faithful CCSJ snapshots, pinned in `UPSTREAM.lock`. **Never edit these**; a re-sync
  (`python scripts/sync_upstream.py`) overwrites them from upstream.
- `overrides/vertex.py` — maps the vendored Anthropic-shaped client onto Vertex Gemini via ADC
  (multimodal content → genai Parts, JSON-Schema cleaned of `additionalProperties`, safety stops →
  Anthropic-style refusals). Model: `gemini-2.5-pro` (override with `VERTEX_GEMINI_MODEL`).
- `main.py` — the SJFU entrypoint (`uvicorn services.swarm.main:app`). Applies the overrides
  *without touching the vendored file*: (1) routes generation to Vertex, (2) rebinds the correction
  prompt's institution name from `INSTITUTION_LEGAL_NAME`, (3) enforces bearer auth.

## Auth

Set `SWARM_API_TOKEN` (secret) on both the swarm and the Next.js server; server→swarm calls send it
as `Authorization: Bearer …` (see `src/lib/swarm.ts`). When the token is unset, auth is skipped for
local dev and a warning is logged.

> **Known gap:** `/api/agent/manual-entry-assistant` is called directly from the browser
> (`TrackingDashboard`, a Client Component) via the public swarm URL, so it can't carry the secret
> token and is exempted from auth. Closing this fully means proxying that call through a Next.js
> route handler — tracked follow-up.

## Endpoints in use

`extract-minutes`, `resolve-delta`, `rewrite-chunk`, `catalog-correction`, `manual-entry-assistant`,
`render-pdf` (WeasyPrint — needs the conda `weasyprint` stack, provided in `environment.yml`).

> The vendored `delta-processor`, `curriculum-auditor`, and `diagnostics-analyst` routes are
> **upstream placeholder stubs that return canned success text and are not called by the SJFU app**.
> They are left in place to keep `vendor/` a faithful mirror; do not wire UI to them expecting real
> behavior (the real remediation lives in the Next.js `/api/catalog/remediate` route).

## Deploy

Cloud Run image via `Dockerfile` (conda `sjfu-catalog` env). Needs ADC for Vertex
(`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`), `SWARM_API_TOKEN`, and `ANTHROPIC_API_KEY` only if
you swap the Vertex override back out. Frontend deploy target (Vercel vs Cloud Run) is still gated on
BUILD_PLAN decision 0.6.
