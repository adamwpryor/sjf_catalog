#!/usr/bin/env node
/**
 * P5 — RLS isolation & role-matrix test (BUILD_PLAN §P5 security gate).
 *
 * Proves the single-tenant auth model (BUILD_PLAN §3 delta #3): the spoke's only
 * RLS regime is `auth.uid()` + `user_roles`, exercised exactly the way the app's
 * `db.ts / queryWithAuth` sets it — `request.jwt.claim.sub` + `SET LOCAL ROLE
 * authenticated`. Asserts the P5 matrix:
 *
 *   1. Unauthenticated (role `anon`, no jwt claim)  → reads return 0 rows.
 *   2. viewer    → can SELECT public tables; CANNOT write them.
 *   3. registrar → CAN write public tables.
 *   4. corrections → any authenticated user may INSERT (submit a flag),
 *                    but a client (viewer) CANNOT UPDATE/DELETE (service-role only).
 *   5. registrar → CAN UPDATE corrections.
 *
 * Every assertion runs inside a transaction that is ROLLED BACK, so the test
 * never mutates catalog data. Exits non-zero on any failure (CI-friendly).
 *
 * Prereqs (P1/P2 must be done first): the spoke DB is provisioned, migrations
 * applied, and at least one row exists in `courses`. Requires env:
 *   DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run: node scripts/test-rls.mjs   (or: npm run test:rls)
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const { Pool } = pg;

const TENANT_ID = 'SJFU';
const VIEWER_EMAIL = 'rls-test-viewer@sjf.edu';
const REGISTRAR_EMAIL = 'rls-test-registrar@sjf.edu';
const TEST_PASSWORD = 'RlsTest!' + 'Passw0rd';

let passed = 0;
let failed = 0;

/** Records a single assertion result. */
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Asserts that an async operation is REJECTED (RLS should block it). */
async function expectRejected(name, fn) {
  try {
    await fn();
    check(name, false, 'expected the operation to be blocked, but it succeeded');
  } catch (err) {
    // An RLS denial surfaces as a permission/row-security error — that is success.
    check(name, true);
  }
}

/** Asserts that an async operation SUCCEEDS. */
async function expectAllowed(name, fn) {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, err.message);
  }
}

/**
 * Asserts a write is effectively blocked by RLS. A denial can surface two ways:
 * a thrown permission error, OR a silent 0-row result (the USING clause filters
 * every row out). Either is a pass; an actual mutation (rowCount > 0) is a fail.
 * `fn` must return the pg result object.
 */
async function expectNoMutation(name, fn) {
  try {
    const res = await fn();
    check(name, res.rowCount === 0, `RLS allowed a mutation of ${res.rowCount} row(s)`);
  } catch {
    check(name, true); // thrown denial — blocked as intended
  }
}

/**
 * Runs `body(client)` in an authenticated transaction, mirroring
 * `queryWithAuth`, then ALWAYS rolls back. Pass `userId = null` to simulate an
 * unauthenticated caller (role `anon`, no jwt claim).
 */
async function inAuthTx(pool, userId, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query('SET LOCAL ROLE authenticated');
    } else {
      await client.query('SET LOCAL ROLE anon');
    }
    return await body(client);
  } finally {
    // Never persist test writes.
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    client.release();
  }
}

/** Creates the user if absent (idempotent) and returns its UUID. */
async function ensureUser(admin, email) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (!error && created?.user) return created.user.id;

  // Already exists — find it by paging the user list.
  for (let page = 1; page <= 20; page++) {
    const { data, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listErr) throw listErr;
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < 200) break;
  }
  throw new Error(`Could not create or locate test user ${email}: ${error?.message || 'unknown'}`);
}

async function main() {
  const { DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const missing = [
    ['DATABASE_URL', DATABASE_URL],
    ['NEXT_PUBLIC_SUPABASE_URL', NEXT_PUBLIC_SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`RLS test cannot run — missing env: ${missing.join(', ')}`);
    console.error('This test requires a provisioned spoke DB (P1/P2). See BUILD_PLAN §P5.');
    process.exit(1);
  }

  const admin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });

  try {
    console.log('Seeding test users + roles...');
    const viewerId = await ensureUser(admin, VIEWER_EMAIL);
    const registrarId = await ensureUser(admin, REGISTRAR_EMAIL);
    // Seed roles via service role (bypasses RLS) — upsert so the test is re-runnable.
    await pool.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'viewer'), ($2, 'registrar')
       ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`,
      [viewerId, registrarId]
    );

    console.log('\n[1] Unauthenticated access (role anon, no jwt claim)');
    await inAuthTx(pool, null, async (c) => {
      const { rows } = await c.query('SELECT id FROM courses LIMIT 5');
      check('anon SELECT courses returns 0 rows', rows.length === 0, `got ${rows.length}`);
    });

    console.log('\n[2] viewer — read-only on public tables');
    await inAuthTx(pool, viewerId, async (c) => {
      await expectAllowed('viewer can SELECT courses', async () => {
        await c.query('SELECT id FROM courses LIMIT 5');
      });
    });
    await inAuthTx(pool, viewerId, async (c) => {
      await expectRejected('viewer CANNOT INSERT courses', async () => {
        await c.query(
          `INSERT INTO courses (tenant_id, course_code, title) VALUES ($1, 'RLS-TEST-101', 'RLS probe')`,
          [TENANT_ID]
        );
      });
    });

    console.log('\n[3] registrar — write on public tables');
    await inAuthTx(pool, registrarId, async (c) => {
      await expectAllowed('registrar CAN INSERT courses', async () => {
        await c.query(
          `INSERT INTO courses (tenant_id, course_code, title) VALUES ($1, 'RLS-TEST-102', 'RLS probe')`,
          [TENANT_ID]
        );
      });
    });

    console.log('\n[4] corrections — client insert allowed, client update/delete blocked');
    await inAuthTx(pool, viewerId, async (c) => {
      await expectAllowed('viewer (client) CAN INSERT a correction', async () => {
        await c.query(
          `INSERT INTO corrections (tenant_id, target_table, field_name, current_value, proposed_value, reason, status, submitted_by)
           VALUES ($1, 'courses', 'title', 'old', 'new', 'rls probe', 'pending', $2)`,
          [TENANT_ID, VIEWER_EMAIL]
        );
      });
    });
    await inAuthTx(pool, viewerId, async (c) => {
      await expectNoMutation('viewer (client) CANNOT UPDATE corrections', () =>
        c.query(`UPDATE corrections SET status = 'approved' WHERE tenant_id = $1`, [TENANT_ID])
      );
    });
    await inAuthTx(pool, viewerId, async (c) => {
      await expectNoMutation('viewer (client) CANNOT DELETE corrections', () =>
        c.query(`DELETE FROM corrections WHERE tenant_id = $1`, [TENANT_ID])
      );
    });

    console.log('\n[5] registrar — can update corrections');
    await inAuthTx(pool, registrarId, async (c) => {
      await expectAllowed('registrar CAN UPDATE corrections', async () => {
        await c.query(`UPDATE corrections SET status = 'approved' WHERE tenant_id = $1`, [TENANT_ID]);
      });
    });

    console.log(`\nRLS matrix: ${passed} passed, ${failed} failed.`);
  } finally {
    await pool.end();
  }

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('RLS test crashed:', err.message);
  process.exit(1);
});
