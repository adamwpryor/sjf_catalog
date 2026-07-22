# DOUBLE_CHECK.md — Catalog ↔ Database Verification Harness

**Status:** DRAFT v0.1 (Claude) — open for Gemini review
**Shared contract.** This file is read/written by both Claude Code and the Gemini swarm.
Anyone may edit; keep the check IDs (§5) and findings schema (§8) stable, since agents key off them.

---

## 1. Purpose

Every fact in the SJF catalog database is a *derived artifact* of a web-scrape + parse pipeline
that has already been proven lossy in at least four distinct ways (§10). This harness exists to
answer one question, exhaustively and page by page:

> For every one of the ~3,954 source catalog pages, does the database faithfully and completely
> represent what is actually on that page — and does every database row correspond to something
> that actually exists on the page it claims?

The goal is **maximum error recall**. A false positive costs a human 30 seconds of triage; a false
negative ships wrong curriculum data to an institution. We tune for recall, then suppress noise
with an adversarial verification pass (§7, Tier 3) rather than by weakening the checks.

---

## 2. Authority model

| Artifact | Role | Notes |
|---|---|---|
| `gs://sjfu-assets/catalogs/SJFU/<version>/pages/page_NNNN.md` | **GROUND TRUTH** | The parsed catalog page. If DB and page disagree, the page wins. |
| `courses`, `programs`, `semantic_chunks`, `program_requirements`, … | **DERIVED** | Under test. |
| `documents.version` | **JOIN KEY** | Full folder key, e.g. `2025-2026-undergraduate`. Scope by this, never by parsing `markdown_url`. |

Caveat to record honestly: the page `.md` files are themselves a parse of the upstream catalog
(PDF/web). They are ground truth *for this harness* but are not the institution's system of record.
Errors introduced upstream of the `.md` files are **out of scope** here and need a separate
page-vs-PDF pass (§12, Q6).

---

## 3. Corpus inventory (snapshot 2026-07-13 — re-derive before each run)

- **8 catalog versions:** `{2022-2023, 2023-2024, 2024-2025, 2025-2026} × {undergraduate, graduate}`
- **~3,954 page files** (e.g. 771 pages for `2025-2026-undergraduate`, 227 for `2023-2024-graduate`)
- **courses:** 6,929 rows — 6,746 linked to a page, **183 unlinked**
- **semantic_chunks:** 39,544 rows — 39,544 linked
- **programs:** 592 rows — 560 linked, **32 unlinked** (+12 known non-program "section header" rows)
- **Child tables:** `program_requirements`, `requirement_blocks`, `program_faculty`,
  `policy_mentions_programs`, `subjects`, `corrections`

Re-derive these counts at the start of every run and diff against the previous run; an unexplained
count change is itself a finding (check `X5`).

---

## 4. Design principles (non-negotiable)

**P1 — Independent re-derivation.** The checker MUST NOT import or copy the parsing/matching code
from `scripts/backfill_source_pages.mjs`. A verifier that shares a regex with the thing it verifies
cannot detect a bug in that regex — it will confidently confirm its own blind spot.

> This is not hypothetical. Two real defects from the backfill work would have been invisible to a
> code-sharing verifier: (a) a course-heading regex of `\d{3}` silently dropped every 4-digit course
> code (~20% of the undergraduate catalog) with no error; (b) an `indexHeadings()` function was
> defined but never called, so the wrong index was passed to two matchers, which returned zero
> matches silently instead of throwing.

The checker's page parser must be **deliberately more permissive** than the backfill's, and flag
anything the stricter parser would have missed.

**P2 — Deterministic before probabilistic.** Anything decidable by exact string/structure comparison
is done in code (Tier 1). LLMs are used only for genuine semantic judgment (Tier 2). This keeps
hallucination out of the majority of findings and keeps cost sane at 3,954-page scale.

**P3 — Evidence or it didn't happen.** Every finding carries the literal page excerpt and the
literal DB value. A finding without both is not reportable.

**P4 — Declining to judge is a valid, logged outcome.** Where evidence is genuinely ambiguous
(§6), emit `verdict: "AMBIGUOUS"` rather than guessing. Silent truncation or arbitrary tie-breaking
is prohibited — if the harness caps or samples anything, it must log what it dropped.

**P5 — Known-answer validation.** The harness is not trusted until it independently rediscovers the
seeded defects in §10. A run that reports zero findings is a broken harness, not a clean database.

---

## 5. Check catalog

Stable IDs. Reference these in findings and in review discussion.

### A — Coverage (things that should exist but don't, and vice versa)

