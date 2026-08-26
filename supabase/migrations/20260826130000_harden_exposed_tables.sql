-- Close the tables the Supabase linter reports as reachable without authorisation.
--
-- The important one is `user_roles`. 20260605183000_rls_policies.sql created it and
-- then never protected it, while every write policy in that same file gates on its
-- contents:
--
--     auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar','owner'))
--
-- With the public anon key alone, an anonymous caller could read every role
-- assignment, and an INSERT granting 'owner' reached the table and was refused only by
-- the foreign-key constraint -- never by a policy. Any signed-in user knows their own
-- uuid, because it is in their own token, so any `viewer` could promote themselves to
-- `owner` and acquire catalog write access. The gate was sound; the key was in the open.
--
-- The `*_backup` tables are created at runtime by verification_harness/remediate.py and
-- the backfill scripts rather than by any migration, so they are altered with IF EXISTS:
-- a database that has never run those tools will not have them, and this migration must
-- still apply cleanly there.

-- ---------------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------------

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Read your own row, and only your own. That is exactly what the browser needs:
-- src/app/page.tsx and src/components/TrackingDashboard.tsx each read the role for
-- their own session user. It is also enough for the write policies quoted above to keep
-- working, since a user only has to see their own row to prove their own role.
DROP POLICY IF EXISTS "Read own role" ON public.user_roles;
CREATE POLICY "Read own role" ON public.user_roles
  FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT, UPDATE or DELETE policy is created, and that is deliberate: with RLS on,
-- an operation with no policy permitting it is denied. Roles are assigned by
-- scripts/invite_user.mjs over the service-role key, and read by the API routes over a
-- direct owner connection; both bypass RLS and are unaffected.

-- ---------------------------------------------------------------------------------
-- Runtime backup tables
-- ---------------------------------------------------------------------------------
-- These hold copies of catalog rows taken before a write. No policy is defined, so no
-- anon or authenticated access is permitted at all; remediate.py reaches them over the
-- owner connection, which RLS does not apply to.

ALTER TABLE IF EXISTS public.harness_remediation_backup            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.source_page_backfill_backup           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.bio_program_prune_backup              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.bio_program_requirements_prune_backup ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------
-- Trigger functions with a mutable search path
-- ---------------------------------------------------------------------------------
-- Neither is SECURITY DEFINER, so the exposure is small, but an unpinned search_path
-- lets a caller's schema shadow the objects these resolve. Both come from
-- 20260526000000_add_lookup_sync_triggers.sql and always exist.

ALTER FUNCTION public.sync_course_subject_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_program_degree_classification_id() SET search_path = public, pg_temp;
