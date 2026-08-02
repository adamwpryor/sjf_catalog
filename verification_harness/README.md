# verification_harness/

**A standalone, read-only audit subsystem for the SJF catalog.** It compares the source catalog
pages (ground truth, in Google Cloud Storage) against the derived Supabase database — page by page —
and reports every discrepancy it can find. It is a distinct function within this repo: it does not
serve the app, and it **never writes to the catalog database**.

> **New here? Read this file, then [`../DOUBLE_CHECK.md`](../DOUBLE_CHECK.md) (the spec) and
> [`../DOUBLE_CHECK_IMPLEMENTATION.md`](../DOUBLE_CHECK_IMPLEMENTATION.md) (the build plan).**

---

## Why this exists

Every row in the catalog database is a *derived artifact* of a scrape-and-parse pipeline that has
already been proven lossy in several distinct ways (course codes silently dropped, everything mapped
to page 1, program URLs fabricated, staff bios ingested as programs). This harness answers one
question exhaustively:

> For every source page, does the database faithfully and completely represent what is on that page —
> and does every database row correspond to something that actually exists on the page it claims?

It tunes for **recall** (catch as many real errors as possible), then suppresses false positives
with adversarial verification rather than by weakening checks.

## How it relates to the rest of the repo

| | This harness | The app (`src/`, `scripts/`) |
|---|---|---|
| Language | **Python** (Conda) | Node / TypeScript |
| Role | Offline QA / audit | Runtime product + data backfill |
| DB access | **Read-only** | Read/write |
| Ground truth | The GCS `.md` pages | — |

The Python/Node split is deliberate. **Design Principle P1:** a verifier must not share parsing code
with the thing it verifies, or it validates its own blind spots. The backfill
(`../scripts/backfill_source_pages.mjs`) is Node + regex; this harness is Python + Markdown-AST. It
imports **nothing** from `../scripts` or `../src`.

---

## Directory map

```
verification_harness/
├── README.md              ← you are here
├── config.py              paths, catalog-version reference data, run gates (NO secrets)
├── models.py              [Gemini]  Pydantic contracts: Finding, PageFacts, ExtractedHeading
├── db.py                  [Claude]  version-scoped read-only DB facts (psycopg2)
├── fetch.py               [Claude]  GCS → artifacts/page-cache/ sync (incremental, ADC, read-only)
├── cli.py                 [shared]  orchestration entry point (fetch → extract → check → load → report)
│
├── extract/               ── Tier 0: source pages → structured facts ──
│   ├── ast_extractor.py     [Gemini]  marko AST walk → PageFacts (headings + ancestor_path)
│   ├── permissive_scan.py   [Gemini]  permissive line-scan diffed vs AST (catches malformed headings)
│   └── page_role.py         [Gemini]  structural page-role classifier (content/toc/index/…)
│
├── checks/                ── Tier 1: deterministic diff ──
│   ├── registry.py          [shared]  check registration + runner (needs_pages / needs_llm skips)
│   ├── coverage.py          [Gemini]  A1, A2, A4, A5 · [Claude] A6 (is_ghost validation)
│   ├── fidelity.py          [Gemini]  B1, B5
│   ├── titles.py            [Claude]  B2 — layered abbreviation resolution (§5 Risk A)
│   ├── provenance.py        [Claude]  C1–C6
│   ├── headings.py          [Claude]  D1, D2, D5–D7
│   ├── integrity.py         [Claude]  E1–E4
│   └── semantic.py          [Claude]  ── Tier 2: LLM adjudication ──
│                                      B2 residue, B3+B4+F1 (fused), B7+F2 (fused), F3, F4
│
├── llm/                   ── the only path to a model; nothing else calls Vertex ──
│   ├── client.py            [Claude]  Vertex via ADC; live / replay / estimate / fake modes
│   ├── cache.py             [Claude]  content-addressed response cache — this is what buys P3
│   └── budget.py            [Claude]  token accounting + the hard $10 ceiling (Q5)
│
├── report/                ── outputs ──
│   ├── sqlite_loader.py     [Claude]  findings.jsonl → findings.sqlite (triage index)
│   ├── run_history.py       [Claude]  X5 — snapshot each sweep, diff against the previous run
│   └── report.py            [Claude]  findings.sqlite → report.md
│
├── tests/
│   ├── fixtures/            frozen golden JSON — CROSS-AUTHORED (extractor's oracle, per P1)
│   └── test_known_answers.py  §11 known-answer gate (P6) — run after a full sweep
│
└── artifacts/             ── all derived outputs; GIT-IGNORED ──
    ├── page-cache/           source .md pages, synced by fetch.py
    ├── extracted_facts/<version>/page_NNNN.json   one file per page (Tier 0 output)
    ├── findings.jsonl        append-only interchange format (all tiers write here)
    ├── findings.sqlite       derived triage index
    ├── run_history.jsonl     one snapshot per sweep (corpus counts + findings + git sha)
    └── report.md             human-readable report
```

