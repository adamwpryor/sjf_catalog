'use client';

import React, { useState, useEffect } from 'react';

type PreviewResult = {
  correctionId: string;
  reason: string;
  status: 'ready' | 'needs_review' | 'error';
  note: string;
  diffs: any[];
};

type AuditFinding = { severity: 'critical' | 'warning'; type: string; course: string; detail: string; origin?: 'new' | 'inherited' };
type AuditResult = {
  summary: {
    courses: number; edges: number; hasSource: boolean;
    new: { critical: number; warning: number };
    inherited: { critical: number; warning: number };
    critical: number; warnings: number; passed: boolean;
  };
  findings: AuditFinding[];
};

export default function CatalogProductionWizard({ sourceCatalogId, sourceCatalogVersion, onComplete, onDraftCreated, isDraft }: { sourceCatalogId: string, sourceCatalogVersion?: string, onComplete: (newCatalogId: string) => void, onDraftCreated?: (newCatalogId: string) => void, isDraft?: boolean }) {
  const [currentStep, setCurrentStep] = useState<number>(isDraft ? 2 : 1);
  const [loading, setLoading] = useState<boolean>(false);
  const [draftId, setDraftId] = useState<string | null>(isDraft ? sourceCatalogId : null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult[] | null>(null);
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [overridePublish, setOverridePublish] = useState<boolean>(false);

  useEffect(() => {
    setCurrentStep(isDraft ? 2 : 1);
    setDraftId(isDraft ? sourceCatalogId : null);
    setLogs([]);
    setError(null);
    setPreview(null);
    setAudit(null);
    setPdfUrl(null);
    setOverridePublish(false);
  }, [sourceCatalogId, isDraft]);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const getNextVersion = (version: string) => {
    const match = version.match(/20(\d{2})-20(\d{2})/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      return `20${end}-20${end + 1} (Draft)`;
    }
    return `${version} (Draft)`;
  };

  const nextVersion = sourceCatalogVersion ? getNextVersion(sourceCatalogVersion) : "Next Year (Draft)";

  const handleInitializeDraft = async () => {
    if (!sourceCatalogId) {
        setError("No active catalog selected to clone.");
        return;
    }
    setLoading(true);
    setError(null);
    addLog(`Initializing ${nextVersion}. Cloning schema and master document...`);
    
    try {
      const res = await fetch('/api/catalog/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceCatalogId: sourceCatalogId,
          newVersion: nextVersion
        })
      });

      if (res.ok) {
        const data = await res.json();
        setDraftId(data.catalogId);
        if (data.counts) {
          addLog(`Draft created successfully. Cloned ${data.counts.courses} courses, ${data.counts.programs} programs, ${data.counts.chunks} policy chunks.`);
        } else {
          addLog("Draft created successfully. Schema cloned.");
        }
        // Refresh the parent catalog list so the new draft appears immediately
        // in the active version selector without requiring a full page reload.
        if (onDraftCreated) onDraftCreated(data.catalogId);
        setCurrentStep(2);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to duplicate catalog.");
        addLog(`Error: ${data.error}`);
      }
    } catch (err) {
      setError("Network error occurred.");
      addLog("Error: Network failure.");
    } finally {
      setLoading(false);
    }
  };

  // Step 2 runs in two phases: compute a preview of field-level diffs, then
  // confirm to write them to the draft. `preview` holds the per-correction results
  // (status 'ready' | 'needs_review' | 'error', each with a list of diffs).
  const handleComputeCorrections = async () => {
    setLoading(true);
    setError(null);
    setPreview(null);
    addLog("Resolving approved corrections against the draft (preview)...");

    try {
      const res = await fetch('/api/catalog/apply-deltas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, mode: 'preview' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to compute corrections.');
        addLog(`Error: ${data.error}`);
        return;
      }
      const results = data.results || [];
      setPreview(results);
      const ready = results.filter((r: any) => r.status === 'ready').length;
      const review = results.filter((r: any) => r.status !== 'ready').length;
      addLog(`Preview ready: ${ready} correction(s) resolve to concrete edits, ${review} need manual review.`);
    } catch (err) {
      setError('Network error while computing corrections.');
      addLog('Error: Network failure during preview.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmApply = async () => {
    if (!preview) return;
    const readyIds = preview.filter((r) => r.status === 'ready').map((r) => r.correctionId);
    if (readyIds.length === 0) {
      addLog('Nothing to apply — no corrections resolved to concrete edits.');
      setCurrentStep(3);
      return;
    }
    setLoading(true);
    setError(null);
    addLog(`Applying ${readyIds.length} correction(s) to the draft...`);

    try {
      const res = await fetch('/api/catalog/apply-deltas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, mode: 'apply', confirmedCorrectionIds: readyIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to apply corrections.');
        addLog(`Error: ${data.error}`);
        return;
      }
      addLog(`Applied ${data.appliedCount} correction(s) to the draft.`);
      if (data.needsReview?.length) addLog(`${data.needsReview.length} left for manual review.`);

      // Narrative phase: re-sync the affected catalog chunks so the RAG/search layer
      // matches the corrected structure (embeddings are flagged for upstream re-indexing).
      addLog('Re-syncing catalog narrative for the applied corrections...');
      try {
        const rsRes = await fetch('/api/catalog/resync-chunks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId, correctionIds: readyIds }),
        });
        const rs = await rsRes.json();
        if (!rsRes.ok) {
          addLog(`⚠ Narrative re-sync failed: ${rs.error}. Structured changes are applied; re-sync can be retried.`);
        } else {
          addLog(`Re-synced ${rs.updated} chunk(s) (${rs.created} created); ${rs.embedded} re-embedded for search.`);
        }
      } catch (e) {
        addLog('⚠ Narrative re-sync network error. Structured changes are applied; re-sync can be retried.');
      }

      setPreview(null);
      setCurrentStep(3);
    } catch (err) {
      setError('Network error while applying corrections.');
      addLog('Error: Network failure during apply.');
    } finally {
      setLoading(false);
    }
  };

  const handleCurriculumAudit = async () => {
    setLoading(true);
    setError(null);
    setAudit(null);
    addLog("Auditing the draft prerequisite graph...");

    try {
      const res = await fetch('/api/catalog/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId, sourceCatalogId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Curriculum audit failed.');
        addLog(`Error: ${data.error}`);
        return;
      }
      setAudit(data);
      const s = data.summary;
      addLog(`Audit: ${s.courses} courses, ${s.edges} edges. ${s.critical} critical / ${s.warnings} warnings total.`);
      if (s.hasSource) {
        addLog(`This cycle introduced ${s.new.critical} new critical + ${s.new.warning} new warning(s); ${s.inherited.critical + s.inherited.warning} inherited from the source catalog.`);
        addLog(s.passed ? '✓ No NEW critical issues — safe to publish.' : `⚠ ${s.new.critical} NEW critical issue(s) introduced this cycle — resolve or override before publishing.`);
      } else {
        addLog('No source catalog to compare against — all findings treated as new.');
      }
    } catch (err) {
      setError('Network error during curriculum audit.');
      addLog('Error: Network failure during audit.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignOff = async () => {
    setLoading(true);
    setError(null);
    setPdfUrl(null);
    addLog("Generating the catalog-of-record PDF from the corrected database...");

    try {
      const res = await fetch('/api/catalog/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Publish failed.');
        addLog(`Error: ${data.error}`);
        return;
      }
      setPdfUrl(data.pdfUrl);
      addLog(`Catalog PDF generated (${Math.round((data.bytes || 0) / 1024)} KB) and uploaded.`);
      addLog("Draft published — catalog production complete! Download the PDF below, then click Done.");
      // NOTE: don't call onComplete() here — it navigates away before the user can see/download
      // the PDF. The "Done" button (shown once pdfUrl is set) completes the wizard.
    } catch (err) {
      setError('Network error while publishing.');
      addLog('Error: Network failure during publish.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[#0b0f1d] border border-[#B6CFD6]/15 rounded-xl p-6 text-slate-200 font-sans max-w-4xl mx-auto mt-6">
      <div className="border-b border-white/10 pb-4 mb-6 relative">
        <h2 className="text-xl font-bold text-white mb-2">Catalog Production Wizard</h2>
        <p className="text-sm text-slate-400">Safely generate the next academic year's catalog using the Campus Swarm Agents. This structured pipeline ensures all delta corrections are applied and curriculum prerequisites are validated before publication.</p>
        <button
          onClick={async () => {
            // Scope the reset to the catalog currently in the wizard only — never
            // strip draft tags across every document in the database.
            const targetCatalogId = draftId || sourceCatalogId;
            if (!targetCatalogId) return;
            const res = await fetch('/api/db', { method: 'POST', body: JSON.stringify({ action: 'fix_stuck_state', catalogId: targetCatalogId }) });
            if (res.ok) window.location.reload();
          }}
          className="absolute top-0 right-0 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs rounded-lg border border-red-500/20 transition-all cursor-pointer"
          title="If you are stuck on Step 2 but want to initialize a new draft, click this to reset."
        >
          Reset Stuck State
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-8">
        {/* Left Column: Steps */}
        <div className="flex-1 space-y-6">
          
          {/* Step 1 */}
          <div className={`p-4 rounded-xl border transition-all ${currentStep === 1 ? 'bg-[#8C2232]/10 border-[#8C2232]' : currentStep > 1 ? 'bg-white/5 border-emerald-500/50' : 'bg-transparent border-white/10 opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className={`font-bold ${currentStep === 1 ? 'text-white' : currentStep > 1 ? 'text-emerald-400' : 'text-slate-400'}`}>1. Initialize Draft Database</h3>
              {currentStep > 1 && <span className="text-emerald-400 text-xs">✔ Complete</span>}
            </div>
            <p className="text-xs text-slate-400 mb-4">Clones the active catalog master schema and courses into a sandboxed draft for editing.</p>
            {currentStep === 1 && (
              <button 
                onClick={handleInitializeDraft} 
                disabled={loading}
                className="bg-[#8C2232] hover:bg-[#65121e] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
              >
                {loading ? 'Initializing...' : 'Clone Active to Draft'}
              </button>
            )}
          </div>

          {/* Step 2 */}
          <div className={`p-4 rounded-xl border transition-all ${currentStep === 2 ? 'bg-[#8C2232]/10 border-[#8C2232]' : currentStep > 2 ? 'bg-white/5 border-emerald-500/50' : 'bg-transparent border-white/10 opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className={`font-bold ${currentStep === 2 ? 'text-white' : currentStep > 2 ? 'text-emerald-400' : 'text-slate-400'}`}>2. Apply Delta Corrections</h3>
              {currentStep > 2 && <span className="text-emerald-400 text-xs">✔ Complete</span>}
            </div>
            <p className="text-xs text-slate-400 mb-4">Resolves every <strong>approved</strong> correction into concrete edits against this draft. Review the diffs, then confirm to write them and mark the corrections <code>applied</code>.</p>
            {currentStep === 2 && (
              <div className="space-y-3">
                {!preview && (
                  <button
                    onClick={handleComputeCorrections}
                    disabled={loading}
                    className="bg-[#8C2232] hover:bg-[#65121e] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Resolving...' : 'Compute Corrections'}
                  </button>
                )}

                {preview && (
                  <div className="space-y-3">
                    <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                      {preview.length === 0 && (
                        <p className="text-xs text-slate-500 italic">No approved corrections to apply.</p>
                      )}
                      {preview.map((r) => (
                        <div key={r.correctionId} className={`rounded-lg border p-3 text-xs ${r.status === 'ready' ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-semibold text-slate-200">{r.reason}</span>
                            <span className={`uppercase text-[9px] font-bold tracking-wider ${r.status === 'ready' ? 'text-emerald-400' : 'text-amber-400'}`}>
                              {r.status === 'ready' ? 'Ready' : 'Needs review'}
                            </span>
                          </div>
                          {r.note && <p className="text-[10px] text-slate-500 mb-1">{r.note}</p>}
                          {r.diffs?.map((d, i) => (
                            <div key={i} className="font-mono text-[10px] text-slate-400 border-t border-white/5 pt-1 mt-1">
                              {d.kind === 'course' && d.before && (
                                <>
                                  <div className="text-slate-300">{d.code}</div>
                                  {Object.keys(d.after).map((c) => (
                                    <div key={c}>
                                      <span className="text-slate-500">{c}:</span>{' '}
                                      <span className="text-red-400">- {String(JSON.stringify(d.before[c]))}</span>{' '}
                                      <span className="text-emerald-400">+ {String(JSON.stringify(d.after[c]))}</span>
                                    </div>
                                  ))}
                                </>
                              )}
                              {d.kind === 'course' && d.note && <div className="text-amber-400">{d.code}: {d.note}</div>}
                              {d.kind === 'program' && d.after && (
                                <div>{d.name}: {Object.keys(d.after).map((c) => `${c} → ${d.after[c]}`).join(', ')}</div>
                              )}
                              {d.kind === 'program' && d.note && <div className="text-amber-400">{d.name}: {d.note}</div>}
                              {d.kind === 'insert' && <div className="text-emerald-400">+ new course {d.code}{d.note ? ` (${d.note})` : ''}</div>}
                              {d.kind === 'edge' && <div>{d.op === 'remove' ? '− ' : '+ '}prereq {d.prereq} {d.op === 'remove' ? 'from' : 'to'} {d.course}</div>}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleConfirmApply}
                        disabled={loading}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                      >
                        {loading ? 'Applying...' : `Confirm & Apply (${preview.filter((r) => r.status === 'ready').length})`}
                      </button>
                      <button
                        onClick={() => setPreview(null)}
                        disabled={loading}
                        className="bg-white/5 hover:bg-white/10 text-slate-300 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                      >
                        Recompute
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 3 */}
          <div className={`p-4 rounded-xl border transition-all ${currentStep === 3 ? 'bg-[#8C2232]/10 border-[#8C2232]' : currentStep > 3 ? 'bg-white/5 border-emerald-500/50' : 'bg-transparent border-white/10 opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className={`font-bold ${currentStep === 3 ? 'text-white' : currentStep > 3 ? 'text-emerald-400' : 'text-slate-400'}`}>3. Curriculum Graph Audit</h3>
              {currentStep > 3 && <span className="text-emerald-400 text-xs">✔ Complete</span>}
            </div>
            <p className="text-xs text-slate-400 mb-4">Traverses the draft course prerequisite graph and flags broken references, prerequisite cycles, and text/structure drift created by the deltas.</p>
            {currentStep === 3 && (
              <div className="space-y-3">
                {!audit && (
                  <button
                    onClick={handleCurriculumAudit}
                    disabled={loading}
                    className="bg-[#8C2232] hover:bg-[#65121e] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Auditing...' : 'Audit Graph'}
                  </button>
                )}

                {audit && (
                  <div className="space-y-3">
                    <div className={`rounded-lg border p-3 text-xs ${audit.summary.passed ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-red-500/30 bg-red-500/5 text-red-300'}`}>
                      {audit.summary.passed
                        ? `✓ This cycle introduced no new critical issues (${audit.summary.courses} courses, ${audit.summary.edges} edges).`
                        : `✗ ${audit.summary.new.critical} NEW critical issue(s) introduced this cycle.`}
                      {audit.summary.hasSource && (
                        <div className="mt-1 text-slate-400">
                          New: {audit.summary.new.critical} critical / {audit.summary.new.warning} warnings ·
                          {' '}Inherited (pre-existing): {audit.summary.inherited.critical} critical / {audit.summary.inherited.warning} warnings
                        </div>
                      )}
                    </div>

                    {audit.findings.length > 0 && (
                      <div className="max-h-60 overflow-y-auto space-y-1 pr-1 font-mono text-[10px]">
                        {audit.findings.map((f, i) => (
                          <div key={i} className={`border-l-2 pl-2 ${f.severity === 'critical' ? 'border-red-500 text-red-300' : 'border-amber-500 text-amber-300'}`}>
                            <span className={`uppercase font-bold mr-1 ${f.origin === 'new' ? 'text-white bg-red-600/40 px-1 rounded' : 'text-slate-500'}`}>{f.origin === 'new' ? 'NEW' : 'inherited'}</span>
                            <span className="uppercase font-bold">[{f.type}]</span> {f.course}: {f.detail}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        onClick={() => setCurrentStep(4)}
                        disabled={loading}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 ${audit.summary.passed ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-amber-600/80 hover:bg-amber-600 text-white'}`}
                      >
                        {audit.summary.passed ? 'Continue to Sign-off' : 'Continue (new criticals unresolved)'}
                      </button>
                      <button
                        onClick={() => setAudit(null)}
                        disabled={loading}
                        className="bg-white/5 hover:bg-white/10 text-slate-300 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                      >
                        Re-run
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 4 */}
          <div className={`p-4 rounded-xl border transition-all ${currentStep === 4 ? 'bg-[#8C2232]/10 border-[#8C2232]' : currentStep > 4 ? 'bg-white/5 border-emerald-500/50' : 'bg-transparent border-white/10 opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className={`font-bold ${currentStep === 4 ? 'text-white' : currentStep > 4 ? 'text-emerald-400' : 'text-slate-400'}`}>4. Sign-off & Publish</h3>
              {currentStep > 4 && <span className="text-emerald-400 text-xs">✔ Complete</span>}
            </div>
            <p className="text-xs text-slate-400 mb-4">Generates the published catalog-of-record PDF from the corrected database, uploads it, and removes the draft tag.</p>
            {currentStep === 4 && (
              <div className="space-y-3">
                {audit && !audit.summary.passed && !overridePublish && !pdfUrl && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
                    ⚠ {audit.summary.new.critical} new critical issue(s) introduced this cycle are unresolved. Resolve them (re-run Step 2) — or override to publish anyway.
                    <button
                      onClick={() => setOverridePublish(true)}
                      className="mt-2 block bg-amber-600/80 hover:bg-amber-600 text-white px-3 py-1.5 rounded text-xs font-semibold cursor-pointer"
                    >
                      Override &amp; publish anyway
                    </button>
                  </div>
                )}
                {!pdfUrl && (
                  <button
                    onClick={handleSignOff}
                    disabled={loading || (!!audit && !audit.summary.passed && !overridePublish)}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Generating PDF...' : 'Generate Catalog PDF & Publish'}
                  </button>
                )}
                {pdfUrl && (
                  <a
                    href={pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-[#8C2232] hover:bg-[#65121e] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    Download Catalog PDF
                  </a>
                )}
                {pdfUrl && (
                  <button
                    onClick={() => { if (draftId) onComplete(draftId); }}
                    className="ml-2 bg-white/5 hover:bg-white/10 text-slate-300 px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                  >
                    Done
                  </button>
                )}
              </div>
            )}
          </div>

        </div>

        {/* Right Column: Terminal Logs */}
        <div className="flex-1 bg-black/50 border border-white/10 rounded-xl p-4 flex flex-col font-mono text-[10px]">
          <h4 className="text-slate-400 mb-3 border-b border-white/10 pb-2">SWARM AGENT EXECUTION LOGS</h4>
          <div className="flex-1 overflow-y-auto space-y-1.5 text-slate-300">
            {logs.length === 0 && <span className="text-slate-600 italic">Waiting for pipeline start...</span>}
            {logs.map((l, i) => (
               <div key={i}>{l}</div>
            ))}
            {error && <div className="text-red-400 mt-2">! ERROR: {error}</div>}
          </div>
        </div>

      </div>
    </div>
  );
}
