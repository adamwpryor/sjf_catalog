'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ImprovementPlanFlow, { type PlanItem } from '@/components/ImprovementPlanFlow';
import { FEATURES } from '@/lib/brand';

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  systemPrompt?: string;
}

interface AccreditorInfo {
  id: string;
  code: string;
  name: string;
  criteria_count: number;
  has_reference_doc: boolean;
}

interface ImprovementPlanProps {
  catalogId?: string;
  catalogs?: any[];
  canEdit?: boolean;
}

/**
 * Derives the active academic year (e.g. "2026-2027") from a catalog version
 * string, falling back to the current calendar year.
 *
 * @param version - The catalog version label.
 * @returns A normalized "YYYY-YYYY" academic year.
 */
function deriveCurrentYear(version: string | undefined): string {
  if (version) {
    const range = version.match(/(20\d{2})\s*[-–—]\s*(20\d{2})/);
    if (range) return `${range[1]}-${range[2]}`;
    const single = version.match(/(20\d{2})/);
    if (single) { const y = parseInt(single[1], 10); return `${y}-${y + 1}`; }
  }
  const y = new Date().getFullYear();
  return `${y}-${y + 1}`;
}

/**
 * Builds a list of selectable academic years starting at the current year.
 *
 * @param currentYear - The active "YYYY-YYYY" year.
 * @param count - How many years forward to include.
 * @returns An ordered list of academic-year strings.
 */
function buildYearOptions(currentYear: string, count = 5): string[] {
  const start = parseInt(currentYear.slice(0, 4), 10);
  const years: string[] = [];
  for (let i = 0; i < count; i++) years.push(`${start + i}-${start + i + 1}`);
  return years;
}

/**
 * Catalog Improvement Plan tab: a Catalog Improvement Assistant (left) that
 * generates and explains quality-aligned recommendations, feeding a persistent,
 * multi-year dependency flowchart — the Catalog Improvement Plan (right).
 */
