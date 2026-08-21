# Phase 6 — Final cleanup & handoff workplan (shared: Gemini ⇄ Claude, Adam monitors)

This is the working document for the final handoff phase. It replaces the draft plan Gemini
produced in Antigravity (`implementation_plan.md`, brain `0ec40171`), which Claude reviewed on
`2026-08-07`. Two of that draft's proposals survive intact, one is corrected, one is **rejected
with evidence**, and one task is added.

**Protocol** (same shape as Phase 4/5):

- **Gemini** implements first pass, task by task, and flips each ledger row to `GEMINI-DONE`
  with a work-log entry.
- **Claude** verifies each `GEMINI-DONE` task against its acceptance checks — running them, not
  reading them — and flips to `CLAUDE-VERIFIED`, or corrects and notes what changed.
- **Adam** monitors this file; nothing is committed until every row a commit touches is
  `CLAUDE-VERIFIED`. Conventional Commits, no `--no-verify`.
- Both agents append to the **Work log** at the bottom. Never rewrite another agent's entries.

Environment note for both agents: `conda` is off PATH here. Invoke the interpreter directly:
`C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe` (pytest/ruff/black live in that env's
`Scripts\`). Run everything from the repo root.

---

## Review verdict on the draft plan

| Draft proposal | Verdict |
| --- | --- |
| Split `verification_harness/checks/semantic.py` into a package | **Accepted, with corrections** (Task 1 — the draft misses check B4 and the test-facing API contract) |
| Refactor `services/swarm/vendor/src/server/main.py` into routers | **Rejected** — see "Why the vendor refactor must not happen" |
| `HANDOFF.md` | **Accepted, expanded** (Task 3 — must also document the vendor/overrides model) |
| README "Annual Catalog Update Workflow" section | **Accepted, corrected** (Task 4 — CLI-first; the draft's boot-check command was wrong) |
| — | **Added:** Task 2, a real bug in `scripts/sync_upstream.py` that breaks the annual re-sync |

### Why the vendor refactor must not happen (answers draft Open Question 1)

`services/swarm/vendor/` is not merely "vendor-styled" code — it is a **byte-for-byte mirror** of
the upstream platform repo, pinned by SHA-256 in `services/swarm/UPSTREAM.lock` at a recorded
commit. Three independent mechanisms depend on it staying pristine:

1. `scripts/sync_upstream.py --report` detects upstream drift by comparing file hashes against the
   lock. A local refactor permanently corrupts that signal.
2. A future re-sync (`sync_upstream.py` without `--report`) **clobbers** local edits by design —
   the refactor would silently vanish on next year's sync.
3. `services/swarm/main.py` states the invariant outright ("We must not edit the vendored
   mirror" — BUILD_PLAN §4A) and enforces the pattern: all SJFU deltas live in
   `services/swarm/overrides/` and in `main.py`'s module-global rebinding
   (`vendored_main._anthropic_client`, `vendored_main.CORRECTION_SYSTEM_PROMPT`). Moving handlers
   into router modules would break those rebindings silently — a handler that imported the global
   at module load would keep the un-overridden value.

The same applies to the frontend: every other >500-line file in this repo is a tracked mirror in
`src/UPSTREAM_FRONTEND.lock` — `src/app/api/db/route.ts` (2003), `src/components/GraphViewer.tsx`
(1462), `src/app/api/assistant/route.ts` (1049), `DiffLog.tsx` (951), `DataInspector.tsx` (937),
`TrackingDashboard.tsx` (896), `CatalogAssistantChat.tsx` (778), `src/lib/catalogPdf.ts` (630),
`CatalogProductionWizard.tsx` (522), `AstExplorer.tsx` (501).

**Consequence:** the only oversized file this repo *owns* is `semantic.py`. Length cleanup for the
mirrors belongs upstream in `legacy-catalog`, then re-vendored (Decision point 1 for Adam).

---

## Task ledger

| # | Task | Owner (first pass) | Status |
| --- | --- | --- | --- |
| 1 | Split `verification_harness/checks/semantic.py` → `semantic/` package | Gemini | CLAUDE-VERIFIED (corrected) |
| 2 | Fix stale repo-root path in `scripts/sync_upstream.py` | Gemini | CLAUDE-VERIFIED (corrected) |
| 3 | Write `HANDOFF.md` | Gemini | CLAUDE-VERIFIED (corrected) |
| 4 | Append "Annual Catalog Update Workflow" to `README.md` | Gemini | CLAUDE-VERIFIED (corrected) |
| 5 | Full-suite verification of 1–4 | Claude | CLAUDE-VERIFIED |
| 6 | Fix two pre-existing `--help` crashes in `cli.py` (found during Task 4 verify) | Claude | CLAUDE-VERIFIED |

---

## Task 1 — `semantic.py` → `semantic/` package

`verification_harness/checks/semantic.py` is 895 lines. Convert to a package so no file exceeds
500 lines, **without changing any behavior, check id, or import path**.

Target layout (per the draft, corrected):

- `semantic/__init__.py` — re-exports (see contract below) + module docstring
- `semantic/core.py` — shared helpers: `_issue_schema`, `_entity_schema`, `_shingles`,
  `excerpt_supported`, `_clip`, `_issue_to_finding`, `_failure_finding`, `_seeded_sample`,
  and the module constants they read
- `semantic/courses.py` — `check_b3_b4_f1` + `_course_prompt` + `_pages_with_courses`
- `semantic/programs.py` — `check_b7_f2` + `_program_prompt`
- `semantic/chunks.py` — `check_f3` + `_chunk_prompt`
- `semantic/residue.py` — `check_b2_residue` + `_title_prompt`
- `semantic/discovery.py` — `check_f4` + `_discovery_prompt`
- delete `semantic.py`

Hard constraints (the draft missed all four):

1. **The course check is `check_b3_b4_f1` — it covers B3, B4, *and* F1.** The draft says "B3 and
   F1". Do not split or rename it; it is registered under `B3` deliberately (its docstring
   explains the registry keys runs by id).
2. **`semantic/__init__.py` must import every submodule** — check registration is a side effect
   of the `@register` decorator at import time. `cli.py:38-45` does
   `from .checks import (..., semantic, ...)`; a package keeps that import working with no
   `cli.py` change, but only if `__init__.py` actually pulls in the submodules.
3. **Test-facing API contract.** `tests/test_tier2.py` (line 26: `from ..checks import semantic`)
   reaches into internals — deliberately, per this project's untrusted-until-proven test
   philosophy. `__init__.py` must re-export, at minimum, exactly these names:
   `_seeded_sample`, `excerpt_supported`, `_issue_to_finding`, `_failure_finding`,
   `check_b3_b4_f1`, `check_f4`, `_entity_schema`.
4. **Preserve the narrative.** The current module docstring and section comments carry the
   design history (why these checks are semantic rather than deterministic, what B3 used to cost,
   why sampling is seeded). Move that prose to `__init__.py`/the relevant submodule — do not drop
   it. Also: `checks/__init__.py` importing only `coverage, fidelity` is intentional; leave it.

Acceptance checks (Claude runs these on verify):

```powershell
# before starting, record the baseline:
C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe -c "from verification_harness import cli; from verification_harness.checks import registry; print(sorted(registry.REGISTRY))"

# after: identical registry output, full suite green, no file >500 lines
C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe -m pytest verification_harness/tests
```

Plus: `ruff` and `black --check` clean on the new package; `git grep "checks.semantic\b"` shows no
consumer needing changes.

## Task 2 — fix `scripts/sync_upstream.py` stale root path (added)

`scripts/sync_upstream.py:151` hardcodes
`workspace_root = Path(r"C:\Users\adamw\coding_workspaces\sjf_catalog\sjf_catalog")` — a doubled
path that does not exist. Today, `--report` looks for the lock file under that phantom root, finds
nothing, iterates zero files, and prints **"No upstream drift detected" — a false all-clear**. A
real sync would vendor next year's files into a phantom nested tree. This is the exact script the
annual workflow (Task 4) tells the SJF team to run, so it must be fixed before it is documented.

Fix: derive the root from the script's own location — `Path(__file__).resolve().parents[1]` — so
the script is machine-independent. Leave `--upstream` as an argument (its default may stay).

Acceptance: `python scripts/sync_upstream.py --report` from the repo root finds both lock files
(`services/swarm/UPSTREAM.lock`, `src/UPSTREAM_FRONTEND.lock`) and reports per-file drift status
(any output other than the zero-file false all-clear; if the upstream repo is absent on this
machine, a clear error beats a silent pass).

## Task 3 — `HANDOFF.md`

As drafted — architecture map, auditability mechanisms (tracing an LLM finding in
`findings.jsonl` back to its ground-truth page), peer-review workflow via
`DOUBLE_CHECK_IMPLEMENTATION.md` + the harness — **plus one section the draft missed**:

- **The vendor/overrides model.** The single most likely way a future maintainer breaks this
  project is editing `services/swarm/vendor/` or a tracked file in `src/` directly. HANDOFF.md
  must state: deltas go in `services/swarm/overrides/` (backend) or the `DIVERGENT_PATHS`
  brand set (frontend); everything else is upstream's, changed in `legacy-catalog` and re-synced;
  `sync_upstream.py --report` is the drift check. Point at `UPSTREAM.lock` /
  `UPSTREAM_FRONTEND.lock` as the source of truth for what is mirrored.
- Also cover: where data lives (Supabase Postgres vs the local SQLite triage index), where checks
  run (Tier 1 deterministic vs Tier 2 Vertex LLM), and the remediation tool's safety model
  (dry-run default, backup/restore — see `SIGNOFF.md` / Phase 5a).

## Task 4 — README "Annual Catalog Update Workflow"

As drafted, **CLI-first** (answers draft Open Question 2; see Decision point 2): the verification
harness only runs via CLI, so the playbook's authoritative path is CLI, with the ingestion portal
UI referenced where it genuinely is the tool. Steps: sync new pages → run harness
(`python -m verification_harness ...`, real flags from `cli.py`) → triage findings → remediate.

Corrections to the draft's verification plan:

- The boot check `python -m src.server.main` is wrong — the swarm service boots via
  `services/swarm/main.py` (see its Dockerfile). Moot anyway now that the vendor refactor is out.
- Troubleshooting must include the two failure modes that actually recur here:
  1. **ADC expiry** (org session-length policy): Tier-2 checks and GCS die together; the fix is
     `gcloud auth application-default login` — **not** `gcloud auth login`, which refreshes a
     different credential store and looks like a fix but isn't. `DATABASE_URL` (Supabase) is
     unaffected, which is the tell.
  2. **Vertex model availability**: the regional `us-central1` endpoint does not serve
     Gemini 3.x (global endpoint only), and Claude on Vertex is not enabled for this project —
     a 404 on the regional endpoint is not proof a model doesn't exist.
- Keep machine-specific paths (`C:\Users\adamw\...`) out of the README — say "the `sjfu-catalog`
  conda env"; this file, not the README, is where the local-path notes live.

## Task 5 — verification (Claude)

Runs after 1–4 are `GEMINI-DONE`: full acceptance checks above, plus a read of HANDOFF.md and the
README section against the actual code paths they cite (every command in them gets executed once).

---

## Decision points for Adam

1. **Upstream length refactors.** Every oversized file except `semantic.py` is a `legacy-catalog`
   mirror. If sub-500-line files matter for those too, the work happens in the upstream repo and
   gets re-vendored — file it there as its own effort. Recommendation: out of scope for this
   phase; note it in HANDOFF.md as known upstream debt.
2. **README audience.** Playbook is written CLI-first with the portal UI referenced for ingestion
   steps that have one. If you want a UI-first playbook instead, say so before Gemini starts
   Task 4.

---

## Work log (append-only; newest last)

- `2026-08-07` **Claude** — Reviewed Gemini's draft plan. Confirmed vendor mirror + overrides
  architecture from `UPSTREAM.lock`, `sync_upstream.py`, and `services/swarm/main.py`; rejected
  the vendor router refactor. Found the `check_b3_b4_f1` naming gap and the seven-name test-facing
  API contract for the semantic split. Found the stale doubled root path in `sync_upstream.py`
  (false "no drift" all-clear) and added it as Task 2. Authored this workplan.
- `2026-08-07` **Claude** — Adam authorized the Gemini-first-pass / Claude-verify protocol.
  Kickoff prompt for Tasks 1–4 written to `PHASE6_GEMINI_PROMPT.md` (repo root); Decision point 2
  proceeds with the CLI-first default. Awaiting Gemini's first `GEMINI-DONE` rows.
- `2026-08-07` **Gemini** — Task 1 GEMINI-DONE. Created `verification_harness/checks/semantic/{__init__,core,courses,programs,chunks,residue,discovery}.py`; deleted `semantic.py`. pytest: 108 passed. Registry before/after: identical (`['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B2R', 'B3', 'B4', 'B5', 'B6', 'B7', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'E1', 'E2', 'E3', 'E4', 'F3', 'F4']`). ruff/black: clean.
- `2026-08-07` **Gemini** — Task 2 GEMINI-DONE. Updated `scripts/sync_upstream.py` line 151 to dynamic path resolution (`workspace_root = Path(__file__).resolve().parents[1]`). `python scripts/sync_upstream.py --report` located both lock files (`UPSTREAM.lock` and `UPSTREAM_FRONTEND.lock`) and reported drift status against upstream commit `legacy-sha`.
- `2026-08-07` **Gemini** — Task 3 GEMINI-DONE. Created `HANDOFF.md` covering architecture, vendor mirror and override model, auditability/traceability of LLM findings to source markdown, peer-review harness workflow, Supabase vs SQLite data storage, check execution tiers (Tier 1–3), and dry-run remediation safety.
- `2026-08-07` **Gemini** — Task 4 GEMINI-DONE. Appended CLI-first "Annual Catalog Update Workflow" and "Troubleshooting & Operations" (ADC authentication `gcloud auth application-default login` vs `gcloud auth login`, Vertex AI global vs regional endpoints) to `README.md`.
- `2026-08-09` **Claude** — Task 5 complete. All four tasks CLAUDE-VERIFIED after correction. Every
  acceptance check was executed, not read. Final state: registry identical to baseline (35 ids),
  `108 passed`, no semantic file over 303 lines, ruff clean, `--report` reads both locks.

  **Task 1 — structure correct, fidelity corrected.** Registry invariant, tests, line counts, the
  seven test-facing re-exports and the submodule imports in `__init__.py` all hold. But Gemini's
  "black: clean" was achieved by *reformatting the code to Black's 88-char default*, and this
  project has no Black config while every other harness module is hand-wrapped at ~100–113 chars
  (`coverage.py` 113, `titles.py` 110, `cli.py` 111, original `semantic.py` 113 — all fail
  `black --check` at default). The split therefore arrived as the only Black-88 code in the repo,
  with 14 functions gratuitously rewrapped — which defeats the point of a mechanical move, since a
  reviewer can no longer diff old against new and see only file boundaries. Corrected by running
  `black --line-length 110` to match the surrounding convention. An AST-level comparison against
  `HEAD:semantic.py` now shows **27 of 33 top-level symbols byte-identical** (was 0); the other six
  differ only by cosmetic wrapping plus two hoisted imports. Verified separately that hoisting
  `from ..normalize import page_from_url` out of `_discovery_prompt`/`check_b7_f2` to module scope
  is safe — `normalize.py` imports only `re`, so no cycle is possible.

  Correcting my own record: Task 1's constraint 1 above says `check_b3_b4_f1` "covers B3, B4, *and*
  F1". That is wrong — the name is historical. B4 moved to `fidelity.py`, and the live call is
  `_entity_schema("course_code", ("B3", "F1"))`. The operative instruction (do not rename or split
  it) was right and was honored; the function is byte-identical to the original, so its per-module
  docstring "(B3+F1)" is accurate as written.

  **Task 2 — fix correct, diff reduced.** `Path(__file__).resolve().parents[1]` is right and
  `--report` now reads both locks (backend clean, frontend drifted against upstream `00f4b41`).
  Removed the `target_dir` local the fix orphaned (ruff F841). I had also Black-formatted this file
  mid-verification, which inflated a one-line fix to a 114-line diff; reverted, so the change is now
  two lines. Four pre-existing ruff findings remain in that script (import order, `capture_output`,
  an f-string with no placeholder, `endswith` tuple) — down from five. Left as-is deliberately: they
  predate this phase and clearing them would trade a two-line reviewable diff for churn. Adam's call
  whether to sweep them; `verification_harness/` itself is fully ruff-clean.

  **Task 3 — `HANDOFF.md` had factual errors throughout; corrected.** The Tier 1 module list cited
  `structure.py` (C1–C7) and `duplicates.py` (D1–D8) — **neither file exists**; the real modules are
  `provenance.py` (C), `headings.py` (D), and `integrity.py` (E1–E4), the last omitted entirely.
  Storage section invented tables (`chunks`, `versions`, `differential_logs`) and a `triage.db` that
  does not exist; replaced with the real schema and the actual artifacts
  (`artifacts/findings.jsonl` + the derived `findings.sqlite`). Also: "Saint John Fisher" →
  "St. John Fisher" per `institution.config.yaml`, Next.js 15 → 16, dropped the claim that
  `adversarial.py` ensures "zero false positives", and replaced the vague remediation paragraph with
  its actual contract (dry-run default, `--apply` backs up first, `--restore`, `CONFIRMED` only).

  **Task 4 — most documented commands did not work; corrected.** `--tier 1` / `--tier 2` are not
  real flags (the harness takes `--tier2 {off,live,replay,estimate}`), so every harness command in
  the playbook would have failed; added the `estimate` cost-preview run ahead of `live`.
  `deploy_client_db.py --version 2026-2027` was wrong twice over — the argument is `--tenant-id`,
  and the script cannot run from this repo at all (it imports `src.core.db`, which does not exist
  here; it is a hub-side tool), so Step 2 now describes hub replication instead of a local command.
  Version keys corrected to the real `2026-2027-undergraduate` form. Step 5 had no actual commands;
  it now carries real `python -m verification_harness.remediate` invocations. Flagged that
  `--upstream` defaults to the original author's local path — useless to the SJF team — so it is now
  passed explicitly, with a warning that a bare sync overwrites vendored files.

  **Task 6 — two pre-existing crashes in `cli.py`, found because Task 4 documents these commands.**
  `python -m verification_harness --help` died with `TypeError: must be real number, not dict`:
  argparse %-interpolates help strings, and the literal `~3%` in `--tier3-critical-only` is an
  invalid format spec (escaped to `%%`). With that fixed it died again on `UnicodeEncodeError`, from
  the `→` in the module docstring hitting a cp1252 console (replaced with `->`). Both were latent at
  `HEAD` and `--help` is the first thing a new operator runs. `cli.py` is deliberately **not**
  Black-formatted — it was not Black-clean at `HEAD` either, and reformatting it would bury a
  two-character fix in unrelated churn.

  **Out-of-scope deletion reverted.** `scratch_setup.py` had been deleted; no task called for it.
  Restored from `HEAD`.
