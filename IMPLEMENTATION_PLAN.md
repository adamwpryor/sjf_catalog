# SJF Catalog — Implementation Plan (v4)

> **Status:** Draft for review. v4 is the first version written *after inspecting the live CDI Factory hub on the NVIDIA Spark box* (`spark-6284.local:~/projects/cdi-factory`). The earlier versions guessed at SJF's data shape; v4 replaces guesses with the actual hub→spoke contract.
>
> **Evolution:** v1 (Gemini) = process-heavy, assumed the data contract. v2 (Claude) = lean MVP, recommended dropping the heavy stack. v3 = re-scoped to Adam's locked choices (internal, full parity, dual-stack). **v4 = corrects the premises those were all built on, now that we've seen the hub.**

---

## 0. What changed after looking at the Spark hub

Three premises from earlier versions are now **falsified or sharpened by evidence**:

1. **❌ "SJF has a different (Schools/Programs/Courses XML) data shape."** False. SJF = **St. John Fisher University** (`tenant_id = "SJFU"`), and its graduate + undergraduate catalogs (2022–2026) were reingested *directly from PDF, exactly like CCSJ*, via the same vision pipeline into the same schema (`documents`, `semantic_chunks`, `courses`, `programs`, lookup tables). The legacy `sjf_test` WordPress-XML processor is irrelevant — superseded. **Consequence:** almost all the "adapt every component to a Schools hierarchy" work in v3 §4 evaporates. The schema is the same; the adaptation is tenant/branding/multi-catalog, not structural.

2. **🔁 The real deliverable is a *spoke factory*, not just an app.** Adam's framing: *"build a process that streamlines the development of a spoke, assuming this hub architecture is in place for ingestion of a catalog directly from PDF."* SJFU is **instance #1**. So we produce two things: **(I)** the running SJFU spoke, and **(II)** a parameterized template + runbook so spoke #2…#N is hours of config, not weeks of code. See §4.

