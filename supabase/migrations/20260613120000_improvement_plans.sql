-- Catalog Improvement Plans: persistent, multi-year, quality-aligned improvement
-- initiatives with dependency mapping. Replaces the previous hardcoded prototype.
-- Criterion columns are accreditor-neutral (accreditation UI is feature-gated).

CREATE TABLE IF NOT EXISTS public.improvement_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'SJFU',
  catalog_id uuid,                          -- source catalog the plan was generated against
  title text NOT NULL,
  description text,
  rationale text,                           -- short AI link: recommendation -> criterion
  ai_detail text,                           -- cached deeper explanation (lazy generated)
  category text,
  criterion_code text,                      -- generic criterion code (any framework), e.g. '2.A'
  criterion_title text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress')),   -- never 'completed'
  target_year text,
  plan_state text NOT NULL DEFAULT 'suggested'
    CHECK (plan_state IN ('suggested', 'selected_current', 'amended_current', 'amended_future')),
  depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,     -- array of improvement_plan ids
  node_x double precision,
  node_y double precision,
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_improvement_plans_tenant_catalog
  ON public.improvement_plans (tenant_id, catalog_id);
CREATE INDEX IF NOT EXISTS idx_improvement_plans_tenant_year
  ON public.improvement_plans (tenant_id, target_year);

-- Row Level Security (mirrors the `corrections` sensitive-table model)
ALTER TABLE public.improvement_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin Registrar Read" ON public.improvement_plans;
DROP POLICY IF EXISTS "Admin Registrar Write" ON public.improvement_plans;

-- READ: admin, registrar, owner
CREATE POLICY "Admin Registrar Read" ON public.improvement_plans FOR SELECT USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'registrar', 'owner'))
);
-- WRITE: admin, registrar, owner (the improvement plan is a collaborative
-- planning tool, so admins manage it too — unlike the corrections approval log).
CREATE POLICY "Admin Registrar Write" ON public.improvement_plans FOR ALL USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'registrar', 'owner'))
);

-- Table privileges for the role assumed by queryWithAuth (SET LOCAL ROLE authenticated)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.improvement_plans TO authenticated;
GRANT ALL ON public.improvement_plans TO service_role;
