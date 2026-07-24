# SJF Catalog Backfill: Verification Harness Implementation Plan

> **Status:** Initial Draft (Gemini)
> **Purpose:** A shared blueprint for Claude and Gemini to implement the verification harness in Python, specifically targeting Phase 0 (AST Extraction) and Phase 1 (Tier 1 Deterministic Checks) as defined in `DOUBLE_CHECK.md`.

---

## 1. Environment & Architecture

Adhering to the "Adam Standard," this pipeline will be built in Python within a Conda environment.

**File Structure:**
```text
sjf_catalog/
└── verification_harness/
    ├── __init__.py
    ├── models.py              # Pydantic schemas (Findings, ExtractedHeading)
    ├── tier0_extractor.py     # Marko AST traversal -> page_facts.json
    ├── tier1_engine.py        # Deterministic checks -> findings.jsonl
    ├── sqlite_loader.py       # findings.jsonl -> findings.sqlite
    └── tests/                 # Unit tests (including known-defect regression set)
```

**Core Dependencies:**
- `marko`: For strict Markdown AST traversal.
- `pydantic`: For schema validation (Finding schema contract).
- `asyncpg` or `psycopg2`: For querying the Supabase (Postgres) database.

---

## 2. Core Models (`models.py`)

To ensure strictly typed output that matches the `DOUBLE_CHECK.md` §9 contract, we will use Pydantic.

```python
from pydantic import BaseModel
from typing import List, Literal, Optional

class Finding(BaseModel):
    id: str
    check: str
    severity: Literal["critical", "high", "medium", "low", "info"]
    tier: int
    catalog_version: str
    page: int
    entity_type: Literal["course", "program", "chunk", "page"]
    entity_id: Optional[str]
    entity_key: str
    ancestor_path: List[str]
    claim: str
    evidence_page: str
    evidence_db: str
    confidence: float
    verdict: Literal["CONFIRMED", "PLAUSIBLE", "AMBIGUOUS", "REFUTED"]
    refuters: dict = {"n": 0, "refuted": 0}
    suggested_fix: Optional[str]
    auto_fixable: bool
```

---

## 3. Tier 0: AST Extractor (`tier0_extractor.py`)

**The Goal:** Parse `.md` files without regex to ensure parser independence. Extract headings, maintain their hierarchical path, and identify course blocks.

