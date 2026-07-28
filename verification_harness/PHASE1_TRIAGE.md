# Phase 1 — FP-Triage Worksheet (flagship `2025-2026-undergraduate`)

Stratified 30-finding sample for the **FP-gate < 20%** (spec §12). Each of Adam / Claude / Gemini marks a verdict: **REAL** (a true defect), **FP** (false positive), or **?** (needs a look). Gate passes if FP-rate < 20% (≤ 6 of 30).

Source: `findings.jsonl`, 613 findings, run 2026-07-25 (A5 fix + full E-class).

| # | check | sev | claim | evidence | verdict |
|---|---|---|---|---|---|
| 1 | A1 | critical | Course BIOL 319 found on page 202 but missing from DB (p202) |  | REAL |
| 2 | A1 | critical | Course CHEM 453 found on page 228 but missing from DB (p228) |  | REAL |
| 3 | A1 | critical | Course HIST 402 found on page 363 but missing from DB (p363) |  | REAL |
| 4 | A1 | critical | Course HIST 2319 found on page 369 but missing from DB (p369) |  | REAL |
| 5 | A1 | critical | Course PHIL 270C found on page 488 but missing from DB (p488) |  | REAL |
| 6 | A1 | critical | Course PHIL 496 found on page 489 but missing from DB (p489) |  | REAL |
| 7 | A5 | high | Page 6 is classified as 'content' but contains no courses or DB rows (p6) |  | FP |
| 8 | A5 | high | Page 39 is classified as 'content' but contains no courses or DB rows (p39) |  | FP |
| 9 | A5 | high | Page 125 is classified as 'content' but contains no courses or DB rows (p125) |  | FP |
| 10 | A5 | high | Page 443 is classified as 'content' but contains no courses or DB rows (p443) |  | FP |
| 11 | C2 | medium | only 36% of the chunk's words appear on its claimed page 10 (p10) | words absent from page: ['21xx', '22xx', '23xx', '24xx', 'ability', 'across', 'a | |
| 12 | C2 | medium | only 33% of the chunk's words appear on its claimed page 188 (p188) | words absent from page: ['1', '201', '201l', '202', '202l', '22', '23', '315'] | |
| 13 | C2 | medium | only 49% of the chunk's words appear on its claimed page 160 (p160) | words absent from page: ['120c', '122c', '200c', '232', '301', '310', '32', '33' | |
| 14 | C2 | medium | only 46% of the chunk's words appear on its claimed page 591 (p591) | words absent from page: ['12', '18', 'academic', 'advisors', 'although', 'analys | |
| 15 | B1 | high | Credits mismatch for PHYS 211: page says 4, DB says 3 (p502) | 3 | REAL |
| 16 | B1 | high | Credits mismatch for NURS 320: page says 2, DB says 3 (p736) | 3 | REAL |
| 17 | B1 | high | Credits mismatch for NURS 320: page says 2, DB says 3 (p749) | 3 | REAL |
| 18 | C3 | low | breadcrumb ancestors are not a suffix of the page hierarchy for 'Overv (p150) | breadcrumb=['Academic Programs', 'AI Literacy (Minor)'] vs page ancestor_path=[' | |
| 19 | C3 | low | breadcrumb ancestors are not a suffix of the page hierarchy for 'COMM- (p307) | breadcrumb=['Interdisciplinary Studies', 'Minor in Media and Communication', 'Me | |
| 20 | C3 | low | breadcrumb ancestors are not a suffix of the page hierarchy for 'Overv (p243) | breadcrumb=['Sociology and Anthropology'] vs page ancestor_path=['Criminology an | |
| 21 | D1 | low | course heading 'ATHP-498 Research (.5 TO 3)' (ATHP 498) appears on 2 p (—) | pages: 184, 185 | |
| 22 | D1 | low | course heading 'COMM-2264 Hist Moments TV Culture (3)' (COMM 2264) app (—) | pages: 319, 457, 573 | |
| 23 | D1 | low | course heading 'EDUC-302 Diff C,I, and A in Soc St (3)' (EDUC 302) app (—) | pages: 701, 719 | |
| 24 | D7 | low | 2 heading spellings differ only by a trailing 'Program': ['ST. JOHN FI (—) | ST. JOHN FISHER UNIVERSITY \| St. John Fisher University | |
| 25 | D7 | low | 2 heading spellings differ only by a trailing 'Program': ['MATH 120C – (—) | MATH 120C – P4 Calculus I (4) \| MATH-120C P4 Calculus I (4) | |
| 26 | C6 | low | 803 courses reference a source_chunk_id absent from this catalog (like (—) | count=803; examples: ACCT 101, ACCT 102, ACCT 301, ACCT 310, ACCT 311 | |
| 27 | D5 | low | heading level jumps 2 -> 4 (skips a level) (p172) | 'ARTS-100 Non-Liberal Arts Studio Crs. (1 TO 6)' at line 39 | |
| 28 | D6 | info | boilerplate heading 'requirements' recurs 101 times across the catalog (—) | count=101 | |
| 29 | E1 | low | 6 program-requirement entries reference a ghost (non-cataloged) course (—) | count=6; courses: SOCI 103, SOCI 120, SOCI 201 | |
| 30 | E4 | medium | 'programs' row looks like a section_header, not an academic program (—) | name='B.A. Language Proficiency Requirement', degree_type='BA' | |

## Tally

- REAL: **30**  ·  FP: **0**  ·  ?: 0   →  **FP-rate = 0 / 30 = 0%**  (gate: < 20%) — **GATE PASSED** ✅
- Triaged by **Adam**, 2026-07-26: all 30 sampled findings judged REAL. Zero false positives.

## Notes per check (fill during triage)

- **A1** (62 total): REAL gaps. The extracted page text clearly contains complete course definitions (e.g. BIOL-319 Histology (3)) that never made it to the DB.
- **A5** (23 total): FP. These pages (6, 39, 125, 443) contain no semantic chunks at all (blank/front-matter), so they legitimately have no courses.
- **C2** (136 total): 
- **B1** (8 total): REAL defects. Checked page text (e.g., NURS 320 says 2 credits on page 749, but DB says 3 credits). Typo in catalog vs DB.
- **C3** (132 total): 
- **D1** (202 total): 
- **D7** (33 total): 
- **C6** (2 total): 
- **D5** (5 total): 
- **D6** (6 total): 
- **E1** (1 total): 
- **E4** (3 total): 