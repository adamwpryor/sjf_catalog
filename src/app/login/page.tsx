'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';
import { INSTITUTION } from '@/lib/brand';

/**
 * Renders the login page for the application.
 *
 * @returns {JSX.Element} The login page component.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resetSent, setResetSent] = useState(false);

  // Surface any error handed back by the /auth/callback route (e.g. an expired
  // recovery link), which redirects here with an `?error=` query param.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackError = params.get('error');
    if (callbackError) {
      setError(callbackError);
      // Strip the param so a refresh doesn't keep re-showing the error.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const supabase = createClient();
      const signIn = () => supabase.auth.signInWithPassword({ email, password });

      let { error } = await signIn();

      // Institutional testers: an @sjf.edu email plus the shared access
      // password provisions an account on first sign-in, then retries the
      // normal flow. Wrong shared password falls through to the original error.
      if (error && email.trim().toLowerCase().endsWith(`@${INSTITUTION.emailDomain}`)) {
        const res = await fetch('/api/auth/tester', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        if (res.ok) {
          ({ error } = await signIn());
          if (error) {
            setError(
              'This email already has an account with its own password. Sign in with that password, or use "Forgot password?" to reset it.'
            );
            return;
          }
        }
      }

      if (error) {
        setError(error.message);
      } else {
        router.push('/');
        router.refresh();
      }
    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const supabase = createClient();
      // Recovery link returns to the callback route, which establishes the
      // session and forwards the user to the "Set Your Password" page.
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/update-password`,
      });

      if (error) {
        setError(error.message);
      } else {
        setResetSent(true);
      }
    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center sjf-app-bg px-4 relative overflow-hidden font-sans">
      {/* Dynamic Background Glows */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#993333]/10 rounded-full blur-[100px] glow-glow"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#FFCC33]/10 rounded-full blur-[100px] glow-glow"></div>

      <div className="w-full max-w-md z-10 animate-in fade-in duration-500 slide-in-from-bottom-6">
        {/* Logo and Headings */}
        <div className="text-center mb-8">
          <div className="inline-block px-4 py-2 bg-white/5 border border-[#FFCC33]/15 rounded-full text-xs font-semibold text-[#FFCC33] uppercase tracking-widest mb-3 backdrop-blur-md">
            {INSTITUTION.appTitle} Portal
          </div>
          <h1 className="text-3xl font-bold serif-title text-white flex items-center justify-center gap-2">
            {INSTITUTION.shortName}
          </h1>
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#FFCC33] mt-0.5 font-mono">
            {INSTITUTION.legalName}
          </div>
          <p className="text-sm text-slate-400 mt-3 font-medium">
            Academic Catalog Audit & Delta Corrections Log
          </p>
        </div>

        {/* Login Form Panel */}
        <div className="glass-panel rounded-2xl shadow-2xl p-6 md:p-8 border border-white/5 relative overflow-hidden">
          {/* Subtle top brand crimson highlight line */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#993333] to-[#FFCC33]"></div>

          {resetSent ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-500/50">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
              </div>
              <h3 className="text-white font-bold text-lg">Check your email</h3>
              <p className="text-sm text-slate-400">
                If an account exists for <span className="text-slate-200 font-semibold">{email}</span>, a secure password link is on its way. Open it to set your password and sign in.
              </p>
              <button
                onClick={() => { setResetSent(false); setMode('login'); setPassword(''); }}
                className="text-xs font-bold text-[#FFCC33] hover:text-white transition-colors cursor-pointer uppercase tracking-wider"
              >
                ← Back to sign in
              </button>
            </div>
          ) : (
          <>
          <form onSubmit={mode === 'reset' ? handleReset : handleLogin} className="space-y-6">
            {error && (
              <div className="bg-[#993333]/10 border border-[#993333]/35 rounded-lg px-4 py-3 text-sm text-red-300 flex items-center gap-2 animate-pulse">
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-[#FFCC33] uppercase tracking-wider mb-2">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={`you@${INSTITUTION.emailDomain}`}
                className="w-full bg-[#3d1010] border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-[#993333] focus:ring-1 focus:ring-[#993333] outline-none transition-all"
              />
            </div>

            {mode === 'login' && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-bold text-[#FFCC33] uppercase tracking-wider">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => { setMode('reset'); setError(''); }}
                    className="text-[11px] font-semibold text-slate-400 hover:text-[#FFCC33] transition-colors cursor-pointer"
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full bg-[#3d1010] border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder-slate-500 focus:border-[#993333] focus:ring-1 focus:ring-[#993333] outline-none transition-all"
                />
              </div>
            )}

            {mode === 'reset' && (
              <p className="text-xs text-slate-400 leading-relaxed">
                Enter your email and we&apos;ll send you a secure link to set a new password.
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#993333] hover:bg-[#7a2929] active:scale-[0.98] text-white rounded-lg py-3 font-semibold text-sm transition-all shadow-lg hover:shadow-[#993333]/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>{mode === 'reset' ? 'Sending link…' : 'Authenticating...'}</span>
                </>
              ) : (
                <span>{mode === 'reset' ? 'Send reset link' : 'Access Audit Dashboard'}</span>
              )}
            </button>
          </form>

          {/* Contextual footer help */}
          <div className="mt-6 pt-6 border-t border-white/5 text-xs text-slate-400 space-y-2 leading-relaxed">
            {mode === 'login' ? (
              <>
                <div>
                  💡 <strong className="text-slate-300">First time here?</strong>
                </div>
                <div>
                  If an administrator invited you, use{' '}
                  <button type="button" onClick={() => { setMode('reset'); setError(''); }} className="text-[#FFCC33] hover:text-white underline underline-offset-2 cursor-pointer">Forgot password?</button>{' '}
                  to set your password for the first time, then sign in.
                </div>
                <div>
                  Testing the pilot? Sign in with your{' '}
                  <span className="text-slate-300 font-semibold">@{INSTITUTION.emailDomain}</span>{' '}
                  email and the shared access password from the project team — your account is created automatically.
                </div>
              </>
            ) : (
              <div>
                Remembered it?{' '}
                <button type="button" onClick={() => { setMode('login'); setError(''); }} className="text-[#FFCC33] hover:text-white underline underline-offset-2 cursor-pointer">Back to sign in</button>
              </div>
            )}
            <div className="text-slate-500 text-[10px] text-center pt-2 select-none">
              {INSTITUTION.legalName.toLowerCase()}
            </div>
          </div>
          </>
          )}
        </div>

        {/* Tagline footer */}
        <div className="text-center mt-8 text-xs text-slate-500 uppercase tracking-widest font-semibold font-serif-title flex items-center justify-center gap-4">
          <span>Browse</span>
          <span className="w-1.5 h-1.5 bg-[#993333] rounded-full"></span>
          <span>Analyze</span>
          <span className="w-1.5 h-1.5 bg-[#FFCC33] rounded-full"></span>
          <span>Improve</span>
        </div>
      </div>
    </div>
  );
}