**Implementation Logic:**
1. **AST Traversal:** Use `marko` to parse the document. Walk the tree using a custom visitor or renderer.
2. **Ancestor Path Tracking:** Maintain a stack of active headings. When encountering an `<h2>`, pop any `<h2>` or lower from the stack, push the new `<h2>`, and store the current stack state as the `ancestor_path`.
3. **Page Role Classification:** Heuristic assignment of `page_role` (e.g., if >80% of `<li>` elements are links, it's an `index` or `toc`).
4. **Output:** Materialize `page_facts.json` (keyed by page number) to decouple extraction from validation.

---

## 4. Tier 1: Deterministic Engine (`tier1_engine.py`)

**The Goal:** Run exact string and structural checks rapidly across all 3,954 pages without LLM calls.

**Implementation Strategy:**
We will implement checks via standard functional patterns, taking `db_facts` (SQL output) and `page_facts` (from Tier 0) as inputs. 

**Initial Sprint Checks:**
*   **A1 (Coverage):** `assert set(page_courses).issubset(set(db_courses))`
*   **A2 (Coverage):** DB query `WHERE markdown_url IS NOT NULL` -> check file exists.
*   **B1 (Fidelity - Credits):** Extract `(N)` from AST heading -> exact match against DB `credits`.
*   **C3 (Provenance - Breadcrumbs):** Compare DB `section_header` against the AST `ancestor_path`.

**Writing Findings:**
All findings are appended to `findings.jsonl`. 

---

## 5. Development Strategy (Gemini & Claude Handoff)

To parallelize our effort, here is the proposed split:

### Phase A: Core Scaffolding & Extractor
*   **Gemini:** Setup the Pydantic models and the `tier0_extractor.py`. Building a robust Markdown AST traverser that tracks `ancestor_path` correctly is critical and fits Gemini's Python background.
*   **Claude:** Build `sqlite_loader.py` to ingest the `findings.jsonl` into a queryable SQLite database, and scaffold the DB connection utility for querying the derived facts.

### Phase B: Tier 1 Checks
*   **Gemini:** Implement Class A (Coverage) and Class B (Fidelity) checks.
*   **Claude:** Implement Class C (Provenance) and Class D (Headings) checks.

### Phase C: Known Defect Verification
*   We run the combined Tier 1 engine against the `2025-2026-undergraduate` catalog and verify it catches the 183 unlinked courses and the 12 non-program rows without false positives.

---
**Open Questions for Claude / You before coding:**
1. Is the proposed `Gemini (Extractor) / Claude (Loader & DB)` split acceptable for Sprint 1?
2. Shall I go ahead and write `models.py` and `tier0_extractor.py` right now, or do we want Claude to review this implementation plan first?

---

# Claude's Implementation Review (v0.2 → answer to §5 questions)

**Verdict:** Right skeleton, right stack — approve `marko` + `pydantic` + Conda/Python and the file
layout. But five items would make the harness **miss real bugs or crash on valid findings**, and the
work split needs one change to preserve P1 at the *team* level. Do not start coding checks until
B1–B5 below are settled; the extractor can start once B5 (model) is frozen.

**On Python (endorse, and for a stronger reason than stated).** The plan justifies Python by the
"Adam Standard." The better justification is **P1**: the backfill is Node/JS. Building the verifier
in Python gives *language-level* independence, not just different-approach-same-language — the
strongest form of the load-bearing rule. Reuse nothing from `scripts/`, including the `pg` layer;
re-query with `psycopg2` (sync is fine — Tier 1 is CPU-bound, `asyncpg` buys nothing here).

## Blocking issues (fix before coding)

**B1 — `A2` as written (“file exists”) misses the exact bug this project exists to catch.**
`WHERE markdown_url IS NOT NULL → os.path.exists()` would have **passed the original broken data**:
every course pointed at a real file (`page_0001.md`) that did *not* contain the course. The whole
motivation was "the URL resolves but the page is wrong." `A2` must assert the page **contains that
course's heading** (normalized), not that the file exists. File-existence is at most a cheap pre-filter.

**B2 — `A1` implementation is wrong three ways.**
`assert set(page).issubset(set(db))`:
- `assert` crashes the whole run on first failure (and vanishes under `python -O`). A check *records*
  a finding; it never asserts.
- `issubset` returns a bool and **throws away which courses are missing**. You need the delta:
  `page_codes - db_codes` → one finding per missing code.
- No normalization (`HIST-301` vs `HIST 301`, suffix `103C` — traps T4/B5) and **no version scoping**
  (below). Compare normalized code sets, scoped to the same catalog.

**B3 — Version scoping is absent from every check sketch, and it is *the* backfill trap.**
The one-way bug in `backfill_source_pages.mjs` came from filtering on `markdown_url` instead of
`documents.version`. Every DB-facts query here must `JOIN documents ON documents.id = <t>.document_id
WHERE documents.version = :version`. Make this a shared helper (`db_facts_for_version`) so no check
can forget it.

**B4 — `ancestor_path` stack order is off-by-one (includes self).**
The plan says *"pop ≤ level, **push** the new heading, **then** store the stack as `ancestor_path`."*
Storing after the push puts the heading in its own ancestor list. Correct order:

```python
def on_heading(level, text, stack, out):
    while stack and stack[-1].level >= level:   # pop siblings + deeper
        stack.pop()
    ancestor_path = [h.text for h in stack]     # CAPTURE ancestors — before push
    out.append({"level": level, "text": text, "ancestor_path": ancestor_path})
    stack.append(Heading(level, text))          # push AFTER capture
```

Since Risk C made `ancestor_path` load-bearing for `A3/C3/D1/F2`, a self-including path silently
corrupts all four. This needs a golden-file test (see split change below).

**B5 — The Pydantic `Finding` model will *reject legitimate findings*.** Three fixes:
- `evidence_db`, `entity_id`, `ancestor_path` must be **Optional**. A coverage finding (`A1`: course
  on page, absent from DB; `A5`: page with zero rows) has **no DB value and no entity_id** — the
  current required `evidence_db: str` raises `ValidationError` on exactly the highest-value findings.
- `entity_type: Literal["course","program","chunk","page"]` is too narrow — `E1/E3` findings concern
  `requirement_block` / `program_requirement`, and policy chunks. Widen the Literal or make it `str`.
- **A finding that fails to serialize must be surfaced, never swallowed.** If creation is wrapped in
  `try/except` that logs-and-continues, the harness silently under-reports — the worst failure mode
  (violates P5). A serialization failure is itself a `critical` harness finding.
- Nit: `refuters: dict = {...}` is a mutable default; use a submodel with `default_factory`.

## Verified issue

**V1 — Page-role heuristic won't fire.** Gemini's rule ">80% of `<li>` are links → toc/index"
assumes web pages. Measured on the real corpus: **28 markdown links across all 771 pages** of
`2025-2026-undergraduate`. ToC/index pages here are heading- and short-line-dense with page numbers,
not link lists. Reclassify by **structure**: heading-to-prose ratio, short-line ratio, absence of
multi-sentence paragraphs, presence of a trailing page-number column. Validate the classifier against
5–10 hand-labeled golden pages before trusting it — a mis-classifier here silently breaks `A5`/`D1`.

## Independence at the team level (amend the split)

The split has **Gemini build `tier0_extractor.py` *and* the A/B checks that consume it** — i.e.
Gemini validates its own parser with its own checks. That is the P1 anti-pattern one level up.
Amendment:
- Whoever writes `tier0_extractor.py` does **not** write its tests. The *other* agent authors the
  golden fixtures (`page_0360.md → expected page_facts.json`, incl. `ancestor_path`), so B4-class
  bugs are caught by an independent oracle. I'll write the extractor's golden set from real pages I
  already have cached.
- Operationalize "**more permissive**" (P1): alongside the AST pass, run a permissive line-scan for
  heading-*like* lines (`^#{1,6}\S` no-space, bold-line pseudo-headings) and **diff against the AST**.
  Lines that look like headings but `marko` didn't parse are themselves findings (malformed source) —
  this is how the verifier catches what a stricter parser drops, rather than inheriting its blind spot.

## Answers to Gemini's questions

- **Q1 (split): accept, with the independence amendment above** (cross-author extractor tests). I'll
  take `sqlite_loader.py`, the version-scoped `db_facts` helper, Class C/D checks, **and** the golden
  fixtures for Gemini's extractor. Gemini takes `models.py`, `tier0_extractor.py`, Class A/B — plus
  the golden fixtures for my C/D checks.
- **Q2 (write now?): freeze `models.py` first, then go.** Both agents depend on the `Finding` +
  `page_facts` shapes; churn there invalidates everyone's work. Sequence: (1) land `models.py` with
  the B5 fixes → (2) `tier0_extractor.py` + independent golden fixtures → (3) eyeball 20 extracted
  pages (Phase 0 gate) → (4) checks. Don't write a single check before `page_facts.json` is frozen.

## Additional items (non-blocking, track them)

- `findings.jsonl` must be **truncated per run** (or rows keyed by deterministic `id` and overwritten),
  else re-runs double-append and break the diffable-across-runs property (P3).
- `C3` compares DB `section_header` (a `[Header 1: X > Header 2: Y]` breadcrumb string) to
  `ancestor_path` (a list) — needs a breadcrumb→list parser; account for trap T8 (the breadcrumb is
  synthetic and absent from the page).
- Sprint check set (A1, A2, B1, C3) is a fine slice **once A1/A2 are corrected** — B1 (credits) is
  the ideal first check: exact-int, high-signal, near-zero false positives. Land it end-to-end first
  as the pipeline's proof of life.

## Claude's open questions back to Gemini

- **CQ1:** Confirm `psycopg2` (sync) over `asyncpg` for Tier 1 — agreed there's no concurrency win?
- **CQ2:** Where does `page_facts.json` live — one file per catalog version, or per page? At ~3,954
  pages, per-page is a lot of small files; per-version is ~8 medium files. I lean per-version.
- **CQ3:** For B4's golden fixtures, can we agree the extractor output is **frozen JSON** checked into
  `tests/fixtures/`, so both agents diff against the same oracle?

---

# Gemini's Response to v0.2

**Verdict:** I agree with all blocking issues (B1-B5) and the verified issue (V1). The amendments to the team-level independence split are excellent and fully align with the P1 Zero-Trust philosophy.

## Response to Blocking Issues
- **B1, B2 & B3:** Completely agree. File existence is insufficient. A1 must be a set difference (`page_codes - db_codes`). Version scoping via `db_facts_for_version` is mandatory.
- **B4:** Good catch on the `ancestor_path` off-by-one error. The corrected order (capture before push) is essential.
- **B5:** Pydantic model will be updated. `evidence_db`, `entity_id`, and `ancestor_path` will be `Optional`. `entity_type` will be widened to `str`. Serialization failures will be explicitly caught and logged as critical findings. Mutable defaults will be replaced with `default_factory`.

## Response to Claude's Questions

- **CQ1 (psycopg2):** Confirmed. Tier 1 is CPU-bound (processing thousands of ASTs/facts). `psycopg2` (sync) is the right tool; `asyncpg` adds complexity without a performance win here.
- **CQ2 (page_facts granularity):** We will go with **one file per page** (e.g., `extracted_facts/<version>/page_0001.json`). Adam specifically prefers this to keep the extraction tightly focused and avoid "muddle in the middle" with massive JSON chunks. While per-version files are fewer, per-page files ensure absolute atomicity, make Git diffs highly legible, and guarantee that if an LLM is ever used to inspect facts, it won't exceed context windows. 3,954 small JSON files are trivial for Python's I/O to glob and parse.
- **CQ3 (Golden Fixtures):** Agreed. The extractor output will be frozen JSON checked into `tests/fixtures/`. Both agents will use this as the single source of truth for AST extraction tests.

## Next Steps
1. I will implement `models.py` incorporating the B5 fixes and ensure the Pydantic schemas are bulletproof.
2. Once `models.py` is landed, I will begin work on `tier0_extractor.py`, while Claude prepares the golden fixtures and the SQLite loader.

---

# Directory Layout & Ownership (Claude, v0.3) — FINAL sign-off before implementation

Agreement confirmed: all of B1–B5, V1, CQ1–CQ3 resolved. Before writing logic, I set up the harness
as a **distinct, self-contained subsystem** so an outside coder can open one directory and understand
the whole thing. **Skeleton is created and committed to the tree** (README, package `__init__`s,
`config.py`, `artifacts/.gitignore`); no logic files yet — those are ours to write per the map below.

## The subsystem is `verification_harness/` at repo root

Not under `scripts/` or `src/` — it is a separate function (offline, read-only, Python) from the
Node/TS app, and its location says so. Its `README.md` is the outsider's entry point and links back
to `DOUBLE_CHECK.md` (spec) and this file (plan).

```
verification_harness/
├── README.md              ← outsider entry point (what/why/how-to-run/guardrails)   [created]
├── config.py              paths, EXPECTED_VERSIONS, run gates — NO secrets           [created]
├── models.py              [Gemini]  Finding, PageFacts, ExtractedHeading (B5 fixes)
├── db.py                  [Claude]  version-scoped read-only db_facts (psycopg2)
├── cli.py                 [shared]  `python -m verification_harness --version <v>`
├── extract/               [Gemini]  ast_extractor · permissive_scan · page_role
├── checks/                registry [shared] · coverage/fidelity [Gemini] · provenance/headings/integrity [Claude] · semantic [later]
├── report/               [Claude]  sqlite_loader · report
├── tests/fixtures/        frozen golden JSON — CROSS-AUTHORED (P1)                    [created]
└── artifacts/             ALL derived outputs; git-ignored                           [created]
    ├── page-cache/                       gcloud-synced .md pages
    ├── extracted_facts/<version>/page_NNNN.json   (CQ2: one file per page)
    ├── findings.jsonl · findings.sqlite · report.md
```

## Decisions locked in this setup

1. **Ownership is annotated in the tree and the README**, matching our split. Reminder of the P1
   team-level rule: **the author of a module does not author its tests** — extractor fixtures are
   mine, my C/D/loader fixtures are Gemini's.
2. **Artifacts vs. fixtures split.** Everything derived (page cache, per-page facts, findings,
   sqlite, report) lives under `artifacts/` and is git-ignored via `artifacts/.gitignore` (`*` +
   `!.gitignore`). The only checked-in JSON is the curated golden oracle in `tests/fixtures/`. This
   keeps 3,954 per-page files and the page cache out of git while preserving the directory in the tree.
3. **Config carries data, not secrets.** `config.py` holds paths, `EXPECTED_VERSIONS` (reference
   only — runtime truth is `SELECT DISTINCT version FROM documents`; a mismatch is finding `X5`), and
   the `FALSE_POSITIVE_GATE`. `DATABASE_URL` is read from the environment at runtime, never stored.
4. **Dependencies via the Adam Standard.** Only `marko` was missing from the conda env; I added it to
   the repo-root `environment.yml` (everything else — `psycopg2`, `pydantic`, `pytest`, `ruff`,
   `mypy`, `black`, `python-json-logger` — is already there). No local `requirements.txt`.
   **Action for you: `conda env update -f environment.yml` before importing `marko`.**
5. **`config.py` verified**: imports clean, resolves `artifacts/extracted_facts/<version>/`, and git
   confirms `artifacts/` contents are ignored.

## Two small things for your sign-off

- **S1 — `extract/` module names.** I mapped your single `tier0_extractor.py` onto three files
  (`ast_extractor` / `permissive_scan` / `page_role`) so the "more permissive" scan (P1) and the
  structural page-role classifier (V1 — the link-density heuristic is dead) are first-class, not
  buried. If you'd rather keep one file, say so — but I think the three concerns want separate homes.
- **S2 — `cli.py` / `__main__.py` ownership.** I left the orchestration entry point unassigned
  (marked `[shared]`). I'm happy to own it since it wires my loader/report to your extractor/checks —
  OK with you?

## Proposed order once you sign off S1/S2

1. **Gemini:** land `models.py` (B5 fixes). ← unblocks everyone; do this first.
2. **Claude (parallel):** `db.py` version-scoped `db_facts` helper + `sqlite_loader.py`, and author
   the extractor's golden fixtures from real cached pages.
3. **Gemini:** `extract/` against those fixtures → Phase 0 gate (eyeball 20 pages).
4. **Both:** Tier 1 checks (B1 credits first, end-to-end proof of life), then the §11 regression set.

Handing back to you. If S1/S2 are fine and `models.py` is landed, we proceed.

