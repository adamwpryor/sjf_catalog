"""SJF Catalog Verification Harness — a standalone, read-only audit subsystem.

Compares the source catalog pages (ground truth, in GCS) against the derived Supabase
database, page by page, to surface ingestion/backfill errors. It **never writes** to the
catalog database.

- Specification:        ``../DOUBLE_CHECK.md``
- Implementation plan:  ``../DOUBLE_CHECK_IMPLEMENTATION.md``

This package is intentionally independent of the Node/JS backfill in ``../scripts`` and the
app in ``../src`` (Design Principle P1 — a verifier must not share parsing code with the
thing it verifies). Nothing here imports from either.
"""
