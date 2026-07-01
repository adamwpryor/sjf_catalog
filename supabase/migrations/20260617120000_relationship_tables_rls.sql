-- Relationship-table RLS for catalog cloning.
--
-- The Catalog Production Wizard clones a catalog by reading and writing these
-- join tables under `SET LOCAL ROLE authenticated`. They had no RLS policies, so:
--   * if RLS was off, any authenticated user could write them (too permissive); and
--   * if RLS was on with no policy, the clone would silently read/insert zero rows.
--
-- The `subjects` lookup table is included here too: its policies were previously
-- only applied at runtime (via the "Reset Stuck State" action) and granted write
-- to admins. This realigns it with the rest of the catalog-authoring surface.
--
-- This brings them in line with documents/courses/programs/semantic_chunks:
--   READ  : any authenticated user (curriculum structure is not sensitive, and the
--           clone must be able to SELECT the source rows it copies forward)
--   WRITE : registrar + owner only — the roles allowed to start a new catalog project.
--
-- Applied via a DO block so it is idempotent and tolerant of tables that may not
-- exist in a given environment.

DO $$
DECLARE
  t text;
  rel_tables text[] := ARRAY[
    'course_prerequisite_links',
    'program_requirements',
    'program_requirement_courses',
    'program_faculty',
    'policy_mentions_courses',
    'policy_mentions_programs',
    'subjects'
  ];
BEGIN
  FOREACH t IN ARRAY rel_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'Skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS "Public Read Access" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Write Access" ON public.%I', t);

    -- READ: any authenticated user.
    EXECUTE format(
      'CREATE POLICY "Public Read Access" ON public.%I FOR SELECT USING (auth.uid() IS NOT NULL)',
      t
    );

    -- WRITE (INSERT/UPDATE/DELETE): registrar + owner only. WITH CHECK is stated
    -- explicitly so INSERT is governed by the same predicate as USING.
    EXECUTE format(
      'CREATE POLICY "Write Access" ON public.%I FOR ALL '
      || 'USING (auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN (''registrar'', ''owner''))) '
      || 'WITH CHECK (auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN (''registrar'', ''owner'')))',
      t
    );

    -- Table privileges for the role assumed by the clone (SET LOCAL ROLE authenticated).
    -- RLS still constrains *which* rows; these grants just make the table reachable.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
