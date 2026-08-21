# AI Assistants & Machine Intelligence Guide

This document defines every AI/LLM-powered feature, model pathway, cost model, and deterministic subsystem shipping in the St. John Fisher University (SJFU) Catalog System. It serves two distinct audiences:
1. **Administrators & Operators:** Deciding which features to enable, understanding operational cost shapes, and assessing database safety before running a task.
2. **Developers & Maintainers:** Understanding backend routing, model provider fallbacks, authentication architecture, and known architectural traps.

---

## 1. Quick Reference Matrix for Operators

The application is a single-page dashboard ([src/app/page.tsx](src/app/page.tsx)) using client-side tabs. Cite the sidebar section and tab label when directing operators.

| Feature Name | Sidebar Tab ID & Label | Implementation Route / Module | Model & Provider Path | DB Write? | Cost Shape |
| --- | --- | --- | --- | --- | --- |
| **Extract Minutes** | `tracking`<br>("New Catalog Builder") | [src/app/api/extract-intake/route.ts](src/app/api/extract-intake/route.ts)<br>→ `/api/agent/extract-minutes` | `gemini-2.5-pro`<br>(Vertex AI keyless, `us-east5`) | **YES**<br>(Pending queue) | Per-call<br>(1 call / doc) |
| **Apply Deltas** | `produce`<br>("Catalog Production") | [src/app/api/catalog/apply-deltas/route.ts](src/app/api/catalog/apply-deltas/route.ts)<br>→ `/api/agent/resolve-delta` | `gemini-2.5-pro`<br>(Vertex AI keyless, `us-east5`) | **YES**<br>(Draft tables) | Per-call<br>(1 call / delta) |
| **Re-Sync Chunks** | `produce`<br>("Catalog Production") | [src/app/api/catalog/resync-chunks/route.ts](src/app/api/catalog/resync-chunks/route.ts)<br>→ `/api/agent/rewrite-chunk` | `gemini-2.5-pro`<br>(Vertex AI keyless, `us-east5`) | **YES**<br>(Narrative text) | Per-call<br>(1 call / chunk) |
| **In-PDF Correction** | `catalog_pdf`<br>("Catalog PDF") | [src/app/api/catalog/assistant/route.ts](src/app/api/catalog/assistant/route.ts)<br>→ `/api/agent/catalog-correction` | `gemini-2.5-pro`<br>(Vertex AI keyless, `us-east5`) | **YES**<br>(Overrides & draft) | Per-call<br>(Capped daily) |
| **Manual Entry Assistant** | `tracking`<br>("New Catalog Builder") | [src/app/api/swarm/manual-entry-assistant/route.ts](src/app/api/swarm/manual-entry-assistant/route.ts)<br>→ `/api/agent/manual-entry-assistant` | `gemini-2.5-pro`<br>(Vertex AI keyless, `us-east5`) | **YES**<br>(On user submit) | Per-turn<br>(Conversational) |
| **AI Catalog Assistant** | `assistant`<br>("AI Catalog Assistant") | [src/app/api/assistant/route.ts](src/app/api/assistant/route.ts) | `gemini-embedding-001` (`us-central1`) + UI Model Choice (default: `gemini-2.5-flash`) | **NO**<br>(Read-only) | Per-turn<br>(2 calls in RAG mode) |
| **Diff Log Review** | `diff_log`<br>("Diff Log") | [src/app/api/diff-summary/route.ts](src/app/api/diff-summary/route.ts)<br>via `callLLM` | `gemini-2.5-pro`<br>(Vertex AI keyless provider cascade) | **NO**<br>(Read-only) | Per-call<br>(1 call / click) |

> [!IMPORTANT]
> **Database Safety:** Exactly **five** AI/LLM-powered features write to the database (Extract Minutes, Apply Deltas, Re-Sync Chunks, In-PDF Correction, and Manual Entry Assistant upon user confirmation). The AI Catalog Assistant and Diff Log Review are strictly read-only.

---

## 2. Detailed AI Feature Specifications

