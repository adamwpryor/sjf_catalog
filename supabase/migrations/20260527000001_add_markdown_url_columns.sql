-- ==============================================================================
-- CDI Factory — Add Markdown URL Columns Migration
-- Date: 2026-05-27
-- Author: Pryor Consulting Chief of Staff
-- ==============================================================================

BEGIN;

-- Add file_hash to documents
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS file_hash TEXT;

-- Add markdown_url to programs
ALTER TABLE public.programs ADD COLUMN IF NOT EXISTS markdown_url TEXT;

-- Add markdown_url to semantic_chunks
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS markdown_url TEXT;

COMMIT;
