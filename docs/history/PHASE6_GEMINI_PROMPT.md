# Phase 6 kickoff — first-pass implementation

Give this whole file to Gemini. Adam authorized the first pass on `2026-08-07`; Claude verifies
behind you, Adam approves commits.

---

## Your assignment

Implement **Tasks 1 through 4** of `PHASE6_HANDOFF_WORKPLAN.md` (repo root), in order. That
document is the contract — it supersedes your Antigravity draft plan (`implementation_plan.md`,
brain `0ec40171`). Read it end to end before touching anything. Task 5 (verification) is Claude's;
do not do it, but do run each task's acceptance checks yourself before marking the task done —
Claude re-runs them independently, and a task marked done that fails its own checks costs a full
round trip.

Both of your draft's open questions are answered in the workplan:

1. **The vendor refactor is rejected — do not implement it.** `services/swarm/vendor/` and every
   file tracked in `src/UPSTREAM_FRONTEND.lock` are byte-for-byte upstream mirrors, hash-pinned
   and clobbered on re-sync. The evidence is in the workplan's "Why the vendor refactor must not
   happen" section. Nothing under `services/swarm/vendor/` changes in this phase, at all.
2. **The README playbook is CLI-first** (Decision point 2 default stands unless Adam has written
   otherwise in the workplan before you start Task 4).

## Rules of engagement

- **Task 1 is a mechanical move, not a rewrite.** Code, docstrings, and comments transfer
  verbatim — no renames, no rewording, no "while I'm here" improvements, no import-style changes.
  The full constraint list (the `check_b3_b4_f1` naming, the mandatory submodule imports in
  `__init__.py`, the seven re-exported test-facing names, the preserved narrative docstring) is in
  the workplan's Task 1 spec. Honor all four; the test suite reaches into internals deliberately.
- **Before moving anything**, record the registry baseline in the work log:

  ```powershell
  C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe -c "from verification_harness import cli; from verification_harness.checks import registry; print(sorted(registry.REGISTRY))"
  ```

  The identical output after the split is Task 1's core invariant.
- `conda` is off PATH on this machine. Use the interpreter directly:
  `C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe` (pytest, ruff, black are in that env's
  `Scripts\`). Run everything from the repo root.
- **Do not commit.** Leave the tree dirty; commits happen after Claude verification, with Adam's
  approval, in Conventional Commits format.
- **Do not touch:** `services/swarm/vendor/`, anything listed in `src/UPSTREAM_FRONTEND.lock`,
  `verification_harness/checks/__init__.py` (its short import list is intentional), or any file
  the workplan doesn't name.
- New Python code you do write (Task 2's path fix, any glue in the new package) follows the
  house standards: type hints on signatures, Google-style docstrings on public functions, PEP 8,
  Black-formatted, Ruff-clean.
- Keep machine-specific paths out of `HANDOFF.md` and `README.md` — those documents are for the
  St. John Fisher team. This file and the workplan are where local paths live.

## How to report

In `PHASE6_HANDOFF_WORKPLAN.md`, which is the shared ledger between you, Claude, and Adam:

1. When a task is complete **and its acceptance checks pass**, flip its ledger row to
   `GEMINI-DONE`.
2. Append one work-log entry per task, newest last, in this shape:

   ```text
   - `2026-08-07` **Gemini** — Task 1 GEMINI-DONE. Created semantic/{__init__,core,courses,programs,chunks,residue,discovery}.py; deleted semantic.py. pytest: 41 passed. Registry before/after: identical. ruff/black: clean. Notes: <anything that surprised you>.
   ```

   Real command output, not paraphrase: paste the pytest tail and the registry lists. If a check
   cannot pass (for example, Task 2's `--report` when the upstream `legacy-catalog` checkout is
   absent on this machine), record what actually happened and leave the row `TODO` with a note —
   an honest blocker costs nothing; a false `GEMINI-DONE` costs a verification round trip.
3. Never edit Claude's or Adam's entries, the ledger rows of other tasks, or the task specs
   themselves. If you believe a spec is wrong, say so in a work-log entry and stop that task;
   Claude or Adam will rule on it.

Work the tasks in order — 1, 2, 3, 4 — since the README playbook (Task 4) documents the script
Task 2 fixes and the structure Task 1 produces. When all four rows read `GEMINI-DONE`, stop.
Claude takes it from there.