### 1. Extract Curriculum Changes from Minutes
* **Trigger Location:** Sidebar tab `tracking` ("New Catalog Builder" under Catalog Tools) — the `TrackingDashboard` component, which is the only caller of `/api/extract-intake`. Note that the separate `filing_cabinet` tab ("Intake Filing Cabinet") renders `IntakeFilingSystem`, which manages uploaded files via `/api/intake-files` and performs no extraction.
* **Implementation:** Next.js handler [src/app/api/extract-intake/route.ts](src/app/api/extract-intake/route.ts) downloads the document from Google Cloud Storage (`intake/` bucket path) and POSTs to the Python Swarm microservice route `/api/agent/extract-minutes` ([services/swarm/main.py](services/swarm/main.py)).
* **Model & Provider Path:** `gemini-2.5-pro` executing keyless on Vertex AI via Google Cloud Application Default Credentials (ADC) or Workload Identity Federation (WIF) in GCP region `us-east5`.
* **System Prompt & Function:** Extracts every approved curricular change (motions that passed, ignoring general discussion or tablements) from uploaded DOCX committee minutes into structured delta proposals (`EXTRACT_SYSTEM_PROMPT`).
* **Database Impact:** **YES.** Writes extracted delta proposals directly into the `corrections` queue table in Supabase with `status = 'pending'`.
* **Cost Shape:** Per-call (one long-context generation call per uploaded minutes document).

### 2. Apply Delta Corrections (Structured Resolution)
* **Trigger Location:** Sidebar tab `produce` ("Catalog Production" under Catalog Tools), Step 2: "Apply Approved Deltas".
* **Implementation:** Next.js orchestrator [src/app/api/catalog/apply-deltas/route.ts](src/app/api/catalog/apply-deltas/route.ts) calls Python Swarm microservice route `/api/agent/resolve-delta` ([services/swarm/main.py](services/swarm/main.py)).
* **Model & Provider Path:** `gemini-2.5-pro` executing keyless on Vertex AI via ADC/WIF in region `us-east5`.
* **System Prompt & Function:** Maps an approved plain-English curriculum correction instruction onto concrete, code-keyed edits (`course_updates`, `course_inserts`, `program_updates`, `prereq_edge_changes`) for a draft catalog (`RESOLVE_SYSTEM_PROMPT`).
* **Database Impact:** **YES.** The Next.js orchestrator resolves course codes and program names to draft catalog UUIDs and executes database writes across `courses`, `programs`, and `course_prerequisite_links`.
* **Cost Shape:** Per-call (one generation call per approved correction item being resolved).

### 3. Narrative Chunk Re-Sync
* **Trigger Location:** Sidebar tab `produce` ("Catalog Production" under Catalog Tools), Step 2: "Re-sync Narrative Chunks".
* **Implementation:** Next.js handler [src/app/api/catalog/resync-chunks/route.ts](src/app/api/catalog/resync-chunks/route.ts) calls Python Swarm microservice route `/api/agent/rewrite-chunk` ([services/swarm/main.py](services/swarm/main.py)).
* **Model & Provider Path:** `gemini-2.5-pro` executing keyless on Vertex AI via ADC/WIF in region `us-east5`.
* **System Prompt & Function:** Rewrites an individual catalog narrative text chunk to reflect an approved curriculum correction only if the chunk genuinely describes the affected course or program (`REWRITE_CHUNK_SYSTEM_PROMPT`).
* **Database Impact:** **YES.** Updates the `content` column of target `semantic_chunks` rows and writes a freshly generated `embedding` in the same transaction, and inserts new description chunks for added courses.
* **Cost Shape:** **Two calls per changed chunk** — one generation call to rewrite the text, plus one `gemini-embedding-001` @ 1536 embedding call to re-vectorize it. Budget accordingly; this is the second-largest per-run cost after ingestion.

