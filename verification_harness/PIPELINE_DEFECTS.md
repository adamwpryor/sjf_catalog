# Pipeline defect report (Phase 5b)

**Audience: whoever owns the catalog ingest.** This document applies nothing. It is the other
half of Phase 5 — the half where the findings actually get resolved.

The verification harness produced **14,758 actionable findings** across 8 catalogs. Phase 5a
can repair **44** of them, because 44 are cases where the page states the correct value and a
single-column `UPDATE` reaches it. The rest are not database defects that happen to be numerous —
they are a small number of **pipeline defects**, each restated once per row it touched.

Fixing the chunker closes ~6,300 findings. Patching rows closes 44. That ratio is the whole
argument for this document existing separately.

| root cause | findings | one upstream change closes them |
| --- | ---: | --- |
| Chunker breadcrumbs are wrong | 6,325 | re-chunk with correct `section_header` |
| Descriptions truncated / bled | 2,503 | fix description capture, re-ingest |
| Heading duplication unresolved | 3,153 | disambiguate by `ancestor_path` at ingest |
| Chunk provenance wrong | 1,139 | rebuild breadcrumbs + `source_chunk_id` |
| Programs not captured | 297 | ingest minors, not just majors |
| Courses not captured | 292 | permissive heading parse |
| Title fidelity | 184 | preserve the page title verbatim |
| Prerequisite parser lossy | 20 | keep grade qualifiers and `or` |
| Schema cannot hold page data | 84 | add columns, or record the decision to drop |

---

## 1. The chunker's breadcrumbs describe the wrong section

**6,325 findings** — `F3`

`semantic_chunks.section_header` frequently names a section the content does not come from — a
pharmacy course filed under `Grading Scale for Nursing Programs`, a course under a school it does
not belong to. This is the single largest defect class in the audit at **one third of all chunks**,
and it is consistent with `C6` independently finding **57% of `source_chunk_id` references dangle**.
Breadcrumbs are the primary scoping key for retrieval, so wrong breadcrumbs mean wrong retrieval
context — this is the finding most likely to be visible to an end user.

Examples:

- `2022-2023-graduate` p2 — The content '## Graduate Degrees with HEGIS Codes' is a header, but the section_header breadcrumb 'Header 1: 2022-2023 Graduate Catalog > Header 2: Gr
- `2022-2023-graduate` p10 — The content 'Standards of Academic Progress Cumulative Grade Point Average' is under the header 'Header 1: 2022-2023 Graduate Catalog > Header 2: Stan
- `2022-2023-graduate` p10 — The content 'Graduate-level students are considered to be in good standing if their cumulative GPA is 3.00 or higher at the end of each semester.' is 

**Upstream change:** Re-chunk with breadcrumbs derived from the page's real heading hierarchy (the harness's
`ancestor_path`, which is already computed per page and verified against golden fixtures).

## 2. Course descriptions are truncated or carry a neighbour's text

**2,503 findings** — `B3`

`courses.description` is cut short relative to the page, or contains prose belonging to the
*adjacent* course. Truncation loses content silently; bleed is worse — it attributes one course's
description to another, which a student would act on.

Examples:

- `2022-2023-graduate` p73 — The database description for GPBH 512 is truncated compared to the page.
- `2022-2023-graduate` p75 — The database description for GPBH 521 is truncated compared to the page.
- `2022-2023-graduate` p80 — The database description for GSMT 620 is truncated compared to the page.

**Upstream change:** Fix description capture to bound on the next course heading rather than a character budget,
then re-ingest. `A6`'s 30 ghost rows need the same pass to gain real content.

## 3. Programs and courses on the page were never captured

**670 findings** — `A3` · `A1` · `A5`

`A3` is a **class miss, not a scatter of individuals**: the ingest captured majors and dropped
minors. `Ethics (Minor)`, `Global Health (Minor)`, `AI Literacy (Minor)` and dozens more are on the
pages with no `programs` row. `A1` is the same story for courses — 292 course headings with no row,
at `critical` severity because a missing course is invisible to every downstream consumer.

Examples:

- `2022-2023-graduate` p77 — Page 77 has the program heading 'M.S. in Sport Management' but no programs row matches it
- `2022-2023-graduate` p96 — Page 96 has the program heading 'Ed.D. in Executive Leadership' but no programs row matches it
- `2022-2023-graduate` p106 — Page 106 has the program heading 'M.S. in Education: School Building Leader' but no programs row matches it

**Upstream change:** Ingest program headings by the pattern the catalog actually uses — credential in
parenthetical or trailing position (`X (Minor)`, `X B.A.`) — not by a majors-only rule.

## 4. The prerequisite parser drops meaning

**20 findings** — `B4`

Two distinct losses, and the second changes what a student must take:

- **Minimum-grade qualifiers dropped** (217 rows on the flagship): `MGMT-357 D-` → `MGMT-357`.
- **`or` dropped** (17 rows): `A or B` → `A, B`, turning *one of these* into *all of these*.

Examples:

- `2022-2023-graduate` p0 — 103 course(s) in 2022-2023-graduate: the page states a prerequisite and the stored value is NULL. This is one ingest behaviour, not 103 independent de
- `2022-2023-undergraduate` p0 — 43 course(s) in 2022-2023-undergraduate: the page states a prerequisite and the stored value is NULL. This is one ingest behaviour, not 43 independent
- `2022-2023-undergraduate` p0 — 222 course(s) in 2022-2023-undergraduate: the stored prerequisite drops the minimum-grade qualifier the page states. This is one ingest behaviour, not

**Upstream change:** Preserve the full prerequisite expression — grade qualifiers and boolean structure — rather
than reducing it to a course-code list.

## 5. The schema cannot hold what the pages carry

**84 findings** — `B6`

`Attributes:` appears on **1,118 flagship courses** and there is no column for it anywhere in
`courses`. Also `Formerly titled:`, `PLACEMENT:`, `Typically offered:`. Q3 already classified this
as an architectural gap rather than a data error; it is recorded here because it is still open.

`Formerly titled:` is worth reading beside `D8`/`D4` — the catalog documenting renames is very
likely the same phenomenon behind courses defined twice under conflicting titles.

Examples:

- `2022-2023-graduate` p0 — 205 course page(s) in 2022-2023-graduate carry 'Attributes:' and the courses table has no column for it — a schema gap, not a data error (Q3). Example
- `2022-2023-graduate` p0 — 3 course page(s) in 2022-2023-graduate carry 'Formerly titled:' and the courses table has no column for it — a schema gap, not a data error (Q3). Exam
- `2022-2023-graduate` p0 — 1 course page(s) in 2022-2023-graduate carry 'NOTE:' and the courses table has no column for it — a schema gap, not a data error (Q3). Examples — GMGT

**Upstream change:** Add columns (or a key/value side table), or record the explicit decision to discard these
fields so the gap stops being rediscovered.

---

## What this document does not do

It applies nothing and proposes no database writes. Every count above is reproducible from
`findings.sqlite`; every finding carries the page excerpt and the DB value that justify it (P4).

Findings are **not** deleted when the pipeline is fixed — re-run the harness and they stop being
produced. That is the regression test for this work.