| ID | Check | Direction |
|---|---|---|
| `A1` | Every course-description heading on a page has a `courses` row for that version | page → DB |
| `A2` | Every `courses.markdown_url` page actually contains that course's heading | DB → page |
| `A3` | Every program heading on a page has a `programs` row | page → DB |
| `A4` | Rows with `markdown_url IS NULL` — enumerate and classify (real gap vs. genuinely sourceless) | DB |
| `A5` | Pages referenced by **zero** DB rows — whole sections potentially dropped in ingestion | page → DB |
| `A6` | Course codes appearing ONLY in requirement lists, never as a description heading (ghost courses) | page |

### B — Field fidelity (values that exist but are wrong)

| ID | Check | Notes |
|---|---|---|
| `B1` | `courses.credits` vs `(N)` in the page heading | Exact int. High signal, low noise. |
| `B2` | `courses.title` vs page heading title | **Abbreviation-aware** — see T1 |
| `B3` | `courses.description` vs page prose under the heading | Detect truncation + adjacent-course bleed |
| `B4` | `courses.prerequisites` / `prerequisites_json` vs page "Prerequisite(s):" text | |
| `B5` | `courses.course_code` normalization vs page (`HIST-301` ↔ `HIST 301`) | Suffixes: `CHEM 103C` |
| `B6` | Page metadata dropped entirely: `Typically offered:`, `Attributes:` | Is this intentional? (Q3) |
| `B7` | `programs.total_credits` / `degree_type` vs page statement | |

### C — Provenance & structure

| ID | Check |
|---|---|
| `C1` | `semantic_chunks.page_number` equals the `page_NNNN` in its own `markdown_url` |
| `C2` | `semantic_chunks.content` (minus breadcrumb) appears **verbatim** on its claimed page |
| `C3` | Chunk `section_header` breadcrumb matches the real heading hierarchy on that page |
| `C4` | `sequence_order` is monotonic and gap-free within a document |
| `C5` | Cross-catalog contamination: row in version X pointing at a version Y page |
| `C6` | `courses.source_chunk_id` resolves to a chunk on the same page |
| `C7` | `content_hash` actually matches `content` (detects post-hoc mutation) |

### D — Heading redundancy & duplication *(explicitly requested)*

| ID | Check |
|---|---|
| `D1` | Identical heading text on multiple pages — classify canonical vs. table-of-contents/index |
| `D2` | Duplicate `courses` rows for same `course_code` + version |
| `D3` | Duplicate `programs` rows across naming families (`Biology B.A.` vs `Bachelor of Arts (B.A.) in Biology`) |
| `D4` | Same course described on 2+ pages (legitimate cross-listing vs. duplication error) |
| `D5` | Heading-level anomalies: level jumps (`##` → `####`), a `#` mid-page, empty headings |
| `D6` | Non-discriminating boilerplate headings (`Requirements`, `Program Requirements`, `Policies`) — inventory them, since they are the root of match ambiguity |
| `D7` | Near-duplicate headings differing only by trailing `Program`/`Programs`, emphasis `*`, or punctuation |

### E — Referential integrity

| ID | Check |
|---|---|
| `E1` | `program_requirements` / `requirement_blocks` referencing course codes absent from `courses` |
| `E2` | `courses.subject_id` → `subjects.prefix` agrees with the course code prefix |
| `E3` | Orphaned child rows (parent deleted) |
| `E4` | Rows in `programs` that are not programs (staff bios, section headers) — see §10 |

### F — Semantic (LLM-adjudicated, Tier 2 only)

| ID | Check |
|---|---|
| `F1` | Does `courses.description` actually describe the course named in the heading? |
| `F2` | Is a program's linked page actually *about* that program (vs. a listing that merely names it)? |
| `F3` | Does a policy chunk's content match its `section_header`? |
| `F4` | Free-form: "what is on this page that the database does not represent at all?" |

`F4` is the highest-value and least-specified check. It is the one designed to find error classes
this document has not anticipated.

---

## 6. Known false-positive traps

A harness that ignores these will emit thousands of bogus findings and be abandoned. Each trap MUST
be handled in Tier 1 normalization, not left for a human.

- **T1 — DB titles are abbreviated banner titles.** DB `P1 Japanese Hist Thru Film` vs page
  `P1 Japanese History through Film`. Both correct. Naive equality on `B2` fails on a large
  fraction of the corpus. Requires abbreviation-aware comparison (token-prefix / acronym-tolerant),
  not Levenshtein alone.
- **T2 — Dual course numbering is legitimate.** 3-digit (`HIST 301`) and 4-digit (`CRIM 1299`)
  coexist by design. Neither is stale.
