#!/usr/bin/env node
/**
 * invite_user.mjs — invite catalog users and assign their access role.
 *
 * Accounts are created by invitation, deliberately. This replaces an earlier
 * self-provisioning route that minted real accounts for anyone presenting one shared
 * password, and set every account's password to that same shared value.
 *
 * What an invitation does:
 *   1. Supabase emails the address a one-time link.
 *   2. The link lands on /auth/callback, which already handles `type=invite`, establishes
 *      a session, and forwards to /update-password so the user sets their own password.
 *   3. This script writes the `user_roles` row. Without it the user signs in successfully
 *      and sees an empty application, because row-level security has nothing to match.
 *
 * Step 3 is the one that is easy to forget and hard to diagnose, so it is not optional here:
 * the role is assigned in the same run as the invitation.
 *
 * DRY RUN BY DEFAULT. Nothing is sent and nothing is written without --send, matching
 * verification_harness/remediate.py and scripts/ingest_self_serve.py.
 *
 * Usage:
 *   node scripts/invite_user.mjs --email a@sjf.edu --role registrar
 *   node scripts/invite_user.mjs --file invites.txt --send
 *   node scripts/invite_user.mjs --list
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL. The service-role key
 * bypasses row-level security entirely — run this from an operator machine, never from the
 * application.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Institutional mail domains. Staff exist on both; see src/lib/brand.ts. */
const ALLOWED_DOMAINS = ['sjf.edu', 'sjfc.edu'];

/** Roles accepted by the user_roles CHECK constraint. */
const ROLES = ['viewer', 'admin', 'registrar', 'owner'];

/**
 * Read a variable from the environment, falling back to .env.local.
 *
 * @param {string} name - Variable name.
 * @returns {string} The value.
 * @throws {Error} If it is set in neither place.
 */
function requireEnv(name) {
  if (process.env[name]) return process.env[name];
  const local = path.join(ROOT, '.env.local');
  if (fs.existsSync(local)) {
    for (const line of fs.readFileSync(local, 'utf-8').split('\n')) {
      if (line.startsWith(`${name}=`)) {
        const raw = line.slice(name.length + 1).split(/\s+#/)[0].trim();
        const value = raw.replace(/^["']|["']$/g, '');
        if (value) return value;
      }
    }
  }
  throw new Error(
    `${name} is not set. Export it or add it to .env.local; it is never stored in source.`,
  );
}

/**
 * Validate an address against the institutional domains.
 *
 * @param {string} email - Address to check.
 * @returns {string|null} An error message, or null when acceptable.
 */
function validate(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'not a valid email address';
  const domain = email.split('@')[1].toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    return `domain "${domain}" is not institutional (expected ${ALLOWED_DOMAINS.join(' or ')})`;
  }
  return null;
}

function parseArgs(argv) {
  const args = { email: null, role: 'viewer', file: null, send: false, list: false, redirect: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--send') args.send = true;
    else if (a === '--list') args.list = true;
    else if (a === '--email') args.email = argv[++i];
    else if (a === '--role') args.role = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--redirect') args.redirect = argv[++i];
  }
  return args;
}

/**
 * Parse an invite file. One `email,role` pair per line; blank lines and `#` comments ignored.
 *
 * @param {string} file - Path to the file.
 * @returns {Array<{email: string, role: string}>} Parsed entries.
 */
function parseFile(file) {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const [email, role = 'viewer'] = line.split(',').map((s) => s.trim());
      return { email: email.toLowerCase(), role };
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const admin = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (args.list) {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw error;
    const { data: roles } = await admin.from('user_roles').select('user_id, role');
    const roleFor = new Map((roles ?? []).map((r) => [r.user_id, r.role]));
    console.log(`\n${data.users.length} account(s):\n`);
    for (const u of data.users) {
      const confirmed = u.email_confirmed_at ? 'confirmed' : 'PENDING INVITE';
      const seen = u.last_sign_in_at ? u.last_sign_in_at.slice(0, 10) : 'never signed in';
      console.log(`  ${u.email.padEnd(34)} ${(roleFor.get(u.id) ?? 'NO ROLE').padEnd(10)} ${confirmed.padEnd(15)} ${seen}`);
    }
    console.log('\nNO ROLE means the user can sign in and will see nothing.\n');
    return;
  }

  const targets = args.file
    ? parseFile(args.file)
    : args.email
      ? [{ email: args.email.toLowerCase(), role: args.role }]
      : [];

  if (targets.length === 0) {
    console.error('Nothing to do. Pass --email <address> [--role <role>], or --file <path>, or --list.');
    process.exit(2);
  }

  // Validate everything before sending anything: a bad row in the middle of a batch
  // should not leave half the invitations sent.
  const problems = [];
  for (const t of targets) {
    const bad = validate(t.email);
    if (bad) problems.push(`${t.email}: ${bad}`);
    if (!ROLES.includes(t.role)) problems.push(`${t.email}: role "${t.role}" is not one of ${ROLES.join(', ')}`);
  }
  if (problems.length) {
    console.error('\nRefusing to send — fix these first:\n');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  // Supabase requires an absolute URL and only honours one on its redirect allowlist.
  // With no site URL configured, fall back to the project default rather than sending a
  // relative path, which Supabase rejects.
  const siteUrl = args.redirect ?? process.env.NEXT_PUBLIC_SITE_URL ?? null;
  const redirectTo = siteUrl ? `${siteUrl.replace(/\/$/, '')}/auth/callback?next=/update-password` : null;

  console.log(`\n${args.send ? 'SENDING INVITATIONS' : 'DRY RUN — nothing will be sent or written'}`);
  console.log(`Supabase project : ${url}`);
  console.log(`Invite redirect  : ${redirectTo || '(Supabase project default)'}\n`);

  for (const { email, role } of targets) {
    if (!args.send) {
      console.log(`  would invite  ${email.padEnd(34)} role=${role}`);
      continue;
    }

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo ?? undefined,
    });

    let userId = data?.user?.id;
    if (error) {
      // Already registered: keep going so the role assignment below still runs.
      const { data: existing } = await admin.auth.admin.listUsers({ perPage: 200 });
      userId = existing?.users?.find((u) => u.email?.toLowerCase() === email)?.id;
      if (!userId) {
        console.error(`  FAILED   ${email.padEnd(34)} ${error.message}`);
        continue;
      }
      console.log(`  exists    ${email.padEnd(34)} (not re-invited)`);
    } else {
      console.log(`  invited   ${email.padEnd(34)}`);
    }

    // The role is the half that RLS actually reads. One row per user, so upsert.
    const { error: roleError } = await admin
      .from('user_roles')
      .upsert({ user_id: userId, role }, { onConflict: 'user_id' });
    console.log(
      roleError
        ? `    role FAILED  ${roleError.message}`
        : `    role=${role} assigned`,
    );
  }

  if (!args.send) {
    console.log('\nRe-run with --send to send these invitations and assign roles.');
  } else {
    console.log('\nDone. Recipients set their own password via the emailed link.');
    console.log('Verify with: node scripts/invite_user.mjs --list');
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
