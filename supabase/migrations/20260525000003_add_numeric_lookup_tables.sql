-- ==============================================================================
-- CDI Factory — Database Numeric Lookup Table Standardization Migration
-- Date: 2026-05-25
-- Author: Pryor Consulting Chief of Staff
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Purge Previous String-Key Lookup Configurations (Clean Reset)
-- ------------------------------------------------------------------------------
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS chunk_type_code CASCADE;
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS toulmin_role_code CASCADE;
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS deontic_modality_code CASCADE;
ALTER TABLE public.semantic_chunks DROP COLUMN IF EXISTS quinean_classification CASCADE;
ALTER TABLE public.courses DROP COLUMN IF EXISTS subject_id CASCADE;
ALTER TABLE public.programs DROP COLUMN IF EXISTS degree_classification_code CASCADE;

DROP TABLE IF EXISTS public.chunk_types CASCADE;
DROP TABLE IF EXISTS public.toulmin_roles CASCADE;
DROP TABLE IF EXISTS public.deontic_modalities CASCADE;
DROP TABLE IF EXISTS public.quinean_web_classifications CASCADE;
DROP TABLE IF EXISTS public.degree_classifications CASCADE;
DROP TABLE IF EXISTS public.subjects CASCADE;

-- ------------------------------------------------------------------------------
-- 2. Create Global Numeric Lookup Tables
-- ------------------------------------------------------------------------------

-- A. Chunk Types
CREATE TABLE public.chunk_types (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    label VARCHAR(50) NOT NULL
);

INSERT INTO public.chunk_types (id, code, label) VALUES
(1, 'root', 'Root Node'),
(2, 'header', 'Header Section'),
(3, 'paragraph', 'Paragraph Content'),
(4, 'table', 'Table Block')
ON CONFLICT (id) DO NOTHING;

-- B. Toulmin Roles
CREATE TABLE public.toulmin_roles (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    label VARCHAR(50) NOT NULL,
    description TEXT
);

INSERT INTO public.toulmin_roles (id, code, label, description) VALUES
(1, 'claim', 'Claim', 'Assertive statement declaring a rule or degree requirement.'),
(2, 'rebuttal', 'Rebuttal', 'Conditions under which the claim does not apply.'),
(3, 'obligation', 'Obligation', 'Deontic requirement acting as an argument premise.'),
(4, 'backing', 'Backing', 'Additional authority validating the warrant (e.g. faculty codes).'),
(5, 'data', 'Data', 'Supporting evidentiary facts, credit counts, or details.'),
(6, 'qualifier', 'Qualifier', 'Expression of degree of logical certainty or conditions.'),
(7, 'warrant', 'Warrant', 'Logical connection linking data to a claim (e.g. prerequisites).'),
(8, 'qualification', 'Qualification', 'Conditional constraint mapping to academic standing.'),
(9, 'prohibition', 'Prohibition', 'Negative constraint declaring forbidden actions.')
ON CONFLICT (id) DO NOTHING;

-- C. Deontic Modalities
CREATE TABLE public.deontic_modalities (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    label VARCHAR(50) NOT NULL,
    description TEXT
);

INSERT INTO public.deontic_modalities (id, code, label, description) VALUES
(1, 'obligation', 'Obligatory', 'Rules that are mandatory (e.g. must, shall, will).'),
(2, 'permission', 'Permissive', 'Optional pathways or guidelines (e.g. may, can, eligible).'),
(3, 'prohibition', 'Prohibitive', 'Forbidden combinations or limits (e.g. cannot, must not).'),
(4, 'na', 'Not Applicable', 'Neutral descriptive content with no direct logical constraint.')
ON CONFLICT (id) DO NOTHING;

-- D. Quinean Web Classifications
CREATE TABLE public.quinean_web_classifications (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    label VARCHAR(50) NOT NULL,
    centrality_index NUMERIC(3, 1) NOT NULL CHECK (centrality_index BETWEEN 1.0 AND 10.0),
    revisability_score NUMERIC(3, 1) NOT NULL CHECK (revisability_score BETWEEN 1.0 AND 10.0),
    description TEXT
);