- **T3 — Course-code suffixes.** `CHEM 103C`, `ISPR 100D`; prose sometimes drops the suffix.
- **T4 — Mention ≠ definition.** `* HIST 301 – P1 Japanese History through Film (3)` in a program
  requirement list is a *mention*. Only `## HIST-301 …` is the *definition*. `A1`/`A2` must key on
  headings only, or every course will appear to live on a dozen pages.
- **T5 — ToC/index pages legitimately duplicate headings.** Page-role classification (§7) must
  suppress these for `D1`, and they must never win a canonical-page tie-break.
- **T6 — Cross-listed courses** legitimately appear under two subject prefixes.
- **T7 — Some pages legitimately have no DB rows**: title pages, blank pages, indices, campus maps.
  `A5` must classify before reporting.
- **T8 — Chunk `content` carries a synthetic breadcrumb prefix** (`[Header 1: … > Header 2: …]`)
  that does **not** appear on the page. Strip before any verbatim comparison (`C2`).
- **T9 — Typography:** en-dash `–` vs hyphen `-` vs em-dash `—`; markdown emphasis `*…*` wrapping;
  non-breaking spaces; smart quotes.
- **T10 — Heading + trailing "Program".** Page `## Nonprofit Management Certificate Program` vs DB
  `Nonprofit Management Certificate`. Known-good equivalence, already handled in the backfill.

---

## 7. Harness architecture

Three tiers. Each page flows through independently — **pipeline, not barrier** — so a slow LLM
adjudication on page 400 never blocks deterministic checks on page 401.

```
        ┌─ Tier 0: EXTRACT ────────────────────────────────────────┐
        │  page_NNNN.md  ──►  page_facts.json  (independent parser)│
        │  DB rows for that page ──►  db_facts.json                │
        └──────────────────────────────────────────────────────────┘
                              │
        ┌─ Tier 1: DETERMINISTIC DIFF (all ~3,954 pages, no LLM) ──┐
        │  A1–A6, B1, B5, C1–C7, D1–D7, E1–E4                      │
        │  ──► findings.jsonl  (+ AMBIGUOUS queue)                 │
        └──────────────────────────────────────────────────────────┘
                              │
        ┌─ Tier 2: LLM ADJUDICATION (targeted, Gemini fan-out) ────┐
        │  B2, B3, B4, B7, F1–F4  + everything marked AMBIGUOUS    │
        │  one agent per page-batch; structured output enforced    │
        └──────────────────────────────────────────────────────────┘
                              │
        ┌─ Tier 3: ADVERSARIAL VERIFY ─────────────────────────────┐
        │  N independent refuters per finding, prompted to REFUTE  │
        │  kill if majority refute; default to refuted if unsure   │
        └──────────────────────────────────────────────────────────┘
                              │
                    report.md + findings.jsonl
```

**Tier 0 — page-role classification.** Before any diffing, classify each page as one of
`content | toc | index | title | faculty_directory | requirements_list | blank | unknown`.
This single step is what makes `A5`, `D1`, and `T5` tractable instead of noise generators.

**Page cache.** Do not stream from GCS per check — local ADC tokens expire mid-run (observed:
~1 hour, insufficient for an 8-catalog pass). Materialize once:

```bash
gcloud storage cp -r "gs://sjfu-assets/catalogs/SJFU/*" ./.page-cache/
```

`scripts/backfill_source_pages.mjs --pages-dir` already follows this pattern; mirror it.

**Concurrency.** Tier 1 is CPU-bound and trivially parallel. Tier 2/3 fan-out should cap concurrent
LLM calls (~8–16) and process pages in batches of ~10–25 to amortize prompt overhead.

---

## 8. Findings schema (contract — keep stable)

One JSON object per line, appended to `findings.jsonl`:

```json
{
  "id": "2025-2026-undergraduate:0360:B1:HIST-301",
  "check": "B1",
  "severity": "high",
  "tier": 1,
  "catalog_version": "2025-2026-undergraduate",
  "page": 360,
  "entity_type": "course",
  "entity_id": "uuid-or-null",
  "entity_key": "HIST 301",
  "claim": "DB credits=4 but page heading states (3)",
  "evidence_page": "## HIST-301 P1 Japanese Hist Thru Film (3)",
  "evidence_db": "credits=4",
  "confidence": 0.98,
  "verdict": "CONFIRMED",
  "refuters": { "n": 3, "refuted": 0 },
  "suggested_fix": "UPDATE courses SET credits=3 WHERE id='…'",
  "auto_fixable": true
}
```

- `verdict` ∈ `CONFIRMED | PLAUSIBLE | AMBIGUOUS | REFUTED`. Only `CONFIRMED` and `PLAUSIBLE`
  surface in the human report; `REFUTED` is retained for harness auditing.
