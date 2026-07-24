# tests/fixtures/ — frozen golden oracle

Checked-in, hand-verified JSON that the extractor's output is diffed against. This is the
**single source of truth** for Tier 0 extraction tests.

**Cross-authoring rule (Design Principle P1):** the agent who writes a module does **not**
write its fixtures. The extractor is built by Gemini, so its golden fixtures here are
authored by Claude from real cached pages (and vice versa for Claude-owned modules). This
is what stops a parser bug from being "confirmed" by a test written with the same blind spot.

Naming: `<version>__page_NNNN.json` — e.g. `2025-2026-undergraduate__page_0360.json`
(the `HIST-301` description page, a good `ancestor_path` + credits fixture).

## PageFacts shape (the oracle — `models.py` `PageFacts` must conform)

The fixtures define the extractor's contract. Gemini's `PageFacts` model conforms to *these*, not the
other way round (that is what "cross-authored oracle" means). Proposed shape, per fixture:

```jsonc
{
  "catalog_version": "2025-2026-undergraduate",
  "page": 360,
  "page_role": "content|toc|index|title|faculty_directory|requirements_list|blank|unknown",
  "leading_orphan_text": true,          // page opens with body prose before its first heading
  "headings": [
    { "level": 2, "line": 8, "text": "<verbatim heading text>", "ancestor_path": ["..."] }
  ],
  "courses": [
    { "code": "HIST 301", "title": "P1 Japanese Hist Thru Film", "credits": 3,
      "credits_raw": null, "heading_line": 8, "ancestor_path": [] }
  ]
}
```

**Gemini — `PageFacts` must gain these fields to carry the oracle (as of 2026-07-18 it does not):**
`page_role` (Literal), `leading_orphan_text: bool`, `courses: List[ExtractedCourse]`, and
`ExtractedHeading.line: int`. Suggested course submodel: `{code, title, credits: Optional[int],
credits_raw: Optional[str] (for "(3 TO 6)"), heading_line: int, ancestor_path: List[str]}`.

**Extraction decisions the oracle locks (extractor must match):**
1. **Code normalization** — `HIST-301` (heading) → `HIST 301` (space). Suffixes kept: `CHEM 103C`.
2. **Title** — strip the code prefix and the trailing `(N)`; **keep** attribute prefixes like `P1`.
3. **Credits** — trailing `(3)` → int `3`. Ranges (`(3 TO 6)`) are a known variant (not on p0360);
   represent as raw string + `null` int, and let fidelity check `B1` reason about it.
4. **`ancestor_path`** — within-page only. A heading with no parent heading *on this page* has `[]`;
   the extractor must **not** borrow a parent from the previous page (page boundaries cut the tree).
5. **`leading_orphan_text`** — flags cross-page body bleed so `B3` can account for it.

If Gemini wants different field names, raise it **before** implementing the extractor — changing the
oracle after the fact invalidates every check written against it.
