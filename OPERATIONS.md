# St. John Fisher University Catalog Platform — Operations & Administrator Runbook

**Audience:** System Administrators, Registrar Staff, and Technical Operators at St. John Fisher University (SJFU) or successor vendors.

**Purpose:** This runbook provides non-developer instructions for operating, auditing, maintaining, and executing annual catalog updates for the SJFU Academic Catalog Platform without requiring original author intervention.

---

## 1. System Architecture & Topology Overview

The SJFU Academic Catalog Platform consists of four primary runtime components:

| Component | Technology | Hosted On | Primary Function |
| --- | --- | --- | --- |
| **Web Frontend** | Next.js 16 / React 19 / TypeScript | Vercel Team | Interactive catalog navigation, curriculum graphs, diff logs, and administrative dashboards. |
| **Swarm Microservice** | Python 3.12 / FastAPI | Google Cloud Run | Keyless AI agents running on Vertex AI (`us-east5`) for manual entry assistance, page extraction, and delta processing. |
| **Catalog Database** | Supabase PostgreSQL + pgvector | Supabase Cloud | 23 replicated relational tables storing courses, programs, requirements, link tables, vector embeddings (`vector(1536)`), and RLS security policies. |
| **Asset Storage** | Google Cloud Storage | GCS (`gs://sjfu-assets`) | Store catalog PDF source files and per-page markdown assets (`catalogs/SJFU/<version>/pages/page_NNNN.md`). |

---

## 2. Annual Catalog Update Playbook

St. John Fisher University has two fully supported operational pathways for executing annual catalog refreshes.

### Path 1: Managed Service (Hub Ingestion)
If SJFU engages Pryor Consulting or a managed ingestion vendor, the vendor extracts the new catalog year using the central ingestion hub and replicates the 7 contract tables to SJFU's Supabase instance via `deploy_client_db.py`.

### Path 2: Self-Serve Ingestion (`scripts/ingest_self_serve.py`)
SJFU can run catalog updates independently on its own cloud infrastructure and AI billing.

#### Step 2.1: Pre-Flight Environment & Budget Verification
Ensure the Conda environment and Application Default Credentials (ADC) are active:

```bash
# 1. Activate Environment
conda activate sjfu-catalog

# 2. Verify ADC Google Cloud Credentials
gcloud auth application-default login

# 3. Estimate LLM Cost Ceiling ($25 Ceiling Default)
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --tier2-estimate
```

#### Step 2.2: Execute Stage A Acquisition (Source → Markdown Pages)
Convert published catalog assets (PDF/HTML) into structured markdown pages in GCS/cache:

```bash
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --stage-a --source ./catalog_source/
```

#### Step 2.3: Execute Stage B Extraction & Dry-Run Preview
Process markdown pages into chunks, extract course/program facts, link tables, and preview contract counts:

```bash
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --dry-run
```

#### Step 2.4: Execute Stage B Live Database Load
Write records transactionally into Supabase Postgres in FK-safe topological order:

```bash
python scripts/ingest_self_serve.py --version 2026-2027-undergraduate --apply
```

Writing requires `--apply` explicitly; every other invocation is a preview. Passing both `--apply`
and `--dry-run` performs a dry run, so the safer flag wins.

---

## 3. Interpreting the 23-Table Database Census

Every self-serve run ends by printing the row count of **every** table in the replication set, not
only the ones it populated. The point is that a partial load cannot look like a complete one.

Real output from a dry run of `2025-2026-undergraduate`, abbreviated:

```
=== 23-Table Database Census ===
  documents                      Count: 8        Status: POPULATED
  semantic_chunks                Count: 39544    Status: POPULATED
  courses                        Count: 6929     Status: POPULATED
  programs                       Count: 592      Status: POPULATED
  program_requirements           Count: 702      Status: POPULATED
  program_requirement_courses    Count: 3371     Status: POPULATED
  course_prerequisite_links      Count: 3527     Status: POPULATED
  faculty                        Count: 104      Status: POPULATED
  course_prereq_blocks           Count: 0        Status: UNPOPULATED (OUT OF SCOPE)
  requirement_blocks             Count: 0        Status: UNPOPULATED (OUT OF SCOPE)
```

