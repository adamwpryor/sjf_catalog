# Playbook D4 — Supabase Auth and access roles

Configures sign-in and the role rows that row-level security depends on.

`TRANSFER_RUNBOOK.md` §3.2 is where this sits. This document owns the commands, the verification,
and the rollback.

**Why this needs its own playbook.** Everything here lives in dashboard settings and in one table's
contents — none of it is in a migration file, so applying all 25 migrations produces a database that
is correctly shaped and completely inaccessible. The migrations create the `user_roles` table and
the policies that read it; they do not create the redirect allowlist and they do not put a single
row in that table.

The characteristic failure is a deployment where sign-in appears to succeed and every page is empty,
because RLS is doing exactly what it was told.

---

## 1. What has to exist

| Piece | Where it lives | Created by |
| --- | --- | --- |
| Redirect URL allowlist | Supabase dashboard → Authentication → URL Configuration | You, by hand |
| `user_roles` table | `supabase/migrations/20260605183000_rls_policies.sql` | Migrations |
| RLS policies on catalog tables | same migration | Migrations |
| **Rows in `user_roles`** | the table | **You, by hand — nothing seeds them** |

`user_roles` is small and strict:

```sql
CREATE TABLE IF NOT EXISTS public.user_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('viewer', 'admin', 'registrar', 'owner')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);
```

One role per user — the `UNIQUE(user_id)` constraint means you promote by updating, not by
inserting a second row. Write operations across the catalog are gated on `registrar` or `owner`;
`viewer` and `admin` do not carry them.

---

## 2. Procedure

### 2.1 Redirect allowlist

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL:** your production domain, e.g. `https://catalog.your-domain.edu`
- **Redirect URLs:** add each origin that will complete a sign-in —
  - `https://catalog.your-domain.edu/**`
  - your Vercel preview domain, if previews are used
  - `http://localhost:3000/**` for local development

The auth callback at `src/app/auth/callback/route.ts` derives its redirect base from the request
host, so an origin missing from this list fails at the exchange step with an opaque error rather
than an obvious one.

### 2.2 Email and provider settings

Confirm under **Authentication → Providers** that the sign-in method you intend is enabled, and that
email confirmation matches your institutional policy. The application uses password sign-in with a
PKCE callback and does not assume any particular provider beyond that.

### 2.3 Inviting users — the supported path

Accounts are created by invitation. `scripts/invite_user.mjs` sends the invitation *and* writes the
`user_roles` row in one run, because doing only the first half is the failure this section exists to
prevent.

```bash
# See who exists and which accounts have no role
node scripts/invite_user.mjs --list

# Preview (dry run by default — nothing sent, nothing written)
node scripts/invite_user.mjs --email someone@sjf.edu --role registrar

# Send
node scripts/invite_user.mjs --email someone@sjf.edu --role registrar --send

# Or in bulk, from a file of "email,role" lines
node scripts/invite_user.mjs --file invites.txt --send
```

It validates against **both** institutional mail domains before sending anything — staff addresses
exist on `sjf.edu` and `sjfc.edu`, and a check that allows only one silently rejects real people.

**Set `NEXT_PUBLIC_SITE_URL` first,** and make sure that URL is on the redirect allowlist from §2.1.
Invitation links are single-use: if they resolve to the wrong origin, the invitation is spent and the
recipient has to be invited again.

The recipient clicks the emailed link, lands on `/auth/callback` (which handles `type=invite`), and
is forwarded to `/update-password` to choose their own password. Nobody shares a password.

### 2.4 Create the first account manually, if you prefer

Create it through the dashboard (**Authentication → Users → Add user**) or by signing up through the
deployed application. Either way, the account exists in `auth.users` with **no role**, and can see
nothing until §2.5.

### 2.5 Seed the roles by hand, if you did not use the invite script

```sql
-- Find the user id
SELECT id, email FROM auth.users ORDER BY created_at DESC LIMIT 5;

-- Grant ownership
INSERT INTO public.user_roles (user_id, role)
VALUES ('<user-uuid>', 'owner');
```

Add the rest of the team by role. Promote an existing user with an update, not an insert:

```sql
UPDATE public.user_roles SET role = 'registrar' WHERE user_id = '<user-uuid>';
```

Grant `owner` sparingly. `registrar` is the role that carries catalog write access, which is what
most day-to-day staff need.

---

## 3. Verification

### 3.1 A role row exists for every user who needs one

```sql
SELECT u.email, COALESCE(r.role, '(none)') AS role
FROM auth.users u
LEFT JOIN public.user_roles r ON r.user_id = u.id
ORDER BY u.created_at;
```

Anyone showing `(none)` can sign in and will see an empty application. That is the failure this
playbook exists to prevent, and it looks like a data migration problem rather than a permissions
one.

### 3.2 Sign in, and confirm you can see catalog data

Open the deployed application and sign in. You should reach the dashboard **and** see courses and
programs. Reaching the dashboard alone proves authentication; seeing rows proves authorisation,
and only the second one exercises RLS.

### 3.3 Write access, if the account is meant to have it

As a `registrar` or `owner`, submit a correction through the catalog tools. A permission error here
points at the role row, not at the feature.

### 3.4 The scripted check

The repository ships a row-level-security test:

```bash
npm run test:rls
```

It needs `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the target project. Run it after
seeding, not before — with an empty `user_roles` it reports failures that are expected rather than
informative.

---

## 4. Rollback

Auth configuration is dashboard state; revert by restoring the previous values. Role rows are
ordinary data:

```sql
-- Remove one user's role
DELETE FROM public.user_roles WHERE user_id = '<user-uuid>';

-- Clear all roles (locks everyone out of catalog data; do this only deliberately)
TRUNCATE public.user_roles;
```

Deleting an `auth.users` row cascades to `user_roles`, so removing a user does not leave a dangling
role.

**One warning about a route that no longer exists.** Earlier revisions shipped a self-provisioning
endpoint that created real accounts for anyone presenting a shared password. It was removed during
security hardening — see `SECURITY_HARDENING.md`. If you find documentation elsewhere describing
self-service account creation, it is describing software that is gone; accounts are created
deliberately, as above.
