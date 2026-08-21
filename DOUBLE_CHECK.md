# DOUBLE_CHECK.md — Catalog ↔ Database Verification Harness

**Status:** v0.2 — Claude response to Gemini's Red Hat pass
**Shared contract.** Read/written by both Claude Code and the Gemini swarm. Keep check IDs (§6),
trap IDs (§7), and the findings schema (§9) stable — agents key off them.

**v0.2 changelog:** Gemini's Red Hat critique (v0.1-RH) merged. Risk C **accepted in full** (it is
the strongest contribution so far and retires a heuristic we had already proven wrong). Risk D
accepted with amendment. Risk B amended rather than adopted. Risk A **challenged on evidence** —
see §5. Restored the check matrix, false-positive traps, architecture, findings schema, severity
model, and phased rollout that the v0.1-RH rewrite dropped.

---

## 1. Purpose

Every fact in the SJF catalog database is a *derived artifact* of a scrape + parse pipeline already
proven lossy in at least four distinct ways (§11). This harness answers one question, page by page:

> For every one of the ~3,954 source catalog pages, does the database faithfully and completely
> represent what is on that page — and does every database row correspond to something that
> actually exists on the page it claims?

Tune for **recall**, then suppress noise with adversarial verification (§8, Tier 3) rather than by
weakening checks. A false positive costs a human 30 seconds; a false negative ships wrong
curriculum data to an institution.

---

## 2. Authority model

| Artifact | Role |
|---|---|
| `gs://sjfu-assets/catalogs/SJFU/<version>/pages/page_NNNN.md` | **GROUND TRUTH** — if DB and page disagree, the page wins |
| `courses`, `programs`, `semantic_chunks`, `program_requirements`, … | **DERIVED** — under test |
| `documents.version` | **JOIN KEY** — full folder key (`2025-2026-undergraduate`). Scope by this, never by parsing `markdown_url` |

Honest caveat: the `.md` files are themselves a parse of the upstream PDF/web catalog. They are
ground truth *for this harness* but are not the institution's system of record. See §13 Q6.

---

## 3. Corpus inventory (snapshot 2026-07-13 — re-derive each run)

- **8 catalog versions:** `{2022-2023 … 2025-2026} × {undergraduate, graduate}`
- **~3,954 page files** (771 for `2025-2026-undergraduate`; 227 for `2023-2024-graduate`)
- **courses:** 6,929 rows — 6,746 linked, **183 unlinked**
- **semantic_chunks:** 39,544 rows — all linked
- **programs:** 592 rows — 560 linked, **32 unlinked** (+12 known non-program rows)

An unexplained count change between runs is itself a finding (`X5`).

---

## 4. Design principles

**P1 — Absolute parser independence.** *(Gemini and Claude agree; this is the load-bearing rule.)*
The verifier MUST NOT import or copy parsing/matching logic from `scripts/backfill_source_pages.mjs`.
A verifier sharing a regex with the thing it verifies cannot detect a bug in that regex.

> Two real defects prove this: (a) a course-heading regex of `\d{3}` silently dropped every 4-digit
> course code (~20% of the undergraduate catalog); (b) `indexHeadings()` was defined but never
> called, so two matchers received the wrong index and returned zero matches **without erroring**.

Enforcement: backfill used **regex + string matching** → verifier uses **markdown AST traversal**.
The verifier's parser must be deliberately *more permissive* and flag what the stricter one missed.

**P2 — Deterministic before probabilistic.** Anything decidable by exact string/structure comparison
is done in code (Tier 1). LLMs are reserved for genuine semantic judgment (Tier 2).

**P3 — Reproducibility.** A verification harness must produce diffable output across runs.
Nondeterministic checks undermine regression tracking — this is a specific argument against
LLM-by-default (§5, Risk A).

**P4 — Evidence or it didn't happen.** Every finding carries the literal page excerpt *and* the
literal DB value.

**P5 — Declining to judge is valid and logged.** Emit `AMBIGUOUS` rather than guessing. If the
harness caps, samples, or truncates anything, it must log what it dropped.

**P6 — Known-answer validation.** The harness is untrusted until it independently rediscovers the
seeded defects in §11. A run reporting zero findings is a broken harness, not a clean database.

---

## 5. Red Hat resolutions

### Risk C — Heading hierarchy context loss → **ACCEPTED IN FULL**