**The census reports the state of the database, not the size of the run.** After a dry run these
are your existing rows. Compare them before and after an `--apply` to see what a load actually did.

> [!IMPORTANT]
> **The contract invariant, and the one thing the self-serve path does not do.**
> `docs/DATA_CONTRACT.md` requires `program_requirement_courses` and `course_prerequisite_links` to
> both be non-zero; both being empty was the original silent-degradation failure.
>
> `scripts/ingest_self_serve.py` produces prerequisite edges but **does not derive program
> requirements**, and it says so at the end of every run. To satisfy the invariant you must run the
> requirement backfill after loading:
>
> ```bash
> node scripts/backfill_program_requirements.mjs
> ```
>
> Until it runs, programs will exist with no requirement rows attached, and the catalog is
> incomplete even though every other count looks healthy. This is stated rather than hidden because
> a plausible-looking count is exactly how the original failure went unnoticed.

## 4. Triage and Quality Assurance (`verification_harness`)

Audit the catalog database after ingestion using the independent verification harness:

```bash
# Tier 0 & 1 Hermetic Audit (Zero Cost, No Network)
python -m verification_harness --version 2025-2026-undergraduate

# Tier 2 Semantic Audit Cost Estimate
python -m verification_harness --version 2025-2026-undergraduate --sync --tier2 estimate

# Tier 2 Live Semantic Audit
python -m verification_harness --version 2025-2026-undergraduate --sync --tier2 live
```

---

## 5. Automated Catalog Remediation (`remediate.py`)

The remediation tool applies the narrow class of findings a deterministic single-column write can
repair. It is **dry-run by default**, backs up every affected cell in the same transaction, and acts
only on `CONFIRMED` findings. It takes a findings file and check ids — **not** a catalog version.

```bash
# Preview: plans and prints, writes nothing. Reviewing one check class at a time is recommended.
python -m verification_harness.remediate --checks B1

# Apply, backing up every affected cell first
python -m verification_harness.remediate --checks B1 --apply

# Reverse the most recent apply (or name one with --run-id)
python -m verification_harness.remediate --restore
```

## 6. Escalation and Ownership

### Who to contact

**On handoff to St. John Fisher University, the escalation point is Bethsaida Sosa.**

Route to that contact anything this runbook does not resolve: a failed catalog load, an audit
finding nobody can interpret, a credential that has expired, or a decision about whether to engage a
managed ingestion vendor for the annual refresh (§2, Path 1).

Two limits worth stating plainly rather than discovering during an incident:

- **The original developer is not an on-call escalation path.** Pryor Consulting may be engaged for
  managed ingestion as a commercial arrangement (§2, Path 1), which is a service, not support.
- **Some credentials can only be renewed by their holder.** Google Application Default Credentials
  expire on an organisational session policy and must be refreshed interactively by the account
  owner — nobody else can do it on their behalf. See §4 troubleshooting.

### Reference documentation

- **Repository overview:** [README.md](README.md)
- **Architecture and ownership model:** [HANDOFF.md](HANDOFF.md)
- **Engineering standards:** [MAINTENANCE_GUIDELINES.md](MAINTENANCE_GUIDELINES.md)
- **Account and billing transfer:** [TRANSFER_RUNBOOK.md](TRANSFER_RUNBOOK.md)
- **AI features and costs:** [AI_ASSISTANTS.md](AI_ASSISTANTS.md)
- **Security posture and known gaps:** [SECURITY_HARDENING.md](SECURITY_HARDENING.md)
- **Expected row counts:** [docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md)
- **Client-run ingestion design:** [docs/SELF_SERVE_INGESTION.md](docs/SELF_SERVE_INGESTION.md)
- **Prompt inventory and IP boundary:** [docs/AI_PROMPT_INVENTORY.md](docs/AI_PROMPT_INVENTORY.md) ·
  [docs/IP_AND_OWNERSHIP.md](docs/IP_AND_OWNERSHIP.md)
