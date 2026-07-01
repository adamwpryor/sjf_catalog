-- Standardize chunk embeddings on gemini-embedding-001 @ 1536.
--
-- The prior embeddings were 4096-d (from the upstream cdi-factory / NVIDIA Spark pipeline),
-- which (a) mismatched the app's 768-d query embedder so every pgvector query errored and fell
-- back to full-text search, and (b) exceeded pgvector 0.8.0's 2000-dim index limit, so they were
-- unindexable. We standardize the whole stack on gemini-embedding-001 @ 1536: query-time and
-- stored vectors now share one space, and 1536 dims is HNSW-indexable.
--
-- This resizes the column to vector(1536), clearing the unusable 4096-d data; the app's
-- generateEmbedding() + scripts/reembed.mjs repopulate it.
ALTER TABLE semantic_chunks ALTER COLUMN embedding TYPE vector(1536) USING NULL::vector(1536);

CREATE INDEX IF NOT EXISTS idx_semantic_chunks_embedding
  ON semantic_chunks USING hnsw (embedding vector_cosine_ops);
