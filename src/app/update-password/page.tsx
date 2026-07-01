'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/utils/supabase/client';

/**
 * Renders the update password page.
 *
 * @returns {JSX.Element} The update password page component.
 */
export default function UpdatePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const supabase = createClient();

    try {
      const { error } = await supabase.auth.updateUser({
        password: password
      });

      if (error) {
        setError(error.message);
      } else {
        setSuccess(true);
        setTimeout(() => {
          router.push('/');
          router.refresh();
        }, 2000);
      }
    } catch (err) {
      console.error(err);
      setError('An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050811] px-4 relative overflow-hidden font-sans">
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#8C2232]/10 rounded-full blur-[100px] glow-glow"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#B6CFD6]/10 rounded-full blur-[100px] glow-glow"></div>

      <div className="w-full max-w-md z-10 animate-in fade-in duration-500 slide-in-from-bottom-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold serif-title text-white flex items-center justify-center gap-2">
            Set Your Password
          </h1>
          <p className="text-sm text-slate-400 mt-3 font-medium">
            Welcome to the CCSJ Ingestion Portal.
          </p>
        </div>

        <div className="glass-panel rounded-2xl shadow-2xl p-8 border border-white/5 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#8C2232] to-[#B6CFD6]"></div>

          {success ? (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-4 border border-emerald-500/50">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
              </div>
              <h3 className="text-white font-bold text-lg">Password Updated!</h3>
              <p className="text-sm text-slate-400">Redirecting to dashboard...</p>
            </div>
          ) : (
            <form onSubmit={handleUpdatePassword} className="space-y-6">
              {error && (
                <div className="bg-[#8C2232]/10 border border-[#8C2232]/35 rounded-lg px-4 py-3 text-sm text-red-300 flex items-center gap-2 animate-pulse">
                  <span>{error}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-[#B6CFD6] uppercase tracking-wider mb-2">
                  New Password
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-[#0a0f1d] border border-white/10 rounded-lg px-4 py-3 text-sm text-white focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232] outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#B6CFD6] uppercase tracking-wider mb-2">
                  Confirm Password
                </label>
                <input
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-[#0a0f1d] border border-white/10 rounded-lg px-4 py-3 text-sm text-white focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232] outline-none transition-all"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#8C2232] hover:bg-[#65121e] active:scale-[0.98] text-white rounded-lg py-3 font-semibold text-sm transition-all shadow-lg hover:shadow-[#8C2232]/20 flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? 'Updating...' : 'Set Password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
