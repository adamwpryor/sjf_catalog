import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/utils/supabase/server'

/**
 * Handles the redirect target for Supabase auth email links (password
 * recovery, invites, email confirmation). Supabase sends the user here with
 * either a PKCE `code` or a `token_hash`/`type` pair; we exchange it for a
 * session (setting the auth cookies) and then forward the user on to `next`.
 *
 * This route MUST be public in `proxy.ts` — the user has no session cookie yet
 * when they arrive, so the proxy would otherwise bounce them to `/login`
 * before the exchange can happen.
 *
 * @param {NextRequest} request - The incoming request from the email link.
 * @returns {Promise<NextResponse>} A redirect to `next` on success, or to
 *   `/login` with an `error` query param on failure.
 */
/**
 * Turn a Supabase verification error into something a recipient can act on.
 *
 * Supabase reports a spent token and a genuinely expired one with the same
 * wording, and "expired" sends people to check the clock when the real cause is
 * usually that the link was already opened once.
 *
 * @param {string} raw - The message from `verifyOtp`.
 * @returns {string} A message naming both causes and the way out.
 */
function linkFailureMessage(raw: string): string {
  const spentOrExpired = /token not found|expired|invalid/i.test(raw)
  return spentOrExpired
    ? 'That sign-in link has already been used or has expired. Each link works '
      + 'once. Ask your catalog administrator for a new one.'
    : raw
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const errorDescription = searchParams.get('error_description')

  // Only allow relative redirects to avoid an open-redirect vector.
  const requestedNext = searchParams.get('next') || '/'
  const next = requestedNext.startsWith('/') ? requestedNext : '/'

  // Behind Vercel the request origin is the internal host; prefer the
  // forwarded host so the redirect lands on the user-facing domain.
  const forwardedHost = request.headers.get('x-forwarded-host')
  const isLocalEnv = process.env.NODE_ENV === 'development'
  const base = !isLocalEnv && forwardedHost ? `https://${forwardedHost}` : origin

  const loginWithError = (message: string) =>
    NextResponse.redirect(`${base}/login?error=${encodeURIComponent(message)}`)

  if (errorDescription) {
    return loginWithError(errorDescription)
  }

  const supabase = await createClient()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${base}${next}`)
    }
    return loginWithError(error.message)
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      // `type` comes straight from the Supabase email link; narrow it to the
      // email-OTP union rather than importing the SDK type.
      type: type as 'recovery' | 'invite' | 'signup' | 'magiclink' | 'email' | 'email_change',
      token_hash: tokenHash,
    })
    if (!error) {
      return NextResponse.redirect(`${base}${next}`)
    }
    // The token is single-use, and this route gets requested more than once in
    // ordinary conditions: a browser or mail-client prefetch, a corporate link
    // scanner, a refresh, an impatient second click. The first request spends the
    // token and sets the session cookies; every later one fails here. Reporting
    // that as an error tells a user whose sign-in has *already succeeded* that
    // their link is broken — which is exactly what happened to the first real
    // invitation this system sent, one second after it worked.
    //
    // So before failing, ask whether this browser is already signed in.
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      return NextResponse.redirect(`${base}${next}`)
    }
    return loginWithError(linkFailureMessage(error.message))
  }

  return loginWithError(
    'That sign-in link could not be read. Links work once and expire; ask your '
    + 'catalog administrator for a new one.',
  )
}