INSERT INTO public.quinean_web_classifications (id, code, label, centrality_index, revisability_score, description) VALUES
(1, 'thesis', 'Core Thesis', 9.0, 2.0, 'Central systemic policies or program cores defining degree identity.'),
(2, 'scaffolding', 'Intermediate Scaffolding', 5.0, 5.0, 'Major sequences and primary logic trees supporting the core structure.'),
(3, 'illustration', 'Peripheral Illustration', 1.0, 9.0, 'Operational details, typical schedule rotations, and elective options.')
ON CONFLICT (id) DO NOTHING;

-- E. Degree Classifications
CREATE TABLE public.degree_classifications (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(30) UNIQUE NOT NULL,
    label VARCHAR(50) NOT NULL,
    education_level VARCHAR(30) NOT NULL
);

INSERT INTO public.degree_classifications (id, code, label, education_level) VALUES
(1, 'BS', 'Bachelor of Science', 'Undergraduate'),
(2, 'BA', 'Bachelor of Arts', 'Undergraduate'),
(3, 'BBA', 'Bachelor of Business Administration', 'Undergraduate'),
(4, 'MS', 'Master of Science', 'Graduate'),
(5, 'MA', 'Master of Arts', 'Graduate'),
(6, 'MBA', 'Master of Business Administration', 'Graduate'),
(7, 'MINOR', 'Academic Minor', 'Undergraduate'),
(8, 'CERT', 'Certificate Program', 'Both'),
(9, 'AA', 'Associate of Arts', 'Undergraduate'),
(10, 'AS', 'Associate of Science', 'Undergraduate')
ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 3. Create Multi-Tenant Lookup Tables
-- ------------------------------------------------------------------------------

-- F. Course Subjects Prefix Table
CREATE TABLE public.subjects (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES public.institutions(code) ON DELETE CASCADE,
    prefix VARCHAR(20) NOT NULL,
    department_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, prefix)
);

-- ------------------------------------------------------------------------------
-- 4. Alter Dependent Tables to Introduce Numeric Foreign Keys
-- ------------------------------------------------------------------------------

-- A. Semantic Chunks
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS chunk_type_id SMALLINT REFERENCES public.chunk_types(id);
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS toulmin_role_id SMALLINT REFERENCES public.toulmin_roles(id);
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS deontic_modality_id SMALLINT REFERENCES public.deontic_modalities(id);
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS quinean_classification_id SMALLINT REFERENCES public.quinean_web_classifications(id);

-- B. Courses
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES public.subjects(id);

-- C. Programs
ALTER TABLE public.programs ADD COLUMN IF NOT EXISTS degree_classification_id SMALLINT REFERENCES public.degree_classifications(id);

-- ------------------------------------------------------------------------------
-- 5. Backfill Existing Operational Data Transactionally
-- ------------------------------------------------------------------------------

-- A. Backfill Semantic Chunks Lookup IDs
UPDATE public.semantic_chunks sc
SET chunk_type_id = ct.id
FROM public.chunk_types ct
WHERE sc.chunk_type = ct.code AND sc.chunk_type_id IS NULL;

UPDATE public.semantic_chunks sc
SET toulmin_role_id = tr.id
FROM public.toulmin_roles tr
WHERE sc.toulmin_role = tr.code AND sc.toulmin_role_id IS NULL;

UPDATE public.semantic_chunks sc
SET deontic_modality_id = dm.id
FROM public.deontic_modalities dm
WHERE (CASE WHEN sc.deontic_modality = 'N/A' THEN 'na' ELSE sc.deontic_modality END) = dm.code 
AND sc.deontic_modality_id IS NULL;

UPDATE public.semantic_chunks sc
SET quinean_classification_id = qw.id
FROM public.quinean_web_classifications qw
WHERE sc.quinean_weight = qw.code AND sc.quinean_classification_id IS NULL;

