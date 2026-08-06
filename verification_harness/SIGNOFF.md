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
| **S** | Setup & scaffolding (skeleton, config, models, DB layer, loader, this ledger) | Claude + Gemini | ☑️ | ✅ |
| **0** | Tier 0 extractor + page-role classifier; golden fixtures; eyeball 20 pages | Gemini (code) · Claude (fixtures) | ☑️* | ✅ |
| **1** | Tier 1 checks on`2025-2026-undergraduate` (A–E). **Gate: FP rate < 20%** | Both | ☑️ | ✅ |

<sub>*Phase 0: extractor confirmed correct on the oracle + B4 nesting; the broader "eyeball 20 pages / page_role on 10 labeled" human gate is still open — see Phase 0 sign-off.</sub>
| **1b** | `B2` abbreviation residue measurement → decide LLM-or-not | Claude | ☑️ | ✅ |
| **2** | Tier 1 across all 8 catalogs + §11 regression set independently rediscovered | Both | ☑️† | ✅ |
| **3** | Tier 2 LLM adjudication (B2 residue, B3/B4/B7, F1–F4) | Claude (built) · Gemini (confirm) | ☑️‡ | ✅ |
| **4** | Tier 3 adversarial verification → triage index → `report.md` | Gemini (built) · Claude (review) | ☑️ | ✅ |
| **5a** | Remediation tool — `B1`/`A6`/`C7` only (dry-run default, backup, `--restore`) | Both | ⬜ | ⬜ |
| **5b** | Pipeline defect report — `F3`/`B3`/`A1`/`A3`/`B4`/`B6` root causes, hands off | Claude | ⬜ | ⬜ |

<sub>†Phase 2: both gates pass (8 catalogs swept, §11 gate 10/10) and **Gemini's P1 cross-confirm is
recorded** (`2026-07-30`, all four items). Only Adam's stamp is outstanding. Note the scoped per-tier
fetch refactor was **deferred with measurements**, not done — see Phase 2 "Deferred".</sub>

<sub>‡Phase 3 is **built and tested but has never run against a model** — ADC expired, so Tier 2 is
unexecuted. Two governance notes recorded rather than resolved: Phase 2's Adam box was still open
when Phase 3 started (Adam directed the start verbally on `2026-08-01`; agents do not check his
box), and the ledger assigned Phase 3 to Gemini. Claude built it. See "Ownership deviation".</sub>

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

### Addendum — automated drift guard (`2026-07-30`, Claude; both agents flagged the gap)

The Phase 0 confirm was done **by hand and never re-run**, so an edit to `extract/` could drift from
the oracle and surface only as changed findings three tiers down. `tests/test_ast_extractor.py` now
replays every fixture on each `pytest` run. It needs no database and no sweep. Per P1 the extractor
is Gemini's, so Claude authored both the fixtures and this test.

**The first version of the guard was worthless, and saying so is the point.** Re-injecting the
historical §11.5 defect (`\d{3,4}` → `\d{3}`, the regex that silently dropped every 4-digit course
code) left the suite **green** — both Phase 0 fixtures contain only 3-digit codes, so the guard
could not see that defect class at all. A test that cannot fail is worse than no test, because it
reports confidence it has not earned.

- **Fixed by pinning the gap, not by loosening the test:** new hand-authored fixture
  `2025-2026-undergraduate__page_0152.json` (AFAM-1001/1002/1003/1299 — four 4-digit codes, plus
  trap T11 title collision). Authored by *reading the page*, never by running the extractor; it
  matched on the first run. Re-injecting the same defect now **fails**: `AFAM 1001` → `AFAM 100`.
- **Comparison is subset-recursive, deliberately.** The Phase 0 fixtures predate `credits_raw` and
  `malformed_headings`; whole-dict equality would fail on those and tempt the obvious "fix" —
  regenerating fixtures from the extractor — which makes the oracle a mirror of the thing it audits
  and voids P1. A field the oracle omits is not asserted; a pinned field that *vanishes* is an error.
- **The resulting blind spot is itself guarded.** `test_oracle_pins_every_model_field` fails when a
  model field exists that no fixture anywhere pins. `_KNOWN_UNPINNED` is currently **empty** —
  `page_0152` pins the full shape — so coverage cannot erode silently.
- Also asserts the **B4 invariant live** (no heading is its own ancestor; `len(ancestor_path) <
  level`, so no parent is borrowed across a page boundary) on every fixture page.

### Sign-off

- [X]  **Gemini** work complete (extractor + classifier)
- [X]  **Claude** independent confirm — extractor matches oracle (flat) + B4 correct (nested), `2026-07-24`.
- [X]  **Open gate items (human/broader):** eyeball 20 extracted pages; validate `page_role` on ≥10
  hand-labeled pages (I confirmed 2 pages rigorously — the sampling breadth is still owed).
- [X]  ✅ **ADAM APPROVED** — *2026.07.26 / I did 10 pages*
- [X]  **Gemini cross-confirm of the addendum (P1 — 2026-08-01):** Verified `page_0152.json` oracle independently against `page_0152.md` source (AFAM 1001-1299 4-digit codes, titles, credits=3, page_role="content"). Verified defect injection: reverting regex to `\d{3}` causes `test_ast_extractor.py` to fail cleanly (`AFAM 100` vs `AFAM 1001`). All 18 tests in suite pass.

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
- [X]  Cross-confirm: **Claude did its half** — found A5 is likely a FP bug; **Gemini did its half** — fixed A5, page_role, and ruff errors.
- [X]  Hand-triage 30-finding sample → **FP rate < 20%** gate → **0% FP, GATE PASSED** (Adam triaged all 30 as REAL, 2026-07-26; see `PHASE1_TRIAGE.md`). Every sampled finding is a genuine DB defect — missing courses (A1), wrong credits (B1), coverage gaps (A5).
- [X]  ✅ **ADAM APPROVED** — 2026-07-28 / FP rate: 0%

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

### Addendum — the measurement was flagship-only; corpus-wide it reverses (`2026-08-01`, Claude)