3. **✅ The spoke keeps the heavier Python (Adam confirmed) — because the catalog-production agent lives in the spoke, not the hub.** The hub owns *ingestion* of existing PDFs and the corrections round-trip (`deploy_client_db.py`, `pull_corrections.py`). But a marquee in-scope feature is the **catalog-production agent** (currently *in development in CCSJ*) that **synthesizes a new year's catalog** from a prior year + deltas. That is an agentic, LLM-driven authoring workload that belongs in the spoke's FastAPI layer (it's the `CatalogProductionWizard` + `/api/catalog/apply-deltas|publish|remediate` + `src/server/main.py` lineage). So we **port CCSJ's full dual-stack swarm**, not a thin embedding service. (This reverses the C′ idea floated in v3; see Decision C.) Note: the spoke also still needs Qwen3-1024 query embedding for the RAG assistant (§3 gotcha #1) — that's now one job among several for the spoke's Python.

"Lift-and-adapt" (Decision F) is confirmed and is exactly right given how much of the contract already exists. **One caveat on the production agent: it is a moving target in CCSJ** — we're porting something still being built, so the SJF copy must track CCSJ's version rather than fork it.

---

## 1. Corrected mental model

```
   ┌──────────────────────── NVIDIA Spark (the HUB) ─────────────────────────┐
   │  ~/projects/cdi-factory                                                   │
   │  • Ingest PDF → vLLM vision (Gemma) → semantic_chunks + relational tables │
   │  • Embed with Qwen3-Embedding-8B (1024-dim, MRL-truncated)                │
   │  • Export Data Pond:  data/dist/<catalog>/  (Parquet + manifest + ontology)│
   │  • supabase/migrations/   ← CANONICAL spoke schema (~18 tables)           │
   │  • scripts/deploy_client_db.py   push pond  → cloud Supabase (per tenant) │
   │  • scripts/pull_corrections.py   pull flags ← cloud, AI-draft fixes, re-push│
   │  • deployment_config.yaml  tenant → cloud DB URL   (SJFU = NOT yet added) │
   └───────────────────────────────────┬──────────────────────────────────────┘
                                        │ pond push / corrections pull (Python, on hub)
                                        ▼
   ┌──────────────────── Cloud Supabase (per-tenant SPOKE DB) ────────────────┐
   │  Postgres + pgvector(1024) + HNSW + RLS (app.current_tenant GUC)          │
   └───────────────────────────────────▲──────────────────────────────────────┘
                                        │ pg / supabase-js
   ┌──────────────────── sjf_catalog (the SPOKE — what we build) ─────────────┐
   │  Next.js 16 / React 19 (lift-and-adapt CCSJ), parameterized by spoke config│
   │  Reads catalog data; writes flags to `corrections`; RAG assistant (Qwen3) │
   └───────────────────────────────────────────────────────────────────────────┘
```

**The spoke we build is mostly a web app + a thin config layer.** The heavy machinery already exists upstream.

---

## 2. Decisions

| # | Decision | Status |
|---|----------|--------|
| A | Internal tool, gated login (CCSJ posture) | ✅ Locked |
| B | Full CCSJ **feature** parity | ✅ Locked (but cheaper than thought — schema is identical) |
| C | **Dual-stack, full Python swarm** (FastAPI + agents) — incl. the catalog-production agent | ✅ Locked (Adam confirmed; C′ rejected) |
| D | Brand tokens, logo, typography for SJFU | 🔵 Incoming — Adam supplies `institution.config.yaml` at repo root (required artifact for all institutions) |
| E | Deploy target (Vercel vs Cloud Run) | ⬜ Needed (gates P9 deploy) |
| F | Build method = lift-and-adapt | ✅ Locked |
| G | Spoke factory shape | ✅ Locked — **G2 scripted generator** (`scripts/spoke/create-spoke`), harvested while building SJFU |
| H | Who provisions | ✅ Locked — **Claude provisions** the SJFU cloud Supabase |
| I | Assistant query embedding | ✅ Locked — **separate FastAPI Qwen3 host** (1024-d), per `BUILD_PLAN.md §7` |

> **Execution detail now lives in `BUILD_PLAN.md`** — the step-by-step runbook (phases P0–P10, per-phase acceptance gates, the schema-assembly include/omit list, the institution-config contract, and the embedding-host API). This section remains the decision/strategy record.

---

## 3. The hub→spoke contract (the spec we build against) — and its gotchas

**Canonical schema** (`supabase/migrations/`, ~18 tables, topological order from `deploy_client_db.py`):
`institutions`, lookup tables (`chunk_types`, `toulmin_roles`, `deontic_modalities`, `quinean_web_classifications`, `degree_classifications`), `subjects`, `documents`, `semantic_chunks`, `courses`, `programs`, `program_requirements`, `program_requirement_courses`, `course_prerequisite_links`, `faculty`, `program_faculty`, `policy_mentions_courses`, `policy_mentions_programs`. Plus `corrections` (cloud-only, *not* replicated).

**Corrections model (already designed — we just build the UI for it):** client UI inserts a row into `corrections` (`target_table ∈ {courses, programs, semantic_chunks}`, `target_row_id`, `field_name`, `current_value`, `proposed_value`, `reason`, `status='pending'`). RLS lets clients `INSERT`/`SELECT` but **blocks `UPDATE`/`DELETE`** (service-role only). `pull_corrections.py` reads pending → AI drafts `UPDATE` → operator approves on hub → `deploy_client_db.py` re-pushes. This *is* the surgical-delta model; masters are never mutated client-side by design.

### ✅ Verified against the live hub Postgres (was Phase-0 risk, now confirmed):

- **Canonical `tenant_id` = `SJFU`.** It is the only tenant present in `semantic_chunks`; every `SJF` query returns 0. The `SJF`/`institution_id` strings in some pond manifests are stale. RLS keys on `SJFU`.
- **SJFU data is fully loaded in the hub Postgres** (this is what `deploy_client_db.py` replicates — it reads the hub DB, *not* the Parquet ponds; ponds are cold backup): `semantic_chunks` 34,570 · `courses` 5,923 · `programs` 4,501 · `program_requirements` 817 · `faculty` 104 · `program_faculty` 147 · `policy_mentions_courses` 26,379 · `policy_mentions_programs` 42,388 · `subjects` 77. So the old "pond format differs / not deployable" worry is moot.

### 🚧 Live gotchas / risks remaining for Phase 0:

1. **Embeddings are Qwen3-Embedding-8B at `vector(1024)` with an HNSW cosine index.** The runtime RAG assistant **must embed user queries with the same Qwen3 model** or similarity is garbage. OpenAI/Vertex embeddings are incompatible. Options: call the hub's vLLM embedding endpoint, stand up a small Qwen3 embedder for the spoke, or use a hosted Qwen3 endpoint.

2. **RLS mechanism mismatch — RESOLVED in favor of the single-tenant auth model.** The hub schema isolates tenants via `current_setting('app.current_tenant', true)` (multi-tenant hub Postgres). CCSJ's web `db.ts`/`queryWithAuth` instead use `request.jwt.claim.sub` (`auth.uid()`) + `SET LOCAL ROLE authenticated` + a `user_roles` table. Because **each spoke gets its own dedicated single-tenant cloud DB**, we **drop the hub's `app.current_tenant` policies on the spoke** and apply the CCSJ-web `auth.uid()`+`user_roles` policies — which `db.ts` already speaks, unchanged. (The QA's earlier framing of "replace jwt.claim with `app.current_tenant`" is reversed by this.) Proven by `BUILD_PLAN` P5's isolation test. See `BUILD_PLAN` §3 delta #3.

3. **✅ RESOLVED by the hub — `program_requirement_courses` 0 → 2,402.** (Hub commit `5d896b4`, live-verified.) The join is now populated.

   **Reconciliation of root cause:** My diagnosis (vLLM text-model CUDA OOM → circuit-breaker → no ASTs → raw-markdown `logic_tree` → linker finds no codes) was **real but secondary**. The hub agent found the **primary** cause: course-bearing requirement chunks (under `… > Requirements > Electives` headers) were routed into `programs.additional_details`, which `link_program_requirements` never reads — so links would be ~0 *even with a healthy text model*. The hub fix consolidates those subtree chunks into `logic_tree` and is **provider-independent** (verified 0→2,402 with `provider=None`), and a `_looks_like_noise` filter cut over-extracted programs 4,501 → 1,203. The fail-loud hardening from my draft was adopted (orchestrator skips the pond publish on population failure; data-quality gate rolls back if codes-present-but-0-links).

   **Residual (not blocking, track for full quality):** the **OOM root cause is logged, not fixed** — native runs still skip LLM AST grouping + degree-type/credits backups, so requirement *semantics* (AND/OR, required vs elective) are regex-quality. Route ingestion through the standalone vLLM server (my Option A in `docs/HUB_HARDENING_AND_REPROCESS.md`) before the **catalog-production agent** relies on high-fidelity requirement structure.

4. **✅ RESOLVED by the hub — `course_prerequisite_links` 46 → 2,939** (commit `70801e7`, live-verified; 1,753 distinct courses now carry a prereq). Same class as gotcha #3: SJFU rarely writes inline "Prerequisite:" prose, so the structured `prerequisites_json` (present but never persisted) is now mapped order-independently by `(document_id, course_code)`. Course Graph is no longer hollow.

   **Residual on requirement *semantics* (deferred, not blocking):** the OOM root cause is still unaddressed — config remains `provider: vllm` (native, in-process), and all 932 `logic_tree` rows are still raw text (0 JSON ASTs). The links exist via the regex path, but LLM-quality AND/OR/elective grouping is not built. Only matters for **catalog-production-agent fidelity**, not for browse/inspect/graph. Fix when the agent ships: run via the standalone vLLM server (Option A), which the config already points at (`base_url: http://127.0.0.1:8000/v1`).

5. **SJFU cloud spoke is not provisioned.** `deployment_config.yaml` has SJFU commented out ("Pending provisioning"). No cloud Supabase project exists yet, and migrations haven't been run against it.

---

## 4. The two deliverables

### Deliverable I — the SJFU spoke web app (lift-and-adapt CCSJ)
Full CCSJ feature parity. Because the schema is identical, "adaptation" is mostly mechanical: swap `tenant_id`, branding, and handle SJFU's **two domains (graduate + undergraduate) × multiple years** in the existing catalog/version selector (CCSJ already supports `version` + `domain_id`; SJFU encodes grad/undergrad in `domain_id`/`version`). Feature map in §5.

### Deliverable II — the spoke factory (template + runbook)
- **De-CCSJ-ify the lifted app** into a template: pull every hardcoded "Calumet/CCSJ", color, and tenant string into one **`spoke.config.ts/yaml`** (institution name, `tenant_id`, Supabase URL/key, brand tokens, feature flags, embedding endpoint).
- **`SPOKE_RUNBOOK.md`** documenting the end-to-end: provision Supabase → run hub `supabase/migrations/` → add tenant to `deployment_config.yaml` → run `deploy_client_db.py --tenant-id <T>` → set spoke env → deploy. (Decision G decides whether this becomes a script.)
- **Contract doc** `docs/HUB_SPOKE_CONTRACT.md` capturing §3 so future spokes don't rediscover the gotchas.

---

## 5. Feature parity map (now schema-aligned — much lighter than v3)

| CCSJ feature | SJFU disposition | Real work |
|---|---|---|
| Dashboard shell, sidebar, tab router | **Port** | Replace branding via `spoke.config`; catalog selector already multi-version |
| `DataInspector` (courses/programs/policies) | **Port ~as-is** | Same tables; add grad/undergrad (`domain_id`) filter |
| `GraphViewer` (prereq + policy graphs) | **Port ~as-is** | Same `course_prerequisite_links` / `policy_mentions_*` tables |
| `AstExplorer`, `DiagnosticsDashboard` | **Port ~as-is** | Re-point to SJFU; metrics gain a domain dimension |
| `CatalogAssistantChat` + assistant API | **Port + rewire embeddings** | **Qwen3 query embedding** (gotcha #1) — the one substantive change |
| `DiffLog`, `TrackingDashboard`, `ImprovementPlan` | **Port** | Confirm draft/publish concept maps to SJFU catalogs |
| **Catalog-production agent** (`CatalogProductionWizard` + `/api/catalog/apply-deltas\|publish\|remediate` + FastAPI) | **Port — flagship feature** | Synthesizes a new year's catalog from prior year + deltas. *In active development in CCSJ — track, don't fork.* Requirement links now populated (gotcha #3 ✅); high-fidelity AND/OR/elective semantics depend on the Option-A vLLM-server fix |
| Corrections flow | **Port — build UI to existing table** | Insert into `corrections` per §3; never mutate masters |
| Intake/GCS, `CatalogPdfView` | **Port** | SJFU `gcs_bucket: sjfu-assets` already exists; re-point creds |
| FastAPI swarm + agents | **Port in full** | Hosts the production agent, remediation, and Qwen3 query embedding for the assistant (Decision C) |
| Auth (`user_roles`, login, RLS) | **Port + reconcile RLS GUC** | Use `app.current_tenant` (gotcha #2) |
| ~~Accreditation / HLC compliance layer~~ | **🚫 OUT OF SCOPE** | See §5.1 |

**Heavy deps:** kept (force-graph, three, recharts, pdf-lib, mammoth, @xyflow) since the features that use them ship.

### 5.1 Out of scope for SJFU — no accreditation / HLC work (Adam, ✅ LOCKED)
SJFU's hub instantiation does **not** subscribe to the accreditor/compliance layer. Drop, for SJFU:
- The **GLOBAL compliance-package subscription** (HLC Policy Book, appeals/arbitration/hearing procedures) — these are CCSJ/HLC artifacts routed to *subscribed* institutions; SJFU is not one (it's MSCHE-accredited, and per Adam needs none of it regardless).
- The **`accreditation_criteria` / `accreditors` tables — OMITTED FROM THE SJFU SCHEMA ENTIRELY** (Adam confirmed: not migrated-but-empty — simply not created). Skip their migrations and any accreditation-standard mapping UI. **Factory-template implication:** the SJFU spoke schema is a *subset* of CCSJ's, so the spoke template needs a per-tenant feature/migration toggle (e.g. `accreditation: false` in `spoke.config`) rather than one fixed schema.
- Any **accreditation-criteria framing** of the `ImprovementPlan` / remediation cron — if those features map catalog content to accreditor standards, they're out or must be refocused on catalog-internal quality only.

**Keep (do not confuse with the above):** institutional policies that live *in the SJFU catalog PDF itself* (academic standing, admissions, etc.) — these are catalog-derived `semantic_chunks` + `policy_mentions_*`, not accreditation. The **Policy Library / Policy Graph stay** as catalog-navigation features; they just aren't framed as compliance. *Net effect:* fewer tables to provision, no GLOBAL package sync, a simpler nav — a real simplification to the "full parity" scope.

---

## 6. Phased plan (lift-and-adapt; effort + exit criteria)

### Phase 0 — Contract verification & provisioning *(hard gate; ~1 day)*
- Resolve all five §3 gotchas. Specifically: confirm canonical `tenant_id`; confirm SJFU pond is deployable (or trigger re-export on hub); stand up the SJFU cloud Supabase; run `supabase/migrations/`; add SJFU to `deployment_config.yaml`; run `deploy_client_db.py --tenant-id SJFU`; verify row counts per table; decide the Qwen3 query-embedding path.
- Write `docs/HUB_SPOKE_CONTRACT.md` + `docs/DATA_CONTRACT.md`.
- **Exit:** SJFU data is live in a cloud Supabase, per-table counts verified, embedding path chosen. *No app code before this.*

### Phase 1 — Lift the template + reskin scaffolding *(~1 day)*
- Copy CCSJ web app; strip CCSJ-isms into `spoke.config`; wire `src/lib/db.ts` to set `app.current_tenant` (gotcha #2); port `DEVELOPER_GUIDELINES.md` + structured logging; `git grep` secret-clean.
- **Exit:** app boots against SJFU env; one query returns real SJFU rows under RLS.

### Phase 2 — Read surface *(~1–2 days)*
- Port dashboard, `DataInspector`, `GraphViewer`, `AstExplorer`, `DiagnosticsDashboard`; add grad/undergrad domain filtering.
- **Exit:** browse SJFU graduate + undergraduate catalogs end to end; graphs/diagnostics render real data.

### Phase 3 — Corrections + assistant *(~1–2 days)*
- Build the correction-flag UI to the existing `corrections` table (RLS-correct, masters untouched).
- Port `CatalogAssistantChat`; wire Qwen3 query embedding (thin Python service or hub endpoint).
- **Exit:** a flag lands in `corrections`; assistant answers from SJFU chunks with matching vectors.

### Phase 4 — Remaining parity (wizard, intake, PDF, improvement) *(~1–2 days)*
- Port the rest; re-point GCS (`sjfu-assets`) and PDF templating.
- **Exit:** all §5 features functional against SJFU.

### Phase 5 — Brand + deploy *(~1 day; needs D + E)*
- Apply SJFU tokens via `spoke.config`; deploy (Vercel/Cloud Run); env via secret store.
- **Exit:** live URL, login works, smoke-tested.

### Phase 6 — Harvest the factory *(~½–1 day)*
- Finalize `SPOKE_RUNBOOK.md`; extract anything reusable into the template; (Decision G2) draft `create-spoke` script.
- **Exit:** a written, repeatable path to spoke #2.

**Honest total: ~6–9 working days**, gated on Phase 0. Lighter than v3 because the schema is identical and the data plane already exists.

---

## 7. Verification / Definition of Done
- **Contract:** `HUB_SPOKE_CONTRACT.md` + `DATA_CONTRACT.md` written; SJFU rows live with verified counts; embedding path proven (a query returns sane nearest-neighbors).
- **Security:** RLS via `app.current_tenant` proven (cross-tenant `SELECT` → 0 rows); `corrections` client-write/no-client-update enforced; `git grep` secret-clean; generic client errors + correlation IDs; structured logging.
- **Function:** browse grad + undergrad; submit a correction that lands only in `corrections` (masters provably unchanged); assistant grounded on SJFU.
- **Factory:** `SPOKE_RUNBOOK.md` lets someone stand up a second spoke without reverse-engineering.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Qwen3 1024-dim embedding mismatch breaks assistant | Standardize spoke on Qwen3-1024 end-to-end via the dedicated embedding host; `BUILD_PLAN` P3 cosine gate proves shared vector space |
| Single-tenant RLS reconciliation (drop hub `app.current_tenant`, keep `auth.uid()`+`user_roles`) done wrong → silent empty results *or* over-permissive | `BUILD_PLAN` §3 delta #3 + **P5 automated isolation test** (unauth write rejected, role matrix, cross-tenant 0 rows) as a hard gate |
| Production-agent fidelity limited by regex-quality requirement semantics (OOM root fix only logged, not fixed) | Route hub ingestion through the standalone vLLM server (Option A) before the agent ships |
| "Track, don't fork" drift on the shared engine | **Vendor-with-lock** mechanism (`BUILD_PLAN` §4A): `UPSTREAM.lock` + `sync_upstream.py --report`; SJFU deltas only via `overrides/`; extract to a versioned package later |
| Accreditation/HLC scope creeps back via ported CCSJ components | §5.1 exclusion enforced by an **explicit migration allow-list** (`BUILD_PLAN` §3), not blind directory execution |
| Backend (FastAPI swarm + Qwen3 host) infra forgotten — only frontend deployed | `BUILD_PLAN` §1 topology + P3/P8 provision both Python hosts near Spark with a cloud→Spark tunnel; P9 injects their URLs |

---

## 9. Status of decisions & remaining asks

**Resolved (hub inspection + Adam's calls — no longer open):** canonical `tenant_id = SJFU`; data loaded & deployable (ponds aren't the deploy source); **`program_requirement_courses` 0→2,402 and `course_prerequisite_links` 46→2,939 fixed by the hub** (gotchas #3/#4 ✅); full Python swarm (C); lift-and-adapt (F); **G2 scripted generator** (G); **Claude provisions** (H); **separate FastAPI Qwen3 embedding host** (I); accreditation omitted from the SJFU schema (§5.1); "track, don't fork" → vendor-with-lock (`BUILD_PLAN` §4A).

**Still genuinely open (these gate execution — see `BUILD_PLAN` §0/§9):**
1. **Brand artifact** — Adam supplies `institution.config.yaml` + logo assets at repo root (Decision D). *(BUILD_PLAN gate 0.3)*
2. **Supabase provisioning credential/channel** for Claude. *(gate 0.4)*
3. **Embedding/swarm host location + cloud→Spark tunnel** (Tailscale/Cloudflare). *(gate 0.5)*
4. **Deploy target** for the frontend — Vercel vs Cloud Run (Decision E); backend hosts per §1. *(gate 0.6)*

---
*Execution sequence now lives in `BUILD_PLAN.md` (phases P0–P10 with acceptance gates). P0 (repo bootstrap + `HUB_SPOKE_CONTRACT.md`/`DATA_CONTRACT.md`) needs none of the above and can start immediately.*
