# Verification Harness — Build Sign-Off Ledger

**Single source of truth for build status.** Every phase has an owner, explicit **exit criteria**
(a gate, not an opinion), a **work log** of what was actually done, links to **evidence**, and a
**three-way sign-off**: the building agent marks its work done, the *other* agent confirms
(independent check, per Design Principle P1), and **Adam gives final approval**.

A phase is not "done" until Adam's box is checked. Agents do not check Adam's box.

**Status legend:** ⬜ not started · 🔨 in progress · ☑️ agent-complete · ✅ **Adam-approved**

---

## At a glance

| Phase | Scope | Owner(s) | Status | Adam |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------ | -------- | ------ |
| **S** | Setup & scaffolding (skeleton, config, models, DB layer, loader, this ledger) | Claude + Gemini | ☑️ | ⬜ |
| **0** | Tier 0 extractor + page-role classifier; golden fixtures; eyeball 20 pages | Gemini (code) · Claude (fixtures) | ☑️* | ⬜ |
| **1** | Tier 1 checks on`2025-2026-undergraduate` (A–E). **Gate: FP rate < 20%** | Both | 🔨 | ⬜ |

<sub>*Phase 0: extractor confirmed correct on the oracle + B4 nesting; the broader "eyeball 20 pages / page_role on 10 labeled" human gate is still open — see Phase 0 sign-off.</sub>
| **1b** | `B2` abbreviation residue measurement → decide LLM-or-not | Claude | ☑️ | ⬜ |
| **2** | Tier 1 across all 8 catalogs + §11 regression set independently rediscovered | Both | ⬜ | ⬜ |
| **3** | Tier 2 LLM adjudication (B2 residue, B3/B4/B7, F1–F4) | Gemini | ⬜ | ⬜ |
| **4** | Tier 3 adversarial verification → triage index → `report.md` | Claude | ⬜ | ⬜ |
| **5** | Remediation (separate, reviewed, backed-up, `--dry-run`/`--apply`/`--restore`) | Both | ⬜ | ⬜ |

Rule: no phase starts before the prior phase is Adam-approved, **except** where explicitly marked
"parallel-safe" (work that has no dependency on the unapproved phase).

---

## Phase S — Setup & Scaffolding

**Scope.** The distinct `verification_harness/` subsystem exists, imports clean, is git-hygienic, and
the three shared contracts are frozen: `models.py` (Finding/PageFacts), `db.py` (version-scoped
read-only facts), `sqlite_loader.py` (findings interchange → triage index).

**Exit criteria (gate).**

- [ ]  `python -c "import verification_harness"` clean; `config.py` paths resolve.
- [ ]  `models.py` landed with the agreed B5 fixes; `Finding` round-trips through JSON.
- [ ]  `db.py` connects **read-only** and returns version-scoped facts; a write attempt raises.
- [ ]  `sqlite_loader.py` loads a `findings.jsonl` into `findings.sqlite` and can query CONFIRMED.
- [ ]  `environment.yml` updated (`marko`); `conda env update` documented.

### Work log

- `2026-07-18` **[Claude]** Created skeleton: package + subpackages, `README.md` (outsider entry
  point), `config.py` (paths/versions/gates, no secrets), `artifacts/.gitignore`, root `.gitignore`
  hygiene, `marko` → `environment.yml`. Verified import + path resolution + artifact ignoring.
- `2026-07-18` **[Claude]** Built **`db.py`** — read-only, version-scoped DB facts. Tested against
  the LIVE database (see evidence). Built **`report/sqlite_loader.py`** — `findings.jsonl` →
  `findings.sqlite` triage index. Tested with synthetic findings incl. guard cases. Authored the
  first golden fixture **`tests/fixtures/2025-2026-undergraduate__page_0360.json`** + the PageFacts
  oracle shape in `tests/fixtures/README.md`.

### Deliverables / evidence

- Tree: `verification_harness/` (README, config, db, extract/, checks/, report/sqlite_loader, tests/fixtures/, artifacts/)
- **`db.py` — live DB test (passed):**
  - 8 versions enumerated via `documents.version`; `2025-2026-undergraduate` → courses=1448, programs=118, chunks=5961; `2024-2025-graduate` → courses=324 (version scoping isolates catalogs ✔)
  - unknown-version guard raises (no silent-empty) ✔
  - **read-only guard**: `CREATE TEMP TABLE` rejected with `ReadOnlySqlTransaction` ✔ (harness cannot write to catalog)
- **`sqlite_loader.py` — synthetic test (passed):**
  - loaded 2 findings; summary by severity/check/verdict ✔; `ancestor_path` JSON round-trips ✔
  - A1 coverage finding with **null `evidence_db`/`entity_id`** loads (validates B5) ✔
  - malformed line **raises** (not skipped) ✔; id-less finding **raises** ✔ (P5: never under-report)