-- B. Backfill Subjects and Course Subject IDs
-- Automatically generate subjects from unique course code prefixes (e.g., 'HSV' from 'HSV 405')
INSERT INTO public.subjects (tenant_id, prefix)
SELECT DISTINCT tenant_id, split_part(course_code, ' ', 1)
FROM public.courses
WHERE course_code IS NOT NULL AND course_code != '' AND split_part(course_code, ' ', 1) != ''
ON CONFLICT (tenant_id, prefix) DO NOTHING;

UPDATE public.courses c
SET subject_id = s.id
FROM public.subjects s
WHERE s.tenant_id = c.tenant_id AND s.prefix = split_part(c.course_code, ' ', 1)
AND c.subject_id IS NULL;

-- C. Backfill Program Degree Classification IDs
-- Try to backfill based on connected program requirement degree name
UPDATE public.programs p
SET degree_classification_id = dc.id
FROM public.program_requirements pr
JOIN public.degree_classifications dc ON (
    CASE 
        WHEN pr.degree_name ILIKE '%Bachelor of Science%' OR pr.degree_name ILIKE '%B.S. in%' OR pr.degree_name ILIKE '%B.S. %' THEN 'BS'
        WHEN pr.degree_name ILIKE '%Bachelor of Arts%' OR pr.degree_name ILIKE '%B.A. in%' OR pr.degree_name ILIKE '%B.A. %' THEN 'BA'
        WHEN pr.degree_name ILIKE '%Minor%' THEN 'MINOR'
        WHEN pr.degree_name ILIKE '%Certificate%' THEN 'CERT'
        WHEN pr.degree_name ILIKE '%Master of Science%' OR pr.degree_name ILIKE '%M.S.%' THEN 'MS'
        WHEN pr.degree_name ILIKE '%Master of Arts%' OR pr.degree_name ILIKE '%M.A.%' THEN 'MA'
        ELSE NULL
    END
) = dc.code
WHERE pr.program_id = p.id AND p.degree_classification_id IS NULL;

-- Try fallback matching directly on program name
UPDATE public.programs p
SET degree_classification_id = dc.id
FROM public.degree_classifications dc 
WHERE (
    CASE
        WHEN name ILIKE '%Bachelor of Science%' OR name ILIKE '%B.S. in%' OR name ILIKE 'B.S. %' THEN 'BS'
        WHEN name ILIKE '%Bachelor of Arts%' OR name ILIKE '%B.A. in%' OR name ILIKE 'B.A. %' THEN 'BA'
        WHEN name ILIKE '%Minor%' THEN 'MINOR'
        WHEN name ILIKE '%Certificate%' THEN 'CERT'
        WHEN name ILIKE '%Master of Science%' OR name ILIKE '%M.S.%' THEN 'MS'
        WHEN name ILIKE '%Master of Arts%' OR name ILIKE '%M.A.%' THEN 'MA'
        ELSE NULL
    END
) = dc.code
AND p.degree_classification_id IS NULL;

-- ------------------------------------------------------------------------------
-- 6. Apply Row Level Security (RLS) Policies
-- ------------------------------------------------------------------------------

-- Enable RLS on newly created lookup tables
ALTER TABLE public.chunk_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.toulmin_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deontic_modalities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quinean_web_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.degree_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

-- Global Lookups have Open Select Policies (Read-Only to all)
CREATE POLICY "Allow global select chunk_types" ON public.chunk_types FOR SELECT USING (true);
CREATE POLICY "Allow global select toulmin_roles" ON public.toulmin_roles FOR SELECT USING (true);
CREATE POLICY "Allow global select deontic_modalities" ON public.deontic_modalities FOR SELECT USING (true);
CREATE POLICY "Allow global select quinean_web_classifications" ON public.quinean_web_classifications FOR SELECT USING (true);
CREATE POLICY "Allow global select degree_classifications" ON public.degree_classifications FOR SELECT USING (true);

-- Multi-Tenant subjects table requires tenant boundary check
-- Dropped tenant isolation policy for spoke

COMMIT;