Shipping `B2` in Phase 3 made it measurable on all eight catalogs for the first time. The flagship
figure holds exactly — **1.7%** — but it is tied for the *lowest* in the corpus, and the corpus rate
is **7.3%**, over §5 Risk A's 2% threshold. The graduate catalogs run to **20.5%**, because the
flagship's defining property (DB and page share the same banner abbreviation) is not shared: there,
the DB holds the long title and the page holds the short form.

**Layer 3 is therefore justified, not optional** — by §5's own rule, applied to a representative
sample. This does not make Phase 1b wrong about what it measured; it makes the generalization from
one catalog to eight unsafe. Full table in Phase 3's evidence. Cost of adjudicating all 720: $0.045.

### Sign-off

- [X]  **Claude** complete — residue < 2% (1.7%, mostly non-abbreviation). Deterministic B2 is sufficient.
- [X]  ✅ **ADAM APPROVED** — 2026-08-05 (stated in session; recorded by Claude). Note the
  Phase 3 addendum above: the 1.7% held for the flagship, but corpus-wide residue is 7.3%, so
  Layer 3 is justified after all. The approval covers the measurement, not the generalization.

---

## Phase 2 — Full Tier 1 Sweep + Regression Set

**Scope.** All 8 catalogs. Harness must **independently rediscover** the §11 seeded defects (183
unlinked courses, 12 non-program rows, ToC ambiguity, dual-numbering residue, page-1/ccsj regression).

**Exit criteria (gate).**

- [X]  All 8 catalogs processed; per-run counts diffed vs prior (X5).
- [X]  §11 regression set: each seeded defect independently surfaced (P6). Zero findings ⇒ broken harness.

### Work log

- `2026-07-28` **[Gemini]** Acknowledged the 8-catalog performance item (full sweep timed out on cumulative chunk fetches). Phase 2 will address this by having each tier fetch only what it needs.
- `2026-07-29` **[Claude]** **Measured the timeout before refactoring for it — the premise was wrong.**
  The DB is not the bottleneck: `db_facts_for_version` is **1.4–2.2s per catalog** (13.5 MB of chunk
  content and 4.4 MB of descriptions across all 8), and the *whole* flagship pipeline — 771 pages
  extracted, 5,961 chunks fetched, all 20 checks — runs in **4.3s**. A full 8-catalog sweep is
  **~27s of compute**. There was no cumulative chunk-fetch cost to remove, so the planned per-tier
  data-subsetting refactor was **not built**: it would have added a declarative needs-vocabulary and
  a lazy fetch path through the audited data layer to save ~1s per catalog. See "Deferred" below.
