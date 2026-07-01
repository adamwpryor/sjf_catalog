-- P0: Vector index
-- Handled in the subsequent migration (20260529000001_resize_embedding_to_1024.sql),
-- which resizes the column to vector(1024) and creates the HNSW index.

-- Add missing structural and referential columns for RAG architecture fixes
ALTER TABLE semantic_chunks 
    ADD COLUMN IF NOT EXISTS table_headers TEXT[],
    ADD COLUMN IF NOT EXISTS cross_references TEXT[];

-- Fix RLS Policy bypassing
-- Drop existing weak policies if they exist
DROP POLICY IF EXISTS "Tenant Isolation - Chunks" ON semantic_chunks;

-- Re-create strict tenant isolation policy utilizing the app.tenant_id session variable
-- matching the application standard established in the corrections table.
CREATE POLICY "Tenant Isolation - Chunks" 
    ON semantic_chunks FOR ALL 
    USING (tenant_id = current_setting('app.tenant_id', true));
