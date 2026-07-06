# Hub Fix — Course-Code Truncation (`\d{3}` drops the 4th digit)

**For:** the CDI Factory hub agent (`cdi-factory`, course populator / vision-enrichment stage).
**Severity:** high — corrupts codes and titles *and* silently deletes courses via collision.
**Status:** spoke-side remediation applied to `2025-2026-undergraduate` (see §4); the Hub root
cause is **not yet fixed** and will reintroduce the corruption on the next ingest. Same
diagnose→patch→benchmark pattern as `HUB_UPGRADE_AIP_PARITY.md`.

---

## 1. Symptom

St. John Fisher migrated to **4-digit** course numbers (e.g. `AFAM-1001`). The hub course
populator extracted the number with a **3-digit** regex, so on ingest:

- `AFAM 1001 "Civil Rights & Civil Wrongs"` was stored as **`AFAM 100`** with the title
  **`"1 Civil Rights & Civil Wrongs"`** — the dropped 4th digit (`1`) was shoved onto the
  front of the title.
- Distinct 4-digit courses sharing a 3-digit prefix **collided**: `AFAM 1001 / 1002 / 1003`
  all truncated to `AFAM 100`; only one row survived, the other two were **never stored**.

## 2. Confirmed diagnostics (live spoke `zkoimkcctqigisfeqlpv`, tenant SJFU, 2025-2026-ug)

```
courses stored ................ 1342   (all numeric codes 3-digit; ZERO 4-digit)
truncation signature .......... 168    (title starts with an orphaned lone digit)
raw chunk 4-digit mentions .... 1162   (source text DID carry the correct 4-digit codes)
distinct 4-digit codes in text.. 322
=> collapse to 213 3-digit buckets  ->  ~109 courses lost to collision
```

The authoritative record survives verbatim in every course chunk's breadcrumb:
```
[Header 1: Academic Programs > Header 2: AFAM-1001 Civil Rights & Civil Wrongs (3)]
```
So the source extraction (vision/markdown) is fine — the **populator's course-code parse is
the sole point of loss.**

## 3. Root cause & fix (Hub)

The course-code extraction regex captures exactly three digits (`\d{3}` / `[A-Z]{2,4}\s*\d{3}`).
On a 4-digit code it takes the first three and leaves the 4th to bleed into the title.

**Fix:** capture the full digit run (with the optional single-letter section suffix), and
never split a number:
```python
# before (drops the 4th digit):
COURSE_CODE = re.compile(r'\b([A-Z]{2,4})\s*[- ]?\s*(\d{3})\b')
# after:
COURSE_CODE = re.compile(r'\b([A-Z]{2,4})\s*[- ]?\s*(\d{3,4})([A-Z]?)\b')
```
Locate every course-code parse in the populator / enrichment path (analogous to the
`program_markers` locus at `src/export/table_populator.py:517` cited in
`HUB_UPGRADE_AIP_PARITY.md`) and widen all of them. Prefer parsing the code **directly from
the `Header 2:` breadcrumb** (`([A-Z]{2,4})-(\d{3,4})([A-Z]?)\s+<title>\s*\((\d+)\)`), which is
already normalized, over re-parsing free text.

**Acceptance (Hub):** after a 2025-2026 re-ingest, `courses` contains 4-digit codes
(≈270+ for undergrad), **zero** titles beginning with a lone digit, and the collided courses
(`AFAM 1002`, `AFAM 1003`, `AFAM 2102`, …) are present as distinct rows. Course count rises
from ~1342 toward the ~1448 the spoke now holds post-remediation.

## 4. Spoke-side remediation already applied (interim)

Because the corruption is deterministic (the orphaned leading digit *is* the dropped 4th
digit), it was repaired in place without re-ingesting:

- **`scripts/backfill_course_codes.mjs`** — dry-run by default, `--apply` to write. Rebuilds
  each truncated code from the row's own data, validates it against the chunk breadcrumbs,
  and inserts the collision-lost courses from their orphaned chunks. Idempotent, transactional,
  writes a rollback manifest. **Applied to `2025-2026-undergraduate`: 168 updated, 106 inserted
  (1342 → 1448); 0 four-digit → 273; 0 orphaned-digit titles. Exact-code overlap with the AIP
  benchmark rose from 0% to 94% of spoke codes.**
- **Query-time regexes widened** to `\d{3,4}` in `src/app/api/db/route.ts` (×4),
  `assistant/route.ts`, `catalog/apply-deltas`, `catalog/assistant`, `catalog/audit` — these
  had been silently skipping every 4-digit reference (a `\d{3}\b` never matches inside `1001`).

**Still to do:** run the backfill for the other **7 catalogs** (`--version <name>`) — they carry
the same truncation — ideally *after* the Hub fix lands so a re-ingest doesn't undo it. Sequence:
Hub regex fix → re-ingest (or backfill the remaining 7) → re-verify 4-digit counts per catalog.
