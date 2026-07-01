'use client';

import React, { useState, useRef, useEffect } from 'react';

interface Props {
  catalogId: string;
  catalogs?: any[];
}

type Msg = { role: 'user' | 'assistant'; content: string };
type Op = { action: string; match?: string; value?: string; scope?: string; column?: string; instruction?: string; detail: string };
const RENDERING_ACTIONS = ['regroup', 'rename', 'hide'];
type Proposal = { classification: 'rendering' | 'data' | 'clarify'; message: string; summary: string; operations: Op[] };
type Staged = { id: string; classification: Proposal['classification']; detail: string; op: Op };

/**
 * On-demand catalog PDF viewer with an in-context correction agent. The registrar previews any
 * catalog (draft or published) and types corrections directly; the agent classifies each as a
 * rendering or data change, previews it, and on Apply writes it to the catalog and re-renders.
 */
export default function CatalogPdfView({ catalogId, catalogs }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const current = catalogs?.find((c) => c.id === catalogId);
  const isDraft = (current?.version + (current?.domain_id || '')).toLowerCase().includes('draft');

  // Correction agent state.
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [file, setFile] = useState<{ name: string; base64: string; type: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, proposal, busy]);
  // Reset the conversation when the selected catalog changes.
  useEffect(() => { setMessages([]); setProposal(null); setStaged([]); setFile(null); setSrc(null); }, [catalogId]);

  // Attach a source document (PDF or Word) the agent reads as authoritative content.
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 3 * 1024 * 1024) { setMessages((m) => [...m, { role: 'assistant', content: '⚠️ That file is over 3 MB — please upload a smaller document (a calendar or table is usually well under that).' }]); return; }
    const reader = new FileReader();
    reader.onload = () => setFile({ name: f.name, base64: String(reader.result || '').split(',')[1] || '', type: f.type || '' });
    reader.readAsDataURL(f);
  };

  const show = (fresh: boolean) => {
    if (!catalogId) return;
    setLoading(true);
    const params = new URLSearchParams({ catalogId, ts: String(Date.now()) });
    if (fresh) params.set('fresh', '1');
    setSrc(`/api/catalog/pdf?${params.toString()}`);
  };

  const downloadUrl = `/api/catalog/pdf?catalogId=${encodeURIComponent(catalogId)}&download=1${isDraft ? '&fresh=1' : ''}`;

  const send = async () => {
    const text = input.trim();
    if ((!text && !file) || busy) return;
    const shown = text || (file ? `(Attached ${file.name})` : '');
    const next: Msg[] = [...messages, { role: 'user', content: shown }];
    setMessages(next);
    setInput('');
    setProposal(null);
    setBusy(true);
    try {
      const res = await fetch('/api/catalog/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Send the typed turns (not the "(Attached …)" placeholder) plus the file as grounding.
        body: JSON.stringify({ catalogId, mode: 'propose', messages: text ? next : messages.concat({ role: 'user', content: text || 'Apply this uploaded document to the catalog.' }), file }),
      });
      const data = await res.json();
      if (!res.ok) { setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${data.error || 'Request failed.'}` }]); return; }
      setFile(null); // the upload is consumed for this turn
      const p: Proposal = data.proposal;
      setMessages((m) => [...m, { role: 'assistant', content: p.message || p.summary || '…' }]);
      if (p.classification !== 'clarify' && p.operations?.length) setProposal(p);
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${e.message || 'Network error.'}` }]);
    } finally {
      setBusy(false);
    }
  };

  // Add the current proposal's operations to the staging list (the scratchpad) for batch approval.
  const stageProposal = () => {
    if (!proposal) return;
    const items: Staged[] = proposal.operations.map((op) => ({
      id: crypto.randomUUID(),
      classification: RENDERING_ACTIONS.includes(op.action) ? 'rendering' : 'data',
      detail: op.detail, op,
    }));
    const total = staged.length + items.length;
    setStaged((s) => [...s, ...items]);
    setProposal(null);
    setMessages((m) => [...m, {
      role: 'assistant',
      content: `Added ${items.length} change${items.length > 1 ? 's' : ''} to your list (${total} staged). Describe more, or review the list and apply them all at once.`,
    }]);
  };

  const removeStaged = (id: string) => setStaged((s) => s.filter((x) => x.id !== id));

  // Apply every staged change in one batch, then re-render the PDF a single time.
  const applyAll = async () => {
    if (!staged.length || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/catalog/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId, mode: 'apply', operations: staged.map((s) => s.op) }),
      });
      const data = await res.json();
      if (!res.ok) { setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${data.error || 'Apply failed.'}` }]); return; }
      const lines: string[] = data.applied || [];
      if (data.nothingApplied) {
        // Nothing actually changed — keep the staged items so they can be adjusted/retried.
        setMessages((m) => [...m, { role: 'assistant', content: `⚠️ Nothing was applied:\n${lines.map((l) => `• ${l}`).join('\n')}\n\nYour staged changes are still here — try rewording or check the target name.` }]);
        return;
      }
      const n = staged.length;
      setMessages((m) => [...m, { role: 'assistant', content: `✓ Applied ${n} change${n > 1 ? 's' : ''} to ${current?.version || 'catalog'}:\n${lines.map((l) => `• ${l}`).join('\n') || 'done'}\n\nRe-rendering the PDF once…` }]);
      setStaged([]);
      show(true); // single re-render for the whole batch
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${e.message || 'Network error.'}` }]);
    } finally {
      setBusy(false);
    }
  };

  if (!catalogId) {
    return (
      <div className="bg-[#0b0f1d] border border-[#B6CFD6]/10 rounded-xl p-8 text-center text-slate-400">
        Select an Active Catalog Version (top right) to generate its PDF.
      </div>
    );
  }

  const badge = (c: Proposal['classification']) =>
    c === 'rendering'
      ? { label: 'Rendering change', cls: 'bg-sky-500/15 text-sky-300 border-sky-500/30' }
      : c === 'data'
        ? { label: 'Database change', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }
        : { label: 'Needs info', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="bg-[#0b0f1d] p-4 rounded-xl border border-[#B6CFD6]/10 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-lg font-bold text-white serif-title">Catalog PDF</h2>
          <p className="text-xs text-slate-400 font-medium">
            {current ? <>Catalog {current.version}{isDraft && <span className="text-amber-400"> — provisional draft preview</span>}</> : 'Generate a PDF of the selected catalog.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => show(false)} disabled={loading}
            className="bg-[#8C2232] hover:bg-[#65121e] text-white px-4 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer">
            {loading ? 'Rendering…' : src ? 'Reload' : 'Generate Preview'}
          </button>
          {src && (
            <button onClick={() => show(true)} disabled={loading}
              className="bg-white/5 hover:bg-white/10 text-slate-300 px-4 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer"
              title="Re-render from the latest catalog data">
              Regenerate
            </button>
          )}
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer"
            className="bg-[#B6CFD6]/10 hover:bg-[#B6CFD6]/20 text-[#B6CFD6] border border-[#B6CFD6]/20 px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            Download
          </a>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-[400px] overflow-y-auto lg:overflow-visible pb-4 lg:pb-0">
        {/* PDF preview */}
        <div className="w-full h-[55vh] lg:h-auto shrink-0 lg:shrink lg:flex-1 bg-[#0b0f1d] rounded-xl border border-[#B6CFD6]/10 overflow-hidden relative">
          {!src && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              Click <span className="mx-1 font-semibold text-slate-300">Generate Preview</span> to render the catalog PDF
              {isDraft ? ' (provisional draft).' : '.'}
            </div>
          )}
          {src && loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10 text-slate-300 text-sm">
              Rendering catalog PDF… (a full catalog can take a moment)
            </div>
          )}
          {src && <iframe key={src} src={src} title="Catalog PDF" className="w-full h-full" onLoad={() => setLoading(false)} />}
        </div>

        {/* Correction agent */}
        <div className="w-full lg:w-[360px] shrink-0 h-[520px] lg:h-auto bg-[#0b0f1d] rounded-xl border border-[#B6CFD6]/10 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-[#B6CFD6]/10 shrink-0">
            <h3 className="text-sm font-bold text-white">Catalog Corrections</h3>
            <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
              Describe fixes in plain English. I’ll classify each as a layout or data change and add it to a list — review the list, then apply them all at once with a single re-render.
            </p>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {messages.length === 0 && !busy && (
              <div className="text-[11px] text-slate-500 leading-relaxed bg-white/5 rounded-lg p-3">
                <p className="text-slate-400 font-semibold mb-1">Try:</p>
                “Supply Chain Management and Business Management – Fast Track are their own headings — nest them under Business Management.”
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`text-xs leading-relaxed whitespace-pre-wrap rounded-lg px-3 py-2 ${m.role === 'user' ? 'bg-[#8C2232]/20 text-slate-100 ml-6' : 'bg-white/5 text-slate-300 mr-2'}`}>
                {m.content}
              </div>
            ))}

            {proposal && (
              <div className="rounded-lg border border-[#B6CFD6]/20 bg-[#0a0e1a] p-3 mr-2">
                <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded border ${badge(proposal.classification).cls}`}>
                  {badge(proposal.classification).label}
                </span>
                <p className="text-xs text-slate-200 font-semibold mt-2">{proposal.summary}</p>
                <ul className="mt-2 space-y-1">
                  {proposal.operations.map((op, i) => (
                    <li key={i} className="text-[11px] text-slate-400 flex gap-1.5">
                      <span className="text-[#B6CFD6] mt-0.5">→</span><span>{op.detail}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 mt-3">
                  <button onClick={stageProposal} disabled={busy}
                    className="flex-1 bg-[#8C2232] hover:bg-[#65121e] text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer">
                    Add to changes
                  </button>
                  <button onClick={() => setProposal(null)} disabled={busy}
                    className="bg-white/5 hover:bg-white/10 text-slate-300 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer">
                    Discard
                  </button>
                </div>
              </div>
            )}

            {busy && <div className="text-[11px] text-slate-500 italic px-1">Thinking…</div>}
          </div>

          <div className="p-3 border-t border-[#B6CFD6]/10 shrink-0">
            {file && (
              <div className="flex items-center gap-2 mb-2 bg-[#070b15] border border-[#B6CFD6]/15 rounded-lg px-2.5 py-1.5">
                <svg className="w-3.5 h-3.5 text-[#B6CFD6] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                <span className="text-[11px] text-slate-300 truncate flex-1" title={file.name}>{file.name}</span>
                <button onClick={() => setFile(null)} disabled={busy} className="text-slate-600 hover:text-rose-400 text-sm leading-none shrink-0 cursor-pointer" title="Remove">×</button>
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={file ? 'Tell me what to do with this document…' : 'Describe a correction, or attach a document…'}
              rows={2}
              disabled={busy}
              className="w-full bg-[#070b15] border border-[#B6CFD6]/15 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-[#B6CFD6]/40 resize-none disabled:opacity-50"
            />
            <input ref={fileRef} type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={onPickFile} className="hidden" />
            <div className="flex justify-between items-center mt-2">
              <button onClick={() => fileRef.current?.click()} disabled={busy}
                className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-[#B6CFD6] disabled:opacity-50 cursor-pointer" title="Attach a PDF or Word document">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                Attach document
              </button>
              <button onClick={send} disabled={busy || (!input.trim() && !file)}
                className="bg-[#8C2232] hover:bg-[#65121e] text-white px-4 py-1.5 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer">
                Send
              </button>
            </div>
          </div>
        </div>

        {/* Staged changes — its own column so the chat stays roomy (the batch proofing list) */}
        {staged.length > 0 && (
          <div className="w-full lg:w-[300px] shrink-0 h-[360px] lg:h-auto bg-[#0b0f1d] rounded-xl border border-[#B6CFD6]/10 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-[#B6CFD6]/10 shrink-0 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-white">Staged changes</h3>
                <p className="text-[11px] text-slate-400">{staged.length} ready to apply — proof before applying</p>
              </div>
              <button onClick={() => setStaged([])} disabled={busy}
                className="text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-50 cursor-pointer shrink-0">Clear all</button>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-3">
              <ol className="space-y-2">
                {staged.map((s, i) => (
                  <li key={s.id} className="flex items-start gap-1.5 text-[11px] text-slate-300">
                    <span className="text-slate-600 w-4 shrink-0 text-right">{i + 1}.</span>
                    <span className={`shrink-0 mt-1 w-1.5 h-1.5 rounded-full ${s.classification === 'data' ? 'bg-amber-400' : 'bg-sky-400'}`}
                      title={s.classification === 'data' ? 'Database change' : 'Rendering change'}></span>
                    <span className="flex-1 leading-snug">{s.detail}</span>
                    <button onClick={() => removeStaged(s.id)} disabled={busy}
                      className="text-slate-600 hover:text-rose-400 shrink-0 leading-none text-sm disabled:opacity-50 cursor-pointer" title="Remove">×</button>
                  </li>
                ))}
              </ol>
            </div>

            <div className="p-3 border-t border-[#B6CFD6]/10 shrink-0">
              <div className="flex items-center gap-3 mb-2 text-[10px] text-slate-500">
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-400"></span>Rendering</span>
                <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>Database</span>
              </div>
              <button onClick={applyAll} disabled={busy}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer">
                {busy ? 'Applying…' : `Apply all ${staged.length} & re-render`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
