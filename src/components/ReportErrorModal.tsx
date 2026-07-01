'use client';

import React, { useState, useEffect } from 'react';

interface ReportErrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  // DB table names — must match the corrections.target_table CHECK constraint
  // ('courses' | 'programs' | 'semantic_chunks'). The Policy Library view maps to
  // 'semantic_chunks' (policies are stored as narrative chunks).
  targetTable: 'courses' | 'programs' | 'semantic_chunks';
  targetRowId: string;
  fieldName: string;
  currentValue: any;
  onSuccess: () => void;
}

/**
 * Renders the Report Error Modal component.
 *
 * @param {ReportErrorModalProps} props - The component props.
 * @param {boolean} props.isOpen - Whether the modal is open.
 * @param {Function} props.onClose - Callback to close the modal.
 * @param {'courses' | 'programs' | 'policies'} props.targetTable - The target table.
 * @param {string} props.targetRowId - The ID of the target row.
 * @param {string} props.fieldName - The name of the field.
 * @param {any} props.currentValue - The current value of the field.
 * @param {Function} props.onSuccess - Callback upon successful submission.
 * @returns {JSX.Element | null} The rendered Report Error Modal component or null.
 */
export default function ReportErrorModal({
  isOpen,
  onClose,
  targetTable,
  targetRowId,
  fieldName,
  currentValue,
  onSuccess
}: ReportErrorModalProps) {
  const [proposedValue, setProposedValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setProposedValue(currentValue || '');
      setReason('');
      setError('');
    }
  }, [isOpen, currentValue]);

  if (!isOpen) return null;

  /**
   * Handles the submission of the correction log.
   *
   * @param {React.FormEvent} e - The form event.
   * @returns {Promise<void>}
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (proposedValue.trim() === '') {
      setError('Please provide a proposed value override.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target_table: targetTable,
          target_row_id: targetRowId,
          field_name: fieldName,
          current_value: String(currentValue),
          proposed_value: proposedValue,
          reason
        })
      });

      if (res.ok) {
        alert("Delta Correction successfully logged to database.");
        onSuccess();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to submit correction.');
      }
    } catch (err) {
      console.error(err);
      setError('A connection error occurred. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200 font-sans">
      <div className="bg-[#0b0f1d] rounded-2xl border border-[#B6CFD6]/15 shadow-2xl max-w-lg w-full overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
        
        {/* Modal Top Bar Crimson highlight line */}
        <div className="h-1.5 bg-[#8C2232]"></div>

        {/* Modal Header */}
        <div className="px-6 py-4 bg-[#090d16] border-b border-white/5 flex justify-between items-center text-white">
          <div>
            <h3 className="font-bold serif-title text-base">Flag Catalog Extraction Error</h3>
            <p className="text-[10px] text-slate-400 font-medium mt-0.5">Surgical delta-override log creation</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors cursor-pointer">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>

        {/* Modal Form Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6 text-left">
          {error && (
            <div className="bg-[#8C2232]/10 border border-[#8C2232]/35 rounded-lg px-4 py-2.5 text-xs text-red-300 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              <span>{error}</span>
            </div>
          )}

          <div className="text-xs text-slate-400 leading-relaxed font-medium space-y-1 bg-black/15 p-3 rounded-lg border border-white/5 font-mono">
            <div>📍 <strong className="text-slate-300">Target Table:</strong> {targetTable}</div>
            <div>📍 <strong className="text-slate-300">Target Column Field:</strong> {fieldName}</div>
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">
              Current Catalog Value (Read-Only)
            </label>
            <div className="bg-[#090d16] border border-white/5 rounded-lg px-4 py-3 text-xs text-slate-400 font-mono overflow-x-auto whitespace-pre">
              {currentValue || 'NULL / Empty'}
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">
              Proposed Value Override
            </label>
            {fieldName === 'description' ? (
              <textarea
                value={proposedValue}
                onChange={(e) => setProposedValue(e.target.value)}
                required
                rows={4}
                className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-3 text-xs text-white placeholder-slate-500 focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232] outline-none transition-all resize-none"
                placeholder="E.g., enter the correct narrative description..."
              ></textarea>
            ) : (
              <input
                type="text"
                value={proposedValue}
                onChange={(e) => setProposedValue(e.target.value)}
                required
                className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-3 text-xs text-white placeholder-slate-500 focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232] outline-none transition-all"
                placeholder="E.g., enter the correct credit number or code override..."
              />
            )}
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">
              Tester Justification (Reason)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
              className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-3 text-xs text-white placeholder-slate-500 focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232] outline-none transition-all resize-none"
              placeholder="E.g., 'ACCT 210 credits should be 4 according to Page 28 of the 2025 PDF catalog...'"
            ></textarea>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg font-bold text-slate-400 bg-white/5 border border-white/5 hover:bg-white/10 transition-colors text-xs cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-lg font-bold text-white bg-[#8C2232] hover:bg-[#65121e] transition-colors text-xs shadow-md cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>Logging...</span>
                </>
              ) : (
                <span>Log Delta Override</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