- `2026-07-29` **[Claude]** Found and fixed the **real** failure: the page cache did not exist and
  could not be rebuilt. The documented step was an out-of-band `gcloud storage cp`, and the gcloud
  session had expired to a state that cannot refresh non-interactively ("Reauthentication failed.
  cannot prompt during non-interactive execution") — so the sweep had *nothing to audit*, which is
  what a "timeout" on cumulative fetches looks like from the outside. Built **`fetch.py`**: an
  incremental, concurrent, read-only GCS sync over ADC (least-privilege scope first, atomic writes,
  a page that will not download raises rather than leaving a truncated cache). **3,954 pages / 9.2 MB
  in 40s cold, 3s warm.** `--sync` is now part of the pipeline; the manual gcloud step is gone.
- `2026-07-29` **[Claude]** Implemented **`A4`** (rows with `markdown_url IS NULL` — enumerate and
  classify), which did not exist and which §11.1/§11.2 require. Added `--checks` selection, per-stage
  timing on every version, `report/run_history.py` (**X5**), and the §11 gate as a permanent test.

### Deliverables / evidence — full 8-catalog sweep

- **All 8 catalogs, 3,954 pages, 4,445 findings, 26.6s, zero harness-error findings, `ruff` clean.**
  Per catalog: 2022-23 grad 298 · 2022-23 ugrad 640 · 2023-24 grad 319 · 2023-24 ugrad 1,100 ·
  2024-25 grad 327 · 2024-25 ugrad 785 · 2025-26 grad 354 · **2025-26 ugrad 622**.
- **Phase 1 reproduces exactly.** The flagship's 622 = the Adam-approved **613** + **9** from the new
  A4. No other count moved, so the Phase 1 FP triage still describes the same findings.
- **By check:** A1=536, A4=42, A5=81, B1=75, C2=514, C3=609, C6=16, D1=1911, D5=54, D6=36, D7=548,
  E1=4, E4=19. **By severity:** critical 536, high 185, medium 533, low 3,142, info 49.
- **Corpus matches §3 exactly** — 3,954 pages (771 flagship, 227 for 2023-2024-graduate), 6,929
  courses, 592 programs, 39,544 chunks. `X5` gate passes; GCS and DB agree on all 8 version keys.
- **Determinism (P3):** two consecutive `--all` runs produced byte-identical counts; `X5` reported
  "no change". The diff was separately verified to *detect* drift (page loss, per-check deltas, a
  newly-appearing check) — a silent "no change" is not being mistaken for a working comparison.

### Deliverables / evidence — §11 known-answer gate (P6)

`pytest verification_harness/tests/test_known_answers.py` — **10 passed.** The expected numbers live
in the test, derived from §3/§11; no check is seeded with them.

| §11 | Known answer | Harness result |
| --- | --- | --- |
| 1 | 183 courses `markdown_url IS NULL` | **183 exactly** — and *classified*: **178 are ghost courses** (referenced in requirement lists, never defined, so no page is expected — `info` aggregate) and **5 are genuine matcher failures** (`high`, enumerated: DEXL 725, DEPT 475/476/477, ITDY 490). This answers §11's open question "genuine gap or matcher failure?" — overwhelmingly neither, and per-row reporting would have been a 178-finding FP flood. |
| 2 | 32 unlinked programs + 12 non-program rows | **32 exactly** (8 of them classified as non-program rows); **E4 = 19** non-program rows, a superset of the documented 12, incl. the `section_header` class. |
| 3 | 9 library-staff bios pruned 2026-07-13 | Rows are gone from `programs`, so E4 cannot fire live. The gate replays all **9** names from `bio_program_prune_backup` through E4's classifier: **9/9 → `staff_bio`**. The *class* is validated, not a row list. |
| 4 | ToC/content ambiguity must be reproduced, not guessed | **A1 fires on 0 toc/index pages** (trap T4/T5 holds); all **1,911** D1 findings carry their page list, so the ambiguity is actionable. The original mislink signature is gone: no page carries 4+ programs, and every Fast-Track program sits on its own page. |
| 5 | Dual-numbering residue (`\d{3}` dropped 4-digit codes) | **171 four-digit codes** surfaced by A1 (AFAM 1003, AMST 2140, ARTS 2325, …). The permissive AST parser sees what the old regex dropped. |
| 6 | All `page_number` = 1; all urls → `ccsj-assets` | **C1 = 0, C5 = 0** across all 8 catalogs. The repair held. |

### Defects the sweep found in the harness itself (fixed)

- **Duplicate finding ids (P3 break).** 8 collisions across the corpus. A source page can define the
  same code twice — `2022-2023-undergraduate` p139 has both `### ARTS-120 Basic Music Theory (3)` and
  `### ARTS-120 Music Theory (3)`; `2022-2023-graduate` p93 does the same for `GMGT-681`. A1/B1/B5
  iterated raw occurrences and emitted the identical claim twice, colliding on
  `{version}:{page}:{check}:{entity_key}`. Fixed by reasoning per code (`courses_by_code`) and naming
  the repetition **inside the claim**, so the conflicting definition stays visible instead of being
  silently deduplicated. Flagship counts unaffected (no repeats there).
- **The loader crashed instead of diagnosing.** The collision surfaced as a bare
  `sqlite3.IntegrityError` from the insert. `sqlite_loader` now detects duplicate ids during parse
  and raises `MalformedFinding` naming the id and both line numbers — consistent with its existing
  rule that a finding must never be silently coalesced or dropped (P5).

### Observations for Adam (not blocking, no action taken)

- **Same-page duplicate course definitions are a real, unreported defect class.** `ARTS-120` and
  `GMGT-681` above are each defined twice on one page *with different titles*. `D1` covers
  multi-page duplication and `D4` cross-listing; nothing covers same-page conflict. A1's claim now
  mentions it, but only when the course is also missing from the DB. Candidate `D8` — your call.
- **`page_role == "toc"` never fires** on this corpus (3,954 pages: content 3,595, faculty_directory
  235, requirements_list 89, title 28, index 7). ToC entries here are bullets, not headings, so they
  fail the classifier's `heading_ratio > 0.1` branch and land in `index`. Harmless today — T5's
  mitigation works through `index` plus `ancestor_path` — but Tier 2/3 must not key on `"toc"`.
- **No automated test guards the Tier 0 extractor.** The Phase 0 fixtures are checked in and were
  confirmed by hand, but nothing re-runs them; a future extractor edit would silently drift from the
  oracle. A fixture test is ~20 lines and belongs to whoever does not own the extractor (P1).
- **The subsystem is not Black-clean** (14 of 24 files). `ruff check` passes. I did not run a
  formatting sweep because it would bury this diff.

### Deferred (was in scope, deliberately not built — needs your call)

**Per-tier data-subsetting refactor.** The handoff scoped this first, on the premise that cumulative
chunk fetches were timing the sweep out. They are not (numbers above). Building it would mean a
declarative `needs` vocabulary on every check and a lazy/column-subsetted path through `db.py` — new
machinery in the one module that must stay obviously read-only and version-scoped — to save roughly
one second per catalog. I judged that a bad trade and stopped to ask rather than either building it
silently or dropping it silently. It becomes worth doing if Tier 2/3 turns out to need
`courses.description` and `prerequisites` (18 MB currently fetched by nobody); revisit at Phase 3.

### Sign-off

- [X]  **Claude** complete — `fetch.py`, `A4`, X5 run history, §11 gate, duplicate-id + loader fixes; full sweep run and reproduced.
- [X]  **Gemini cross-confirm (P1 — 2026-07-30):** (a) `A4` ghost-vs-matcher-failure split confirmed (178 ghost courses aggregated to 1 `info` per catalog; 5 real gaps enumerated as `high`; non-program rows handed to `E4`); (b) `courses_by_code` fix confirmed (deduplicates identical ID claims per page without finding loss, appending conflicting titles inside claim text; flagship reproduces 613 + 9 A4 = 622); (c) §11 gate re-run independently (**10/10 passed**); (d) deferred subsetting refactor confirmed approved (pipeline is 26.6s across all 8 catalogs, 4.3s flagship; DB fetch is not the bottleneck).
- [X]  ✅ **ADAM APPROVED** — 2026-08-05 (stated in session; recorded by Claude)

---

## Phase 3 — Tier 2 (LLM adjudication)

**Scope.** `checks/semantic.py`: B2 residue, B3/B4/B7, F1–F4 (F4 = sampled discovery, `info` only,
promotion rule). Gemini fan-out, batched, structured output.

**Exit criteria (gate).**

- [X]  Adjudicated findings carry evidence + confidence.
- [X]  F4 stays `info` — enforced in code, not requested in the prompt.
- [X]  Cost within the Q5 ceiling — **$7.96 projected** against $10, measured without spending.
- [ ]  **A live Tier 2 run has actually happened.** Blocked: see "Blocker" below.
- [X]  FP triage of a Tier 2 finding sample, mirroring the Phase 1 gate — **PASSED**.

### FP gate — PASSED (`2026-08-06`, Adam)

30 Tier 2 findings from `2022-2023-graduate`, stratified by check, seeded and reproducible
(`PHASE3_TIER2_TRIAGE.md`). **Adam judged all 30 REAL, with one he would quibble as a judgment
call.** FP rate is at worst 1 in 30 — **3.3%**, well inside §12's 20% ceiling, and consistent with
Phase 1's 0% on Tier 1.

Two things follow that are worth stating, because the gate was run to decide them:

- **`F3` stays per-chunk and is not aggregated.** It is 76% of Tier 2's output (1,062 of 1,404 on
  the smallest catalog) and I proposed giving it the `B4`/`C6` treatment. The triage says no: `B4`
  aggregated because 217 rows shared *one* defect, so the claim compressed without losing anything.
  `F3`'s findings are each a *different* chunk with a *different* wrong breadcrumb — `PHAR-3226
  State Pharmacy Law` filed under `Grading Scale for Nursing Programs` — so aggregating would
  destroy exactly the per-row detail remediation needs. The volume is real defect volume, and §1 is
  explicit that a false negative costs more than a false positive. Grouping belongs in `report.md`,
  which now caps at 50 per check and says plainly what it omitted; the findings stream keeps
  everything (P5).
- **The gate result changes Tier 3's cost/benefit, and that needs a decision.** Tier 3 exists to
  suppress false positives. At a measured ~3% FP rate there is very little to suppress, and it cost
  **57 minutes for one catalog** (~9 hours corpus-wide) refuting findings that are almost all real.
  Recorded in Phase 4 rather than resolved here.

### Blocker — Tier 2 has never been executed (`2026-08-01`)

Application Default Credentials are expired. Every candidate model, region, and scope fails
identically:

```text
RefreshError: Reauthentication is needed.
Please run `gcloud auth application-default login` to reauthenticate.
```

Probed on `2026-08-01`: `gemini-2.5-flash` and `gemini-2.5-pro` × `us-east5` / `us-central1` /
`global`, plus a bare `google.auth.default()` under both `devstorage.read_only` and
`cloud-platform`. **All six model probes and both scopes fail at the token refresh**, before any
request is formed — so this is not a Vertex, quota, region, or model-availability problem. The
refresh token itself is dead, and renewing it needs a human at a browser:

```bash
gcloud auth application-default login        # Adam, interactively — an agent cannot do this
python -m verification_harness --all --tier2 estimate     # confirm the projection
python -m verification_harness --all --tier2 live --budget 10
```

This also disables `--sync`; the run above therefore uses the already-complete local page cache
(3,954 pages). Everything below was built and verified against that cache without a model.

### Work log

- `2026-08-01` **[Claude]** Built the **`llm/` layer** — `client.py` (Vertex via ADC, structured
  output, temperature 0, retry with backoff, refusal detection, concurrency cap), `cache.py`
  (content-addressed response cache), `budget.py` (token accounting + hard dollar ceiling). Four run
  modes: `live`, `replay`, `estimate`, `fake`.
- `2026-08-01` **[Claude]** Built **`checks/semantic.py`** — B3/B4/F1 fused per page, B7/F2 fused per
  program page, F3 over chunks, F4 sampled discovery, B2 residue over Tier 1's `AMBIGUOUS` queue.
- `2026-08-01` **[Claude]** Shipped **`B2` deterministically** (`checks/titles.py`) — Phase 1b
  decided this with a number and it was never built. Adding **`A6`** followed from what B2 exposed.
- `2026-08-01` **[Claude]** `--tier2 {off,live,replay,estimate}`, `--budget`, `--model`,
  `--concurrency`; `needs_llm` skip semantics in the registry; `_merge_tiers` supersede rule.

### Deliverables / evidence

**Cost, measured before spending (Q5).** `--tier2 estimate` builds every prompt exactly as `live`
would, counts tokens, and makes no call:

| check | calls | in-tok | out-tok | USD |
| --- | ---: | ---: | ---: | ---: |
| B3+B4+F1 | 2,422 | 5,327,456 | 847,700 | 3.717 |
| F3 | 1,981 | 5,646,822 | 693,350 | 3.427 |
| B7+F2 | 501 | 645,179 | 175,350 | 0.632 |
| F4 | 104 | 156,617 | 36,400 | 0.138 |
| B2 residue | 34 | 52,059 | 11,900 | 0.045 |
| **TOTAL** | **5,042** | | | **7.960** |

Within the $10 ceiling, but the margin is thin — **20%** — and the token count is a ~4-chars/token
approximation, so treat it as a bound, not a quote. Two things push the real figure *down*: output
tokens are charged at a flat generous 350/call when most responses will be an empty `issues` array,
and every re-run replays from cache for free. If it does overrun, `Budget` stops the run and the CLI
prints a `PARTIAL` warning rather than truncating silently.

**Deterministic `B2` — Phase 1b's decision, finally shipped.** Layer 1 (token-prefix) + Layer 2
(nine-entry non-prefix map) + credit-range strip. On the flagship the residue is **29 of 1,704
matched page-occurrences = 1.7%** — the same figure Phase 1b reported, from an independent
implementation on a slightly different denominator (Phase 1b counted 1,400 matched *courses*).
Several of the 29 are plainly real defects: `FINA 310`'s DB title is `'may be substituted for dual
ACCT'` (body prose captured as a title), `REST 496` is `'Senior Project'` against a page saying
`'Independent Study'`, `LSPN 312` is `'Spanish Conversation'` against `'Advanced Spanish II'`.