`[Gemini]` / `[Claude]` mark current build ownership. Per P1, **the author of a module does not write
its tests** — the golden fixtures under `tests/fixtures/` are authored by the *other* agent.

## Data flow

```
GCS pages ──sync──► artifacts/page-cache/
                          │
              Tier 0 (extract/) ──► artifacts/extracted_facts/<version>/page_NNNN.json
                          │
   Supabase ──db.py──► db_facts (version-scoped, read-only)
                          │
              Tier 1 (checks/) ──► artifacts/findings.jsonl
                          │
   Tier 2/3 (semantic + adversarial verify, later) ──► findings.jsonl
                          │
       report/sqlite_loader.py ──► findings.sqlite ──► report/report.py ──► report.md
```

## Running it

```bash
conda activate sjfu-catalog                          # deps live in ../environment.yml
# DATABASE_URL + GOOGLE_APPLICATION_CREDENTIALS are read from ../.env.local (never committed)

# full sweep: fetch the source pages, then audit all 8 catalogs (~30s + ~40s on a cold cache)
python -m verification_harness --all --sync

# one catalog, or one class of check while iterating
python -m verification_harness --version 2025-2026-undergraduate
python -m verification_harness --all --checks A4,E4

# the known-answer gate: the harness must independently rediscover every §11 seeded defect
pytest verification_harness/tests/test_known_answers.py -v
```

### Tier 2 (LLM adjudication)

Tier 2 is **off by default** — it costs money, so it never runs because you forgot a flag.

```bash
# what would this cost? builds every prompt, counts tokens, makes no call, spends nothing
python -m verification_harness --all --tier2 estimate

# run it (needs working ADC; the ceiling stops the run rather than overrunning)
python -m verification_harness --all --tier2 live --budget 10

# re-run offline and free, replaying the recorded responses; a cache miss is reported, not filled
python -m verification_harness --all --tier2 replay
```

**Authentication is ADC only** — Adam's org disallows API keys, so there is no key path. When the
refresh token expires, *every* Tier 2 call fails at `RefreshError: Reauthentication is needed`, and
the fix needs a browser:

```bash
gcloud auth application-default login
```

**The response cache is load-bearing, not an optimization.** `artifacts/tier2-cache/` keys every
response by a hash of (model, system, prompt, schema, params). A re-run replays byte-identical
answers for free — which is the only reason Tier 2 findings are diffable across runs (P3). Deleting
it forfeits comparability with the previous run; changing the model or temperature invalidates it
correctly, because those answers would not have been the same.

`--sync` populates `artifacts/page-cache/` from GCS through `fetch.py` and is **incremental**, so
leaving it on costs one listing round-trip per catalog. Without it the cache must already exist —
the run raises rather than silently auditing nothing. Every run also appends a snapshot to
`artifacts/run_history.jsonl` and prints the **X5** diff against the previous run; an unexplained
count change is itself a finding (spec §3).

## Guardrails (from the spec — do not remove)

- **Read-only.** No check writes to the catalog DB. Remediation is a separate, reviewed, backed-up
  step (mirroring `../scripts/backfill_source_pages.mjs`: dry-run default, `--apply`, `--restore`).
- **Version scoping.** Every DB query joins `documents.version` — never parse `markdown_url`. This
  was the exact trap that made the original backfill one-way.
- **Findings, not asserts.** A check *records* a finding; it never `assert`s (that would crash the
  run and hide every later finding).
- **Never silently drop a finding.** A finding that fails to serialize is itself a `critical` finding.
  Under-reporting is the worst failure mode.
- **Known-answer validation.** The harness is untrusted until it independently rediscovers the seeded
  defects in `DOUBLE_CHECK.md` §11. A run reporting zero findings means a broken harness.
- **Tier 2 evidence is verified, not trusted.** A model can produce a fluent page excerpt that is not
  on the page, and downstream that is indistinguishable from a real finding. Every returned excerpt
  is matched back against the source; one that is not there demotes the verdict to `AMBIGUOUS` and
  says so. The finding is kept — a model inventing evidence is something the run must show.
- **Discovery cannot promote itself.** `F4`'s `info` severity is forced in code, not requested in the
  prompt. A hypothesis becomes a defect only when a human encodes it as a deterministic check.

## Standards

Follows `../DEVELOPER_GUIDELINES.md`: PEP 8, type hints on all signatures, Google-style docstrings,
Black + Ruff + MyPy, JSON structured logging (`python-json-logger`), no secrets in source. Python
dependencies are declared in the repo-root `../environment.yml`, not a local requirements file.
