# SJF Catalog — Autonomous Build Plan (Execution Runbook)

**Purpose.** A step-by-step, near-autonomously-executable plan to stand up the **SJFU spoke** (lift-and-adapt of CCSJ) against the CDI Factory hub, *and* to extract a reusable **scripted spoke generator** from doing it. Companion to `IMPLEMENTATION_PLAN.md` (strategy/decisions/root-cause record); this file is the **how**.

**How to use.** Review §0 pre-flight first ("checked for errors before beginning"). Each phase has **Actions → Acceptance gate → Rollback**. Do not advance past a phase whose acceptance gate fails. Phases P0–P2 are infra; P3+ is software. An agent executing this should stop and surface any gate failure rather than improvise.

**Locked decisions (Adam):** internal tool · full CCSJ feature parity **minus accreditation/HLC** (`IMPLEMENTATION_PLAN.md §5.1`) · **dual-stack + full Python swarm** (incl. catalog-production agent) · **lift-and-adapt** · **AI (Claude) provisions** · **scripted generator** (Decision G2) · **separate FastAPI host for the Qwen3 embedding model** · brand tokens supplied as a required root artifact.

---

## 0. Pre-flight (error-check gate — clear before P1)

| # | Check | Must be true |
|---|---|---|
| 0.1 | Hub reachable | `ssh … adamwpryor@spark-6284.local hostname` → `spark-6284` |
| 0.2 | Hub data verified | SJFU live counts: `program_requirement_courses=2402`, `course_prerequisite_links=2939`, `courses=5923`, `programs=1203` (✅ confirmed) |
| 0.3 | **Brand artifact present** | `institution.config.yaml` exists at repo root and validates against §2 schema *(BLOCKER — Adam supplies)* |
| 0.4 | Supabase admin creds | A Supabase access token / org for Claude to create the project *(BLOCKER — Adam supplies channel)* |
| 0.5 | Embedding host target | Decision on where the Qwen3 FastAPI host runs (Spark GPU vs elsewhere) + how the deployed spoke reaches it (Tailscale/Cloudflare tunnel) — see §7 |
| 0.6 | Deploy target | Vercel vs Cloud Run for the Next.js spoke (Decision E) |
| 0.7 | Secrets policy | No secrets committed; all via env/secret store; `deployment_config.yaml` stays gitignored on the hub |

**Outstanding human inputs:** 0.3 (brand file), 0.4 (Supabase token), 0.5/0.6 (host + deploy target). Everything else is automatable.

---

## 1. Target topology

```
 Adam → [Next.js spoke  (Vercel/Cloud Run)] ──auth/SQL──> [SJFU Cloud Supabase: Postgres+pgvector(1024)+HNSW+RLS]
              │  calls                                            ▲  data load (one-time + on re-ingest)
              ├─► [FastAPI Swarm host]  (catalog-production agent, remediation)   │
              └─► [Qwen3 Embedding host]  (FastAPI, /embed → 1024-d)  ────────────┘
                         ▲ both Python hosts sit near the Spark GPU; reached via secure tunnel
        Hub (Spark): cdi-factory → deploy_client_db.py pushes hub Postgres → SJFU Cloud Supabase
```