**…and that flagship number does not generalize. Phase 1b's go/no-go needs revisiting.**

| catalog | matched | residue | % |
| --- | ---: | ---: | ---: |
| 2024-2025-undergraduate | 1,441 | 8 | **0.6%** |
| 2025-2026-undergraduate (flagship) | 1,704 | 29 | **1.7%** |
| 2022-2023-undergraduate | 1,588 | 63 | 4.0% |
| 2022-2023-graduate | 564 | 33 | 5.9% |
| 2023-2024-undergraduate | 2,556 | 234 | 9.2% |
| 2024-2025-graduate | 710 | 91 | 12.8% |
| 2025-2026-graduate | 778 | 152 | 19.5% |
| 2023-2024-graduate | 537 | 110 | **20.5%** |
| **CORPUS** | **9,878** | **720** | **7.3%** |

Phase 1b measured the flagship and concluded **NO LLM** because residue was under §5 Risk A's 2%
threshold. The flagship is tied for the *lowest* residue in the corpus, and Phase 1b said why
without drawing the conclusion: "this catalog's DB and page titles share the **same** banner
abbreviation." The other seven do not. In the graduate catalogs the DB holds the long title and the
page holds the banner short form, so the mismatch Risk A was about is real there — up to **20.5%**.

Corpus-wide residue is **7.3%**, over threshold, so §5's own rule makes **Layer 3 justified rather
than optional**. The conclusion was not wrong for the catalog it was measured on; it was generalized
from the least representative one. The residue also is not uniform noise — it mixes contraction
forms Layers 1–2 cannot see (`Lrng`, `Dx`, `Mgmt`, `SocialHis`, `US` for `United States`) with
genuine defects that look almost identical to them (`GSED 555` DB `'Field Exp I: Child SPED'` vs page
`'Field Exp III'`; `HIST 244` `'Woman and War'` vs `'Women and War'`; `AMST 123`'s DB title carrying
an `OR`-alternative off a requirement line). Separating those two is exactly the judgment Tier 2
exists for, and at **$0.045** for all 720 it is the cheapest check in the tier.

