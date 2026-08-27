'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { INSTITUTION } from '@/lib/brand';

/**
 * Landing page for invitation and password-reset links.
 *
 * Why this page exists, rather than verifying in the `/auth/callback` route:
 *
 * The verification token is single-use, and it is spent by whatever fetches the URL
 * first. That is very often not the recipient. Mail security scanners open every link
 * in a message before it is delivered; browsers and mail clients prefetch links to
 * warm them; preview cards fetch them to render a thumbnail. All of those issue a
 * GET. When the server verified on GET, the token was spent by the machine that
 * fetched it, the session cookie went to that machine, and the person clicking a
 * moment later was told their link was invalid — after their account had, in fact,
 * just been confirmed. That happened twice to real users of this system.
 *
 * So nothing is verified until a person presses the button. A GET renders this page
 * and spends nothing. The exchange runs in the browser, which also guarantees the
 * session lands in the right browser rather than in a scanner's.
 *
 * @returns {JSX.Element} The confirmation page.
 */
export default function ConfirmPage() {
  const router = useRouter();
  const [params, setParams] = useState<{ tokenHash: string; type: string; next: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tokenHash = q.get('token_hash');
    const type = q.get('type');
    const requestedNext = q.get('next') || '/';
    if (!tokenHash || !type) {
      setError('This link is missing information. Ask your catalog administrator for a new one.');
      return;
    }
    setParams({
      tokenHash,
      type,
      // Relative destinations only, so a crafted link cannot bounce someone off-site.
      next: requestedNext.startsWith('/') ? requestedNext : '/',
    });
  }, []);

  const handleConfirm = async () => {
    if (!params) return;
    setLoading(true);
    setError('');
    try {
      const supabase = createClient();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        type: params.type as 'recovery' | 'invite' | 'signup' | 'magiclink' | 'email' | 'email_change',
        token_hash: params.tokenHash,
      });
      if (verifyError) {
        setError(
          'That link has already been used or has expired. Each link works once — '
          + 'ask your catalog administrator for a new one.',
        );
        setLoading(false);
        return;
      }
      router.push(params.next);
      router.refresh();
    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred. Ask your catalog administrator for a new link.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center sjf-app-bg px-4 relative overflow-hidden font-sans">
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#993333]/10 rounded-full blur-[100px] glow-glow"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#FFCC33]/10 rounded-full blur-[100px] glow-glow"></div>

      <div className="w-full max-w-md z-10 animate-in fade-in duration-500 slide-in-from-bottom-6">
        <div className="text-center mb-8">
          <div className="inline-block px-4 py-2 bg-white/5 border border-[#FFCC33]/15 rounded-full text-xs font-semibold text-[#FFCC33] uppercase tracking-widest mb-3 backdrop-blur-md">
            {INSTITUTION.appTitle} Portal
          </div>
          <h1 className="text-3xl font-bold serif-title text-white">Welcome</h1>
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#FFCC33] mt-1 font-mono">
            {INSTITUTION.legalName}
          </div>
        </div>

        <div className="glass-panel rounded-2xl shadow-2xl p-8 border border-white/5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#993333] to-[#FFCC33]"></div>

          {error ? (
            <div className="space-y-4 text-center">
              <div className="bg-[#993333]/10 border border-[#993333]/35 rounded-lg px-4 py-3 text-sm text-red-300">
                {error}
              </div>
              <button
                onClick={() => router.push('/login')}
                className="text-xs font-bold text-[#FFCC33] hover:text-white transition-colors cursor-pointer uppercase tracking-wider"
              >
                Go to sign in
              </button>
            </div>
          ) : (
            <div className="space-y-6 text-center">
              <p className="text-sm text-slate-300 leading-relaxed">
                Press continue to confirm your account and choose a password.
              </p>
              <button
                onClick={handleConfirm}
                disabled={loading || !params}
                className="w-full bg-[#993333] hover:bg-[#7a2929] active:scale-[0.98] text-white rounded-lg py-3 font-semibold text-sm transition-all shadow-lg hover:shadow-[#993333]/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Confirming…' : 'Continue'}
              </button>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                This link works once. Nothing is used up until you press continue.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
