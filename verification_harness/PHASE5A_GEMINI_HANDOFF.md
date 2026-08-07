# Phase 5a handoff — cross-confirm the remediation tool before it writes

Give this whole file to Gemini. Adam chose this step deliberately on `2026-08-06` rather than
applying directly.

---

## Why this review exists

`verification_harness/remediate.py` is the **only code in this project that writes to the production
catalog database**. Claude wrote it. Under P1, the author of a thing does not certify it — and the
cost of a defect here is different in kind from everywhere else in the harness: every other mistake
produced a wrong *finding*, which a human reads and discards. A mistake here produces a wrong *row*,
which nobody reads and everybody trusts.

44 writes are queued. All are `B1` credit corrections on `courses.credits`. Nothing has been applied.

---

## What it claims to guarantee

Verify each independently. Do not take the docstrings as evidence — they are Claude's account of
Claude's code.

1. **`--dry-run` is the default.** Running with no flags must plan and print, never write.
2. **Backup precedes writes, in the same transaction.** Every affected column is copied into
   `harness_remediation_backup` before any `UPDATE`, and both roll back together. A backup that
   could outlive a failed apply would let `--restore` reverse changes that never happened.
3. **`--restore` round-trips.** After an apply, `--restore --run-id <id>` returns every touched cell
   to its pre-apply value and clears that run's backup rows. **Test this end to end on a scratch
   row, not by reading the code** — it is the only safety net.
4. **Idempotent.** A second `--apply` over the same findings is a no-op: a change whose current
   value already equals the target is dropped at plan time.
5. **Contested cells are refused.** A course defined on several pages produces several findings
   about one row. If two name *different* targets for the same cell, the tool must refuse that cell
   entirely rather than apply both and let the last win. See `_collapse()`. **This is the defect the
   dry run caught in Claude's first version; confirm the fix actually holds** — construct two
   findings disagreeing about one row and check the cell is refused, not written.
6. **Unknown check ids error.** `--checks D8` must exit non-zero with an explanation, never skip
   silently. A remediation tool that quietly ignores a class under-applies and nobody notices.
7. **Only `CONFIRMED` findings are acted on.** `AMBIGUOUS`, `PLAUSIBLE` and `REFUTED` must be
   filtered out at load time.
8. **`db.py` is untouched and still read-only.** The write path lives in its own module with its own
   connection, so no check can ever mutate the catalog however it is later edited. Confirm
   `remediate.py` does not import a writable cursor from `db.py` — it may reuse `_dsn()` only.

## Two judgment calls to check, not just the mechanics

- **`A6` refuses all 30 findings.** Every ghost row still carries the synthesized
  `"CODE (referenced; not in catalog)"` title, and the tool declines to clear `is_ghost` while the
  row holds no real content — otherwise the row would assert a course it does not have. Confirm you
  agree that is the right call rather than an over-cautious one.
- **20 of the 44 writes set `credits = 0`.** Adam accepted this on `2026-08-06`; spot-checked
  against `## EDUC-108 Clinical Experience I (0)`, where the page says 0 and the stored 50 is the
  defect. These are clinical and field-experience courses. **Verify a different one yourself against
  its source page** — a single spot-check by the author is not independent confirmation, and
  zero-credit touches transcripts.

## How to run it

```bash
python -m verification_harness.remediate                  # dry run, full 44-row diff
python -m verification_harness.remediate --checks B1      # one class
python -m verification_harness.remediate --checks D8      # must ERROR, not skip
```

Do **not** run `--apply` against production as part of this review. If you need to prove the
apply/restore round-trip, do it on a scratch row you create and delete yourself, and say plainly in
your write-up what you touched.

## What to produce

Append your findings to `SIGNOFF.md` under Phase 5a as a cross-confirm entry — what you verified,
how, and anything you would change before Adam applies. **Do not check Adam's approval box.** That
rule is on line 8 of the ledger, it was violated once already on `2026-08-06` in Phase 4, and it
matters most here: "no phase starts before the prior phase is Adam-approved" is what stands between
an unreviewed tool and 44 writes to live curriculum data.

If you find a defect, say so plainly and stop — do not fix it silently. Claude will correct it and
you re-check, so the review stays independent.

## Files

| file | why |
| --- | --- |
| `verification_harness/remediate.py` | the tool under review |
| `verification_harness/SIGNOFF.md` | Phase 5 scope, and why 5a is this small |
| `verification_harness/PIPELINE_DEFECTS.md` | 5b — what 5a deliberately does *not* fix |
| `scripts/backfill_source_pages.mjs` | the dry-run/apply/restore pattern 5a mirrors |
