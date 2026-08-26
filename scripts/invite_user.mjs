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
 *   node scripts/invite_user.mjs --email me@example.com --allow-external --send   # smoke test
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
 * Read an optional variable, from the environment or .env.local.
 *
 * @param {string} name - Variable name.
 * @returns {string|null} The value, or null when unset.
 */
function optionalEnv(name) {
  try {
    return requireEnv(name);
  } catch {
    return null;
  }
}

/**
 * Validate an address against the institutional domains.
 *
 * The domain check is a typo guard: an invitation is single-use, so a mistyped
 * address is a wasted invitation and a support request. `allowExternal` lifts it
 * for the deliberate exceptions - smoke-testing the flow, or an outside
 * contractor - and is never the default.
 *
 * @param {string} email - Address to check.
 * @param {boolean} [allowExternal=false] - Permit a non-institutional domain.
 * @returns {string|null} An error message, or null when acceptable.
 */
function validate(email, allowExternal = false) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'not a valid email address';
  const domain = email.split('@')[1].toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain) && !allowExternal) {
    return `domain "${domain}" is not institutional (expected ${ALLOWED_DOMAINS.join(' or ')}). `
      + 'Pass --allow-external if this is deliberate.';
  }
  return null;
}

function parseArgs(argv) {
  const args = {
    email: null, role: 'viewer', file: null,
    send: false, list: false, redirect: null, allowExternal: false, link: false, help: false,
    out: null, remove: false, confirm: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--send') args.send = true;
    else if (a === '--allow-external') args.allowExternal = true;
    else if (a === '--link') args.link = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--remove') args.remove = true;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--help' || a === '-h') args.help = true;
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

const HELP = `
Add a user to the catalog, and give them a role.

  npm run user:list                          who has an account, and what role
  npm run user:invite -- --email a@sjf.edu --role viewer --send
  npm run user:link   -- --email a@sjf.edu --role viewer

Two ways to add someone:

  --send    Supabase emails them an invitation. Needs custom SMTP configured
            (Authentication > Emails > SMTP Settings). Without it Supabase
            accepts the request, reports success, and delivers nothing to
            anyone outside the project team.

  --link    Mints the sign-in link and writes it to
            artifacts/scratch/invite_links.txt for you to deliver yourself.
            No email is involved. Use this when SMTP is not set up, or when a
            message is not arriving. Each link signs its holder in as that
            user: send one per recipient, then delete the file.

Both create the account AND write the role row. A user without a role can sign
in and will see an empty application.

Options:
  --email <address>     one person
  --file <path>         many, one "email,role" per line ("#" comments allowed)
  --role <role>         viewer | admin | registrar | owner   (default: viewer)
                        registrar and owner can edit the catalog; the others cannot
  --send                send invitation emails (omit for a dry run)
  --link                mint links to a file instead of emailing
  --list                show existing accounts and roles
  --remove --email <a>  delete an account and its role (add --confirm to apply)
  --redirect <url>      override where the link returns to
  --out <path>          write links somewhere other than the default file
  --allow-external      permit a non-institutional address (deliberate exceptions only)
  --help                this text

Environment: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
NEXT_PUBLIC_SITE_URL, read from the environment or .env.local. The site URL must
also be on the Supabase redirect allowlist, or links silently return to whatever
the project's Site URL is set to.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length === 2) {
    console.log(HELP);
    return;
  }
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

  if (args.remove) {
    if (!args.email) {
      console.error('--remove needs --email <address>.');
      process.exit(2);
    }
    const email = args.email.toLowerCase();
    const { data: all, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (listErr) throw listErr;
    const found = all?.users?.find((u) => u.email?.toLowerCase() === email);

    if (!found) {
      console.log(`\n  ${email} has no account; nothing to remove.\n`);
      return;
    }
    if (!args.confirm) {
      console.log(`\n  DRY RUN — would delete ${email} (created ${found.created_at?.slice(0, 10)}).`);
      console.log('  Their role row goes with it. Re-run with --confirm to delete.\n');
      return;
    }

    // Deleting the auth user cascades to user_roles via ON DELETE CASCADE.
    const { error: delErr } = await admin.auth.admin.deleteUser(found.id);
    if (delErr) {
      console.error(`  FAILED to delete ${email}: ${delErr.message}`);
      process.exit(1);
    }
    console.log(`\n  deleted  ${email}`);
    const { data: orphan } = await admin.from('user_roles').select('user_id').eq('user_id', found.id);
    console.log(`  role row removed: ${(orphan?.length ?? 0) === 0}\n`);
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
    const bad = validate(t.email, args.allowExternal);
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
  const siteUrl = args.redirect ?? optionalEnv('NEXT_PUBLIC_SITE_URL');
  const redirectTo = siteUrl ? `${siteUrl.replace(/\/$/, '')}/auth/callback?next=/update-password` : null;

  const header = args.link
    ? 'GENERATING LINKS — no email is sent; you deliver them'
    : args.send
      ? 'SENDING INVITATIONS'
      : 'DRY RUN — nothing will be sent or written';
  console.log(`\n${header}`);
  console.log(`Supabase project : ${url}`);
  console.log(`Invite redirect  : ${redirectTo || '(Supabase project default)'}\n`);

  const external = targets.filter((t) => !ALLOWED_DOMAINS.includes(t.email.split('@')[1]));
  if (external.length) {
    console.log(`  NOTE: ${external.length} non-institutional address(es) permitted by --allow-external:`);
    for (const t of external) console.log(`        ${t.email}`);
    console.log('        Remove these accounts when they are no longer needed.');
    console.log('');
  }

  if (args.link) {
    // Supabase's built-in mailer refuses any address that is not on the project team,
    // and does so *after* returning 200 — the invitation looks sent and never arrives.
    // Minting the link here skips the mailer entirely: delivery becomes the operator's
    // problem, which is the only thing that works before custom SMTP is configured.
    const outFile = args.out
      ? path.resolve(ROOT, args.out)
      : path.join(ROOT, 'artifacts', 'scratch', 'invite_links.txt');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    // Refuse to overwrite. The previous batch may not have been delivered yet, and
    // these are one-time credentials: silently replacing them loses links that were
    // already generated and, if the earlier ones were sent, invalidates them.
    if (fs.existsSync(outFile)) {
      console.error(`\n  ${path.relative(ROOT, outFile).replace(/\\/g, '/')} already exists.`);
      console.error('  It may hold links that have not been delivered yet, so this will not');
      console.error('  overwrite it. Deliver and delete that file, or pass --out <path>.\n');
      process.exit(1);
    }
    const generatedAt = new Date();
    const lines = [
      'One-time sign-in links.',
      '',
      `Generated ${generatedAt.toISOString()}.`,
      '',
      'THESE EXPIRE — after this project\'s email OTP window (Supabase dashboard >',
      'Authentication > Providers > Email; the Supabase default is one hour). A link',
      'delivered after that is refused as "invalid or has expired" even though nobody',
      'used it. Send these now, or regenerate when you are ready to send.',
      '',
      'Each link also works ONCE, and anything that opens it counts — a mail scanner',
      'or a browser prefetch can spend it before the recipient ever clicks.',
      '',
      'Each line below is a CREDENTIAL: whoever opens it becomes that user. Send each',
      'to its own recipient over a channel you trust, then delete this file.',
      '',
    ];

    for (const { email, role } of targets) {
      let kind = 'invite';
      let res = await admin.auth.admin.generateLink({
        type: 'invite',
        email,
        options: redirectTo ? { redirectTo } : undefined,
      });
      if (res.error) {
        // Already present — commonly a previous invitation that was never delivered.
        // A recovery link reaches the same /update-password destination.
        kind = 'recovery';
        res = await admin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: redirectTo ? { redirectTo } : undefined,
        });
      }
      if (res.error) {
        console.error(`  FAILED    ${email.padEnd(34)} ${res.error.message}`);
        continue;
      }

      const { error: roleError } = await admin
        .from('user_roles')
        .upsert({ user_id: res.data?.user?.id, role }, { onConflict: 'user_id' });

      // Do NOT hand out properties.action_link. That points at Supabase's own /verify
      // endpoint, which completes the exchange and then redirects to the application
      // with the session in the URL *fragment*. Fragments are never sent to a server,
      // so /auth/callback — a server route — receives an empty query string and
      // correctly reports the link as invalid. It never worked, rather than expiring.
      //
      // properties.hashed_token is the same verification in the form that route already
      // handles: it reads token_hash + type and calls verifyOtp. Build that URL here.
      const props = res.data.properties;
      const verificationType = props.verification_type ?? kind;
      let link;

      if (siteUrl) {
        const target = new URL('/auth/callback', siteUrl);
        target.searchParams.set('token_hash', props.hashed_token);
        target.searchParams.set('type', verificationType);
        target.searchParams.set('next', '/update-password');
        link = target.toString();
      } else {
        // Without a site URL there is nothing to point at; the Supabase link is wrong
        // for this application but is better than emitting nothing.
        link = props.action_link;
        console.error('  WARNING: NEXT_PUBLIC_SITE_URL is not set, so this link goes to Supabase');
        console.error('           rather than the application, and will not sign anyone in.');
      }

      lines.push(`${email}   role=${role}   (${verificationType} link)`, link, '');
      console.log(
        `  link      ${email.padEnd(34)} role=${role} ${kind}`
        + `${roleError ? `  ROLE FAILED: ${roleError.message}` : ''}`,
      );
    }

    fs.writeFileSync(outFile, lines.join('\n'), { mode: 0o600 });
    console.log(`\nWritten to ${path.relative(ROOT, outFile).replace(/\\/g, '/')} (gitignored).`);
    console.log('Deliver each link to its recipient NOW, then delete the file.');
    console.log('They expire after this project\'s email OTP window (Supabase dashboard >');
    console.log('Authentication > Providers > Email), and each works only once.');
    return;
  }

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