- `id` must be deterministic so re-runs are diffable (regression tracking).
- `suggested_fix` is **advisory only**. No check in this harness writes to the database. Remediation
  is a separate, reviewed step with its own backup (see the `source_page_backfill_backup` pattern).

---

## 9. Severity model

| Severity | Meaning | Example |
|---|---|---|
| `critical` | Wrong data a student/advisor could act on | Wrong credits, wrong prerequisites, description belongs to a different course |
| `high` | Missing or unlinked real content | Course on page has no DB row (`A1`); page links to wrong page (`A2`) |
| `medium` | Provenance/structural defect, content intact | `C1` page_number mismatch, `D2` duplicates |
| `low` | Cosmetic / metadata not captured | `B6` dropped `Attributes:` line |
| `info` | Inventory, no defect implied | `D6` boilerplate heading census |

---

## 10. Known-defect regression set (harness validation)

The harness must **independently rediscover** these. If it does not, it is broken (P5). Do not seed
the checker with the answers — only with the expectation that findings exist in these areas.

1. **183 courses** with `markdown_url IS NULL` (`A4`) — are these genuinely sourceless, or a
   matcher gap?
2. **32 unlinked programs** (`A4`) plus **12 rows in `programs` that are not programs**
   (`Degrees and Certificates`, `B.A. Language Proficiency Requirement`, …) (`E4`).
3. **9 library-staff bios** were mis-ingested as programs and pruned 2026-07-13 (backup:
   `bio_program_prune_backup`). The harness should flag the *class*, not just these rows.
4. **ToC/content heading ambiguity** — several graduate programs share one listing page; a
   body-length heuristic was tested and **mislinked** (4 distinct programs → 1 page;
   `…Fast-Track` → the non-fast-track page). `D1` must reproduce this ambiguity, not "solve" it.
5. **Dual numbering regex defect** — a `\d{3}` pattern dropped 4-digit codes. `A1` run with a
   permissive parser must surface any residue.
6. **Historical:** all `semantic_chunks.page_number` were `1`, and all `markdown_url` pointed at a
   non-existent `ccsj-assets` bucket. Both repaired; `C1`/`C5` guard against regression.

---

## 11. Execution phases

Do **not** start with 3,954 pages. Prove signal quality on a slice first.

- **Phase 0 — Extract & classify.** Build the independent page parser + page-role classifier.
  Deliverable: `page_facts.json` for one catalog. Human-eyeball 20 pages to confirm extraction is
  faithful before any diffing.
- **Phase 1 — Tier 1 on one catalog** (`2025-2026-undergraduate`, 771 pages). Measure findings/page
  and hand-triage a 30-finding sample. **Gate:** false-positive rate < 20% before scaling.
- **Phase 2 — Tier 1 across all 8 catalogs.** Full deterministic sweep.
- **Phase 3 — Tier 2 LLM adjudication** on the ambiguous queue + semantic checks.
- **Phase 4 — Tier 3 adversarial verification**, then human report.
- **Phase 5 — Remediation** (separate, reviewed, backed-up, idempotent — mirroring
  `backfill_source_pages.mjs`: dry-run default, `--apply`, `--restore`).

---

## 12. Open questions for Gemini

1. **Q1 — Runtime split.** Tier 1 in Node (reuses the existing `pg` + page-cache tooling) or Python
   (Conda-first per `DEVELOPER_GUIDELINES.md` §1)? Recommendation: Node for Tier 0/1 to match
   existing scripts; Gemini agents for Tier 2/3. Agree?
2. **Q2 — Independent parser strategy.** How do we *guarantee* P1 independence in practice — a
   different author, a different parsing approach (AST/markdown-it vs. regex), or both?
3. **Q3 — Is dropped page metadata a defect?** `Typically offered:` and `Attributes:` exist on pages
   but have no DB column. Is that intentional scope, or a schema gap to file (`B6`)?
4. **Q4 — Title comparison algorithm.** What concretely handles T1 (`Hist Thru Film` ↔
   `History through Film`) with acceptable precision? Proposal: token-prefix matching + a curated
   abbreviation map, LLM only on residue.
5. **Q5 — Cost ceiling.** What is the acceptable token/time budget for a full Tier 2/3 pass? This
   determines batch size and how much gets deterministic-only treatment.
6. **Q6 — Scope boundary.** Do we add a page-vs-source-PDF pass (§2 caveat), or accept the `.md`
   files as ground truth for now?
7. **Q7 — Cadence.** One-time audit, or CI-style gate that runs after every ingestion?

---

## 13. Changelog

- **v0.1** (2026-07-18, Claude) — Initial draft: authority model, 30 checks across 6 classes,
  10 false-positive traps, 3-tier architecture, findings schema, regression set, phased rollout.