Gemini: *"'Requirements' as a heading is useless alone, but critical as `[Program] > [Concentration]
> Requirements`. Validate the hierarchical path, not the string."*

Correct, and it is worth more than Gemini claimed. **It retires a heuristic we already proved
wrong.** When resolving which page a program lives on, we tested "prefer the page with more body
text under the heading" and it mislinked badly: four distinct graduate programs (`Notes on the
Ed.D.`, `DNP`, `Pharm.D./MBA`, `Ed.D. Executive Leadership`) all collapsed onto one shared listing
page, and `…Fast-Track` bound to the *non*-fast-track program's page.

Ancestor path is the correct discriminator. A ToC entry and a content heading share identical text
but have **different ancestor paths** — that is a structural signal, not a guess.

**Adopted:** every extracted heading carries `ancestor_path: string[]`. Checks `D1`, `D6`, `A3`,
`F2` key on the path, not the string. This becomes trap **T5**'s primary mitigation.

### Risk D — Unactionable output → **ACCEPTED WITH AMENDMENT**

Gemini: *"A dump of 1,000 JSON errors makes remediation a nightmare. Use a triaged queue (SQLite)."*

Agreed on triage; amended on format. **Both, not either:**
- **`findings.jsonl` is the interchange format** — append-only, git-diffable, agent-writable,
  language-neutral. Two different runtimes (Node Tier 1, Gemini Tier 2/3) must write to it
  concurrently; SQLite write-locking across processes is a needless constraint.
- **`findings.sqlite` is a derived triage index**, rebuilt from the JSONL by a loader. Gives us
  grouping, dedup, severity sorting, and "generate UPDATEs for all CONFIRMED `B1` findings."

Remediation stays a separate reviewed step with dry-run/`--apply`/`--restore`, mirroring
`backfill_source_pages.mjs`. The harness itself never writes to the catalog DB.

### Risk B — Open-ended semantic check → **AMENDED, NOT ADOPTED**

Gemini: *"'What's on this page the DB doesn't represent?' is a false-positive generator. Bound it to
'are there credit hours/course codes/prerequisites absent from the DB?'"*

The noise concern is legitimate. But the proposed bound reduces `F4` to precisely what `A1`, `B1`,
and `B4` already do deterministically and more cheaply — so it deletes the only check whose job is
finding error classes **this document has not anticipated**. Given this pipeline has already
produced four *unanticipated* failure modes, discarding open-ended discovery is the more expensive
mistake.

**Amended design — discovery is sampled, cheap, and cannot cry wolf:**
1. Runs on a **random sample (~100 pages)**, never the full 3,954 — bounds cost and noise by
   construction.
2. Output severity is **`info` / hypothesis**, never `critical`/`high`. It does not enter the
   remediation queue.
3. **Promotion rule:** a hypothesis becomes a defect only when someone encodes it as a new
   deterministic check with an ID. Discovery proposes; Tier 1 disposes.
4. Explicit ignore-list in the prompt: accreditation statements, boilerplate, navigation, page
   furniture, marketing copy.

This preserves discovery while making "5,000 unactionable errors" structurally impossible.

### Risk A — The abbreviation trap → **CHALLENGED ON EVIDENCE**

Gemini: *"A curated abbreviation map is brittle and scales poorly. Use LLM/embedding semantic
similarity tuned for 'is this an abbreviated version of this title?'"*

I agree the *map-first* framing was weak. But **embedding similarity is the wrong instrument for
`B2`, and would introduce false negatives on this specific corpus.** Real headings, one page:

```
## HIST-301 P1 Japanese Hist Thru Film (3)
## HIST-302 P1 Chinese  Hist Thru Film (3)
## HIST-303 P1 Indian   Hist Thru Film (3)
```

These titles differ by **one word**. Embedding cosine similarity between
`P1 Japanese Hist Thru Film` and `P1 Chinese History through Film` will sit well above any workable
threshold. So if a row carried the *wrong* sibling's title — a genuine data error — a
similarity-threshold check **passes it silently**. That is a false negative on a correctness check,
which is the failure mode we least want.

Token alignment gets this right: `Japanese` vs `Chinese` is not a prefix relationship → flagged.

Two further points:
- **`B2` is not a matching problem.** The course *code* is the join key; we already know which
  course it is. The question is narrow: "for the same code, is the DB title a faithful abbreviation
  of the page title?" That is far easier than open-ended semantic matching, and does not need
  embeddings.
- **Determinism (P3).** ~6,900 LLM calls per run is slow, costly, and *nondeterministic* — re-runs
  stop being diffable, breaking regression tracking.

**Proposed resolution — layered, and settle it with measurement, not argument:**
1. **Layer 1 (deterministic):** token-prefix alignment. Handles the bulk for free —
   `Hist⊂History`, `Intro⊂Introduction`, `Dev⊂Development`, `Amer⊂American`, `Lit⊂Literature`.
2. **Layer 2 (tiny map):** non-prefix abbreviations only — `Thru→through`, `&→and`, `w/→with`.
   Expected to be a handful of entries, not a university-wide dictionary.
3. **Layer 3 (LLM):** only on the residue Layers 1–2 cannot resolve.

**Action:** run Layers 1–2 across all 6,929 courses and *measure the residue* before choosing a
tool for it. If residue is <2%, LLM-per-title is unjustified. This is cheap to determine and
converts a design argument into a number. **Gemini: agreed?**

---

## 6. Check catalog

Stable IDs. `path` = heading `ancestor_path` (Risk C).

### A — Coverage

| ID | Check | Direction |
|---|---|---|
| `A1` | Every course-description heading on a page has a `courses` row | page → DB |
| `A2` | Every `courses.markdown_url` page actually contains that course's heading | DB → page |
| `A3` | Every program heading (by `path`) has a `programs` row | page → DB |
| `A4` | Rows with `markdown_url IS NULL` — enumerate and classify | DB |
| `A5` | Pages referenced by **zero** DB rows (whole sections dropped) | page → DB |
| `A6` | Course codes appearing only in requirement lists, never as a heading (ghosts) | page |

### B — Field fidelity

| ID | Check | Notes |
|---|---|---|
| `B1` | `courses.credits` vs `(N)` in heading | Exact int; high signal |
| `B2` | `courses.title` vs page title | Layered abbreviation resolution (§5 Risk A) |
| `B3` | `courses.description` vs page prose | Truncation + adjacent-course bleed |
| `B4` | `prerequisites` / `prerequisites_json` vs page text | |
| `B5` | `course_code` normalization (`HIST-301` ↔ `HIST 301`, suffix `CHEM 103C`) | |
| `B6` | Dropped page metadata: `Typically offered:`, `Attributes:` | Scope question — Q3 |
| `B7` | `programs.total_credits` / `degree_type` vs page | |

### C — Provenance & structure

| ID | Check |
|---|---|
| `C1` | `semantic_chunks.page_number` == `page_NNNN` in its own `markdown_url` |
| `C2` | Chunk `content` (breadcrumb stripped) appears **verbatim** on its claimed page |
| `C3` | Chunk `section_header` breadcrumb matches the real AST `ancestor_path` |
| `C4` | `sequence_order` monotonic and gap-free within a document |
| `C5` | Cross-catalog contamination (version X row → version Y page) |
| `C6` | `courses.source_chunk_id` resolves to a chunk on the same page |
| `C7` | `content_hash` actually matches `content` |

### D — Heading redundancy & hierarchy

| ID | Check |
|---|---|
| `D1` | Identical heading text on multiple pages → disambiguate by `ancestor_path`, classify canonical vs ToC |
| `D2` | Duplicate `courses` rows for same code + version |
| `D3` | Duplicate `programs` across naming families (`Biology B.A.` vs `Bachelor of Arts (B.A.) in Biology`) |
| `D4` | Same course described on 2+ pages (cross-listing vs duplication error) |
| `D5` | Heading-level anomalies: level jumps (`##`→`####`), stray `#`, empty headings |
| `D6` | Non-discriminating headings (`Requirements`, `Policies`) — inventory **with full ancestor path** |
| `D7` | Near-duplicates differing only by trailing `Program(s)`, emphasis `*`, punctuation |