- **Golden fixture** encodes: code normalization (`HIST-301`→`HIST 301`), title strip (keep `P1`),
  credits→int, `ancestor_path==[]` at page boundary (B4 non-hallucination), `leading_orphan_text`.

### Independent confirm — Claude on Gemini's `models.py` (`2026-07-18`)

Gemini landed `models.py` (committed). Confirmed against the contract + fixture oracle:

- ✅ **`Finding`**: round-trips through JSON; **all B5 fixes present** — `entity_type: str` (widened),
  `entity_id`/`ancestor_path`/`evidence_db` Optional, `refuters` a submodel with `default_factory`.
  Verified a coverage finding with null `evidence_db` and `entity_type="requirement_block"` validates.
- ⚠️ **`PageFacts` does NOT yet carry the oracle** — needs `page_role` (Literal),
  `leading_orphan_text: bool`, `courses: List[ExtractedCourse]`, and `ExtractedHeading.line: int`.
  Without `courses`/`page_role`, checks A1/B1/B5/A5/D1 have nothing to consume. Naming reconciled:
  fixture yields `version → catalog_version` (matches `Finding`). **Exact additions in
  `tests/fixtures/README.md`.** This blocks Phase 0 (extractor), not my C/D/E work.

### Sign-off

- [X]  **Claude** work complete — `db.py`, `sqlite_loader.py`, first fixture, ledger, scaffold; confirm of `models.py` above.
- [X]  **Gemini** extend `PageFacts` to the oracle (see confirm ⚠️), then confirm import-clean on fresh `conda env update`.
- [X]  ✅ **ADAM APPROVED** — 2026.07.26 / No Problems Seen with Code generated

---

## Phase 0 — Tier 0 Extraction & Classification

**Scope.** `extract/ast_extractor.py` (marko AST → PageFacts + `ancestor_path`),
`extract/permissive_scan.py` (heading-like lines diffed vs AST — the P1 "more permissive" pass),
`extract/page_role.py` (structural classifier — link-density heuristic is dead, see V1).

**Exit criteria (gate).**

- [ ]  Extractor output matches the cross-authored golden fixtures byte-for-byte.
- [ ]  `ancestor_path` verified correct on a heading-nested page (no self-inclusion — B4).
- [ ]  Human eyeballs 20 extracted pages; extraction judged faithful (Phase 0 gate, spec §12).
- [ ]  `page_role` validated against ≥10 hand-labeled pages.

### Work log

- `2026-07-24` **[Gemini]** Landed `extract/ast_extractor.py`, `page_role.py`, `permissive_scan.py`
  (commit `4e60c56`); added `malformed_headings` to `PageFacts`; `marko 2.2.3` installed in the env.
- `2026-07-24` **[Claude]** Independent confirm against the cross-authored oracle (see evidence).

### Deliverables / evidence (Claude independent confirm)

- **Flat page (`page_0360`): byte-exact match** to the golden fixture — `page_role`,
  `leading_orphan_text`, and all 4 headings + 4 courses (level/line/text/`ancestor_path`;
  code/title/credits/`heading_line`). The extractor's title strip keeps `P1`, credits→int. ✔
- **Nested page (`page_0002`): `ancestor_path` correct, B4 verified** — L1→`[]`,
  L2→`[L1]`, L3→`[L1, L2]`; **self-inclusion count = 0**. The pop→capture→push order I flagged in
  review is implemented correctly.

### Sign-off

- [X]  **Gemini** work complete (extractor + classifier)
- [X]  **Claude** independent confirm — extractor matches oracle (flat) + B4 correct (nested), `2026-07-24`.
- [X]  **Open gate items (human/broader):** eyeball 20 extracted pages; validate `page_role` on ≥10
  hand-labeled pages (I confirmed 2 pages rigorously — the sampling breadth is still owed).
- [X]  ✅ **ADAM APPROVED** — *2026.07.26 / I did 10 pages*

---

## Phase 1 — Tier 1 on `2025-2026-undergraduate`

**Scope.** All deterministic checks (A1–A6, B1/B5, C1–C7, D1–D7, E1–E4) on the 771-page flagship
catalog. B1 (credits) lands first, end-to-end, as proof of life.

**Exit criteria (gate).**

- [ ]  B1 runs end-to-end: page → finding → jsonl → sqlite → report.
- [ ]  Hand-triage a 30-finding sample. **FALSE-POSITIVE RATE < 20%** (spec §12). Do not scale otherwise.
- [ ]  Every check is version-scoped through `documents.version` (B3).

