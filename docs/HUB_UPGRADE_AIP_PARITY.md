# Hub Ingestion Upgrade — AIP-Grade Accuracy & Block Structure

**For:** the CDI Factory hub agent (`spark-6284.local:~/projects/cdi-factory`, branch `feature/campus-swarm`).
**Goal:** bring the hub (PDF→vision) ingestion to the **accuracy and structure** of the AIP model (Supabase `thsrwztyvqjkhcfzapnl`), benchmarked on **2025-2026**. The two projects do **not** merge — AIP is the read-only yardstick (see `AIP_BENCHMARK.md`). Drafted for review; nothing applied to the hub.

This is the same diagnose→patch→benchmark pattern as the prior two fixes (`5d896b4`, `70801e7`).

---

## 1. Confirmed diagnostics (live hub, tenant SJFU)

**Programs — over-extracted and unstable.**
```
2022-2023-grad 140 · 2022-2023-ug 168 · 2023-2024-grad 110 · 2023-2024-ug 305
2024-2025-grad  50 · 2024-2025-ug 160 · 2025-2026-ug 270 · 2025-2026-grad 0(!)
total 1203   |   AIP 2025-2026 (both levels merged) = 99
```
- Undergrad alone swings 168→305→160→270 across years → unstable extraction.
- **`2025-2026-graduate` has 0 programs** — a straight miss (8th catalog produced no programs).
- Name-variant / sub-unit inflation: **89 "Concentration in …"**, **4 "Fast Track"**, **32 "… Program"** rows counted as distinct programs. `program_markers` (`src/export/table_populator.py:517`) treats `"Concentration in"` and `"Fast Track"` as standalone programs; keying by `(document_id, program_name)` fragments name-variants.

**Prerequisites — under-extracted at the source, not lost at link time.**
```
courses_with_prereq_text = 1901 / 5923   code_refs = 3387   resolved = 2939   ghost = 448 (13%)
AIP edges ≈ 17,635
```
- Only **13%** of references are dropped as ghosts (`link_course_prerequisites` requires same-document match, else logs a ghost node and drops it). So the linker is *not* the bottleneck.
- The bottleneck is **extraction**: only ~32% of courses have *any* prerequisite text, averaging <2 codes. The structured `prerequisites_json` (origin of the recent fix) simply wasn't produced for most courses.
- **Open question for the hub agent (verify):** AIP's `terms`/`crn`/`historical_enrollment`/`active_majors_by_term` tables suggest its prereqs came from a **Banner/SIS export**, not the catalog PDF. If so, 17,635 may be a *source ceiling* the PDF can't reach. Determine whether AIP's prereqs are Banner-sourced; if yes, full parity needs a Banner feed, and the PDF target should be "extract every prereq the PDF actually states," measured against a PDF-stated-prereq sample — not against 17,635.

**Structure — flat, not block-based.** `course_prerequisite_links(course_id, prereq_course_id)` and `program_requirement_courses(... group_name, or_group_id)` carry no `logic_type`. AIP encodes `ALL_OF / CHOOSE_N / CREDITS_FROM / OPTIONAL`. Requirement logic in particular (AIP: ALL_OF 139 / CHOOSE_N 101 / CREDITS_FROM 52) is absent.

---

## 2. Workstreams

### WS1 — Program normalization (target: ~99/yr both levels, stable)
- **Fold sub-units into parents:** `"Concentration in X"`, `"Fast Track"`, track/option variants should attach to their parent program (as a `concentration`/`track` attribute or child), **not** create program rows. Remove `"Concentration in"`/`"Fast Track"` from `program_markers`; route them to the parent via the header path.
- **Merge name-variants:** normalize `program_name` (strip trailing `" Program"`, `" Courses"`, degree-suffix noise) before the `(document_id, program_name)` key, so `"Nursing B.S."`, `"Nursing B.S. Program"`, `"B.S. in Nursing"` collapse to one.
- **Fix the 2025-2026-graduate 0-programs miss** — investigate why that document yielded none (header pattern? chunking?).
- **Acceptance:** per-catalog program counts are stable across years and 2025-2026 (both levels) lands near AIP's 99 (±~15%); no concentration/track rows in `programs`.

