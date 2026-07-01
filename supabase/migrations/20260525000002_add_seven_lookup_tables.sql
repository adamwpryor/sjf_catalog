-- ==============================================================================
-- CDI Factory — Database Lookup Table Standardization Migration
-- Date: 2026-05-25
-- Author: Pryor Consulting Chief of Staff
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Ensure master institutions are registered
-- ------------------------------------------------------------------------------
INSERT INTO public.institutions (code, name, created_at) VALUES
('GLOBAL', 'Global / Shared Accreditation Data', NOW()),
('CCSJ', 'Calumet College of Saint Joseph', NOW()),
('SJFU', 'St. John Fisher University', NOW())
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. Create Global Lookup Tables
-- ------------------------------------------------------------------------------

-- A. Chunk Types
CREATE TABLE IF NOT EXISTS public.chunk_types (
    code VARCHAR(30) PRIMARY KEY,
    label VARCHAR(50) NOT NULL
);

INSERT INTO public.chunk_types (code, label) VALUES
('header', 'Header Section'),
('paragraph', 'Paragraph Content'),
('table', 'Table Block'),
('root', 'Root Node')
ON CONFLICT (code) DO NOTHING;

-- B. Toulmin Roles
CREATE TABLE IF NOT EXISTS public.toulmin_roles (
    code VARCHAR(30) PRIMARY KEY,
    label VARCHAR(50) NOT NULL,
    description TEXT
);

INSERT INTO public.toulmin_roles (code, label, description) VALUES
('claim', 'Claim', 'Assertive statement declaring a rule or degree requirement.'),
('rebuttal', 'Rebuttal', 'Conditions under which the claim does not apply.'),
('obligation', 'Obligation', 'Deontic requirement acting as an argument premise.'),
('backing', 'Backing', 'Additional authority validating the warrant (e.g. faculty codes).'),
('data', 'Data', 'Supporting evidentiary facts, credit counts, or details.'),
('qualifier', 'Qualifier', 'Expression of degree of logical certainty or conditions.'),
('warrant', 'Warrant', 'Logical connection linking data to a claim (e.g. prerequisites).'),
('qualification', 'Qualification', 'Conditional constraint mapping to academic standing.'),
('prohibition', 'Prohibition', 'Negative constraint declaring forbidden actions.')
ON CONFLICT (code) DO NOTHING;

-- C. Deontic Modalities
CREATE TABLE IF NOT EXISTS public.deontic_modalities (
    code VARCHAR(30) PRIMARY KEY,
    label VARCHAR(50) NOT NULL,
    description TEXT
);

INSERT INTO public.deontic_modalities (code, label, description) VALUES
('obligation', 'Obligatory', 'Rules that are mandatory (e.g. must, shall, will).'),
('permission', 'Permissive', 'Optional pathways or guidelines (e.g. may, can, eligible).'),
('prohibition', 'Prohibitive', 'Forbidden combinations or limits (e.g. cannot, must not).'),
('na', 'Not Applicable', 'Neutral descriptive content with no direct logical constraint.')
ON CONFLICT (code) DO NOTHING;

-- D. Quinean Web Classifications
CREATE TABLE IF NOT EXISTS public.quinean_web_classifications (
    code VARCHAR(30) PRIMARY KEY,
    label VARCHAR(50) NOT NULL,
    centrality_index NUMERIC(3, 1) NOT NULL CHECK (centrality_index BETWEEN 1.0 AND 10.0),
    revisability_score NUMERIC(3, 1) NOT NULL CHECK (revisability_score BETWEEN 1.0 AND 10.0),
    description TEXT
);

INSERT INTO public.quinean_web_classifications (code, label, centrality_index, revisability_score, description) VALUES
('thesis', 'Core Thesis', 9.0, 2.0, 'Central systemic policies or program cores defining degree identity.'),
('scaffolding', 'Intermediate Scaffolding', 5.0, 5.0, 'Major sequences and primary logic trees supporting the core structure.'),
('illustration', 'Peripheral Illustration', 1.0, 9.0, 'Operational details, typical schedule rotations, and elective options.')
ON CONFLICT (code) DO NOTHING;

-- E. Degree Classifications
CREATE TABLE IF NOT EXISTS public.degree_classifications (
    code VARCHAR(30) PRIMARY KEY,
    label VARCHAR(50) NOT NULL,
    education_level VARCHAR(30) NOT NULL
);