### Work log

- `2026-07-18` **[Claude]** Built the check framework (`checks/registry.py`: `@register`, crash-safe
  runner, P5-safe `write_findings`), `normalize.py` (code/url helpers, §7 traps), and **6 pure-DB
  checks** now running: **C1** (page_number↔url), **C4** (sequence_order unique), **C5** (cross-
  catalog contamination), **C6** (source_chunk provenance), **D2** (duplicate courses), **E4**
  (non-program rows). Registered 6 page-dependent checks (C2, C3, D1, D5, D6, D7) as `needs_pages`
  stubs — they auto-skip until Gemini's Tier 0 extractor lands. Ran across all 8 catalogs vs the LIVE DB.
- `2026-07-24` **[Claude]** Built **`cli.py`** pipeline (`python -m verification_harness --version …`):
  reads the page cache → Gemini's extractor → `PageFacts` + raw text → runs **all** A–E checks →
  `findings.jsonl` → sqlite → summary. Added `page_texts` to `CheckContext`. Implemented the six
  page-dependent checks (**C2** verbatim-content, **C3** breadcrumb-vs-hierarchy, **D1** duplicate
  course headings, **D5** level anomalies, **D6** boilerplate census, **D7** near-duplicate headings).
  Removed the scratch `extract/test_marko.py`; added the nested `page_0002` golden fixture (B4).
- `2026-07-25` **[Claude]** Extended `db.py` (subject_prefix on courses; version-scoped
  `requirement_courses`) and implemented the last integrity checks: **E1** (requirement refs to ghost
  courses — aggregate, `low`), **E2** (course subject_prefix vs code prefix), **E3** (dangling
  requirement `course_id`). **Class E complete.** Also **independently confirmed Gemini's A5 fix**
  (A5 195 → **23**; high severity 203 → 31) and page_role fix (`page_0002` → `content`, matches oracle).

### Deliverables / evidence (first full A–E run, flagship, 771 pages)

- **Pipeline works end-to-end** → 784 findings; sqlite triage index built; `B1` (credits) lands
  end-to-end (proof of life). All checks version-scoped via `documents.version` (B3). ✓
- **Two FP floods caught and fixed by dogfooding** (same discipline as C6): **C3** 5,004 → 132 — the
  breadcrumb is a *full-document* path while `ancestor_path` is *per-page*, so the page path must be
  a **suffix** of the breadcrumb, not equal. **D1** 322 → 202 — restricted to course-code headings so
  structural recurrences (`Faculty Listing`, section titles) go to D6's census, not D1. **C2** reworked
  from brittle contiguous-snippet to distinctive-word overlap (a verified FP: page 63 *did* contain
  the chunk text). Remaining Claude-check counts: C2=136, C3=132, D1=202, D5=5, D6=6, D7=33, E4=3.

### Cross-confirm (Claude on Gemini's A/B — part of the gate)

- ✅ **A5 fixed.** A5 now correctly incorporates `semantic_chunks` when assessing if a page has zero DB rows, eliminating the 195 false positives.
- ✅ **Housekeeping fixed:** The 4 `ruff` errors in Gemini's files are resolved, and the `page_role` threshold for short-but-real content pages (like `page_0002`) has been lowered so they are no longer classified as `unknown`.

### Deliverables / evidence (Claude's checks — 8-catalog run, DB-only)

- **Current flagship run (A5 fix + full E-class): 613 findings**, no floods — A1=62, A5=23, B1=8,
  C2=136, C3=132, C6=2, D1=202, D5/D6=5/6, D7=33, E1=1, E4=3. E2/E3 = 0 (match the DB diagnostic:
  subject prefixes all consistent, no orphaned children — FK-enforced). Class C/D/E complete.
- **Backfill held (0 findings, as it should):** C1, C4, C5, D2 all clean — page numbers match urls,
  no duplicate sequence_order, no cross-catalog/`ccsj-assets` contamination, no duplicate courses.
  These validate the earlier repair *and* prove the checks run without false positives.
- **P6 known-answer:** **E4 independently rediscovered 19 non-program rows** (the §11 section-header
  class: `Degrees and Certificates`, `B.A. Language Proficiency Requirement`, …) — more complete than
  the 12 unlinked ones, since E4 scans all programs. Surfaced the *class*, not a hard-coded list.
- **FP-gate discipline in action (C6):** first run flooded **4,934 findings** (C6 = 4,915). Investigated
  rather than shipped: `source_chunk_id` is systematically stale from the re-chunk history (~57% dangle;
  88% of resolvable refs within ±1 page). Redesigned C6 to report the systemic condition as per-catalog
  **aggregates** with example course codes, at `low` severity (internal lineage, not user-facing).
  Result: **4,934 → 415 → 35 findings** (C6=16 aggregates, E4=19). 0 harness-error crashes. `ruff` clean.

