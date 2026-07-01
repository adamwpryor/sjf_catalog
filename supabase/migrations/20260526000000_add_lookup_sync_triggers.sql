-- ==============================================================================
-- CDI Factory — Automated Lookup Synchronization Triggers
-- Date: 2026-05-26
-- Author: Pryor Consulting Chief of Staff
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Triggers for semantic_chunks (Toulmin, Deontic, Quinean, Chunk Types)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_semantic_chunk_lookup_ids()
RETURNS TRIGGER AS $$
BEGIN
    -- A. Map chunk_type to chunk_type_id
    IF NEW.chunk_type IS NOT NULL THEN
        SELECT id INTO NEW.chunk_type_id 
        FROM public.chunk_types 
        WHERE code = NEW.chunk_type;
    END IF;

    -- B. Map toulmin_role to toulmin_role_id
    IF NEW.toulmin_role IS NOT NULL THEN
        SELECT id INTO NEW.toulmin_role_id 
        FROM public.toulmin_roles 
        WHERE code = NEW.toulmin_role;
    END IF;

    -- C. Map deontic_modality to deontic_modality_id (normalizing 'N/A' to 'na')
    IF NEW.deontic_modality IS NOT NULL THEN
        SELECT id INTO NEW.deontic_modality_id 
        FROM public.deontic_modalities 
        WHERE code = (CASE WHEN NEW.deontic_modality = 'N/A' THEN 'na' ELSE NEW.deontic_modality END);
    END IF;

    -- D. Map quinean_weight to quinean_classification_id
    IF NEW.quinean_weight IS NOT NULL THEN
        SELECT id INTO NEW.quinean_classification_id 
        FROM public.quinean_web_classifications 
        WHERE code = NEW.quinean_weight;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_semantic_chunk_lookup_ids ON public.semantic_chunks;
CREATE TRIGGER trigger_sync_semantic_chunk_lookup_ids
BEFORE INSERT OR UPDATE OF chunk_type, toulmin_role, deontic_modality, quinean_weight
ON public.semantic_chunks
FOR EACH ROW
EXECUTE FUNCTION public.sync_semantic_chunk_lookup_ids();

-- ------------------------------------------------------------------------------
-- 2. Triggers for courses (Automated Subject Prefix Isolation)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_course_subject_id()
RETURNS TRIGGER AS $$
DECLARE
    v_prefix VARCHAR(20);
    v_subject_id INTEGER;
BEGIN
    -- Extract the prefix (first word of the course code, e.g., 'HSV' from 'HSV 405')
    IF NEW.course_code IS NOT NULL AND NEW.course_code != '' THEN
        v_prefix := split_part(NEW.course_code, ' ', 1);
        
        IF v_prefix != '' THEN
            -- Ensure subject exists in subjects lookup table scoped to tenant
            INSERT INTO public.subjects (tenant_id, prefix)
            VALUES (NEW.tenant_id, v_prefix)
            ON CONFLICT (tenant_id, prefix) DO NOTHING;
            
            -- Fetch the subject ID
            SELECT id INTO v_subject_id 
            FROM public.subjects 
            WHERE tenant_id = NEW.tenant_id AND prefix = v_prefix;
            
            NEW.subject_id := v_subject_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_course_subject_id ON public.courses;
CREATE TRIGGER trigger_sync_course_subject_id
BEFORE INSERT OR UPDATE OF course_code, tenant_id
ON public.courses
FOR EACH ROW
EXECUTE FUNCTION public.sync_course_subject_id();

-- ------------------------------------------------------------------------------
-- 3. Triggers for programs (Automated Degree Classification Matching)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_program_degree_classification_id()
RETURNS TRIGGER AS $$
DECLARE
    v_code VARCHAR(30);
    v_degree_id SMALLINT;
BEGIN
    -- Dynamically extract classification from program name
    IF NEW.name IS NOT NULL THEN
        v_code := CASE
            WHEN NEW.name ILIKE '%Bachelor of Science%' OR NEW.name ILIKE '%B.S. in%' OR NEW.name ILIKE 'B.S. %' THEN 'BS'
            WHEN NEW.name ILIKE '%Bachelor of Arts%' OR NEW.name ILIKE '%B.A. in%' OR NEW.name ILIKE 'B.A. %' THEN 'BA'
            WHEN NEW.name ILIKE '%Minor%' THEN 'MINOR'
            WHEN NEW.name ILIKE '%Certificate%' THEN 'CERT'
            WHEN NEW.name ILIKE '%Master of Science%' OR NEW.name ILIKE '%M.S.%' THEN 'MS'
            WHEN NEW.name ILIKE '%Master of Arts%' OR NEW.name ILIKE '%M.A.%' THEN 'MA'
            ELSE NULL
        END;
        
        IF v_code IS NOT NULL THEN
            SELECT id INTO v_degree_id 
            FROM public.degree_classifications 
            WHERE code = v_code;
            
            NEW.degree_classification_id := v_degree_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_program_degree_classification_id ON public.programs;
CREATE TRIGGER trigger_sync_program_degree_classification_id
BEFORE INSERT OR UPDATE OF name
ON public.programs
FOR EACH ROW
EXECUTE FUNCTION public.sync_program_degree_classification_id();

COMMIT;