### WS2 — Adopt AIP's block/edge logic model (schema + populator)
Add tables mirroring AIP (so the spoke inherits real AND/OR/choose semantics). Suggested DDL (new migration):
```sql
-- prerequisites as logic blocks
CREATE TABLE course_prereq_blocks (
  id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  document_id UUID NOT NULL, logic_type TEXT NOT NULL CHECK (logic_type IN ('ALL_OF','CHOOSE_N','CREDITS_FROM','OPTIONAL')),
  required_value INT);
CREATE TABLE course_prereq_edges (
  block_id BIGINT NOT NULL REFERENCES course_prereq_blocks(id) ON DELETE CASCADE,
  target_course_id UUID NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (block_id, target_course_id));
-- program requirements as logic blocks
CREATE TABLE requirement_blocks (
  id BIGSERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL, block_code TEXT, title TEXT,
  logic_type TEXT NOT NULL CHECK (logic_type IN ('ALL_OF','CHOOSE_N','CREDITS_FROM','OPTIONAL')),
  required_value INT, credits_min INT, credits_max INT, description TEXT);
CREATE TABLE block_courses (
  block_id BIGINT NOT NULL REFERENCES requirement_blocks(id) ON DELETE CASCADE,
  course_id UUID NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (block_id, course_id));
```
- **Populator:** emit blocks from the **LLM AST** (the `logic_tree` JSON). The AST already distinguishes AND/OR; extend the prompt/schema to also emit `CHOOSE_N` (“choose N of …”) and `CREDITS_FROM` (“N credits from …”) with `required_value`, then map AST nodes → blocks + edges/members instead of flat rows. Keep the flat `course_prerequisite_links` / `program_requirement_courses` as a denormalized rollup for back-compat (and for the spoke's simpler views).
- **Dependency:** this requires the LLM AST to actually run → **WS4 is a hard prerequisite** (today all 932 `logic_tree` rows are raw text because the text model OOMs).
- **Acceptance:** `requirement_blocks` shows a logic_type mix comparable to AIP (CHOOSE_N + CREDITS_FROM present, not 100% ALL_OF); spot-check 5 programs vs the source PDF for correct grouping.

### WS3 — Prerequisite coverage + ghost courses
- **Raise extraction coverage:** ensure the vision/enrichment step emits `prerequisites_json` (or prose) for every course whose PDF entry states prerequisites — current 1,901/5,923 is the gap. Measure against a hand-labeled sample of catalog pages.
- **Stop dropping the 13%:** adopt AIP's **ghost-course** pattern — when a prereq references a code absent from the catalog, insert a placeholder course (`is_ghost`) + a `ghost_log` row, and link to it, instead of discarding. Add `is_ghost` to `courses` and a `ghost_log` table.
- **Acceptance:** courses-with-prereqs and total edges rise materially toward the PDF-stated ceiling; 0% silent drops (every reference becomes an edge or a logged ghost).

### WS4 — Route ingestion through the standalone vLLM server (now MANDATORY)
The native in-process reload OOMs (see `HUB_HARDENING_AND_REPROCESS.md`), which disables the LLM AST — and WS2's logic blocks depend on it. Run the OpenAI-compatible vLLM **server** (config already has `base_url: http://127.0.0.1:8000/v1`) and route the pipeline through the `SparkProvider` so the text model stays resident.
- **Acceptance:** after a 2025-2026 re-ingest, `logic_tree` rows are valid JSON ASTs (not raw text); WS2 blocks populate.

---

## 3. Benchmark protocol (the definition of "AIP-accurate")
Regenerate **2025-2026** (undergrad + graduate) on the hub, then compare to AIP catalog id1:
| Metric | Hub now | AIP (2025-2026) | Target |
|---|---|---|---|
| programs (both levels) | 270 (+0 grad) | 99 | ~99 (±15%), grad non-zero |
| requirement_blocks logic mix | n/a (flat) | ALL_OF 139 / CHOOSE_N 101 / CREDITS_FROM 52 | non-trivial CHOOSE_N + CREDITS_FROM present |
| prereq edges | ~370/catalog | ~5,900/yr | rise toward PDF-stated ceiling; 0% silent drops |
| logic_tree | raw text | — | valid JSON ASTs |

**Sequence:** WS4 (unblock LLM) → WS1 (program normalization) + WS3 (coverage/ghosts) → WS2 (block model from AST) → benchmark vs AIP. Each ships behind the existing fail-loud / data-quality gates so a degraded run can't publish.
