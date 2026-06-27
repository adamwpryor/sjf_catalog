# FastAPI Swarm — catalog-production agent + remediation

The Python agent layer ported from CCSJ (`CatalogProductionWizard` + `/api/catalog/*` +
`src/server/main.py` lineage) that synthesizes a new year's catalog from a prior year + deltas.
Generation LLM is GCP-hosted (Vertex Gemini or self-hosted Cloud Run GPU — chosen at P8).

**Upstream tracking:** the shared engine is vendored from CCSJ via the vendor-with-lock
mechanism (`BUILD_PLAN.md` §4A) — `vendor/` holds CCSJ snapshots with `UPSTREAM.lock`; SJF
deltas go in `overrides/`, never by editing vendored files.

> To be implemented in P8.