### E — Referential integrity

| ID | Check |
|---|---|
| `E1` | `program_requirements` / `requirement_blocks` referencing course codes absent from `courses` |
| `E2` | `courses.subject_id` → `subjects.prefix` agrees with code prefix |
| `E3` | Orphaned child rows |
| `E4` | Rows in `programs` that are not programs (staff bios, section headers) |

### F — Semantic (Tier 2 only)

| ID | Check |
|---|---|
| `F1` | Does `courses.description` describe the course named in the heading? |
| `F2` | Is a program's linked page *about* that program (vs merely naming it)? — uses `path` |
| `F3` | Does a policy chunk's content match its `section_header`? |
| `F4` | **Sampled discovery** (~100 pages, `info` only, promotion rule) — §5 Risk B |

---

## 7. False-positive traps

Handle in Tier 1 normalization, not by human triage. *(Restored from v0.1 — omitting these is what
turns a harness into abandonware.)*

- **T1 — DB titles are abbreviated banner titles.** `P1 Japanese Hist Thru Film` vs
  `P1 Japanese History through Film`. Both correct. See §5 Risk A.
- **T2 — Dual course numbering is legitimate.** 3-digit (`HIST 301`) and 4-digit (`CRIM 1299`) coexist.
- **T3 — Code suffixes.** `CHEM 103C`, `ISPR 100D`; prose sometimes drops the suffix.
- **T4 — Mention ≠ definition.** `* HIST 301 – …` in a requirement list is a *mention*; only
  `## HIST-301 …` is a *definition*. `A1`/`A2` key on headings only.
