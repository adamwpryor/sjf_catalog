-- ==============================================================================
-- CDI Factory — Database 3NF Normalization Pruning Migration
-- Date: 2026-05-28
-- Author: Pryor Consulting Chief of Staff
-- ==============================================================================

BEGIN;

-- 1. Drop redundant string classifier columns from semantic_chunks
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS quinean_weight CASCADE;
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS toulmin_role CASCADE;
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS deontic_modality CASCADE;
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS chunk_type CASCADE;

-- 2. Drop dead description column from programs
ALTER TABLE public.programs DROP COLUMN IF EXISTS description CASCADE;

-- 3. Drop legacy PL/pgSQL synchronization triggers & functions
DROP TRIGGER IF EXISTS trigger_sync_semantic_chunk_lookup_ids ON public.semantic_chunks CASCADE;
DROP FUNCTION IF EXISTS sync_semantic_chunk_lookup_ids() CASCADE;

COMMIT;
