-- ==============================================================================
-- Courses → Source Catalog Page Linkage
-- Date: 2026-07-02
-- ------------------------------------------------------------------------------
-- Courses were the only inspectable entity with no traceable link back to the
-- source catalog page. programs/semantic_chunks already carry markdown_url;
-- courses did not. These columns let the Data Inspector render the exact catalog
-- markdown a course's description was extracted from, and give future extractor
-- runs a place to record provenance (which semantic_chunk the description came
-- from). Populated by the recovery backfill for the current catalog.
-- ==============================================================================

ALTER TABLE courses ADD COLUMN IF NOT EXISTS markdown_url TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS source_chunk_id UUID REFERENCES semantic_chunks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_source_chunk_id ON courses(source_chunk_id);