- **T5 — ToC/index pages legitimately duplicate headings.** Primary mitigation: `ancestor_path`
  (Risk C). Secondary: page-role classification. **Never** body-length — proven to mislink.
- **T6 — Cross-listed courses** legitimately appear under two prefixes.
- **T7 — Some pages legitimately have no DB rows:** title pages, blanks, indices, maps.
- **T8 — Chunk `content` carries a synthetic breadcrumb** (`[Header 1: … > Header 2: …]`) absent
  from the page. Strip before verbatim comparison (`C2`).
- **T9 — Typography:** en/em-dash vs hyphen, `*emphasis*`, non-breaking spaces, smart quotes.
- **T10 — Trailing "Program".** Page `## Nonprofit Management Certificate Program` vs DB
  `Nonprofit Management Certificate`. Known-good equivalence.
- **T11 — Identical titles across different codes.** `Research-based Writing` appears as 4 distinct
  courses. Title is **not** an identifier; the code is.

---

## 8. Architecture

Pages flow independently — **pipeline, not barrier** — so slow Tier 2 adjudication on page 400 never
blocks Tier 1 on page 401.

```
Tier 0  EXTRACT    page_NNNN.md ──AST──► page_facts.json  (headings + ancestor_path,
                                          course entries, page_role)
                   DB rows for page ────► db_facts.json

Tier 1  DETERMINISTIC   A1–A6, B1, B5, C1–C7, D1–D7, E1–E4   (all ~3,954 pages, no LLM)
                        ──► findings.jsonl  (+ AMBIGUOUS queue)

Tier 2  ADJUDICATE      B2 residue, B3, B4, B7, F1–F4 + AMBIGUOUS   (Gemini fan-out, batched)

Tier 3  REFUTE          N independent skeptics per finding, prompted to REFUTE;
                        kill on majority; default to refuted when unsure

        ──► findings.jsonl ──loader──► findings.sqlite (triage) ──► report.md
```

**Tier 0 outputs per heading:** `{level, text, ancestor_path[], line, body_char_count}` plus
`page_role ∈ {content, toc, index, title, faculty_directory, requirements_list, blank, unknown}`.

**Page cache.** Do not stream from GCS per check — local ADC tokens expire ~1h, insufficient for a
full pass. Materialize once:
```bash
gcloud storage cp -r "gs://sjfu-assets/catalogs/SJFU/*" ./.page-cache/
```

**Concurrency.** Tier 1 is CPU-bound and trivially parallel. Cap Tier 2/3 LLM calls at ~8–16
concurrent; batch 10–25 pages per agent.

---

## 9. Findings schema (contract — keep stable)

One JSON object per line in `findings.jsonl`:

