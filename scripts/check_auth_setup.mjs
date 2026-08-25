#!/usr/bin/env node
/**
 * check_auth_setup.mjs — verify that sign-in links will actually reach the application.
 *
 * Two pieces of Supabase dashboard configuration decide whether an invitation or a
 * password reset works, and neither lives in this repository, so no other test here
 * can see them:
 *
 *   1. Authentication > URL Configuration — the Site URL and the redirect allowlist.
 *      When the deployed origin is missing, Supabase does not reject the request. It
 *      silently rewrites the link to point at the Site URL instead, and the recipient
 *      lands somewhere that cannot complete their sign-in.
 *   2. Authentication > Emails > SMTP Settings — without custom SMTP, Supabase refuses
 *      to deliver to anyone who is not a member of the project team, and refuses after
 *      reporting success.
 *
 * This asks Supabase for a real link and inspects where it points, which is the only
 * way to observe (1) from outside the dashboard. Nothing is emailed and nothing is
 * printed that could sign anyone in.
 *
 * Read-only: it creates no users and changes no configuration.
 *
 *   npm run user:check
 *
 * Exits non-zero if the redirect is wrong, so CI or a migration checklist can gate on it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a variable from the environment, falling back to .env.local.
 *
 * @param {string} name - Variable name.
 * @returns {string|null} The value, or null when set in neither place.
 */
function readEnv(name) {
  if (process.env[name]) return process.env[name];
  const local = path.join(ROOT, '.env.local');
  if (fs.existsSync(local)) {
    for (const line of fs.readFileSync(local, 'utf-8').split('\n')) {
      if (line.startsWith(`${name}=`)) {
        const value = line.slice(name.length + 1).split(/\s+#/)[0].trim().replace(/^["']|["']$/g, '');
        if (value) return value;
      }
    }
  }
  return null;
}

const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => console.log(`  FAIL  ${m}`);
const warn = (m) => console.log(`  WARN  ${m}`);

async function main() {
  console.log('\nChecking Supabase auth configuration\n');
  let failed = false;

  const url = readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const siteUrl = readEnv('NEXT_PUBLIC_SITE_URL');

  for (const [name, value] of [
    ['NEXT_PUBLIC_SUPABASE_URL', url],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceKey],
  ]) {
    if (value) pass(`${name} is set`);
    else {
      fail(`${name} is not set — add it to .env.local`);
      failed = true;
    }
  }
  if (!url || !serviceKey) process.exit(1);

  if (siteUrl) {
    pass(`NEXT_PUBLIC_SITE_URL is set to ${siteUrl}`);
  } else {
    fail('NEXT_PUBLIC_SITE_URL is not set — invitation links cannot be built');
    console.log('        Set it to the deployed application address, e.g. https://catalog.example.edu');
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Use an account that already exists: generating a recovery link neither creates a
  // user nor changes an existing one, and nothing is delivered.
  const { data: users, error: listError } = await admin.auth.admin.listUsers({ perPage: 1 });
  if (listError) {
    fail(`cannot reach Supabase: ${listError.message}`);
    process.exit(1);
  }
  pass('service-role credentials accepted');

  const probe = users?.users?.[0]?.email;
  if (!probe) {
    warn('no accounts exist yet, so the redirect cannot be tested from here');
    console.log('        Re-run this after adding the first user.');
    process.exit(failed ? 1 : 0);
  }

  const expected = `${siteUrl.replace(/\/$/, '')}/auth/callback?next=/update-password`;
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: probe,
    options: { redirectTo: expected },
  });
  if (error) {
    fail(`could not generate a test link: ${error.message}`);
    process.exit(1);
  }

  const got = new URL(data.properties.action_link).searchParams.get('redirect_to') ?? '';
  const want = new URL(expected);
  const trim = (p) => p.replace(/\/$/, '');
  let landing = null;
  try {
    landing = new URL(got);
  } catch {
    landing = null;
  }

  // Check the origin and the path separately. Supabase can honour the origin while
  // dropping the path, which sends the recipient to the home page with no session —
  // an origin-only check calls that a pass and it is not one.
  if (!landing) {
    fail('sign-in links carry no destination at all');
    failed = true;
  } else if (landing.origin !== want.origin) {
    fail(`sign-in links return to ${landing.origin}, not ${want.origin}`);
    console.log('        Supabase substitutes its Site URL when the origin is not allowlisted.');
    console.log('        Dashboard > Authentication > URL Configuration:');
    console.log(`          Site URL      ${want.origin}`);
    console.log(`          Redirect URLs ${want.origin}/**`);
    failed = true;
  } else if (trim(landing.pathname) !== trim(want.pathname)) {
    fail(`sign-in links reach ${landing.origin} but land on ${landing.pathname}, not ${want.pathname}`);
    console.log('        The origin is accepted and the path is being dropped, so recipients arrive');
    console.log('        signed out. Add a wildcard entry to the redirect allowlist:');
    console.log(`          ${want.origin}/**`);
    failed = true;
  } else {
    pass(`sign-in links return to ${landing.origin}${landing.pathname}`);
  }

  // Email delivery cannot be observed directly; report what can be checked.
  const { data: roles } = await admin.from('user_roles').select('user_id');
  const roleCount = roles?.length ?? 0;
  const { data: all } = await admin.auth.admin.listUsers({ perPage: 200 });
  const userCount = all?.users?.length ?? 0;
  if (roleCount < userCount) {
    warn(`${userCount - roleCount} account(s) have no role and will see an empty application`);
    console.log('        List them with: npm run user:list');
  } else {
    pass(`every account (${userCount}) has a role`);
  }

  console.log(
    failed
      ? '\nFAILED — fix the above before inviting anyone; links will not work.\n'
      : '\nAll checks passed.\n',
  );
  console.log('Not checked here: whether Supabase can actually deliver email. Without custom');
  console.log('SMTP it refuses every address outside the project team, silently. See');
  console.log('OPERATIONS.md section 6.5. `npm run user:link` sidesteps email entirely.\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
