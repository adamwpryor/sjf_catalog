# Phase 7: Security Hardening

This document tracks the fixes applied during the Phase 7 Ownership Transfer to secure the deployment against unauthorized access, resource consumption, and data destruction.

## §2.2 Items Addressed

### 1. Fail-open Auth in Swarm Service (`services/swarm/main.py`)
- **Vulnerability**: The swarm API middleware logged a warning if `SWARM_API_TOKEN` was absent, but allowed the request to proceed. This effectively made all LLM-powered backend routes open to the public internet, burning cloud resources without authentication.
- **Fix**: Updated `_BearerAuthMiddleware` in `services/swarm/main.py` to check for `_SWARM_TOKEN` properly and return a `401 Unauthorized` response with `JSONResponse` if it is not set.
- **Verification**: Tested the auth gate indirectly by ensuring the swarm smoke test passed, proving valid endpoints still resolve properly when auth matches.

### 2. The Permanently Open LLM Endpoint (`/api/agent/manual-entry-assistant`)
- **Vulnerability**: The endpoint was listed in `_OPEN_PATHS` in `services/swarm/main.py` and was directly called from the Next.js frontend (`TrackingDashboard.tsx`). This exposed a billable cloud AI endpoint without enforcing the swarm token.
- **Fix**: Removed `/api/agent/manual-entry-assistant` from `_OPEN_PATHS`. Created a Next.js proxy route at `src/app/api/swarm/manual-entry-assistant/route.ts` which performs a zero-trust Supabase session check, and forwards the authenticated request to the Swarm backend using the private `SWARM_API_TOKEN` header. Updated the frontend to call this new proxy.
- **Verification**: Compiled Next.js cleanly (`npm run typecheck` passed). The `TrackingDashboard.tsx` correctly resolves the relative URL.

### 3. Destructive GET (`src/app/api/clean-database/route.ts`)
- **Vulnerability**: The endpoint performed irreversible database wipes over a `GET` request, accepting the cleanup secret in the URL query string (which leaks into server logs, proxy logs, and browser history).
- **Fix**: As recommended by Adam, the endpoint was removed entirely. It was a pilot-stage convenience that is too risky to hand over to a new operator.
- **Verification**: The route folder `src/app/api/clean-database/` was deleted.

### 4. Shared-password Self-provisioning (`src/app/api/auth/tester/route.ts`)
- **Vulnerability**: A shared tester password allowed users to mint real, authenticated Supabase users using the admin `service_role` key.
- **Fix**: As recommended, the endpoint was deleted entirely. User creation should be handled natively through Supabase Auth or proper SSO flows.
- **Verification**: The route folder `src/app/api/auth/tester/` was deleted. On verification Claude found the **caller was left behind** — `src/app/login/page.tsx` still POSTed to the deleted route on any failed sign-in from an institutional email address, so the login page held a live call to a 404 alongside a comment describing a feature that no longer existed. The fallback branch has been removed and the shared secret dropped from `.env.example` and `.env.local`.

## §2.2b Stubs Addressed

### 5. Swarm Stub Endpoints
- **Vulnerability**: The `delta-processor`, `curriculum-auditor`, and `diagnostics-analyst` endpoints were placeholders returning canned "success" JSON without doing any actual work. A new operator might assume these systems were functioning normally.
- **Fix**: Removed all three stub endpoints from `services/swarm/main.py`.
- **Verification**: Swarm endpoints successfully re-evaluated with `ruff` and local validation.

## Style / Code Quality Debt Addressed

- Inherited upstream lint warnings (43 `ruff` errors in `services/swarm/`) were resolved. The blind-exception findings (`BLE001`) were **suppressed with `# noqa`, not rewritten** — deliberately, since narrowing an `except Exception` changes which failures propagate, and that is a behavioral change that does not belong in a security pass. The type-annotation findings (`RUF013`, import ordering) were fixed properly. The swarm service now passes `ruff check`.

---

## §2.3 Database Exposure (2026-08-26)

Found by running Supabase's own database linter against the live project while provisioning the
first real user accounts, then confirming each finding by hand against the REST API with nothing but
the public anon key. Applied as `supabase/migrations/20260826130000_harden_exposed_tables.sql`.

### 6. `user_roles` had no row-level security — privilege escalation

The table every write policy depends on was the one table not protected.
`20260605183000_rls_policies.sql` creates `user_roles`, then gates catalog writes on it:

```sql
auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar','owner'))
```

…and never enables RLS on `user_roles` itself. Verified against production: with only the anon key,
which ships to every browser, an anonymous caller read every role assignment, and an `INSERT`
granting `owner` **reached the table** — refused only by the foreign-key constraint, never by a
policy. Every signed-in user knows a valid `auth.users` uuid, because it is their own and it is in
their token. **Any `viewer` could have promoted themselves to `owner`.**