INSERT INTO public.degree_classifications (code, label, education_level) VALUES
('BS', 'Bachelor of Science', 'Undergraduate'),
('BA', 'Bachelor of Arts', 'Undergraduate'),
('BBA', 'Bachelor of Business Administration', 'Undergraduate'),
('MS', 'Master of Science', 'Graduate'),
('MA', 'Master of Arts', 'Graduate'),
('MBA', 'Master of Business Administration', 'Graduate'),
('MINOR', 'Academic Minor', 'Undergraduate'),
('CERT', 'Certificate Program', 'Both'),
('AA', 'Associate of Arts', 'Undergraduate'),
('AS', 'Associate of Science', 'Undergraduate')
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 3. Create Multi-Tenant Lookup Tables
-- ------------------------------------------------------------------------------

-- F. Course Subjects Prefix Table
CREATE TABLE IF NOT EXISTS public.subjects (
    id SERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES public.institutions(code) ON DELETE CASCADE,
    prefix VARCHAR(20) NOT NULL,
    department_name TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, prefix)
);

-- ------------------------------------------------------------------------------
-- 4. Alter Dependent Tables to Introduce Foreign Keys
-- ------------------------------------------------------------------------------

-- A. Semantic Chunks
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS chunk_type_code VARCHAR(30) REFERENCES public.chunk_types(code);
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS toulmin_role_code VARCHAR(30) REFERENCES public.toulmin_roles(code);
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS deontic_modality_code VARCHAR(30) REFERENCES public.deontic_modalities(code);
ALTER TABLE public.semantic_chunks ADD COLUMN IF NOT EXISTS quinean_classification VARCHAR(30) REFERENCES public.quinean_web_classifications(code);

-- B. Courses
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES public.subjects(id);

-- C. Programs
ALTER TABLE public.programs ADD COLUMN IF NOT EXISTS degree_classification_code VARCHAR(30) REFERENCES public.degree_classifications(code);

-- ------------------------------------------------------------------------------
-- 5. Backfill Existing Operational Data
-- ------------------------------------------------------------------------------

-- A. Backfill Semantic Chunks Lookup Codes
UPDATE public.semantic_chunks 
SET chunk_type_code = chunk_type
WHERE chunk_type IS NOT NULL AND chunk_type_code IS NULL;

UPDATE public.semantic_chunks 
SET toulmin_role_code = toulmin_role
WHERE toulmin_role IS NOT NULL AND toulmin_role_code IS NULL;

UPDATE public.semantic_chunks 
SET deontic_modality_code = CASE 
    WHEN deontic_modality = 'N/A' THEN 'na'
    ELSE deontic_modality
END
WHERE deontic_modality IS NOT NULL AND deontic_modality_code IS NULL;

UPDATE public.semantic_chunks 
SET quinean_classification = quinean_weight
WHERE quinean_weight IS NOT NULL AND quinean_classification IS NULL;

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

-- C. Backfill Program Degree Classification Codes
-- Try to backfill based on connected program requirement degree name
UPDATE public.programs p
SET degree_classification_code = CASE
    WHEN pr.degree_name ILIKE '%Bachelor of Science%' OR pr.degree_name ILIKE '%B.S. in%' OR pr.degree_name ILIKE '%B.S. %' THEN 'BS'
    WHEN pr.degree_name ILIKE '%Bachelor of Arts%' OR pr.degree_name ILIKE '%B.A. in%' OR pr.degree_name ILIKE '%B.A. %' THEN 'BA'
    WHEN pr.degree_name ILIKE '%Minor%' THEN 'MINOR'
    WHEN pr.degree_name ILIKE '%Certificate%' THEN 'CERT'
    WHEN pr.degree_name ILIKE '%Master of Science%' OR pr.degree_name ILIKE '%M.S.%' THEN 'MS'
    WHEN pr.degree_name ILIKE '%Master of Arts%' OR pr.degree_name ILIKE '%M.A.%' THEN 'MA'
    ELSE NULL
END
FROM public.program_requirements pr
WHERE pr.program_id = p.id AND p.degree_classification_code IS NULL;

-- Try fallback matching directly on program name
UPDATE public.programs p
SET degree_classification_code = CASE
    WHEN name ILIKE '%Bachelor of Science%' OR name ILIKE '%B.S. in%' OR name ILIKE 'B.S. %' THEN 'BS'
    WHEN name ILIKE '%Bachelor of Arts%' OR name ILIKE '%B.A. in%' OR name ILIKE 'B.A. %' THEN 'BA'
    WHEN name ILIKE '%Minor%' THEN 'MINOR'
    WHEN name ILIKE '%Certificate%' THEN 'CERT'
    WHEN name ILIKE '%Master of Science%' OR name ILIKE '%M.S.%' THEN 'MS'
    WHEN name ILIKE '%Master of Arts%' OR name ILIKE '%M.A.%' THEN 'MA'
    ELSE NULL
END
WHERE degree_classification_code IS NULL;

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
