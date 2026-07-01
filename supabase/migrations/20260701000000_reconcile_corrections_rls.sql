-- Reconcile corrections RLS into a single, coherent single-tenant regime.
--
-- BUILD_PLAN §3 delta #3 calls for reconciling RLS to one auth model, but two
-- migrations left overlapping, contradictory policies on `corrections`:
--   * 20260525000000_add_corrections_table.sql
--       clients_can_submit_corrections  (INSERT WITH CHECK true)
--       clients_can_view_own_corrections(SELECT USING true)     -- any authed user reads ALL rows
--       (comment claimed "UPDATE/DELETE blocked client-side")
--   * 20260605183000_rls_policies.sql
--       "Admin Registrar Read"  (SELECT admin/registrar/owner)
--       "Admin Registrar Write" (FOR ALL registrar/owner)       -- silently re-enabled client UPDATE/DELETE
--
-- Because permissive policies OR together, the live behavior was: SELECT open to any
-- authenticated user, and UPDATE/DELETE allowed to registrar/owner — softening the
-- P5/P7 "client UPDATE/DELETE blocked" gate, and (separately) breaking admin review
-- because the API PATCH route authorizes admin but the write policy excluded it.
--
-- This migration replaces all four with one regime:
--   INSERT : any authenticated user            -- the flag/feedback submission path
--   SELECT : admin | registrar | owner         -- reviewers only (sensitive queue)
--   UPDATE : admin | registrar | owner         -- status transitions via /api/corrections PATCH
--   DELETE : none for the authenticated role   -- append-only for clients; only the hub's
--                                                 service-role (pull_corrections.py, which
--                                                 bypasses RLS) may purge/transition rows.

ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;

-- Drop every prior corrections policy (from both source migrations).
DROP POLICY IF EXISTS "clients_can_submit_corrections"   ON corrections;
DROP POLICY IF EXISTS "clients_can_view_own_corrections"  ON corrections;
DROP POLICY IF EXISTS "Admin Registrar Read"              ON corrections;
DROP POLICY IF EXISTS "Admin Registrar Write"             ON corrections;
-- Names this migration owns (idempotent re-run).
DROP POLICY IF EXISTS "corrections_insert_authenticated"  ON corrections;
DROP POLICY IF EXISTS "corrections_select_reviewers"      ON corrections;
DROP POLICY IF EXISTS "corrections_update_reviewers"      ON corrections;

-- INSERT: any authenticated user may file a correction flag.
CREATE POLICY "corrections_insert_authenticated" ON corrections
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- SELECT: only reviewers see the corrections queue.
CREATE POLICY "corrections_select_reviewers" ON corrections
  FOR SELECT
  USING (auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'registrar', 'owner')));

-- UPDATE: reviewers transition status (pending -> approved/applied/rejected) via the API.
-- WITH CHECK mirrors USING so the row can't be reassigned out of the reviewer regime.
CREATE POLICY "corrections_update_reviewers" ON corrections
  FOR UPDATE
  USING (auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'registrar', 'owner')))
  WITH CHECK (auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('admin', 'registrar', 'owner')));

-- No DELETE policy: the authenticated role cannot delete corrections. The hub's
-- service-role key bypasses RLS and remains free to purge/transition rows.