### 4. In-PDF Catalog Correction Assistant ("Fix It Here")
* **Trigger Location:** Sidebar tab `catalog_pdf` ("Catalog PDF" under Catalog Tools) or the PDF view in `produce` ("Catalog Production") via the chat drawer alongside the rendered catalog PDF.
* **Implementation:** Next.js route [src/app/api/catalog/assistant/route.ts](src/app/api/catalog/assistant/route.ts) calling Python Swarm microservice route `/api/agent/catalog-correction` ([services/swarm/main.py](services/swarm/main.py)) for classification and `/api/agent/rewrite-chunk` for execution.
* **Model & Provider Path:** `gemini-2.5-pro` executing keyless on Vertex AI via ADC/WIF in region `us-east5`. Supports multimodal vision grounding when a rendered PDF page base64 or source document is attached.
* **System Prompt & Function:** Classifies a registrar's in-PDF plain-English correction request into rendering presentation overrides or data changes and emits a structured change plan (`CORRECTION_SYSTEM_PROMPT`).
* **Database Impact:** **YES.** When applied (`mode = 'apply'`), writes presentation overrides to `documents.presentation_overrides`, course field edits to `courses`, and rewrites/deletes narrative rows in `semantic_chunks`.
* **Cost Shape:** Per-call (classification call with optional vision PDF page attachment + chunk rewrite calls). Rate-limited by `CORRECTION_DAILY_LIMIT` (defaults to 150 calls/user/day).

### 5. Manual Entry Assistant
* **Trigger Location:** Sidebar tab `tracking` ("New Catalog Builder" under Catalog Tools) inside the `TrackingDashboard` component modal dialog ("Manual Entry Assistant").
* **Implementation:** Next.js route [src/app/api/swarm/manual-entry-assistant/route.ts](src/app/api/swarm/manual-entry-assistant/route.ts) proxying to Python Swarm microservice route `/api/agent/manual-entry-assistant` ([services/swarm/main.py](services/swarm/main.py)).
* **Model & Provider Path:** `gemini-2.5-pro` executing keyless on Vertex AI via ADC/WIF in region `us-east5`.
* **System Prompt & Function:** Acts as a conversational assistant asking clarifying questions about cascading catalog updates until the user confirms the change, then outputs a structured JSON correction block (`MANUAL_ENTRY_SYSTEM_PROMPT`).
* **Database Impact:** **YES.** While the chat route itself is read-only, accepting the finalized correction block POSTs the payload to `/api/corrections`, creating a pending record in the `corrections` queue table.
* **Cost Shape:** Per-turn (one generation call per conversational turn in the modal dialog).

### 6. AI Catalog Assistant (Strict RAG & General Chat)
* **Trigger Location:** Sidebar tab `assistant` ("AI Catalog Assistant" under Overview).
* **Implementation:** Next.js route [src/app/api/assistant/route.ts](src/app/api/assistant/route.ts).
* **Model & Provider Path:**
  * **Vector Query Embeddings:** `gemini-embedding-001` @ 1536 dimensions executing keyless on Vertex AI in GCP region `us-central1` (or Google AI Studio via `GEMINI_API_KEY`).
  * **Response Generation:** Model selected in UI dropdown ([src/components/CatalogAssistantChat.tsx](src/components/CatalogAssistantChat.tsx)). Defaults out of the box to `gemini-2.5-flash` (Vertex AI keyless). Anthropic (`claude-sonnet-5`, `claude-opus-5`) and OpenAI (`gpt-4o`) options require provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
* **System Prompt & Function:** Answers natural language queries regarding courses, requirements, and policy facts by performing vector similarity search over catalog chunks or generating read-only SQL queries.
* **Database Impact:** **NO.** Read-only queries against `semantic_chunks`, `courses`, `programs`, and link tables.
* **Cost Shape:** Per-turn (2 calls per question in Strict RAG mode: 1 vector embedding call + 1 generation call).

### 7. Diff Log Editorial Review ("AI Summary")
* **Trigger Location:** Sidebar tab `diff_log` ("Diff Log" under Catalog Tools) via the "AI Summary" button on inspected version diffs.
* **Implementation:** Next.js route [src/app/api/diff-summary/route.ts](src/app/api/diff-summary/route.ts) calling `callLLM` in [src/lib/llm.ts](src/lib/llm.ts).
* **Model & Provider Path:** Single-shot provider cascade in `callLLM`: (1) Anthropic `claude-opus-5` if `ANTHROPIC_API_KEY` set; (2) Vertex AI `gemini-2.5-pro` keyless (`us-central1`); (3) Gemini API key `gemini-2.5-flash`; (4) OpenAI `gpt-4o`. In a stock deployment with no external API keys, resolves to `gemini-2.5-pro` on Vertex AI.
* **System Prompt & Function:** Generates a plain-English 3-part editorial review (Summary, What changed, Worth a closer look) for non-technical catalog editors comparing two versions (`EDITORIAL_SYSTEM_PROMPT`).
* **Database Impact:** **NO.** Read-only text generation.
* **Cost Shape:** Per-call (1 generation call per diff review request).