Three runtime hosts for the spoke: **(A)** Next.js web, **(B)** FastAPI swarm, **(C)** Qwen3 embedding FastAPI (dedicated, per Decision #3). B and C live on/near Spark (GPU + cached models); A is cloud-deployed and calls B/C over a tunnel.

---

## 2. The institution config contract (required root artifact)

Single source of truth the generator consumes. **Required for every institution, forever.** Filename: `institution.config.yaml` at repo root. Brand tokens are filled by Adam; infra fields (project ref, URLs) are filled by the generator as it provisions and committed back (non-secret values only).

```yaml
institution:
  tenant_id: "SJFU"                 # canonical, matches hub rows (verified)
  legal_name: "St. John Fisher University"
  short_name: "Fisher"
  domains: ["undergraduate", "graduate"]   # maps to documents.domain_id / version suffix
  accreditation: false              # ← omits accreditation schema + UI (SJFU)

brand:                              # Adam supplies; drives the single theme layer
  colors: { primary: "#______", secondary: "#______", accent: "#______", bg: "#______", surface: "#______" }
  typography: { serif: "", sans: "", mono: "" }
  logo: { light: "public/brand/logo-light.svg", dark: "public/brand/logo-dark.svg", favicon: "public/brand/favicon.ico" }
  app_title: "Fisher Catalog"

supabase:                           # generator fills project_ref/urls after provisioning (non-secret)
  project_ref: ""                   # e.g. abcdwxyz...  (filled by generator)
  url: ""                           # https://<ref>.supabase.co
  # anon key + service key + DATABASE_URL live in the secret store ONLY, never here

embedding:
  provider: "qwen3-host"
  model: "Qwen/Qwen3-Embedding-8B"
  dimension: 1024                   # MRL-truncated; MUST match stored vectors
  endpoint_env: "SJFU_EMBED_URL"    # resolved from secret store at runtime

swarm:
  fastapi_base_env: "SJFU_SWARM_URL"
  features: { production_agent: true, remediation: true, assistant: true, intake_gcs: true, pdf: true }

deploy:
  target: "vercel"                  # or "cloud_run"
  gcs_bucket: "sjfu-assets"         # already exists on the hub side
```

A JSON Schema for this file lands at `scripts/spoke/institution.schema.json` (P10) so the generator can validate (gate 0.3).

---

## 3. Schema assembly spec (the exact include/omit/override list)

The spoke cloud DB schema = **hub core migrations** + **selected CCSJ-web migrations**, with three deliberate deltas. The generator runs them in this order against the fresh Supabase project.

> **Mechanism (answers "how do we skip migrations"):** the generator does **not** blindly `supabase db push` either source directory. It executes an **explicit ordered allow-list** of migration files (the list below), copied into *this* repo's `supabase/migrations/` at P1. Omission = a file is simply absent from the allow-list. **Verified:** the hub's `supabase/migrations/` create **no** accreditation tables (the hub `deploy_client_db.py` TABLE_ORDER contains none) — accreditation exists only as the two named CCSJ-*web* migrations, so the omission is confined to the web side and dropping it cannot affect catalog data.

**A. Hub core (`cdi-factory/supabase/migrations/`)** — run all EXCEPT as noted:
`init_schema` → `add_programs_and_courses` → `add_institutions` → `add_corrections_table` (cloud-only feedback table) → `add_program_faculty_tables` → `add_seven_lookup_tables` → `add_numeric_lookup_tables` → `add_lookup_sync_triggers` → `add_policy_linkages` → `add_markdown_url_columns` → `add_prerequisites_json` → `prune_denormalized_columns` → `production_readiness` → **`resize_embedding_to_1024`** (KEEP — this sets `vector(1024)` + HNSW; the embedding space we standardize on).

**B. CCSJ-web migrations (`ccsj-catalog/supabase/migrations/`)** — port these app tables/policies:
- `user_roles` (from `rls_policies.sql` / auth model), `improvement_plans` (base only), `catalog_agent_usage`, relationship-table RLS, corrections audit columns, `documents_catalog_pdf_url`, `documents_presentation_overrides`, `add_hnsw_index` (reconcile with A's HNSW — keep one).

**C. The three deliberate deltas:**
1. **🚫 OMIT `embedding_1536_hnsw.sql`.** It resizes to `vector(1536)` (Gemini) and clears Spark vectors. We are 1024-d Qwen3 end-to-end. Keeping it would destroy the hub embeddings and break query/stored alignment.
2. **🚫 OMIT accreditation migrations** (`improvement_plans_accreditor.sql`, `accreditation_criteria_unique.sql`) and any `accreditor_*` columns. `institution.config.accreditation:false` drives this. Improvement Plan ships in catalog-internal-quality form only.
3. **🔁 RECONCILE RLS to single-tenant auth model.** The spoke DB is single-tenant (SJFU only). DROP the hub's `app.current_tenant` tenant-isolation policies from `init_schema`/`add_programs_and_courses` and apply the CCSJ-web `auth.uid()` + `user_roles` policies (`rls_policies.sql`, `relationship_tables_rls.sql`). Result: `db.ts`/`queryWithAuth` (which sets `request.jwt.claim.sub` + `SET LOCAL ROLE authenticated`) is the only RLS regime — no `app.current_tenant` needed on the spoke.

> Output of P1 is a single ordered, idempotent migration set under `supabase/migrations/` in *this* repo (the generator copies + filters from both sources), so the spoke DB is reproducible.

---

## 4. The scripted generator (Decision G2)

Built incrementally **while** doing SJFU, then hardened in P10. Location: `scripts/spoke/`.

- `create-spoke.mjs --config institution.config.yaml [--phase provision|schema|load|app|all] [--dry-run]`
- Responsibilities (each idempotent, each re-runnable):
  1. **validate** config against `institution.schema.json`; abort on miss (gate 0.3).
  2. **provision** Supabase project (or reuse if `project_ref` set); write back `project_ref`/`url`.
  3. **schema** — run the §3 assembled migration set; verify table presence.
  4. **load** — invoke hub `deploy_client_db.py --tenant-id <T>` (over SSH) then run §P2 data-quality gates.
  5. **app** — copy the web template, apply `institution.config` (branding, tenant, feature flags incl. `accreditation:false`), wire env.
- **Idempotency rule:** every step checks current state first (project exists? table exists? rows present?) and is safe to re-run. Failures are loud and leave prior good state intact (mirrors the hub's rollback-on-gate-fail).
- **Secret handling:** generator reads secrets from the OS/secret store, never writes them to `institution.config.yaml` or the repo.

---

## 4A. Code-sharing & upstream-tracking (resolves "track, don't fork")

**The problem (per QA):** a literal lift-and-adapt *is* a fork. CCSJ's catalog-production agent is still under active development, so blind copy/paste guarantees silent divergence. We need a defined mechanism, not a vibe.

**Boundary — classify every ported module into one of two buckets:**
1. **Presentation / config (DIVERGENT — fork freely).** The Next.js UI, theme, brand, routing, copy. These *should* differ per spoke; the `institution.config` template is exactly how they diverge. No tracking needed.
2. **Shared engine (TRACKED — must not silently drift).** The catalog-production agent, FastAPI swarm endpoints, and catalog domain logic (`src/server/`, `/api/catalog/*` logic, delta/remediation). These evolve upstream in CCSJ and must stay in sync.

**Mechanism — vendor-with-lock now, extract-to-package later:**

- **Now (SJFU = instance #1):** vendor the shared-engine modules into `services/swarm/vendor/` with an **`UPSTREAM.lock`** manifest recording, per file: source repo (`ccsj-catalog`), path, and the **git commit SHA** it was copied from. Add `scripts/sync_upstream.py` that re-reads CCSJ at HEAD, diffs against the vendored snapshot, and **reports drift** (which upstream files changed since their recorded SHA) for human-reviewed re-vendoring. "Tracking" becomes a concrete, auditable command (`python scripts/sync_upstream.py --report`) instead of manual diffing.
- **Discipline (keeps re-sync clean):** SJFU-specific behavior on vendored modules goes through a thin **`services/swarm/overrides/`** adapter layer + config — **never by editing vendored files**. So the vendored snapshot stays a faithful mirror and a re-sync never clobbers local work. If a vendored file *must* change for SJFU, that's a signal to push the change upstream into CCSJ first, then re-vendor.
- **Later (factory end-state, harvested in P10):** once CCSJ's agent stabilizes, extract the shared engine into a **versioned internal Python package** (`cdi-spoke-engine`) installed from a pinned git ref / private index; CCSJ and SJFU both depend on it by version, and `create-spoke` pins the version per spoke. The vendor+lock is the *bridge* that avoids blocking SJFU on a CCSJ refactor today.

**Acceptance (added to P8):** `UPSTREAM.lock` exists and lists every vendored file with a SHA; `sync_upstream.py --report` runs and shows 0 drift at vendor time; no edits to vendored files (all SJFU deltas live in `overrides/`).

---

## 5. Build phases

### P0 — Bootstrap repo + tooling *(no external deps)*
- **Actions:** scaffold Next.js 16 / React 19 / Tailwind v4 (mirror CCSJ `tsconfig`/`eslint`/`next.config`); add `environment.yml` (conda `sjfu-catalog`: fastapi, uvicorn, pandas, pyarrow, psycopg2, openai, supabase, transformers/torch for Qwen3); port `DEVELOPER_GUIDELINES.md`; create `scripts/spoke/` skeleton; write `docs/HUB_SPOKE_CONTRACT.md` + `docs/DATA_CONTRACT.md` from verified schema/counts.
- **Gate:** `npm run dev` boots an empty shell; `conda env create` succeeds; `git grep` finds no secrets.
- **Rollback:** n/a (greenfield).

### P1 — Provision cloud Supabase + assemble schema *(Claude provisions; needs 0.4)*
- **Actions:** `create-spoke --phase provision` (create project, capture ref/url/keys→secret store, write non-secret ref/url back to config). Then `--phase schema` runs the §3 migration set.
- **Gate:** all §3-A/B tables exist; `embedding` column is `vector(1024)`; HNSW index present; `corrections` present with its CHECK constraint; **no `accreditor_*` columns, no 1536 column**; `\d semantic_chunks` shows expected shape. RLS: a no-auth `SELECT` returns 0 rows; an authed `SELECT` returns rows.
- **Rollback:** delete the Supabase project; re-run.

### P2 — Load SJFU data + data-quality gates *(needs hub SSH)*
- **Actions:** add SJFU to hub `deployment_config.yaml` (gitignored, on hub); `create-spoke --phase load` → runs `deploy_client_db.py --tenant-id SJFU`.
- **Gate (hard):** cloud counts match hub within tolerance and the **fixed link tables are non-zero**:
  `courses≈5923`, `programs≈1203`, `program_requirements≈932`, **`program_requirement_courses≈2402`**, **`course_prerequisite_links≈2939`**, `semantic_chunks≈34570`, `documents`=8 (grad+undergrad×4yr). Embeddings present and 1024-d (spot pgvector query returns sane neighbors). *This gate is the contract-boundary check that the silent-degradation class (IMPLEMENTATION_PLAN §3) cannot recur.*
- **Rollback:** truncate SJFU tables in cloud; re-run load.

### P3 — Qwen3 embedding FastAPI host *(Decision #3; needs 0.5)*
- **Actions:** stand up `services/embed/` FastAPI app on/near Spark: loads `Qwen3-Embedding-8B`, exposes `POST /embed` (see §7 contract), MRL-truncates to 1024, L2-normalizes. Expose to the cloud spoke via secure tunnel; store URL in secret store as `SJFU_EMBED_URL`.
- **Gate:** `POST /embed {"input":["nursing prerequisites"]}` → 1024-float vector; cosine vs a known SJFU chunk embedding is high for an on-topic query (proves shared vector space). Latency acceptable.
- **Rollback:** independent service; toggle assistant off (`features.assistant:false`) if unavailable.

### P4 — Lift + de-CCSJ-ify the web template
- **Actions:** copy `ccsj-catalog/src` (web layer); replace all hardcoded CCSJ branding/colors/strings with reads from `institution.config` via one theme module (`src/lib/brand.ts`); gate accreditation UI behind `accreditation` flag (off → ImprovementPlan in catalog-quality mode, no accreditor fields); port `db.ts`, `gcs.ts`, `catalogPdf.ts`, supabase client/server utils, login/update-password.
- **Gate:** `npm run build` clean; ESLint/TS clean; no literal "Calumet"/"CCSJ"/HLC strings remain (`git grep -i` clean except in docs).

### P5 — Data layer + auth + RLS isolation test
- **Actions:** point `db.ts` at SJFU `DATABASE_URL`; confirm `queryWithAuth` sets `request.jwt.claim.sub` + role; seed `user_roles`; **replace CCSJ's `llm.ts generateEmbedding()` (Gemini@1536) with a call to the Qwen3 host** (`SJFU_EMBED_URL`, 1024).
- **Gate (security):** automated test — unauth write rejected; authed viewer can read, cannot write; registrar can write; `corrections` insert allowed, client `UPDATE/DELETE` blocked; generic error bodies + correlation IDs; structured logs.

### P6 — Read surface (browse / inspect / graphs)
- **Actions:** port dashboard shell + catalog selector (reads `documents`; supports grad/undergrad domain filter); `DataInspector` (courses/programs/policies), `GraphViewer` (curriculum + policy), `AstExplorer`, `DiagnosticsDashboard`, department contacts.
- **Gate:** browse SJFU undergrad+grad end to end; prerequisite graph renders (non-empty — relies on P2's 2,939 links); program→required-courses renders (relies on 2,402 links); diagnostics counts match P2.

### P7 — Corrections + assistant
- **Actions:** build correction-flag UI to existing `corrections` table (never mutates masters; matches the hub round-trip model); port `CatalogAssistantChat` + `/api/assistant`, grounding retrieval on `semantic_chunks.embedding` via Qwen3 query embeddings (P3 host).
- **Gate:** a submitted flag lands only in `corrections` (masters provably unchanged by query); assistant returns answers grounded in SJFU chunks with sane citations; hub `pull_corrections.py` can read the pending row.

### P8 — FastAPI swarm + catalog-production agent
- **Actions:** stand up `services/swarm/` (FastAPI), port the production-agent lineage (`CatalogProductionWizard` + `/api/catalog/apply-deltas|publish|remediate` + `src/server/main.py`); wire to Spark vLLM for generation; track CCSJ's evolving version (don't fork).
- **Gate:** wizard drafts a next-year catalog from a prior year + deltas; apply-deltas writes a draft `documents` row without touching published rows; remediation runnable. *Note fidelity caveat:* requirement AND/OR/elective grouping is regex-quality until the hub routes ingestion through the standalone vLLM server (IMPLEMENTATION_PLAN §3 residual).

### P9 — Brand + deploy *(needs 0.6)*
- **Actions:** apply `institution.config.brand` tokens/logo; `create-spoke --phase app` finalizes; deploy to target; inject env from secret store (`DATABASE_URL`, anon/service keys, `SJFU_EMBED_URL`, `SJFU_SWARM_URL`, GCS creds).
- **Gate:** live URL loads, login works, a catalog renders, assistant responds, a correction round-trips. Smoke test green.

### P10 — Harvest the generator + docs
- **Actions:** finalize `scripts/spoke/create-spoke.mjs` + `institution.schema.json`; extract anything CCSJ/SJFU-specific into config; write `SPOKE_RUNBOOK.md` (provision→schema→load→app for spoke #2); record the §3 schema-assembly decisions as code (the migration filter list).
- **Gate:** a dry-run `create-spoke --config <fake-institution>.yaml --dry-run` plans a full spoke with no SJFU/CCSJ hardcoding; runbook lets a new operator reach a live spoke without reverse-engineering.

---

## 6. Verification matrix (what "checked for errors" means per layer)

| Layer | Automated gate | Where |
|---|---|---|
| Schema correctness | table presence, `vector(1024)`, no 1536/accreditor cols | P1 |
| Data completeness | the 7 count checks incl. both fixed link tables | P2 |
| Embedding alignment | cosine of on-topic query vs stored chunk is high | P3 |
| Branding cleanliness | `git grep -i 'calumet\|ccsj\|hlc'` clean (sans docs) | P4 |
| Security/RLS | unauth-write rejected, role matrix, corrections write-only | P5 |
| Feature correctness | graphs/links non-empty, correction isolation, grounded assistant | P6–P8 |
| Repeatability | dry-run generator with a fake institution | P10 |

---

## 7. Qwen3 embedding host — API contract (§P3)

```
POST /embed
  body:  { "input": ["text1", "text2", ...] }
  resp:  { "model": "Qwen/Qwen3-Embedding-8B", "dimension": 1024,
           "embeddings": [[...1024 floats...], ...] }
Rules: MRL-truncate to 1024 (must match stored), L2-normalize, batch up to N,
       auth via bearer token (secret), health at GET /healthz.
```
The spoke's `llm.ts`/assistant calls this for **every** query embedding. Stored vectors (hub, Qwen3-1024) and query vectors (this host, Qwen3-1024) MUST share model + dimension or pgvector cosine search is meaningless — this is the single most important runtime invariant.

---

## 8. Risks specific to execution

| Risk | Mitigation |
|---|---|
| Accidentally running the 1536 migration → destroys hub embeddings | §3 delta #1 is explicit; P1 gate asserts column is 1024 and fails if 1536 |
| Cloud spoke reaches embedding/swarm hosts (cloud → Spark) | secure tunnel (Tailscale/Cloudflare) decided at 0.5; assistant/agent degrade-gracefully if host down |
| RLS double-regime (hub `app.current_tenant` + web `auth.uid`) left permissive | §3 delta #3 drops hub tenant policies on the spoke; P5 isolation test is the proof |
| Production-agent output low-fidelity (regex requirement semantics) | known/deferred; fix = hub vLLM-server routing before agent GA |
| Generator hardcodes SJFU/CCSJ | P10 dry-run with a fake institution is the acceptance gate |
| Secrets leak into config/repo | §4 secret rule; `git grep` gate in P0/P4 |

---

## 9. What unblocks execution right now
1. **`institution.config.yaml` at repo root** with SJFU brand tokens + logo assets (Adam). *(gate 0.3)*
2. **Supabase provisioning credential/channel** for Claude. *(gate 0.4)*
3. **Embedding/swarm host location + cloud→Spark tunnel** decision. *(gate 0.5)*
4. **Deploy target** Vercel vs Cloud Run. *(gate 0.6)*

With those, P0 (repo bootstrap + contract docs) and P1 (provision + schema) can run immediately; P0 can in fact start now without any of them.