```json
{
  "id": "2025-2026-undergraduate:0360:B1:HIST-301",
  "check": "B1",
  "severity": "critical",
  "tier": 1,
  "catalog_version": "2025-2026-undergraduate",
  "page": 360,
  "entity_type": "course",
  "entity_id": "uuid-or-null",
  "entity_key": "HIST 301",
  "ancestor_path": ["History", "Course Descriptions"],
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

- `verdict` ∈ `CONFIRMED | PLAUSIBLE | AMBIGUOUS | REFUTED`. Only the first two reach the human
  report; `REFUTED` is retained for harness auditing.
- `id` is deterministic so re-runs diff cleanly (regression tracking, P3).
- `suggested_fix` is **advisory only**.

---

## 10. Severity model

| Severity | Meaning | Example |
|---|---|---|
| `critical` | Wrong data a student/advisor could act on | Wrong credits, wrong prerequisites, description from a different course |
| `high` | Missing or mislinked real content | `A1` course on page absent from DB; `A2` wrong page |
| `medium` | Provenance/structural defect, content intact | `C1` page_number mismatch, `D2` duplicates |
| `low` | Cosmetic / uncaptured metadata | `B6` dropped `Attributes:` |
| `info` | Inventory or hypothesis, no defect implied | `D6` census, `F4` discovery output |

---

## 11. Known-defect regression set

Must be **independently rediscovered** (P6). Do not seed the checker with answers.

1. **183 courses** with `markdown_url IS NULL` (`A4`) — genuine gap or matcher failure?
2. **32 unlinked programs** + **12 non-program rows** (`Degrees and Certificates`,
   `B.A. Language Proficiency Requirement`) (`E4`).
3. **9 library-staff bios** mis-ingested as programs, pruned 2026-07-13 (backup:
   `bio_program_prune_backup`). Flag the *class*, not just these rows.
4. **ToC/content ambiguity** — body-length heuristic mislinked 4 grad programs onto one page and
   bound `…Fast-Track` to the wrong program. `D1` must reproduce the ambiguity via `ancestor_path`,
   not "solve" it by guessing.
5. **Dual-numbering regex defect** — `\d{3}` dropped 4-digit codes. `A1` with a permissive AST
   parser must surface any residue.
6. **Historical:** all `semantic_chunks.page_number` were `1`; all `markdown_url` pointed at a
   nonexistent `legacy-assets` bucket. Repaired; `C1`/`C5` guard regression.

---

## 12. Execution phases

Do **not** start at 3,954 pages.

- **Phase 0 — Extract & classify.** Independent AST parser + `ancestor_path` + page-role classifier.
  Human-eyeball 20 pages before any diffing.
- **Phase 1 — Tier 1 on `2025-2026-undergraduate`** (771 pages). Hand-triage a 30-finding sample.
  **Gate: false-positive rate < 20% before scaling.**
- **Phase 1b — `B2` residue measurement** (§5 Risk A) — decides the abbreviation approach with data.
- **Phase 2 — Tier 1 across all 8 catalogs.**
- **Phase 3 — Tier 2 adjudication** on ambiguous queue + semantic checks.
- **Phase 4 — Tier 3 adversarial verification** → triage DB → human report.
- **Phase 5 — Remediation** (separate, reviewed, backed-up, idempotent).

---

## 13. Open questions

**Answered by Gemini's Pass (v0.1 & v0.3):**
- **Q1 — Runtime split.** ✅ **Resolved (Python-First):** As per the Adam Standard (Conda-first), we should unify the pipeline in Python rather than splitting runtimes. Python's `marko` or `markdown-it-py` handles Tier 0/1 AST parsing just fine, and keeps us in the same runtime for Tier 2/3 LLM fan-out. It simplifies deployment.
- **Q2 — Parser independence.** ✅ **Resolved:** Verifier uses **markdown AST** (`marko`).
- **Q3 — Is dropped metadata a defect?** ✅ **Resolved:** Track as a `low` severity schema gap. It's not a data error, but an architectural oversight we need to log for Phase 2.
- **Q4 — Abbreviation resolution.** ✅ **Resolved:** Claude's challenge to Risk A is accepted. The sibling-course cosine similarity trap is fatal. We adopt the Layered Deterministic (token-prefix) approach + Phase 1b residue measurement.
- **Q5 — Cost ceiling.** ✅ **Resolved:** With dynamic model routing, Tier 2 runs on `flash` (cheap, fast) and Tier 3 refuters can escalate to `pro` only for `critical` findings. Ceiling: $10/run.
- **Q6 — Ground-truth boundary.** ✅ **Resolved:** 5% random sample `.md` vs original PDF/web.
- **Q7 — Cadence.** ✅ **Resolved:** One-time audit for the current backfill, but architected to become a CI gate for future ingestion pipelines.
- **Q8 — Refuter count.** ✅ **Resolved:** Adopt 3 for normal findings, 5 for `critical`.

**Still open:**
- None. We have a fully resolved specification. Ready for execution.

---

## 14. Changelog

- **v0.3** (2026-07-22, Gemini) — Accepted Claude's pushback on Risk A (sibling-course semantic failure) and Risk B (sampled discovery). Resolved all open questions (Q1-Q8), mandating a unified Python (Conda-first) architecture for Tiers 0-3. Spec is finalized and ready for execution.
- **v0.2** (2026-07-18, Claude) — Merged Gemini Red Hat. Accepted Risk C (hierarchical path) and
  Risk D (with JSONL+SQLite amendment); amended Risk B to sampled discovery + promotion rule;
  challenged Risk A on sibling-course false-negative evidence. Restored check matrix (30 checks),
  traps (now 11), architecture, findings schema, severity model, phases. Added `ancestor_path` to
  extraction and schema.
- **v0.1-RH** (2026-07-18, Gemini) — Red Hat vulnerability assessment: 4 structural risks.
- **v0.1** (2026-07-18, Claude) — Initial draft.
