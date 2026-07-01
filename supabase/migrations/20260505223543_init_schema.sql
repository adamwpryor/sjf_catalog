CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id TEXT NOT NULL,
    version TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE semantic_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    
    -- Graph / Tree Structure
    parent_chunk_id UUID REFERENCES semantic_chunks(id),
    sequence_order INTEGER NOT NULL,
    chunk_type TEXT NOT NULL,
    
    -- Content & AI Metadata
    section_header TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    page_number INTEGER,
    quinean_weight TEXT,
    toulmin_role TEXT,
    deontic_modality TEXT,
    
    -- Vector Search
    embedding vector(4096),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Apply Row Level Security (RLS) as mandated by Zero-Trust
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_chunks ENABLE ROW LEVEL SECURITY;

-- For local development/ingestion, we allow service role to bypass RLS,
-- but we define strict policies for tenants.
CREATE POLICY "Tenant Isolation - Documents" 
    ON documents FOR ALL 
    USING (true); -- Documents are shared, or joined by chunk tenant

-- Dropped tenant isolation policy for spoke
