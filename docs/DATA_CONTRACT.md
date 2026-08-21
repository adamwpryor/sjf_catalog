# Data Contract (SJFU)

SJFU cloud counts must match the hub within tolerance. The table below is the **canonical baseline for a successful data load**, re-baselined on **2026-08-20** to the post-AIP-parity hub (program de-duplication + prereq/requirement logic blocks landed; see `HUB_UPGRADE_AIP_PARITY.md`). These numbers were captured live from the spoke project `zkoimkcctqigisfeqlpv` after `deploy_client_db.py --tenant-id SJFU`.

| Table | Expected Count | Notes |
| --- | --- | --- |
| `courses` | 6,929 | |
| `programs` | 592 | De-duplicated by the AIP-parity upgrade (was 1,203 over-extracted) |
| `program_requirements` | 702 | |
| `program_requirement_courses` | 3,371 | **Crucial link table — must be non-zero** |
| `course_prerequisite_links` | 3,527 | **Crucial link table — must be non-zero** |
| `semantic_chunks` | 39,544 | Embeddings rewritten to `vector(1536)` (gemini-embedding-001) in P3 |
| `documents` | 8 | grad+undergrad × 4 years |

**The invariant (do not regress):** the two link tables must be non-zero. Their being zero was the original silent-degradation failure (IMPLEMENTATION_PLAN §3); a non-zero count on both is the contract-boundary check that it did not recur.

**Superseded baseline (pre-upgrade, for history):** courses 5,923 · programs 1,203 · program_requirements 932 · program_requirement_courses 2,402 · course_prerequisite_links 2,939 · semantic_chunks 34,570 · documents 8. The counts shifted with the hub upgrade — program de-dup lowered `programs` and `program_requirement_courses`; improved prereq extraction raised `course_prerequisite_links`. Tolerance is checked against the current (post-upgrade) row, not this one.

---

## Re-baseline history

**2026-08-20.** Measured against production and corrected. Four of the seven rows had drifted from
the 2026-07-01 figures, because remediation work landed after that baseline was taken and nothing
re-measured it:

| Table | Was | Now | Change |
| --- | ---: | ---: | ---: |
| `courses` | 6,397 | 6,929 | +532 |
| `programs` | 601 | 592 | −9 |
| `program_requirements` | 705 | 702 | −3 |
| `program_requirement_courses` | 1,366 | 3,371 | +2,005 |

The two large moves are attributable: `scripts/backfill_program_requirements.mjs` populates
`program_requirement_courses` for programs that had none, and `scripts/backfill_course_codes.mjs`
recovers courses lost to 3-digit code collisions. `course_prerequisite_links`, `semantic_chunks`,
and `documents` were unchanged.

**Why this matters beyond bookkeeping.** This table is the acceptance yardstick for any ingestion
run, including the self-serve path in `docs/SELF_SERVE_INGESTION.md`. A stale contract makes a
correct load look wrong and a wrong load look plausible, which is the failure mode the whole
document exists to prevent. Re-measure it after any bulk remediation, and record the move here.