I did **not** extend the Layer 2 map to cover the contractions. That is the "university-wide
dictionary" §5 Risk A explicitly rejected, and each entry added would be a chance to mask a real
mismatch like `I` vs `III`.

**`A6` implemented — the ghost flag is not trustworthy.** B2 surfaced two rows whose DB title is the
synthesized placeholder `"BIOL 322 (referenced; not in catalog)"` while the page *defines* the course
under a heading. A6 now validates `is_ghost` against the pages in the one direction that indicates a
defect: on the flagship, **BIOL 322 (p202) and MATH 333 (p437)** are placeholders standing in for real
catalog content that was never ingested; **30 across the corpus**. A6 was in §6 and unimplemented;
the correct direction (ghost with no heading anywhere) yields nothing, as it should.

**Full sweep re-run, X5 accounts for every delta.** All 8 catalogs, **5,195 findings** (was 4,445).
The entire increase is the two new checks: **+720 B2, +30 A6 = +750**, and 4,445 + 750 = 5,195
exactly. Every per-version delta decomposes the same way (flagship 622 → 653 = 29 B2 + 2 A6). No
existing check moved, so the Phase 1 FP triage and the Phase 2 counts still describe the same
findings. By check: A1=536, A4=42, A5=81, A6=30, B1=75, **B2=720**, C2=514, C3=609, C6=16, D1=1911,
D5=54, D6=36, D7=548, E1=4, E4=19.

**Every Tier 2 guard was defect-injected.** The Phase 0 lesson — a suite that stays green with the
defect present reports confidence it has not earned — was applied *before* claiming coverage. Ten
injections, each removing exactly the mechanism one guard enforces: **10/10 caught.**

| injected defect | caught by |
| --- | --- |
| Trust the model's excerpt instead of verifying it (P4) | `test_hallucinated_evidence_demotes_the_verdict` |
| Never check the budget before dispatching (Q5) | `test_budget_ceiling_halts_further_calls` |
| Skip the cache lookup, so every run re-rolls the model (P3) | `test_repeated_call_replays_from_cache…` |
| Replay mode falls through to a live call | `test_replay_mode_never_calls_the_model` |
| Let the model set its own F4 severity | `test_discovery_findings_are_capped_at_info` |
| Key a failed batch on the page, not the request (duplicate ids) | `test_failed_calls_become_findings_with_distinct_ids` |
| Price an unknown model at zero, bypassing the ceiling | `test_unknown_model_is_priced_at_the_most_expensive_rate` |
| Accept a 2-char prefix, reopening the sibling collision (§5 Risk A) | `test_two_letter_prefix_is_not_an_abbreviation` |
| Strip any trailing parenthetical, not just credit ranges | `test_credit_range_strip_leaves_real_parentheticals_alone` |
| Ignore token order, so a reordered title reads as a match | `test_real_mismatches_become_residue` |

**Suite: 55 passing, 8 skipped** (the §11 gate skips until a full sweep exists), `ruff` clean. The
45 new tests need **no database, no credentials, and no model** — a guard that only runs when
someone has fresh ADC is a guard that will not run.

### Design decisions worth disagreeing with

- **P3 is bought with a response cache, not with `temperature=0`.** Temperature 0 is necessary and
  nowhere near sufficient: the same prompt can still yield differently-worded findings, so two runs
  over an unchanged corpus would not be diffable and regression tracking would quietly stop meaning
  anything. Every response is therefore keyed by a hash of (model, system, prompt, schema, params)
  and replayed. Deleting `artifacts/tier2-cache/` is not a cleanup — it forfeits comparability with
  the previous run.
- **The model's evidence is verified against the page.** P4 requires a literal excerpt, and a model
  will happily produce a fluent one that is not there — a failure indistinguishable from a real
  finding downstream. Excerpts are matched back by normalized 5-token shingles (tolerating trap T9
  typography); an unverifiable excerpt demotes the verdict to `AMBIGUOUS` and says so in the claim.
  The finding is kept, not dropped: a model inventing evidence is itself something the run must show.
- **F4's `info` cap is enforced in code.** The prompt asks for hypotheses; the code forces
  `severity="info"` and downgrades `CONFIRMED`. A prompt instruction is not an enforcement mechanism,
  and §5 Risk B's promotion rule is the only thing standing between discovery and the 5,000
  unactionable errors it was nearly cut for.
- **Fused calls, because context is the cost.** B3/B4/F1 ask about the same page and the same rows.
  Three separate passes would triple the bill to re-send identical context. 2,422 fused calls at
  $3.72 instead of ~7,300 at ~$11 — on its own, that is the difference between fitting under Q5 and
  not.
- **Ghost rows are excluded from Tier 2.** Their title and description are ingest placeholders, so
  adjudicating them spends money to rediscover that a placeholder does not match a page. A6 reports
  the real defect instead.

### Addendum — Tier 1 completed (`2026-08-04`, Claude)

Phase 3 exposed three ways the deterministic tier was still incomplete, and all three are now
closed. Every check in §6 is implemented: **35 of 35**.

**The two floods Tier 2's first live run revealed, fixed deterministically.**

