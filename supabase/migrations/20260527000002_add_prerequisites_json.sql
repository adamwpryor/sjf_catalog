-- Migration: Add prerequisites_json column to courses and semantic_chunks tables
-- Scoped to hold LLM-extracted structured prerequisites and corequisites for catalog graph-linking.

ALTER TABLE courses ADD COLUMN IF NOT EXISTS prerequisites_json JSONB;
ALTER TABLE semantic_chunks ADD COLUMN IF NOT EXISTS prerequisites_json JSONB;