---

## 3. Critical Architectural Traps & Realities

### Trap 1: The Swarm Model Constant is Historical
In `services/swarm/main.py`, line 26 defines `LLM_MODEL = os.environ.get("EXTRACT_MINUTES_MODEL", "claude-opus-4-8")`, and swarm agents pass `model=LLM_MODEL` to the client. **That value is never used.** The `_anthropic_client()` function returns `override_anthropic_client()` from `services/swarm/overrides/vertex.py`, which discards the model argument entirely and uses `DEFAULT_VERTEX_MODEL` (`gemini-2.5-pro`).
* **Reality:** All five Python Swarm agents run `gemini-2.5-pro` keyless on Vertex AI in region `us-east5`. No Claude models or Anthropic API keys are used by the Python service.

### Trap 2: Codebase Evolution & Removed Endpoints
Planning documents (such as early revisions of `docs/history/PHASE7_OWNERSHIP_TRANSFER.md`) described twelve AI endpoints. Three placeholder stub endpoints (`delta-processor`, `curriculum-auditor`, `diagnostics-analyst`) were **removed** during security hardening (Task C2). Furthermore, `/api/agent/manual-entry-assistant` is no longer called directly from the browser; it is proxied securely server-side via `src/app/api/swarm/manual-entry-assistant/route.ts`.
* **Reality:** Exactly seven `@app` routes remain in `services/swarm/main.py`: `/health` (GET), `/api/agent/extract-minutes` (POST), `/api/agent/rewrite-chunk` (POST), `/api/agent/resolve-delta` (POST), `/api/agent/render-pdf` (POST - non-AI WeasyPrint), `/api/agent/manual-entry-assistant` (POST), and `/api/agent/catalog-correction` (POST).

### Trap 3: Two Vertex AI Regions, and They Are Interchangeable

`src/lib/llm.ts` defaults to `us-central1`; `services/swarm/overrides/vertex.py` defaults to `us-east5`.

* **Reality (probed `2026-08-13`):** both regions serve `gemini-embedding-001` at 1536 dimensions, and embedding the same text in each returns **identical** vectors — cosine similarity `1.0000000000`, zero per-component difference. Region is a serving location, not a model variant, so query vectors and stored vectors may be produced in different regions with no effect on retrieval quality.
* **What actually matters:** the two sides read *different environment variables* — `GCP_LOCATION` for the TypeScript app, `GOOGLE_CLOUD_LOCATION` for the Python services — and neither consults the other. If you consolidate on one region, set both. The split is historical rather than load-bearing.

### Trap 4: Model Cascades and UI Model Selector Requirements
* `callLLM` ([src/lib/llm.ts](src/lib/llm.ts)) checks provider credentials in fixed order: Anthropic -> Vertex AI -> Gemini Key -> OpenAI. In a stock deployment without third-party API keys, it resolves to `gemini-2.5-pro` on Vertex AI.
* The assistant's model picker ([src/components/CatalogAssistantChat.tsx](src/components/CatalogAssistantChat.tsx)) lists 11 models. Gemini models (`gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3.6-flash`, etc.) work out of the box keyless via Vertex AI. Options labeled `(needs API key)` (Claude and GPT models) fail unless `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` are provisioned in `.env.local`.

### Trap 5: Two Model Calls in a Single RAG Request
In `src/app/api/assistant/route.ts`, asking a question in Strict RAG mode triggers **two** separate model invocations:
1. An embedding call (`gemini-embedding-001` @ 1536 dimensions) to compute the query vector for pgvector retrieval.
2. A generation call (e.g., `gemini-2.5-flash`) to generate the final grounded response using retrieved context chunks.
* **Cost Impact:** Operators must account for 2 API calls per chat turn when estimating usage costs.

