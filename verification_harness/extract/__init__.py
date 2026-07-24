"""Tier 0 — extraction.

Turns each source ``page_NNNN.md`` into structured ``PageFacts`` (headings with their
``ancestor_path``, course entries, page role) via a Markdown AST walk. Deliberately
independent of the backfill's regex parser (Design Principle P1), and paired with a
*permissive* line-scan that flags heading-like lines the strict AST pass drops.

Modules: ``ast_extractor`` (marko AST), ``permissive_scan`` (AST-vs-line-scan diff),
``page_role`` (structural classifier).
"""
