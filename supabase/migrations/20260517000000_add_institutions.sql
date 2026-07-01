-- Institutions registry: provides a stable numeric primary key for cross-institution
-- research queries while keeping tenant_id TEXT for RLS continuity.

CREATE TABLE institutions (
    id   SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,  -- matches tenant_id values (e.g. 'SJFU', 'GLOBAL')
    name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;

-- Service role can manage institutions; no tenant-scoped restriction needed here
-- since this is a global registry, not per-tenant data.
CREATE POLICY "Service role manages institutions"
    ON institutions FOR ALL
    USING (true);

-- Seed known institutions for this spoke (create-spoke templates the tenant row).
INSERT INTO institutions (code, name) VALUES
    ('GLOBAL', 'Global / Shared Accreditation Data'),
    ('SJFU',   'St. John Fisher University');

-- Add institution_id FK to semantic_chunks alongside tenant_id (which stays for RLS)
ALTER TABLE semantic_chunks
    ADD COLUMN institution_id INTEGER REFERENCES institutions(id);

-- Backfill from existing tenant_id values
UPDATE semantic_chunks sc
SET institution_id = i.id
FROM institutions i
WHERE i.code = sc.tenant_id;

-- Same for programs and courses
ALTER TABLE programs
    ADD COLUMN institution_id INTEGER REFERENCES institutions(id);

UPDATE programs p
SET institution_id = i.id
FROM institutions i
WHERE i.code = p.tenant_id;

ALTER TABLE courses
    ADD COLUMN institution_id INTEGER REFERENCES institutions(id);

UPDATE courses c
SET institution_id = i.id
FROM institutions i
WHERE i.code = c.tenant_id;

-- documents table uses domain_id but not tenant_id; no change needed there.

-- Index for research queries crossing institutions
CREATE INDEX idx_semantic_chunks_institution_id ON semantic_chunks(institution_id);
CREATE INDEX idx_programs_institution_id ON programs(institution_id);
CREATE INDEX idx_courses_institution_id ON courses(institution_id);