### Trap 6: Clarifying What is NOT AI
Several core audit and remediation features in the repository are completely **deterministic algorithms** with no AI or LLM involvement:
1. **Curriculum Graph Audit** ([src/app/api/catalog/audit/route.ts](src/app/api/catalog/audit/route.ts)): Uses Depth-First Search (`findCycles`) and regex parsing (`extractCodes`) to detect dangling prerequisites, orphan edges, cycles, and text/JSON drift. Read-only.
2. **Automated Remediation Engine** ([src/app/api/catalog/remediate/route.ts](src/app/api/catalog/remediate/route.ts) and `/api/cron/remediate`): Uses Levenshtein edit-distance string matching (`editDistance`) to automatically fix prefix typos (e.g., `MATH` vs `MAT`) and reconcile text/JSON drift. **Writes to DB.**
3. **Verification Harness Remediation** ([verification_harness/remediate.py](verification_harness/remediate.py)): Deterministic python script for catalog repair. Dry-run by default, creates backup tables, and supports `--restore`. **Writes to DB.**
4. **PDF Renderer** (`/api/agent/render-pdf` in [services/swarm/main.py](services/swarm/main.py)): Uses WeasyPrint to render HTML to PDF bytes. Non-AI.

---

## 4. Deterministic Non-AI Subsystems Summary

| Subsystem Name | Location | Description | DB Write? |
| --- | --- | --- | --- |
| **Curriculum Graph Audit** | [src/app/api/catalog/audit/route.ts](src/app/api/catalog/audit/route.ts) | Graph cycle detection (DFS) & prerequisite text/JSON drift parsing. | **NO** |
| **Remediation Engine & Cron** | [src/app/api/catalog/remediate/route.ts](src/app/api/catalog/remediate/route.ts)<br>[src/app/api/cron/remediate/route.ts](src/app/api/cron/remediate/route.ts) | Levenshtein-based prefix typo repair and text/JSON drift auto-reconcile. | **YES** |
| **Verification Harness Repair** | [verification_harness/remediate.py](verification_harness/remediate.py) | CLI tool for applying confirmed harness findings. Backup-backed & reversible. | **YES** |
| **Verification Harness Audit** | [verification_harness/db.py](verification_harness/db.py) | Read-only SQL assertions auditing catalog contract invariants. | **NO** |
| **PDF Rendering Service** | `/api/agent/render-pdf` in [services/swarm/main.py](services/swarm/main.py) | WeasyPrint HTML-to-PDF compilation service. | **NO** |

---

## 5. Developer Maintenance & Debugging Notes

### Authentication Infrastructure
* **Next.js API Routes:** Authenticate user sessions via Supabase Auth (`supabase.auth.getSession()`). Routes connecting to the Python Swarm attach the internal `SWARM_API_TOKEN` bearer header via `swarmAuthHeaders()` ([src/lib/swarm.ts](src/lib/swarm.ts)).
* **Python Swarm Microservice:** Enforces `SWARM_API_TOKEN` via `_BearerAuthMiddleware` ([services/swarm/main.py](services/swarm/main.py)). Unauthenticated requests receive HTTP 401. Health check `/health` remains public for Cloud Run readiness probes.

### Environment Variable Checklist for AI Services
* `GCP_PROJECT_ID` - Required. Google Cloud Project ID for Vertex AI.
* `GCP_LOCATION` - Optional. Vertex AI region for embeddings (`us-central1`).
* `SWARM_API_TOKEN` - Required for Swarm authentication between Next.js and Python Cloud Run.
* `NEXT_PUBLIC_SWARM_API_URL` / `SWARM_BASE_URL` - Endpoint URL for the Python Swarm microservice.
* `CORRECTION_DAILY_LIMIT` - Daily call cap per user for in-PDF correction assistant (default: 150).
* `ANTHROPIC_API_KEY` - Optional. Required only if enabling Anthropic models in UI or `callLLM`.
* `OPENAI_API_KEY` - Optional. Required only if enabling OpenAI models in UI or `callLLM`.
* `GEMINI_API_KEY` - Optional. Fallback Google AI Studio API key if keyless Vertex ADC is unused.

### Diagnostic Command
To verify that the Python Swarm service imports correctly and connects to the keyless Vertex AI shim:
```bash
python -c "import services.swarm.main as m; print(m.app.title, type(m._anthropic_client()).__name__)"
```
Expected output: `SJFU Catalog Swarm API (Vertex AI) VertexShimClient`
