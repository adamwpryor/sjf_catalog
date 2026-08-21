# 🎓 St. John Fisher University — Catalog Platform

The St. John Fisher University (SJFU) catalog platform is a single-tenant academic catalog management system. It provides gated administrative tools for course, program, and policy publishing, graph auditing, and AI-assisted catalog corrections.

- **Tenant Identifier:** `SJFU`
- **Institution:** St. John Fisher University
- **Brand Palette:** Cardinal Red `#993333`, Gold `#FFCC33` (see [institution.config.yaml](institution.config.yaml))

---

## 1. System Architecture

| Component | Technology Stack | Operational Role |
| --- | --- | --- |
| **Web App & API** | Next.js 16 / React 19 / Tailwind CSS | Gated single-page dashboard, API routes, authentication, RAG chat, and diff log reviews. |
| **Python Swarm Microservice** | FastAPI (Python / Conda) | Structured delta resolution, narrative chunk re-sync, committee minutes parsing, and WeasyPrint PDF generation. |
| **Vector Embeddings** | Vertex AI `gemini-embedding-001` (1536-d) | 1536-dimensional vector generation for query retrieval and semantic catalog chunk indexing. |
| **Database Layer** | Supabase Postgres + pgvector + RLS | Structured catalog data (`courses`, `programs`, `program_requirements`), the prerequisite graph (`course_prerequisite_links`), vector storage (`semantic_chunks`), and the review queue (`corrections`). |

---

## 2. Core Documentation Index

* [MAINTENANCE_GUIDELINES.md](MAINTENANCE_GUIDELINES.md) — System engineering standards, zero-trust security, and verification discipline guidelines.
* [AI_ASSISTANTS.md](AI_ASSISTANTS.md) — Detailed guide to all 7 shipping AI features, model pathways, database safety matrix, and deterministic non-AI features.
* [TRANSFER_RUNBOOK.md](TRANSFER_RUNBOOK.md) — Step-by-step account, billing, and infrastructure transfer runbook for transitioning ownership to SJFU or a successor vendor.
* [SECURITY_HARDENING.md](SECURITY_HARDENING.md) — Security fixes, access control boundaries, and known operational guardrails.
* [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) — Database schema contract invariants and expected row count baseline.
* [docs/SELF_SERVE_INGESTION.md](docs/SELF_SERVE_INGESTION.md) — Architecture design for client-run catalog ingestion.
* [OPERATIONS.md](OPERATIONS.md) — Administrator runbook: annual update, triage, remediation, and escalation.
* [docs/AI_PROMPT_INVENTORY.md](docs/AI_PROMPT_INVENTORY.md) — Every prompt in the software, and how each maps to the commissioned deliverables.
* [docs/IP_AND_OWNERSHIP.md](docs/IP_AND_OWNERSHIP.md) — Ownership position and licensing boundary.
* [HANDOFF.md](HANDOFF.md) — High-level architecture map and system auditability framework.

---

## 3. Environment Setup (Conda-First, Zero-Trust)

### 1. Configuration & Secrets
Copy the committed configuration template to an untracked local environment file:
```bash
cp .env.example .env.local
```
Fill in the required credentials (`DATABASE_URL`, `GCP_PROJECT_ID`, `SWARM_API_TOKEN`, etc.). Credentials and secrets must **never** be committed to source control. Missing required variables will cause explicit startup configuration errors per [MAINTENANCE_GUIDELINES.md](MAINTENANCE_GUIDELINES.md).

### 2. Python Environment (Swarm & Harness)
Create and activate the dedicated Conda environment using [environment.yml](environment.yml):
```bash
conda env create -f environment.yml
conda activate sjfu-catalog
```

### 3. Web Dashboard

Install Node dependencies (pinned via [.nvmrc](.nvmrc)) and start the development server:

```bash
npm install
npm run dev
```

The application dashboard will be accessible at `http://localhost:3000`.

### 4. Swarm Service (required for the AI correction features)

Five of the seven AI features route through the Python service — minutes extraction, delta
resolution, chunk re-sync, in-PDF corrections, and the manual entry assistant. The dashboard loads
without it, but those features return errors. Start it in a second terminal, from the repo root:

```bash
conda activate sjfu-catalog
uvicorn services.swarm.main:app --port 8080
```

Then point the web app at it by setting `NEXT_PUBLIC_SWARM_API_URL=http://localhost:8080` in
`.env.local`, and set `SWARM_API_TOKEN` to the same value on both sides. **If `SWARM_API_TOKEN` is
unset the service refuses every request with 401** — that is deliberate (see
[SECURITY_HARDENING.md](SECURITY_HARDENING.md)); only `/health` and the docs endpoints answer
without it.

