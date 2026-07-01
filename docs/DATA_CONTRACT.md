# Data Contract (SJFU)

SJFU cloud counts must match the hub within tolerance. The following counts serve as the canonical baseline for a successful data load:

| Table | Expected Count (Approx) | Notes |
|---|---|---|
| `courses` | 5,923 | |
| `programs` | 1,203 | *See HUB_UPGRADE_AIP_PARITY.md regarding over-extraction* |
| `program_requirements` | 932 | |
| `program_requirement_courses` | 2,402 | Crucial link table |
| `course_prerequisite_links` | 2,939 | Crucial link table |
| `semantic_chunks` | 34,570 | Embeddings will be rewritten to 1536 dimensions |
| `documents` | 8 | grad+undergrad × 4 years |
