-- ==============================================================================
-- CDI Factory — Policy Mentions Linkage Junction Tables Migration
-- Date: 2026-05-27
-- Author: Pryor Consulting Chief of Staff
-- ==============================================================================

BEGIN;

-- 1. Create Policy to Course Mentions Junction
CREATE TABLE IF NOT EXISTS public.policy_mentions_courses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL REFERENCES public.institutions(code) ON DELETE CASCADE,
    policy_chunk_id UUID NOT NULL REFERENCES public.semantic_chunks(id) ON DELETE CASCADE,
    course_id       UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, policy_chunk_id, course_id)
);

-- 2. Create Policy to Program Mentions Junction
CREATE TABLE IF NOT EXISTS public.policy_mentions_programs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL REFERENCES public.institutions(code) ON DELETE CASCADE,
    policy_chunk_id UUID NOT NULL REFERENCES public.semantic_chunks(id) ON DELETE CASCADE,
    program_id      UUID NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, policy_chunk_id, program_id)
);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.policy_mentions_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_mentions_programs ENABLE ROW LEVEL SECURITY;

-- 4. Apply Tenant Isolation Policies
DROP POLICY IF EXISTS "Tenant Isolation - Policy Mentions Courses" ON public.policy_mentions_courses;
-- Dropped tenant isolation policy for spoke

DROP POLICY IF EXISTS "Tenant Isolation - Policy Mentions Programs" ON public.policy_mentions_programs;
-- Dropped tenant isolation policy for spoke

COMMIT;