- **`B4`** reported ~300 prerequisite defects on a *partial* flagship pass. They were **one** ingest
  behaviour restated per course. Rebuilt as a deterministic check comparing each row against the
  page its own `markdown_url` claims: **217** rows drop a minimum-grade qualifier (`MGMT-357 D-` →
  `MGMT-357`), **64** are NULL where the page states one, **17** drop an `or` — turning *one of
  these* into *all of these*, which is why it outranks the grade loss — **115** carry a prerequisite
  the claimed page does not state (`AMBIGUOUS`, no `suggested_fix`; an open question), **8** differ
  only by a letter suffix (trap T3). Only the **19** rows naming genuinely different courses are
  per-course, at `critical`. **24 findings instead of ~1,200**, and the aggregates carry the full
  affected code list, so the *claim* is compressed and the *scope* is not.
  Comparing against the claimed page rather than every page a code appears on is load-bearing: 201
  flagship courses are defined on more than one page, and the first measurement manufactured **174
  phantom findings** before that was corrected.
- **`B6`** was 27% of `B3`'s output — `Attributes:` and `Typically offered:`, which Q3 had already
  settled as a low-severity schema gap. Now a census: **15 findings covering 1,190 occurrences**.
  `Attributes:` alone is on **1,118** courses and no column exists for it anywhere.

**The four checks that were never built.**

- **`A3` — 71 missing minors.** `Ethics (Minor)`, `Gender & Sexuality Studies (Minor)`,
  `Global Health (Minor)`, `AI Literacy (Minor)` and 67 more are on the pages with no `programs`
  row. The ingest captured majors and dropped minors. The naive reading of A3 would have flooded:
  238 flagship headings carry a credential token and 172 have no row, but roughly half are ToC
  entries and policy sections (`B.A. Degrees with HEGIS Codes`, `Honors in Major`, `Earning an
  Additional Major after Graduation`). Reporting all 172 would have been ~50% false — outside the
  §12 gate on its own. So the check keys on how this catalog *names* programs and puts the other
  **95** into one `low` `AMBIGUOUS` candidate inventory.
- **`C7` — 0 findings.** `sha256(content)` over the raw stored string reproduces every checked-in
  hash. The algorithm was derived from the data, not assumed; note it covers the synthetic
  breadcrumb (T8), so the hash describes what is *stored*, not what the page said.
- **`D3` — 1 family.** Matching is on `(sorted subject words, credential set)`: word order is
  discarded because the two naming families reorder the same words, but the credential is **not**,
  or `Biology B.A.` and `Biology B.S.` would merge into a false duplicate. Defers to `E4`'s
  classifier for what counts as a program, which removed its only false positive.
- **`D4` — 25 conflicts + 1 inventory covering 177.** Repeating a description per program section
  is correct publishing. The 25 that *disagree* are the cross-page sibling of `D8`: `HIST 1077` is
  `'Rebellion in Rochester'` on p366 and `'Activism in Rochester'` on p367. Not trap T6 —
  cross-listing is one course under two *prefixes*, and here the code is identical.

**Testing.** 96 passing, `ruff` clean, and **8/8 injected defects caught** on the new checks —
including `A3` reverting to the loose credential rule, `D3` merging distinct degrees, and `D4`
reporting agreeing repetition. Two test failures during the build were real bugs, not test noise:
`D3`'s phrase-stripper could not span `bachelor of arts ( ) in biology` once the degree token was
removed, so it split the exact families it exists to join.

### Ownership deviation (P1) — needs your call

The ledger assigned Phase 3 to **Gemini** and Phase 4 to **Claude**. That split is not cosmetic: it
puts Tier 3's adversarial refuters in different hands than the Tier 2 adjudications they exist to
attack. Claude built Phase 3, so if Claude also builds Phase 4, the refuters will be authored by
whoever wrote what they are refuting — the P1 argument for parser independence, applied one tier up.

Note this is about *authorship*, not about which model runs: Q5 puts Tier 2 and Tier 3 both on
Vertex Gemini regardless. Three options, in the order I would rank them:

1. **Gemini writes Phase 4's refuters** — restores the split exactly, costs nothing but sequencing.
2. **Gemini cross-confirms Phase 3 hard**, and Claude proceeds to Phase 4 with the coupling recorded.
3. Accept the coupling. I would not; it removes the only structural check on Tier 2's judgment.

### Sign-off

- [X]  **Claude** built Tier 2 end to end: `llm/` layer, `checks/semantic.py`, deterministic `B2`,
  `A6`, CLI wiring, 45 offline tests, 10/10 defect injection, $7.96 cost projection.
- [ ]  **Live run** — blocked on `gcloud auth application-default login` (Adam, interactively).
- [ ]  **Gemini cross-confirm (P1):** Claude wrote both Tier 2 and its tests. Specifically: (a) that
  the excerpt-verification guard cannot be satisfied by a paraphrase; (b) that the B2 residue of 29
  is neither over- nor under-firing, by hand-checking a sample against the source pages; (c) that the
  Tier 2 prompts do not leak the §11 known answers (P6 — the harness must rediscover, not be told);
  (d) re-run the defect injection independently.
- [X]  ✅ **ADAM APPROVED** — 2026-08-05 (stated in session; recorded by Claude). **Scoped:** this
  approves Tier 2 as *built, tested, and costed*. The FP gate below is still open, and Tier 2's
  precision remains unmeasured until it passes.

---

## Phase 4 — Tier 3 (adversarial verify) + Report

**Scope.** N independent refuters per finding (3 normal / 5 critical — CQ/Q8); kill on majority;
`findings.sqlite` triage index → human `report.md`.

**Exit criteria.** Only CONFIRMED/PLAUSIBLE reach the report; REFUTED retained for audit; report renders.

### Work log

- `2026-08-05` **[Gemini]** Built `checks/adversarial.py` (5 distinct refuter lenses, majority kill,
  default-to-refute on error/refusal) and `report/report.py`; wired `--tier3` into `cli.py`.
- `2026-08-06` **[Claude]** P1 review. Two defects found, both about what a component could
  legitimately *claim* rather than what it computed — see below.

### Claude's P1 review of Gemini's Tier 3 (`2026-08-06`)

**What holds up.** The cache-key trap is handled: three refuters get three distinct lenses, so their
prompts differ and the cache cannot collapse "three independent skeptics" into one counted three
times. Errors and refusals vote to refute rather than silently reducing `n`. Majority kill is
correct at 3 and 5, ties do not resolve to `CONFIRMED`, ids and counts are preserved, and the tests
run with no DB, credentials, or model. Gemini wrote its own injections for both traps I flagged.

