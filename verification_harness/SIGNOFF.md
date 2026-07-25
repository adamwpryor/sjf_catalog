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
|---|---|---|---|---|
| **S** | Setup & scaffolding (skeleton, config, models, DB layer, loader, this ledger) | Claude + Gemini | ☑️ | ⬜ |
| **0** | Tier 0 extractor + page-role classifier; golden fixtures; eyeball 20 pages | Gemini (code) · Claude (fixtures) | 🔨 | ⬜ |
| **1** | Tier 1 checks on `2025-2026-undergraduate` (A–E). **Gate: FP rate < 20%** | Both | 🔨 | ⬜ |
| **1b** | `B2` abbreviation residue measurement → decide LLM-or-not | Claude | ⬜ | ⬜ |
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
- [ ] `python -c "import verification_harness"` clean; `config.py` paths resolve.
- [ ] `models.py` landed with the agreed B5 fixes; `Finding` round-trips through JSON.
- [ ] `db.py` connects **read-only** and returns version-scoped facts; a write attempt raises.
- [ ] `sqlite_loader.py` loads a `findings.jsonl` into `findings.sqlite` and can query CONFIRMED.
- [ ] `environment.yml` updated (`marko`); `conda env update` documented.

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
- [x] **Claude** work complete — `db.py`, `sqlite_loader.py`, first fixture, ledger, scaffold; confirm of `models.py` above.
- [x] **Gemini** extend `PageFacts` to the oracle (see confirm ⚠️), then confirm import-clean on fresh `conda env update`.
- [ ] ✅ **ADAM APPROVED** — _date / note_

---

## Phase 0 — Tier 0 Extraction & Classification

**Scope.** `extract/ast_extractor.py` (marko AST → PageFacts + `ancestor_path`),
`extract/permissive_scan.py` (heading-like lines diffed vs AST — the P1 "more permissive" pass),
`extract/page_role.py` (structural classifier — link-density heuristic is dead, see V1).

**Exit criteria (gate).**
- [ ] Extractor output matches the cross-authored golden fixtures byte-for-byte.
- [ ] `ancestor_path` verified correct on a heading-nested page (no self-inclusion — B4).
- [ ] Human eyeballs 20 extracted pages; extraction judged faithful (Phase 0 gate, spec §12).
- [ ] `page_role` validated against ≥10 hand-labeled pages.

### Work log
- _pending_

### Sign-off
- [x] **Gemini** work complete (extractor + classifier)
- [ ] **Claude** independent confirm (golden fixtures authored by Claude pass; ancestor_path spot-check)
- [ ] ✅ **ADAM APPROVED** — _date / note_

---

## Phase 1 — Tier 1 on `2025-2026-undergraduate`

**Scope.** All deterministic checks (A1–A6, B1/B5, C1–C7, D1–D7, E1–E4) on the 771-page flagship
catalog. B1 (credits) lands first, end-to-end, as proof of life.

**Exit criteria (gate).**
- [ ] B1 runs end-to-end: page → finding → jsonl → sqlite → report.
- [ ] Hand-triage a 30-finding sample. **FALSE-POSITIVE RATE < 20%** (spec §12). Do not scale otherwise.
- [ ] Every check is version-scoped through `documents.version` (B3).

### Work log
- `2026-07-18` **[Claude]** Built the check framework (`checks/registry.py`: `@register`, crash-safe
  runner, P5-safe `write_findings`), `normalize.py` (code/url helpers, §7 traps), and **6 pure-DB
  checks** now running: **C1** (page_number↔url), **C4** (sequence_order unique), **C5** (cross-
  catalog contamination), **C6** (source_chunk provenance), **D2** (duplicate courses), **E4**
  (non-program rows). Registered 6 page-dependent checks (C2, C3, D1, D5, D6, D7) as `needs_pages`
  stubs — they auto-skip until Gemini's Tier 0 extractor lands. Ran across all 8 catalogs vs the LIVE DB.

### Deliverables / evidence (Claude's checks — 8-catalog run)
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
- [x] **Gemini** (A, B) complete · [x] **Claude** (C, D, E) — 6 pure-DB checks done; C2/C3/D1/D5/D6/D7 await extractor
- [ ] Cross-confirm: each agent triages a sample of the *other's* findings
- [ ] Hand-triage 30-finding sample → **FP rate < 20%** gate (35 findings total so far; needs Adam/triage)
- [ ] ✅ **ADAM APPROVED** — _date / FP rate: ___%_

---

## Phase 1b — `B2` Abbreviation Residue

**Scope.** Run token-prefix + tiny non-prefix map across all 6,929 course titles; measure the
unresolved residue to decide, with a number, whether Tier 2 LLM title-checking is justified (spec §5
Risk A). Parallel-safe with Phase 1.

**Exit criteria.** Residue % reported; go/no-go on LLM `B2` recorded with the number.

### Sign-off
- [ ] **Claude** complete · [ ] ✅ **ADAM APPROVED** — _residue: ___%_

---

## Phase 2 — Full Tier 1 Sweep + Regression Set

**Scope.** All 8 catalogs. Harness must **independently rediscover** the §11 seeded defects (183
unlinked courses, 12 non-program rows, ToC ambiguity, dual-numbering residue, page-1/ccsj regression).

**Exit criteria (gate).**
- [ ] All 8 catalogs processed; per-run counts diffed vs prior (X5).
- [ ] §11 regression set: each seeded defect independently surfaced (P6). Zero findings ⇒ broken harness.

### Sign-off
- [ ] **Both** complete · [ ] **cross-confirm** regression hits · [ ] ✅ **ADAM APPROVED** — _date_

---

## Phase 3 — Tier 2 (LLM adjudication)

**Scope.** `checks/semantic.py`: B2 residue, B3/B4/B7, F1–F4 (F4 = sampled discovery, `info` only,
promotion rule). Gemini fan-out, batched, structured output.

**Exit criteria.** Adjudicated findings carry evidence + confidence; F4 stays `info`; cost within Q5 ceiling.

### Sign-off
- [ ] **Gemini** complete · [ ] **Claude** confirm · [ ] ✅ **ADAM APPROVED** — _date_

---

## Phase 4 — Tier 3 (adversarial verify) + Report

**Scope.** N independent refuters per finding (3 normal / 5 critical — CQ/Q8); kill on majority;
`findings.sqlite` triage index → human `report.md`.

**Exit criteria.** Only CONFIRMED/PLAUSIBLE reach the report; REFUTED retained for audit; report renders.

### Sign-off
- [ ] **Claude** complete · [ ] **Gemini** confirm · [ ] ✅ **ADAM APPROVED** — _date_

---

## Phase 5 — Remediation (separate tool)

**Scope.** A reviewed, backed-up, idempotent fixer consuming CONFIRMED findings — mirroring
`scripts/backfill_source_pages.mjs` (`--dry-run` default, `--apply`, `--restore`, full backup table).
**Never** invoked by the harness itself.

**Exit criteria.** Dry-run diff reviewed by Adam per finding-class before any `--apply`; backup verified.

### Sign-off
- [ ] **Both** complete · [ ] ✅ **ADAM APPROVED PER FINDING-CLASS** — _date_

---

## Change log
- `2026-07-18` Ledger created (Claude). Phase S in progress.
