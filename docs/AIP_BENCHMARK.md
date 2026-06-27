# AIP as the accuracy/structure benchmark for hub ingestion

The existing **"SJF Catalog Project"** Supabase (`thsrwztyvqjkhcfzapnl`, us-west-2) holds the **Academic Intelligence Platform (AIP)** data model. Per Adam: the two projects are **not** to be merged. AIP is a **reference benchmark** for what correctly-*structured*, accurate extraction looks like; the goal is to bring the **new (cdi-factory hub) ingestion** up to AIP-grade accuracy/structure across all 8 catalogs. AIP is *not* richer data — it's a **narrower pool** (see below) with a **better structural model**.

## What AIP actually contains (verified)
- **Catalogs (3 rows, but really one populated year):** `2025-2026` active "Master" (id 1, **the only one with programs**), `2024-2025` ARCHIVE (courses only), `2025-2026` DRAFT (courses only). AIP merges undergrad+grad into a single "Master" catalog; it did **not** ingest all 8 hub catalogs.
- **Per catalog:** id1 = 99 programs / 1,993 courses; id2 ≈ 1,953 courses; id4 ≈ 1,953 courses.
- **Normalized, registrar-grade relational model** with explicit AND/OR logic.

## The target structural model (this is the point)
**Prerequisites** — block + edge, not flat links:
- `course_prereq_blocks(course_id, logic_type ∈ {ALL_OF, CHOOSE_N, CREDITS_FROM, OPTIONAL}, required_value)` — 9,927 rows (all `ALL_OF`; multiple blocks per course encode alternative paths)
- `course_prereq_edges(block_id, target_course_id)` — **17,635 edges**

**Program requirements** — block + members + exclusions, with real curriculum logic:
- `requirement_blocks(program_id, block_code, title, logic_type, required_value, credits_min/max)` — 292 rows: **ALL_OF 139 · CHOOSE_N 101 · CREDITS_FROM 52**
- `block_courses(block_id, course_id)` — 2,882 · `block_excluded_courses` — 18

**Also:** `ghost_log` (referenced-but-missing courses) + `is_ghost` flag; `policy_constraints(rule_expression jsonb, target_type)`; per-entity embeddings on `course_metadata`/`program_metadata`; `subjects/terms/schools/attributes/restrictions/equivalencies`; `flags`/`user_feedback`/`catalog_changelog` (entity_type incl. `prereq_ast`/`requirement_ast`).

## The accuracy gaps the hub must close (benchmarked vs AIP)
| Dimension | Hub (8 catalogs) | AIP (≈2025-2026) | Gap |
|---|---|---|---|
| Programs | 1,203 (~150/catalog) | 99 (both levels, one year) | **Hub over-extracts ~3×** — needs dedup/normalization |
| Prereq coverage | 2,939 flat links total | 17,635 edges (one year) | **Hub under-captures prereqs ~6×** |
| Prereq structure | flat `(course, prereq)` | block+edge w/ `logic_type` | Hub lacks AND/OR block grouping |
| Requirement logic | flat `program_requirement_courses` | blocks w/ CHOOSE_N / CREDITS_FROM / ALL_OF | Hub lacks choose-n / credits-from semantics |

## Implications
1. **The "OOM / vLLM-server" residual is now mandatory, not deferred.** Requirement logic (CHOOSE_N/CREDITS_FROM) and accurate AND/OR grouping require the hub's LLM AST extraction to actually run → route ingestion through the standalone vLLM server.
2. **The hub schema + populator must adopt a block/edge logic model** (course_prereq_blocks/edges + requirement_blocks/block_courses with `logic_type`) to represent AIP-grade structure — and the spoke schema (`BUILD_PLAN §3`) inherits it.
3. **Benchmark protocol:** validate the hub's regenerated `2025-2026` output against AIP catalog id1 (same year, both levels) — program count, prereq edge count/coverage, requirement-block logic distribution — before declaring the ingestion "AIP-accurate."
4. AIP project stays **read-only / untouched**; it is the yardstick, not a deploy target.