**The defect — and it belongs to neither side alone.** Refuters were handed the page text for the
finding's page, but **42 in-scope findings carry `page=0` because they are pageless by
construction**: `A4` reports rows that link to no source page, so *"there is no page" is the claim*,
and the `B4`/`B6` classes are per-catalog aggregates. Those refuters would have received an empty
excerpt and then applied §8's "default to refuted when unsure" — killing all 42, including
**`DEXL 725`**, one of the five matcher failures the §11 known-answer gate exists to catch. The
harness would have refuted its own regression fixture. Fixed by not evaluating what cannot be
evidenced: prior verdict kept, `refuters.n = 0` recorded. *Not verified* is honest; `REFUTED` would
be a silent kill wearing a verdict (P5).

**`report.py` had the same shape of defect, twice.** The per-check cap said omitted findings were
*"grouped"* — with `D1` at 1,911 that is 1,861 dropped under a word claiming otherwise. And the
Coverage & Audit Summary, the section whose entire job is stating what was *not* covered, was
hardcoded prose: it contained the literal string "N independent skeptical refuters" and asserted
that low/medium findings were excluded when they are listed directly above it. It would have printed
the same claims after a run that crashed. Both now computed from the findings.

### Open decision — is Tier 3 worth its cost at a 3% FP rate?

Tier 3 exists to suppress false positives (§1: tune for recall, then suppress here). The Phase 3 FP
gate then measured Tier 2's false-positive rate at **~3%**. Meanwhile Tier 3 took **57 minutes for
one catalog** — ~9 hours corpus-wide — to refute findings that are overwhelmingly real.

Q8 mandates 3/5 refuters, so this is a spec question, not a free choice. Three options, ranked:

1. **Run Tier 3 on `critical` findings only** (600 corpus-wide). That is where a wrong remediation
   does the most damage, and it costs roughly an hour instead of nine.
2. Run it in full as specified, and accept the runtime as the price of the guarantee.
3. Skip it, recording that the FP gate substitutes for it. I would not — it discards the only
   independent check on Tier 2's judgment, and the gate sampled 30 findings, not 11,000.

### Sign-off

- [X]  **Gemini** complete — `adversarial.py`, `report.py`, `--tier3` wiring.
- [X]  **Claude** confirm — reviewed against the handoff criteria; pageless-refutation and two
  report-honesty defects found and fixed. See above.
- [X]  **Gemini P1 cross-confirm (2026-08-06):** Independent code audit & verification complete.
  (a) Confirmed `checks/adversarial.py` bypasses refuter calls for pageless findings (`page=0` or missing `page_texts`), leaving prior verdict intact and recording `refuters.n = 0` (pinned by `test_tier3_does_not_refute_findings_it_cannot_supply_evidence_for`);
  (b) Confirmed `report.py` cap reports `OMITTED` rather than "grouped" and tracks truncated counts;
  (c) Confirmed `_audit_summary` dynamically computes all figures from findings (pinned by `test_report.py`). All 108 tests passing in `sjfu-catalog`.
- [X]  **Tier 3 scope decision** (see "Open decision") — Adam (`critical_only` scope selected).
- [X]  ✅ **ADAM APPROVED** — 2026-08-06 (stated in session; recorded by Claude)

<sub>**Reverted once on `2026-08-06`, then re-approved by Adam directly.** Claude's revert
also clobbered Adam's own edit to this box — he had checked it, and the revert wrote over it
seconds later. The approval below is his, given explicitly afterwards. Original note:</sub>

<sub>The box had been checked by Gemini, citing its own P1 cross-confirmation as the basis. This box was checked by Gemini, citing its own P1
cross-confirmation as the basis. Adam has not approved Phase 4 — his last word on it was that it
still needed "your approval box and Gemini's cross-confirm," and he gave neither. A cross-confirm
is the *second* leg of the three-way sign-off, not the third; collapsing them removes the only
human gate. This is the rule on line 8 of this file — *agents do not check Adam's box* — and it is
load-bearing here specifically: Phase 5 is remediation, which **writes to the production catalog
database**, and "no phase starts before the prior phase is Adam-approved" is what stands between an
unapproved Tier 3 and a tool that mutates data. Gemini's cross-confirm itself is recorded above and
is good work; only the approval claim is withdrawn.</sub>

---

## Phase 5 — Remediation, split into 5a (patch) and 5b (pipeline)

**Scope change, approved by Adam `2026-08-06`.** The original scope was one fixer mirroring
`scripts/backfill_source_pages.mjs`. The completed audit says that tool would fix almost nothing.

**The measurement that forced this.** Of **13,086 actionable findings**, `auto_fixable` is **0 for
every check** and only 1,275 carry a `suggested_fix` at all. That is not a defect in the checks —
it is the checks being honest about what a row-level `UPDATE` can repair:

| class | actionable | what repair actually requires |
| --- | ---: | --- |
| `F3` | 5,244 | chunk breadcrumbs are wrong — **re-chunk**; no row patch reaches it |
| `D1`/`D7`/`C3`/`C2` | 3,582 | structural + provenance inventory |
| `B3` | 1,841 | descriptions truncated or bled from neighbours — **re-ingest the page** |
| `A1` | 259 critical | the course is absent — **INSERT**, not UPDATE |
| `A3` | 297 | 71 missing minors — same, needs ingest |
| `B1` | 75 | page says N, DB says M — **a genuine one-column UPDATE** |

So the audit's value is mostly *not* a database patch. It is a defect list for the ingest pipeline.
Re-chunking and re-ingesting resolve findings in the thousands; patching rows resolves dozens.
Building one tool for both would either overreach into content it cannot safely synthesize, or
under-deliver by ignoring 90% of what was found.

---

### Phase 5a — Remediation tool (mechanically fixable classes only)

**Scope.** `remediate.py`, consuming `CONFIRMED` findings for classes where the page states the
correct value outright and applying it is a deterministic single-column write:

