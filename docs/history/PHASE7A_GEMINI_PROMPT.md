# Phase 7 Group A kickoff — remove the upstream client entirely

Give this whole file to Gemini. Adam made both gating decisions on `2026-08-11`. Claude verifies
behind you; Adam approves commits.

**This file is itself a removal target.** It necessarily contains the strings you are hunting. It
gets deleted once gate A10 passes — do not treat its existence as a reason to leave references
elsewhere.

---

## Read this first: a Phase 6 rule has been REVERSED

In Phase 6 you were told, emphatically, never to touch `services/swarm/vendor/` because it was a
hash-pinned mirror of the `legacy-catalog` repository. **That rule is now void.** Adam's decision:
every trace of legacy-client / Legacy Institution comes out of this project, no exceptions. The
vendor relationship is not being licensed or partitioned — it is being deleted.

So the vendored backend **becomes owned code**, the override indirection folds into it, and the sync
machinery is deleted. If any instruction in `PHASE6_GEMINI_PROMPT.md` or
`PHASE6_HANDOFF_WORKPLAN.md` conflicts with this file, **this file wins**.

What has *not* changed: `services/swarm/overrides/vertex.py` is SJF-owned, contains no legacy-client
references, does real adaptation work, and **stays as it is**.

## Your assignment

Implement **Group A only** (tasks A1–A9) from the ledger in `PHASE7_OWNERSHIP_TRANSFER.md` §6. Read
§2.1 of that document first — it explains what the work is and why. A10 is Claude's gate; Group B
(ingestion) and Group C (documentation) are not yours yet and must not be started.

**A1 goes first and alone.** `src/lib/llm.ts:18` currently reads
`process.env.GCP_PROJECT_ID || 'legacy-catalog-production'`. If that variable is ever unset in a
deployment, every Vertex call silently targets and bills **another client's** cloud project. Replace
the fallback with an explicit thrown configuration error, per `DEVELOPER_GUIDELINES.md:13`, then fix
the live value at `.env.local:26`. One line, largest consequence in the phase. Do it, verify it,
log it, then move on.

## Traps — each of these has already caught someone

1. **The prompt leak is bigger than the override.** `services/swarm/main.py:23-30` swaps the
   institution's full legal name out of `CORRECTION_SYSTEM_PROMPT` at import time. It does **not**
   touch three further literal references at `vendor/src/server/main.py:743,753,754`, which sit
   inside few-shot examples built from that client's real catalog structure and are transmitted to
   the model on every correction request. Fix all four sites in the source. Do not assume the
   override covered anything but the name.
2. **Reword, do not delete, the bucket healing.** `src/lib/gcs.ts:150-175` heals legacy asset URLs.
   The database is currently clean (verified against production: zero legacy-bucket URLs across
   39,544 chunks, 6,929 courses, 592 programs), but deleting the healing branch converts any future
   regression from a silent repair into a dead-path 404. Keep the behavior, remove the client's name
   from the docstring, and describe the condition generically ("a bucket other than the configured
   one"). Same treatment for the header of `scripts/backfill_source_pages.mjs` and the four
   verification-harness docstrings that name the old bucket.
3. **Some documents are *about* the relationship.** `BUILD_PLAN.md` (31 hits),
   `IMPLEMENTATION_PLAN.md` (20), `README.md` (6), and the Phase 6/7 plans contain passages whose
   subject is the upstream lift-and-adapt. String substitution produces nonsense there. Rewrite the
   passages so they describe the platform's own history without naming another institution — e.g.
   "adapted from an existing catalog platform". **`PHASE7_OWNERSHIP_TRANSFER.md` is included in this
   sweep**, but preserve its meaning: it is the live plan.
4. **Two leaks a name search alone will not surface.** `DESIGN.md:167` carries that client's brand
   hex `#999999`; the adjacent note at `:168` claiming `src/app/login/page.tsx` still hardcodes it is
   **stale — I verified the login page is clean**, so correct the note rather than "fixing" the page.
   `STATUS.md:27` publishes their live Supabase project ref. Also purge the pinned upstream commit
   SHA `legacy-sha`, which appears 45 times across the two lock files
   you are deleting.
5. **`.claude/settings.local.json` is untracked but on disk.** It will not ship via git, but it
   travels with any directory-level handover. Clean it too.
6. **`package-lock.json:5190` is a false positive** — a base64 integrity hash for the `gopd` package
   that happens to contain the letters. Do not edit it.

## Rules of engagement

- **Do not touch git history.** Three commit messages contain the name; how to handle that is an
  open decision of Adam's (rewrite vs. squashed fresh repo). Not your call, not this task.
- **Do not reformat.** Phase 6's main correction was that you ran Black at its 88-char default on a
  project with no Black config, hand-wrapped at ~100-110, producing 14 gratuitously rewrapped
  functions. Match the conventions of the file you are editing. If you must format, `--line-length
  110`.
- **Verify every claim against the source before acting on it**, including the line numbers in this
  file. Phase 6's documents named two modules that do not exist and CLI flags the harness never had.
  Line numbers shift as you edit — re-locate by content, not by number.
- **The suite must stay green.** `C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe -m pytest
  verification_harness/tests` — 108 passing now. Also keep `npm run lint` and `npm run typecheck`
  clean. Run them after A3 especially; de-vendoring moves real code.
- **Do not commit.** Leave the tree dirty. Adam approves commits after Claude verifies.
- `conda` is off PATH: use `C:\Users\adamw\anaconda3\envs\sjfu-catalog\python.exe` directly, from
  the repo root.

## How to report

In `PHASE7_OWNERSHIP_TRANSFER.md`, flip each Group A row to `GEMINI-DONE` when it is complete **and
its checks pass**, and append one work-log entry per task with real command output — the pytest
tail, the lint result, the search count before and after. Not paraphrase.

For A9, state the residual count explicitly: how many occurrences remain, in which files, and why
each is intentional (this prompt file, for instance). A10 is a hard zero gate and Claude will run it
independently; a task marked done that fails it costs a full round trip.

If a spec here is wrong, say so in a work-log entry and stop that task rather than guessing. An
honest blocker costs nothing.