Fixed by enabling RLS with a single `SELECT` policy: a user may read their own row and no other. No
write policy exists, so no write is permitted. The browser needs exactly this much
(`src/app/page.tsx`, `src/components/TrackingDashboard.tsx` each read the role for their own session
user), and the write policies above still resolve, since proving your own role only requires seeing
your own row.

Verified after the change by signing in as a throwaway account: it reads its own role (1 row), sees
no other role (0 rows), and a self-promotion `PATCH` returns `204` while leaving the role `viewer` —
RLS matched no rows. **The status code alone looks like success**, which is why the check compares
the resulting value.

### 7. Runtime backup tables were world-readable

`harness_remediation_backup`, `source_page_backfill_backup`, `bio_program_prune_backup`, and
`bio_program_requirements_prune_backup` hold pre-change copies of catalog rows and were readable with
the anon key. RLS is now enabled on all four, with no policy — nothing outside the owner connection
may read them.

These are created at runtime by tooling, not by any migration, so the migration guards each with
`IF EXISTS` and `remediate.py` now enables RLS on the table it creates. Without that second half the
protection would not survive: a fresh database gets an unprotected table on its first `--apply`.

### 8. Trigger functions with a mutable `search_path`

`sync_course_subject_id` and `sync_program_degree_classification_id` are now pinned to
`public, pg_temp`. Neither is `SECURITY DEFINER`, so the exposure was small.

### 9. Leaked-password protection was disabled

Now enabled: Supabase checks new passwords against HaveIBeenPwned. Turned on before the first real
users chose their passwords rather than after.

**Result:** all five ERROR-level linter findings cleared, along with both `search_path` warnings and
the leaked-password warning.

---

## Known, Not Fixed

Recording these deliberately. A hardening document that lists only what was fixed implies the rest is clean.

### D. `vector` extension lives in the `public` schema

The linter recommends moving it. Doing so means dropping and recreating the extension, which every
`vector(1536)` column and every index depends on — a migration with real risk of leaving the catalog
unsearchable, for a hardening benefit that is close to theoretical here. Left in place deliberately.

### E. Email OTP expiry is 24 hours, not the recommended one hour

Raised on purpose, and the linter flags it (`auth_otp_long_expiry`). Sign-in links have to be
delivered by hand until custom SMTP is configured, and a one-hour window cannot survive that. **Once
SMTP is configured, put this back to 3600** — links then arrive in seconds and the long window is
pure exposure.

### F. Nine tables report `rls_enabled_no_policy`

Informational, and in most cases it is the intended state: RLS enabled with no policy denies
everything, which is what the backup tables and `faculty`, `ghost_log`, `catalog_agent_usage`,
`course_prereq_blocks` and `course_prereq_edges` should do. They are read through the API routes over
an owner connection, which RLS does not apply to. Worth a review if any of them ever needs to be read
directly from the browser.

### G. Minimum password length is 6

Supabase's default, below current guidance. Raising it is a one-line configuration change and was
left alone because it was not among the flagged findings and changes behaviour for real users.

### A. Server-side session checks do not revalidate the token

Every authenticated API route in this application — 12+ of them, including the new proxy added above — authorizes with `supabase.auth.getSession()`. Supabase's own guidance is that `getSession()` **does not revalidate the auth token** on the server; it decodes what the cookie carries. The method intended for server-side authorization decisions is `getUser()`, which verifies the token against the Auth server.

This is a pre-existing, **systemic** pattern rather than a defect introduced here, which is why it was not changed as part of this pass — swapping the call in one route while eleven others keep the old pattern buys nothing and obscures the real work. It should be its own task, converting every route together, with the session-shape differences handled at each call site.

**Risk if left:** a forged or stale auth cookie could pass an authorization check that a `getUser()` call would reject.

### B. The swarm bearer comparison is not constant-time

`services/swarm/main.py` compares the presented bearer token to the expected value with `!=`. A constant-time comparison (`hmac.compare_digest`) is the correct primitive. The practical exposure is low — this is a server-to-server token behind Cloud Run, and a timing oracle over the public internet is noisy — but it is a one-line change whenever that file is next touched.

### C. Permissive CORS

The FastAPI app is configured with `allow_origins=["*"]`. In the current architecture every caller is server-to-server (the Next.js backend), so CORS is not the control that matters and the bearer token is. It should still be narrowed to the deployed frontend origin as defence in depth, and must be narrowed if any browser-direct call is ever reintroduced.