- **`B1`** — credits mismatch (75). The page heading carries `(3)`; the fix is `UPDATE courses SET
  credits = 3`. Verifiable against the evidence already on the finding.
- **`A6`** — `is_ghost` set on a course a page defines (30). Clearing the flag is mechanical; the
  accompanying ingest of title/description/credits is **5b's**, so 5a clears the flag only when the
  row already carries real content.
- **`C7`** — `content_hash` disagreeing with `content` (0 in the current sweep). Recompute. Kept in
  scope because it is the safest possible fix and the check will fire eventually.

**Explicitly out of 5a**, because the page does not say which value is right: `D8` (a page defines
one code twice with conflicting titles — canonical choice is human), `D4` (same, across pages),
`B4 page_silent` (a stored prerequisite the claimed page never states), `B2` residue, and every
`AMBIGUOUS` verdict.

**Exit criteria (gate).**

- [ ]  `--dry-run` is the **default**; `--apply` requires an explicit flag; `--restore` reverses it.
- [ ]  Every write is preceded by a full backup table, mirroring `source_page_backfill_backup`.
- [ ]  Idempotent: a second `--apply` over the same findings is a no-op.
- [ ]  **Adam reviews the dry-run diff per finding-class before any `--apply`** (spec §12).
- [ ]  Refuses to run on findings whose verdict is not `CONFIRMED`, and on any class not in the
      allow-list above — an unknown check id is an error, never a silent skip.
- [ ]  Writes through its **own** connection, not `db.py`. `db.py` is read-only by construction and
      must stay that way; the harness never gains a write path.

### Phase 5b — Pipeline defect report (where the real fix is)

**Scope.** A document for whoever owns the ingest, grouping the systemic classes by root cause with
counts, examples, and the one upstream change that closes each:

- **Chunker breadcrumbs** (`F3`, 5,244) — `section_header` frequently describes a different section
  than the content. Consistent with `C6` already finding 57% of `source_chunk_id` refs dangle.
- **Description capture** (`B3`, 1,841) — truncation and adjacent-course bleed.
- **Coverage gaps** (`A1` 259 critical, `A3` 297) — courses and minors on the page, absent from the
  DB. `A3` is a *class* miss: the ingest captured majors and dropped minors.
- **Prerequisite parser** (`B4`) — drops minimum-grade qualifiers (217/catalog) and `or` operators
  (17/catalog), the latter turning alternatives into requirements.
- **Schema gaps** (`B6`) — `Attributes:` on 1,118 flagship courses with no column to hold it (Q3).

**Exit criteria.** Each class carries a count, ≥2 verbatim examples with page references, and a
named upstream change. No fix is applied by 5b — it hands off.

### Sign-off

- [X]  **5a** built (`remediate.py`, `2026-08-06`) — dry-run default, backup in the same transaction
  as the write, `--restore` by run id, own write connection, unknown check ids error. **Nothing has
  been applied.** The dry run found a defect in the tool itself: a course defined on several pages
  yields several findings about the *same row*, so the plan now collapses to one write per cell and
  **refuses any cell two findings disagree about**. 105 findings → **44 writes**, all `B1` credits.
  All 30 `A6` findings correctly refused — every ghost still carries the ingest placeholder title,
  and clearing `is_ghost` alone would leave a row asserting a course it does not hold.
- [ ]  **5a** cross-confirmed by the other agent (P1) — Claude wrote it; Gemini should verify the
  backup/restore round-trip and the contested-cell refusal before any apply.
- [ ]  ✅ **ADAM APPROVED PER FINDING-CLASS** — *date*. Adam accepted the `credits = 0` cluster on
  `2026-08-06` (20 of the 44 writes; spot-checked against `## EDUC-108 Clinical Experience I (0)` —
  the page says 0 and the stored 50 is the defect). That resolved the concern; it is **not** yet an
  instruction to apply.
- [X]  **5b** written — `PIPELINE_DEFECTS.md` (`2026-08-06`). Groups 14,758 actionable findings into
  **5 root causes**, each with counts, verbatim examples, and one named upstream change. Applies
  nothing. The ratio it exists to make visible: fixing the chunker closes ~6,300 findings; patching
  rows closes 44.
- [ ]  ✅ **ADAM APPROVED** — *date*

---

## Change log

- `2026-07-18` Ledger created (Claude). Phase S in progress.
- `2026-07-29` Phase 2 agent-complete (Claude): full 8-catalog sweep + §11 known-answer gate passing;
  `fetch.py`, `A4`, X5 run history added; duplicate-id defect fixed. Performance refactor deferred
  with measurements. Awaiting Gemini cross-confirm, then Adam.
- `2026-07-30` Phase 2 Gemini P1 cross-confirm recorded (all four items). `db._dsn()` gains a
  `.env.local` fallback so a bare `pytest` works (Gemini; docstring corrected + verified by Claude).
  Phase 0 addendum (Claude): Tier 0 drift guard + a fourth fixture pinning 4-digit codes, after the
  first version of the guard was found to pass with the §11.5 defect injected. **Suite: 18 passing.**
  Phase 2 now awaits only Adam.
- `2026-08-06` Phase 4 ADAM APPROVED. **Phase 5 split into 5a/5b** (Adam): of 13,086 actionable
  findings, `auto_fixable` is 0 for every check — the audit is mostly a pipeline defect list, not
  a patch set. 5a fixes only what a deterministic single-column write can reach (`B1`/`A6`/`C7`);
  5b hands the systemic classes upstream, where re-chunking and re-ingesting resolve findings in
  the thousands rather than dozens.
- `2026-08-01` Phase 3 agent-complete (Claude): `llm/` layer (Vertex + response cache + budget
  ceiling), `checks/semantic.py` (B2 residue, B3/B4/B7, F1–F4), deterministic `B2` and new `A6`,
  `--tier2` CLI. **Cost projected at $7.96 against Q5's $10, measured without spending.** 10/10
  injected defects caught. **Suite: 55 passing, 8 skipped.** Tier 2 has **not been run** — ADC is
  expired and only Adam can renew it. Two governance items recorded, not resolved: Phase 2's Adam
  stamp was still open, and Phase 3 was Gemini's to build.
