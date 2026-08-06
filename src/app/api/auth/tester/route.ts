import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'crypto'
import { INSTITUTION } from '@/lib/brand'

/**
 * Self-service tester provisioning for institutional pilot access.
 *
 * Anyone with an `@sjf.edu` email who presents the shared tester access
 * password (env `TESTER_ACCESS_PASSWORD`, server-only) gets a real Supabase
 * account created on the fly with that password; the client then signs in
 * through the normal `signInWithPassword` flow so cookies/sessions behave
 * exactly like every other user.
 *
 * This route MUST be public — callers have no session yet.
 *
 * Deliberate safety properties:
 * - Disabled entirely unless `TESTER_ACCESS_PASSWORD` is set.
 * - Never touches an existing account (no password overwrite → no takeover of
 *   real staff accounts via the shared password).
 * - Shared-password check is timing-safe and returns the same generic 401 for
 *   wrong password vs. wrong domain, to avoid oracle behavior.
 */

/** Uniform rejection so the endpoint leaks nothing about which check failed. */
function rejected(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'Invalid email or access password.' },
    { status: 401 },
  )
}

/**
 * Compares two strings in constant time.
 *
 * @param a - The candidate value supplied by the caller.
 * @param b - The expected secret value.
 * @returns True when the values match exactly.
 */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Provisions a tester account for a valid institutional email + shared
 * access password.
 *
 * @param request - JSON body `{ email: string, password: string }`.
 * @returns 200 `{ ok: true, created }` when the caller may proceed to sign in
 *   (`created: false` means the account already existed and was left
 *   untouched); 401 on any validation failure; 503 when the feature is off.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const accessPassword = process.env.TESTER_ACCESS_PASSWORD
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  if (!accessPassword || !serviceRoleKey || !supabaseUrl) {
    return NextResponse.json(
      { ok: false, error: 'Tester access is not enabled.' },
      { status: 503 },
    )
  }

  let email = ''
  let password = ''
  try {
    const body = await request.json()
    email = String(body?.email ?? '').trim().toLowerCase()
    password = String(body?.password ?? '')
  } catch {
    return rejected()
  }

  // Local-part sanity + exact institutional domain match.
  const domain = `@${INSTITUTION.emailDomain}`
  if (!email.endsWith(domain)) return rejected()
  const localPart = email.slice(0, -domain.length)
  if (!/^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?$/.test(localPart)) return rejected()

  if (!safeEquals(password, accessPassword)) return rejected()

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { error } = await admin.auth.admin.createUser({
    email,
    password: accessPassword,
    email_confirm: true,
    user_metadata: { tester: true, provisioned_via: 'tester-access-password' },
  })

  if (error) {
    // Existing account (invited staff, prior tester, etc.): leave it alone.
    // The client retries normal sign-in, which succeeds for prior testers and
    // fails with a clear message for accounts holding their own password.
    if (error.code === 'email_exists' || error.status === 422) {
      return NextResponse.json({ ok: true, created: false })
    }
    console.error(
      JSON.stringify({
        level: 'error',
        route: 'api/auth/tester',
        message: 'tester provisioning failed',
        code: error.code ?? null,
      }),
    )
    return NextResponse.json(
      { ok: false, error: 'Could not provision tester access. Try again shortly.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, created: true })
}
