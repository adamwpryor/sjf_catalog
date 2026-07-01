-- 1. Create user_roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'admin', 'registrar', 'owner')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 2. Enable RLS on all tables
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE faculty ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;

-- 3. Drop existing policies if any to prevent errors
DROP POLICY IF EXISTS "Public Read Access" ON documents;
DROP POLICY IF EXISTS "Write Access" ON documents;

DROP POLICY IF EXISTS "Public Read Access" ON courses;
DROP POLICY IF EXISTS "Write Access" ON courses;

DROP POLICY IF EXISTS "Public Read Access" ON programs;
DROP POLICY IF EXISTS "Write Access" ON programs;

DROP POLICY IF EXISTS "Public Read Access" ON semantic_chunks;
DROP POLICY IF EXISTS "Write Access" ON semantic_chunks;

DROP POLICY IF EXISTS "Admin Registrar Read" ON corrections;
DROP POLICY IF EXISTS "Admin Registrar Write" ON corrections;

-- 4. Create Policies

-- Public Tables: courses, programs, semantic_chunks, documents
-- SELECT: true (if authenticated)
CREATE POLICY "Public Read Access" ON documents FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Write Access" ON documents FOR ALL USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar', 'owner'))
);

CREATE POLICY "Public Read Access" ON courses FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Write Access" ON courses FOR ALL USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar', 'owner'))
);

CREATE POLICY "Public Read Access" ON programs FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Write Access" ON programs FOR ALL USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar', 'owner'))
);

CREATE POLICY "Public Read Access" ON semantic_chunks FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Write Access" ON semantic_chunks FOR ALL USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar', 'owner'))
);

-- Sensitive Tables: corrections, improvement_plans
-- SELECT: admin, registrar, owner
-- WRITE: registrar, owner
CREATE POLICY "Admin Registrar Read" ON corrections FOR SELECT USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'registrar', 'owner'))
);
CREATE POLICY "Admin Registrar Write" ON corrections FOR ALL USING (
  auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar', 'owner'))
);