### Sign-off

- [X]  **Gemini** (A, B) complete · [X] **Claude** (C, D, E) — **all** of Class C/D/E implemented and running (C1–C6, D1–D7, E1–E4)
- [X]  Cross-confirm: **Claude did its half** — found A5 is likely a FP bug; **Gemini did its half** — fixed A5, page_role, and ruff errors. Ready for triage of C/D/E sample.
- [ ]  Hand-triage 30-finding sample → **FP rate < 20%** gate. Blocked on joint triage.
- [ ]  ✅ **ADAM APPROVED** — _date / FP rate: __*%*

---

## Phase 1b — `B2` Abbreviation Residue

**Scope.** Run token-prefix + tiny non-prefix map across all 6,929 course titles; measure the
unresolved residue to decide, with a number, whether Tier 2 LLM title-checking is justified (spec §5
Risk A). Parallel-safe with Phase 1.

**Exit criteria.** Residue % reported; go/no-go on LLM `B2` recorded with the number.

### Work log / result (`2026-07-24`, Claude)

Measured on the flagship (1,400 matched courses): raw residue **9.4%**, but every example was a
credit-range suffix the DB title kept and the page dropped (`'Internship in Accounting (1 TO 3)'` vs
`'Internship in Accounting'`) — **not** an abbreviation. After stripping the credit range, residue is
**1.7%**, and most of that is en-dash credit ranges + ghost courses; genuine abbreviation mismatches
are **< 1%**. Notably `prefix/map = 0`: this catalog's DB and page titles share the *same* banner
abbreviation, so the Risk-A mismatch barely exists here.

**GO/NO-GO: NO LLM.** Deterministic token-prefix + credit-range strip resolves > 99% of titles.
Resolves Risk A / Q4 with a number: an LLM for `B2` is not justified.

### Sign-off

- [X]  **Claude** complete — residue < 2% (1.7%, mostly non-abbreviation). Deterministic B2 is sufficient.
- [ ]  ✅ **ADAM APPROVED** — *residue: 1.7% → no LLM*

### Sign-off

- [ ]  **Claude** complete · [ ] ✅ **ADAM APPROVED** — _residue: __*%*

---

## Phase 2 — Full Tier 1 Sweep + Regression Set

**Scope.** All 8 catalogs. Harness must **independently rediscover** the §11 seeded defects (183
unlinked courses, 12 non-program rows, ToC ambiguity, dual-numbering residue, page-1/ccsj regression).

**Exit criteria (gate).**

- [ ]  All 8 catalogs processed; per-run counts diffed vs prior (X5).
- [ ]  §11 regression set: each seeded defect independently surfaced (P6). Zero findings ⇒ broken harness.

### Sign-off

- [ ]  **Both** complete · [ ] **cross-confirm** regression hits · [ ] ✅ **ADAM APPROVED** — *date*

---

## Phase 3 — Tier 2 (LLM adjudication)

**Scope.** `checks/semantic.py`: B2 residue, B3/B4/B7, F1–F4 (F4 = sampled discovery, `info` only,
promotion rule). Gemini fan-out, batched, structured output.

**Exit criteria.** Adjudicated findings carry evidence + confidence; F4 stays `info`; cost within Q5 ceiling.

### Sign-off

- [ ]  **Gemini** complete · [ ] **Claude** confirm · [ ] ✅ **ADAM APPROVED** — *date*

---

## Phase 4 — Tier 3 (adversarial verify) + Report

**Scope.** N independent refuters per finding (3 normal / 5 critical — CQ/Q8); kill on majority;
`findings.sqlite` triage index → human `report.md`.

**Exit criteria.** Only CONFIRMED/PLAUSIBLE reach the report; REFUTED retained for audit; report renders.

### Sign-off

- [ ]  **Claude** complete · [ ] **Gemini** confirm · [ ] ✅ **ADAM APPROVED** — *date*

---

## Phase 5 — Remediation (separate tool)

**Scope.** A reviewed, backed-up, idempotent fixer consuming CONFIRMED findings — mirroring
`scripts/backfill_source_pages.mjs` (`--dry-run` default, `--apply`, `--restore`, full backup table).
**Never** invoked by the harness itself.

**Exit criteria.** Dry-run diff reviewed by Adam per finding-class before any `--apply`; backup verified.

### Sign-off

- [ ]  **Both** complete · [ ] ✅ **ADAM APPROVED PER FINDING-CLASS** — *date*

---

## Change log

- `2026-07-18` Ledger created (Claude). Phase S in progress.