export default function ImprovementPlan({ catalogId, catalogs = [], canEdit = false }: ImprovementPlanProps) {
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [accreditors, setAccreditors] = useState<AccreditorInfo[]>([]);
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const currentVersion = useMemo(
    () => catalogs.find((c: any) => c.id === catalogId)?.version as string | undefined,
    [catalogs, catalogId]
  );
  const currentYear = useMemo(() => deriveCurrentYear(currentVersion), [currentVersion]);
  const yearOptions = useMemo(() => buildYearOptions(currentYear), [currentYear]);

  // Accreditor grounding status, in order of fidelity:
  // structured criteria > ingested reference document > general knowledge.
  const grounding = useMemo(() => {
    const withCriteria = accreditors.filter(a => a.criteria_count > 0);
    if (withCriteria.length > 0) {
      return { grounded: true, label: `Grounded on ${withCriteria.map(a => a.code).join(', ')} criteria` };
    }
    const withDocs = accreditors.filter(a => a.has_reference_doc);
    if (withDocs.length > 0) {
      return { grounded: true, label: `Grounded on ${withDocs.map(a => a.code).join(', ')} reference docs` };
    }
    if (accreditors.length > 0) {
      return { grounded: false, label: `${accreditors.map(a => a.code).join(', ')} · no criteria or docs loaded` };
    }
    return { grounded: false, label: 'Accreditor not configured' };
  }, [accreditors]);

  /** Loads all persisted plan items for the tenant. */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/improvement-plan');
      if (res.ok) {
        const data = await res.json();
        setPlans(data.plans || []);
        setAccreditors(data.accreditors || []);
      }
    } catch (err) {
      console.error('Failed to load improvement plan:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    setMessages([{
      id: 'welcome',
      role: 'assistant',
      content: FEATURES.accreditation
        ? `Hi — I'm your **Catalog Improvement Assistant**. I review the selected catalog against your accreditor's criteria and turn it into a planning document.\n\nClick **Generate Plan** to draft 2–5 sequenced improvements for each relevant accreditation criterion, mapped out with dependencies on the right. Then select, amend, or schedule each item for a future year. You can also ask me questions about accreditation or specific catalog sections.`
        : `Hi — I'm your **Catalog Improvement Assistant**. I review the selected catalog for quality, clarity, and consistency and turn it into a planning document.\n\nClick **Generate Plan** to draft 2–5 sequenced improvements across the catalog's weakest areas, mapped out with dependencies on the right. Then select, amend, or schedule each item for a future year. You can also ask me questions about specific catalog sections.`,
    }]);
  }, [refresh, catalogId]);

  /** Triggers AI plan generation grounded in the selected catalog. */
  const handleGenerate = async () => {
    if (!catalogId) return;
    setGenerating(true);
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: '_Scanning the catalog against quality criteria and drafting a sequenced plan…_' }]);
    try {
      const res = await fetch('/api/improvement-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate', catalogId }),
      });
      if (res.ok) {
        const data = await res.json();
        const next: PlanItem[] = data.plans || [];
        setPlans(next);
        const suggested = next.filter(p => p.plan_state === 'suggested').length;
        const crits = Array.from(new Set(next.map(p => p.criterion_code).filter(Boolean)));
        setMessages(prev => [...prev, {
          id: Date.now().toString() + 'r',
          role: 'assistant',
          content: suggested > 0
            ? `Done. I drafted **${suggested} improvement${suggested === 1 ? '' : 's'}** across **${crits.length} improvement criteria** (${crits.join(', ')}). They're on the map to the right with dependencies drawn in. Click any card to see the rationale, get a detailed explanation, or schedule it.`
            : `I couldn't draft new suggestions right now — please confirm an AI provider is configured on the server. Your existing plan items are unchanged.`,
        }]);
      } else {
        const err = await res.json().catch(() => ({}));
        setMessages(prev => [...prev, { id: Date.now().toString() + 'e', role: 'assistant', content: `Generation failed: ${err.error || 'unknown error'}.` }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { id: Date.now().toString() + 'e', role: 'assistant', content: `Generation failed: ${err.message}.` }]);
    } finally {
      setGenerating(false);
    }
  };

  /** Free-form accreditation Q&A via the grounded assistant. */
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: chatInput };
    setMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setIsThinking(true);
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content, catalogId, mode: 'RAG', history: messages.map(m => ({ role: m.role, content: m.content })) }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages(prev => [...prev, { id: Date.now().toString() + 'a', role: 'assistant', content: data.response, systemPrompt: data.systemPrompt }]);
      } else {
        setMessages(prev => [...prev, { id: Date.now().toString() + 'a', role: 'assistant', content: 'Sorry, I hit an error connecting to the AI service.' }]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsThinking(false);
    }
  };

  /** Persists an edit/state-transition and merges the result locally. */
  const handlePatch = useCallback(async (id: string, fields: Partial<PlanItem>) => {
    try {
      const res = await fetch('/api/improvement-plan', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      if (res.ok) {
        const data = await res.json();
        setPlans(prev => prev.map(p => (p.id === id ? data.plan : p)));
      }
    } catch (err) {
      console.error('Patch failed:', err);
    }
  }, []);

  /** Requests (and caches) a deeper AI explanation for an item. */
  const handleExplain = useCallback(async (id: string): Promise<string> => {
    const res = await fetch('/api/improvement-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'explain', id }),
    });
    if (!res.ok) return 'Could not generate an explanation right now.';
    const data = await res.json();
    setPlans(prev => prev.map(p => (p.id === id ? { ...p, ai_detail: data.ai_detail } : p)));
    return data.ai_detail || '';
  }, []);

  /** Deletes a single item. */
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this improvement item?')) return;
    const res = await fetch('/api/improvement-plan', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) setPlans(prev => prev.filter(p => p.id !== id));
  }, []);

  /** Clears an entire prior year of plan items. */
  const handleDeleteYear = useCallback(async (year: string) => {
    if (!confirm(`Delete ALL improvement items targeted for ${year}? This cannot be undone.`)) return;
    const res = await fetch('/api/improvement-plan', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_year', targetYear: year }),
    });
    if (res.ok) setPlans(prev => prev.filter(p => p.target_year !== year));
  }, []);

  return (
    <div className="h-full flex flex-col lg:flex-row gap-6 animate-in fade-in duration-300 font-sans">
      {/* LEFT: Catalog Improvement Assistant */}
      <div className="w-full lg:w-[400px] xl:w-[440px] shrink-0 bg-[#0b0f1d] border border-[#B6CFD6]/20 rounded-2xl flex flex-col overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-[#B6CFD6]/10 bg-black/40 flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-full bg-[#8C2232]/20 flex items-center justify-center border border-[#8C2232]/50">
            <svg className="w-4 h-4 text-[#8C2232]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-white">Catalog Improvement Assistant</h3>
            <p className="text-[10px] text-emerald-400 font-mono uppercase tracking-widest flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Catalog {currentVersion || '—'} · {currentYear}
            </p>
            {FEATURES.accreditation && (
              <p className={`text-[10px] font-mono tracking-wide mt-0.5 flex items-center gap-1 ${grounding.grounded ? 'text-[#B6CFD6]' : 'text-slate-500'}`}>
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                {grounding.label}
              </p>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-gradient-to-b from-transparent to-black/20">
          {messages.map(msg => (
            <div key={msg.id} className={`flex flex-col max-w-[92%] ${msg.role === 'user' ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
              <div className={`p-3 rounded-2xl border text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-[#8C2232] text-white border-[#8C2232]/50 rounded-br-none'
                  : 'bg-white/5 text-slate-200 border-white/5 rounded-bl-none'
              }`}>
                <div className="markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ node, ...props }) => <h1 className="text-sm font-extrabold mt-3 mb-2 text-white" {...props} />,
                      h2: ({ node, ...props }) => <h2 className="text-xs font-bold mt-3 mb-1.5 text-white" {...props} />,
                      p: ({ node, ...props }) => <p className="mb-2 last:mb-0 leading-relaxed text-slate-200" {...props} />,
                      ul: ({ node, ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                      li: ({ node, ...props }) => <li className="text-slate-200" {...props} />,
                      strong: ({ node, ...props }) => <strong className="font-bold text-white" {...props} />,
                      em: ({ node, ...props }) => <em className="text-slate-400" {...props} />,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
          {isThinking && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl p-3 bg-white/5 text-slate-400 border border-white/5 rounded-bl-none text-xs flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                Synthesizing…
              </div>
            </div>
          )}
        </div>

        {/* Generate + chat input */}
        <div className="p-4 bg-black/40 border-t border-[#B6CFD6]/10 shrink-0 space-y-3">
          <button
            onClick={handleGenerate}
            disabled={generating || !catalogId}
            className="w-full px-4 py-2.5 bg-[#8C2232] hover:bg-[#a32a3c] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-bold transition-all shadow-md flex items-center justify-center gap-2"
          >
            {generating ? (
              <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Generating plan…</>
            ) : (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M11 2l1.6 4.6L17 8l-4.4 1.4L11 14l-1.6-4.6L5 8l4.4-1.4L11 2z" /></svg>
                {plans.some(p => p.plan_state === 'suggested') ? 'Regenerate Plan' : 'Generate Plan'}
              </>
            )}
          </button>
          <form onSubmit={handleSendMessage} className="relative flex items-center">
            <input
              type="text"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              placeholder={FEATURES.accreditation ? 'Ask about accreditation or a catalog section…' : 'Ask about catalog quality or a specific section…'}
              className="w-full bg-black/50 border border-white/10 rounded-full pl-4 pr-12 py-2.5 text-sm text-white outline-none focus:border-[#B6CFD6]/50 transition-colors"
              disabled={isThinking}
            />
            <button type="submit" disabled={!chatInput.trim() || isThinking}
              className="absolute right-1.5 p-1.5 bg-[#B6CFD6]/10 hover:bg-[#B6CFD6]/20 text-[#B6CFD6] rounded-full disabled:opacity-50 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
            </button>
          </form>
        </div>
      </div>

      {/* RIGHT: Catalog Improvement Plan (flowchart) */}
      <div className="flex-1 flex flex-col gap-4 min-h-0">
        <div className="bg-[#0b0f1d] p-5 rounded-2xl border border-[#B6CFD6]/10 shrink-0 shadow-lg flex flex-wrap justify-between items-center gap-3">
          <div>
            <h2 className="text-xl font-bold text-white serif-title">Catalog Improvement Plan</h2>
            <p className="text-xs text-slate-400 font-medium mt-1">
              A multi-year, dependency-mapped plan of quality-aligned catalog improvements. Items stay here until you select or amend them.
            </p>
          </div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#8C2232]/10 border border-[#8C2232]/30">
            <svg className="w-3.5 h-3.5 text-[#8C2232]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <span className="text-[10px] text-[#B6CFD6] font-mono tracking-wide">{plans.length} items · drag to arrange · click for detail</span>
          </div>
        </div>

        <ImprovementPlanFlow
          plans={plans}
          currentYear={currentYear}
          yearOptions={yearOptions}
          canEdit={canEdit}
          onPatch={handlePatch}
          onExplain={handleExplain}
          onDelete={handleDelete}
          onDeleteYear={handleDeleteYear}
          onAddManual={() => setShowManual(true)}
        />
      </div>

      {showManual && (
        <ManualAddModal
          yearOptions={yearOptions}
          currentYear={currentYear}
          catalogId={catalogId}
          onClose={() => setShowManual(false)}
          onSaved={(plan) => { setPlans(prev => [plan, ...prev]); setShowManual(false); }}
        />
      )}
    </div>
  );
}

interface ManualAddModalProps {
  yearOptions: string[];
  currentYear: string;
  catalogId?: string;
  onClose: () => void;
  onSaved: (plan: PlanItem) => void;
}

/** Modal for manually adding an improvement item to the plan. */
function ManualAddModal({ yearOptions, currentYear, catalogId, onClose, onSaved }: ManualAddModalProps) {
  const [form, setForm] = useState({
    title: '', description: '', criterion_code: '', category: 'Policy',
    status: 'planned', target_year: currentYear,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/improvement-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', initiative: { ...form, catalog_id: catalogId, plan_state: 'selected_current' } }),
      });
      if (res.ok) { const data = await res.json(); onSaved(data.plan); }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0b0f1d] border border-[#B6CFD6]/20 rounded-xl w-full max-w-lg p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-white mb-4 serif-title">Add Improvement Item</h3>
        <div className="space-y-4 text-sm">
          <div>
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Title</label>
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#8C2232]" placeholder="e.g. Standardize course description headers" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Description</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#8C2232] h-20" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Criterion</label>
              <input value={form.criterion_code} onChange={e => setForm({ ...form, criterion_code: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#8C2232]" placeholder="e.g. 2.A" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Target Year</label>
              <select value={form.target_year} onChange={e => setForm({ ...form, target_year: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#8C2232]">
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Category</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#8C2232]">
                {['Formatting', 'Organizational', 'Policy', 'Accessibility', 'Assessment'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-[#8C2232]">
                <option value="planned">Planned</option>
                <option value="in_progress">In Progress</option>
              </select>
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white transition-colors">Cancel</button>
          <button onClick={submit} disabled={saving || !form.title.trim()}
            className="px-4 py-2 bg-[#8C2232] hover:bg-[#65121e] disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-all shadow-md">
            {saving ? 'Saving…' : 'Add to Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