Confirm it is up:

```bash
curl http://localhost:8080/health
```

---

## 4. Annual Catalog Update Playbook

This CLI-first playbook guides developers and administrators through auditing, verifying, and updating the catalog for new academic years.

### Step 1: Health & Verification Check

Before starting an update cycle, verify that all repository test suites and service imports pass cleanly:

```bash
# Run 108 hermetic verification harness unit tests
python -m pytest verification_harness/tests

# Run strict TypeScript typechecking and ESLint checks
npm run typecheck && npm run lint

# Run Python Swarm import smoke test (validates VertexShimClient factory)
python -c "import services.swarm.main as m; assert type(m._anthropic_client()).__name__ == 'VertexShimClient'; print('swarm ok')"
```

### Step 2: Ingest Catalog Source Pages

Everything downstream reads one artifact: the per-page markdown for the catalog version, stored at
`gs://<GCS_BUCKET>/catalogs/SJFU/<version>/pages/page_NNNN.md`. The harness treats those pages as
ground truth, and the database rows are audited against them.

There are two ways to get from that page set into the database — see
[OPERATIONS.md](OPERATIONS.md) §2 for the full playbook:

- **Managed ingestion.** A vendor produces the page set and replicates the catalog tables.
- **Self-serve.** `python scripts/ingest_self_serve.py --version <version>` reads the pages and
  writes courses, programs, chunks, and the prerequisite graph itself. It previews by default and
  requires `--apply` to write. **It does not derive program requirements** — run
  `node scripts/backfill_program_requirements.mjs` afterwards, or `program_requirement_courses`
  stays empty and the contract invariant in [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md) is not
  satisfied. The design and its limits are in
  [docs/SELF_SERVE_INGESTION.md](docs/SELF_SERVE_INGESTION.md).

Producing the page set itself from a published catalog (Stage A) remains the least automated step.

Once the pages exist in the bucket, `--sync` in Step 3 pulls them into the local cache incrementally.

### Step 3: Run Verification Harness

Run the verification harness against the target catalog version. Using `--sync` populates the local page cache incrementally from GCS. Use `--tier2 estimate` to preview projected model costs before executing a live run.

```bash
# Dry estimate: builds every prompt, spends $0.00, prints projected cost
python -m verification_harness --version 2025-2026-undergraduate --sync --tier2 estimate

# Full execution: Tier 1 deterministic checks + Tier 2 LLM adjudication via Vertex AI ($25.00 budget ceiling)
python -m verification_harness --version 2025-2026-undergraduate --sync --tier2 live
```

### Step 4: Triage Audit Findings

Inspect findings in `verification_harness/artifacts/findings.jsonl` or query the derived SQLite triage index (`verification_harness/artifacts/findings.sqlite`, automatically rebuilt after every run):
- **Tier 1 Findings**: Systemic formatting, title abbreviation, or prerequisite extraction defects.
- **Tier 2 Findings**: Semantic description truncation, mislinked programs, or course identity mismatches.

### Step 5: Remediate & Apply Corrections

The remediation tool applies single-column repairs to confirmed findings. It is **dry-run by default** (plans without writing) and backs up every affected row before making changes.

```bash
# Preview planned changes for a specific check class (e.g. B1)
python -m verification_harness.remediate --checks B1

# Apply the fixes (creates a transaction backup; use --restore to reverse)
python -m verification_harness.remediate --checks B1 --apply

# Re-run deterministic checks to confirm findings are resolved
python -m verification_harness --version 2025-2026-undergraduate
```

---

## 5. Operations & Troubleshooting

### 1. Google Cloud ADC Credential Expiry
- **Symptom**: Tier 2 checks or GCS operations fail with authentication errors, while database (`DATABASE_URL`) queries remain functional.
- **Root Cause**: GCP Application Default Credentials (ADC) token expiration due to organization session-length policies.
- **Fix**: Re-authenticate ADC specifically using:
  ```bash
  gcloud auth application-default login
  ```
  *(Note: `gcloud auth login` refreshes CLI credentials but does NOT update Application Default Credentials used by Python SDKs.)*

### 2. Vertex AI Model Endpoint Availability
- **Symptom**: Vertex AI API calls return 404 errors for requested model endpoints.
- **Root Cause**: Regional endpoints (such as `us-central1`) do not serve Gemini 3.x models (which require global endpoints), and Anthropic Claude models on Vertex are not enabled for this GCP project.
- **Fix**: The harness's Tier 2 model defaults to `gemini-2.5-flash` on the regional endpoint. Stay on the Gemini 2.5 family unless the project is reconfigured for global endpoints.
