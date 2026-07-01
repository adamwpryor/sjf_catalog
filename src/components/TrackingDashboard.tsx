'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface TrackingDashboardProps {
  catalogId: string;
  catalogs?: any[];
}

/**
 * Renders the Tracking Dashboard component.
 *
 * @param {TrackingDashboardProps} props - The component props.
 * @param {string} props.catalogId - The ID of the catalog.
 * @param {any[]} [props.catalogs] - The list of catalogs.
 * @returns {JSX.Element} The rendered Tracking Dashboard component.
 */
export default function TrackingDashboard({ catalogId, catalogs }: TrackingDashboardProps) {
  const [user, setUser] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const isAdmin = ['admin', 'owner', 'registrar'].includes(user?.role);

  const [corrections, setCorrections] = useState<any[]>([]);
  const [selectedCorrection, setSelectedCorrection] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recentlyUploadedData, setRecentlyUploadedData] = useState<{name: string, url: string, rawText: string, aiPrompt: string} | null>(null);
  const [showViewerModal, setShowViewerModal] = useState(false);
  
  // Intake file selection
  const [intakeFiles, setIntakeFiles] = useState<any[]>([]);
  const [selectedIntakeFile, setSelectedIntakeFile] = useState<string>('');
  
  // Natural Language AI Manual Entry State
  const [messages, setMessages] = useState<{role: string, content: string}[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [analyzingNl, setAnalyzingNl] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState<string | null>(null);

  const [manualForm, setManualForm] = useState({
    target_table: 'courses',
    target_row_id: '',
    field_name: '',
    current_value: '',
    proposed_value: '',
    reason: ''
  });
  const [submittingManual, setSubmittingManual] = useState(false);

  const API_BASE_URL = process.env.NEXT_PUBLIC_SWARM_API_URL || 'http://localhost:8080';

  const currentCatalog = catalogs?.find(c => c.id === catalogId);
  const isDraftCatalog = currentCatalog?.version?.toLowerCase().includes('draft') || false;

  // Data-quality remediation (auto-fix mechanical findings; queue judgment for review).
  const [remediation, setRemediation] = useState<any | null>(null);
  const [remediating, setRemediating] = useState(false);

  const handleRemediate = async (mode: 'preview' | 'apply') => {
    setRemediating(true);
    try {
      const res = await fetch('/api/catalog/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId, mode }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Remediation failed.'); return; }
      if (mode === 'preview') {
        setRemediation(data);
      } else {
        alert(`Applied ${data.appliedMechanical} mechanical fix(es); filed ${data.filedJudgment} item(s) for registrar review.`);
        setRemediation(null);
        loadCorrections();
      }
    } catch {
      alert('Network error during remediation.');
    } finally {
      setRemediating(false);
    }
  };

  useEffect(() => {
    loadCorrections();
    
    /**
     * Fetches the current user and their role.
     *
     * @returns {Promise<void>}
     */
    const fetchUser = async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const { data: roleData } = await supabase.from('user_roles').select('role').eq('user_id', session.user.id).single();
        setUser({ role: roleData?.role || 'viewer' });
      }
    };
    fetchUser();
  }, [statusFilter, catalogId]);

  /**
   * Loads the corrections based on the status filter.
   *
   * @returns {Promise<void>} A promise that resolves when corrections are loaded.
   */
  async function loadCorrections() {
    try {
      setLoading(true);
      const url = statusFilter === 'all' ? '/api/corrections' : `/api/corrections?status=${statusFilter}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setCorrections(data);
        if (data.length > 0) {
          setSelectedCorrection(data[0]);
        } else {
          setSelectedCorrection(null);
        }
      }
    } catch (err) {
      console.error("Failed to load corrections log: ", err);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Handles updating the status of a review.
   *
   * @param {'approved' | 'applied' | 'rejected'} status - The new status.
   * @returns {Promise<void>}
   */
  const handleReviewStatus = async (status: 'approved' | 'applied' | 'rejected') => {
    if (!selectedCorrection) return;
    setSubmittingReview(true);

    try {
      const res = await fetch('/api/corrections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selectedCorrection.id,
          status
        })
      });

      if (res.ok) {
        alert(`Correction successfully marked as ${status}.`);
        loadCorrections();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to update correction status.');
      }
    } catch (err) {
      console.error(err);
      alert('A network error occurred.');
    } finally {
      setSubmittingReview(false);
    }
  };

  /**
   * Fetches available files from the intake folder.
   */
  const loadIntakeFiles = async () => {
    try {
      const res = await fetch('/api/intake-files');
      if (res.ok) {
        const { data } = await res.json();
        // Flatten files from the structure for easy selection
        const files: any[] = [];
        const extractFiles = (nodes: any[]) => {
          for (const node of nodes) {
            if (node.type === 'file') files.push(node);
            else if (node.type === 'folder' && node.children) extractFiles(node.children);
          }
        };
        extractFiles(data);
        setIntakeFiles(files);
        if (files.length > 0) setSelectedIntakeFile(files[0].id);
      }
    } catch (err) {
      console.error("Failed to load intake files", err);
    }
  };

  useEffect(() => {
    if (showUploadPanel) {
      loadIntakeFiles();
    }
  }, [showUploadPanel]);

  /**
   * Handles the extraction of a selected file from the intake folder.
   */
  const handleFileExtract = async () => {
    if (!selectedIntakeFile) return;
    setUploading(true);
    
    try {
      const res = await fetch('/api/extract-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: selectedIntakeFile, catalogId })
      });

      if (res.ok) {
        const data = await res.json();
        setShowUploadPanel(false);
        setRecentlyUploadedData({ 
          name: selectedIntakeFile.split('/').pop() || selectedIntakeFile, 
          url: data.filePath || '',
          rawText: data.rawText || "No text extracted.",
          aiPrompt: data.aiPrompt || "No prompt available."
        });
        alert('File successfully extracted. New semantic instructions have been appended to the Delta Log as PENDING.');
        loadCorrections(); // Refresh the list
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to process file.');
      }
    } catch (err) {
      console.error(err);
      alert('A network error occurred while extracting.');
    } finally {
      setUploading(false);
    }
  };

  /**
   * Pings the FastAPI backend to parse the natural language instruction.
   */
  const handleAnalyzeInstruction = async () => {
    if (!currentInput.trim()) return;
    
    const newUserMessage = { role: 'user', content: currentInput };
    const updatedMessages = [...messages, newUserMessage];
    
    setMessages(updatedMessages);
    setCurrentInput('');
    setAnalyzingNl(true);
    setMarkdownPreview(null);
    
    try {
      const res = await fetch(`${API_BASE_URL}/api/agent/manual-entry-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updatedMessages,
          catalogId: catalogId
        })
      });

      if (res.ok) {
        const data = await res.json();
        
        // Add agent response to chat
        setMessages(prev => [...prev, { role: 'assistant', content: data.markdown_preview }]);
        
        if (data.parsed) {
          setManualForm({
            target_table: data.parsed.target_table,
            target_row_id: data.parsed.target_row_id,
            field_name: data.parsed.field_name,
            current_value: data.parsed.current_value,
            proposed_value: data.parsed.proposed_value,
            reason: 'Manual entry via AI Assistant'
          });
          setMarkdownPreview(data.markdown_preview);
        }
      } else {
        const data = await res.json().catch(() => ({}));
        const detail = data.error || `Agent server returned ${res.status}.`;
        setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ Failed to analyze instruction: ${detail}` }]);
      }
    } catch (err: any) {
      // Surface the real failure instead of fabricating a parsed result, so an
      // offline/broken agent server is visible rather than masked.
      console.error("Manual-entry assistant request failed:", err);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ Could not reach the agent server: ${err?.message || 'Network error.'}`
      }]);
    } finally {
      setAnalyzingNl(false);
    }
  };

  /**
   * Handles the submission of a manual correction.
   */
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualForm.target_table || !manualForm.target_row_id || !manualForm.field_name || !manualForm.proposed_value) {
      alert('Please fill out all required fields.');
      return;
    }

    setSubmittingManual(true);
    try {
      const res = await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...manualForm,
          current_value: manualForm.current_value || null, // Optional
        })
      });

      if (res.ok) {
        alert('Manual correction logged successfully as PENDING.');
        setShowManualForm(false);
        setManualForm({ target_table: 'courses', target_row_id: '', field_name: '', current_value: '', proposed_value: '', reason: '' });
        setMessages([]);
        setMarkdownPreview(null);
        loadCorrections();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to submit manual correction.');
      }
    } catch (err) {
      console.error(err);
      alert('A network error occurred.');
    } finally {
      setSubmittingManual(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300 font-sans h-full flex flex-col">
      {/* Dashboard Toolbar Header */}
      <div className="bg-[#0b0f1d] p-4 rounded-xl border border-[#B6CFD6]/10 flex flex-col md:flex-row justify-between items-center gap-4 shrink-0">
        <div>
          <h2 className="text-lg font-bold text-white serif-title">New Catalog Builder.</h2>
          <p className="text-xs text-slate-400 font-medium">Audit row and field level overrides submitted by testers.</p>
        </div>

        {/* Status Filters & Actions */}
        <div className="flex gap-4 items-center">
          <div className="flex gap-2 bg-[#090d16] p-1 rounded-lg border border-white/5 font-mono">
            {['pending', 'rejected', 'approved', 'applied', 'all'].map(status => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer ${
                  statusFilter === status 
                    ? 'bg-[#8C2232] text-white shadow-md' 
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
          
          <button
            onClick={() => {
              if (!isDraftCatalog) {
                alert("Write-Protection Active: You can only add corrections to a Draft catalog.");
                return;
              }
              setShowManualForm(!showManualForm);
              setShowUploadPanel(false);
            }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border flex items-center gap-2 ${
              isDraftCatalog 
                ? 'bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border-blue-500/20 cursor-pointer'
                : 'bg-slate-800/50 text-slate-500 border-slate-700/50 cursor-not-allowed opacity-60'
            }`}
            title={isDraftCatalog ? "Manual Correction Entry" : "Write-Protection Active: Must be on a Draft catalog"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            Manual Entry
          </button>
          
          <button
            onClick={() => {
              if (!isDraftCatalog) {
                alert("Write-Protection Active: You can only upload minutes to a Draft catalog.");
                return;
              }
              setShowUploadPanel(!showUploadPanel);
              setShowManualForm(false);
            }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border flex items-center gap-2 ${
              isDraftCatalog 
                ? 'bg-[#B6CFD6]/10 hover:bg-[#B6CFD6]/20 text-[#B6CFD6] border-[#B6CFD6]/20 cursor-pointer'
                : 'bg-slate-800/50 text-slate-500 border-slate-700/50 cursor-not-allowed opacity-60'
            }`}
            title={isDraftCatalog ? "Upload Committee Minutes" : "Write-Protection Active: Must be on a Draft catalog"}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            Upload Minutes
          </button>

          {isAdmin && (
            <button
              onClick={() => handleRemediate('preview')}
              disabled={remediating}
              className="px-4 py-2 rounded-lg text-xs font-bold transition-all border flex items-center gap-2 bg-amber-600/10 hover:bg-amber-600/20 text-amber-400 border-amber-500/20 cursor-pointer disabled:opacity-50"
              title="Scan this catalog for data-quality issues; auto-fix mechanical ones and queue the rest for review"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              {remediating ? 'Scanning...' : 'Data-Quality Remediation'}
            </button>
          )}

          {currentCatalog?.catalog_pdf_url && (
            <a
              href={`/api/catalog/pdf?catalogId=${catalogId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 rounded-lg text-xs font-bold transition-all border flex items-center gap-2 bg-[#8C2232]/10 hover:bg-[#8C2232]/20 text-[#d98a98] border-[#8C2232]/30 cursor-pointer"
              title="Download the published catalog-of-record PDF"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Catalog PDF
            </a>
          )}
        </div>
      </div>

      {/* Remediation preview panel */}
      {remediation && (
        <div className="bg-[#0b0f1d] border border-amber-500/30 p-4 rounded-xl space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-white">
              Data-quality remediation — {remediation.summary.mechanical} auto-fixable, {remediation.summary.judgment} for review
            </p>
            <button onClick={() => setRemediation(null)} className="text-slate-500 hover:text-white text-xs cursor-pointer">Dismiss</button>
          </div>
          {remediation.mechanical?.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-1 font-mono text-[10px] text-slate-300">
              {remediation.mechanical.map((m: any, i: number) => (
                <div key={i} className="border-l-2 border-emerald-500 pl-2">
                  <span className="text-slate-200">{m.course}</span>
                  {m.remaps?.length > 0 && <span className="text-emerald-400"> remap {m.remaps.map((r: any) => `${r.from}→${r.to}`).join(', ')}</span>}
                  <div><span className="text-red-400">- {String(m.before)}</span> <span className="text-emerald-400">+ {String(m.after)}</span></div>
                </div>
              ))}
            </div>
          )}
          {remediation.judgment?.length > 0 && (
            <div className="text-[10px] text-amber-300">
              {remediation.judgment.length} item(s) need a registrar decision (will be filed as pending corrections).
            </div>
          )}
          <button
            onClick={() => handleRemediate('apply')}
            disabled={remediating}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 cursor-pointer"
          >
            {remediating ? 'Applying...' : `Apply ${remediation.summary.mechanical} fixes & queue ${remediation.summary.judgment}`}
          </button>
        </div>
      )}

      {/* Recently Uploaded File Banner */}
      {recentlyUploadedData && (
        <div className="bg-emerald-900/20 border border-emerald-500/30 p-4 rounded-xl flex items-center justify-between shadow-lg">
          <div className="flex items-center gap-3">
            <svg className="w-6 h-6 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <div>
              <p className="text-sm font-bold text-white">Successfully Ingested: {recentlyUploadedData.name}</p>
              <p className="text-xs text-slate-400">Review the generated overrides below. Click View Source Document to verify the extraction.</p>
            </div>
          </div>
          <button
            onClick={() => setShowViewerModal(true)}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all shadow-md flex items-center gap-2 cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            View Source Document & AI Context
          </button>
        </div>
      )}

      {/* Interactive Document Viewer Modal */}
      {showViewerModal && recentlyUploadedData && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0b0f1d] border border-[#B6CFD6]/30 rounded-xl w-full max-w-5xl flex flex-col shadow-2xl h-[85vh] overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 bg-black/50 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                <div>
                  <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wide">Interactive Review</h3>
                  <p className="text-[10px] text-slate-400">{recentlyUploadedData.name}</p>
                </div>
              </div>
              <button onClick={() => setShowViewerModal(false)} className="text-slate-500 hover:text-white transition-colors cursor-pointer">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            
            <div className="flex-1 flex flex-col md:flex-row overflow-hidden divide-y md:divide-y-0 md:divide-x divide-white/10">
              {/* Left Side: Extracted Document Text */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="bg-black/30 px-4 py-2 border-b border-white/5 shrink-0 flex justify-between items-center">
                  <span className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono">Raw Extracted Text</span>
                  <a href={recentlyUploadedData.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-emerald-400 hover:underline">Download Original</a>
                </div>
                <div className="flex-1 p-6 overflow-y-auto custom-scrollbar bg-[#050811]">
                  <pre className="text-xs text-slate-300 font-sans whitespace-pre-wrap break-words leading-relaxed">
                    {recentlyUploadedData.rawText}
                  </pre>
                </div>
              </div>

              {/* Right Side: AI System Prompt */}
              <div className="flex-1 flex flex-col overflow-hidden bg-black/20">
                <div className="bg-black/30 px-4 py-2 border-b border-white/5 shrink-0">
                  <span className="text-[10px] font-bold text-amber-500/80 uppercase tracking-widest font-mono">AI Extraction Prompt</span>
                </div>
                <div className="flex-1 p-6 overflow-y-auto custom-scrollbar">
                  <p className="text-xs text-slate-400 mb-4">This is the system prompt that guided the semantic extraction. You can review it here to understand why certain overrides were or weren't generated.</p>
                  <textarea 
                    className="w-full h-full bg-black/40 border border-white/10 rounded-lg p-4 text-xs font-mono text-amber-200/80 outline-none focus:border-amber-500/50 resize-none"
                    defaultValue={recentlyUploadedData.aiPrompt}
                    readOnly
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-white/10 bg-black/50 flex justify-end gap-3 shrink-0">
              <button onClick={() => setShowViewerModal(false)} className="px-6 py-2 bg-[#8C2232] hover:bg-[#65121e] text-white rounded-lg text-xs font-bold transition-all shadow-md cursor-pointer">
                Close Review Pane
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload/Extract Panel */}
      {showUploadPanel && (
        <div className="bg-[#0b0f1d] p-6 rounded-xl border border-dashed border-[#B6CFD6]/30 flex flex-col items-center justify-center text-center gap-4 shrink-0 animate-in slide-in-from-top-4">
          <h3 className="text-sm font-bold text-white serif-title">Intake Funnel: Extract Committee Minutes</h3>
          <div className="bg-amber-900/20 border border-amber-500/30 text-amber-200/80 p-3 rounded-lg text-xs w-full max-w-lg">
            <strong>Note:</strong> Any new file you want to process must first be uploaded to the <strong>Intake Filing Cabinet</strong> in the Overview section. Direct uploads are no longer permitted here to ensure proper filing.
          </div>
          
          {intakeFiles.length === 0 ? (
            <p className="text-xs text-slate-400">No files found in the intake filing cabinet. Please upload documents there first.</p>
          ) : (
            <div className="flex gap-3 items-center w-full max-w-lg mt-2">
              <select 
                value={selectedIntakeFile}
                onChange={(e) => setSelectedIntakeFile(e.target.value)}
                className="flex-1 bg-[#090d16] border border-white/20 rounded-lg px-3 py-3 text-sm text-white outline-none focus:border-[#8C2232]"
              >
                {intakeFiles.map(f => (
                  <option key={f.id} value={f.id}>{f.id}</option>
                ))}
              </select>
              <button
                onClick={handleFileExtract}
                disabled={uploading || !selectedIntakeFile}
                className="px-6 py-3 bg-[#8C2232] hover:bg-[#65121e] text-white rounded-lg text-sm font-bold transition-all shadow-lg cursor-pointer disabled:opacity-50"
              >
                {uploading ? 'Extracting Semantics...' : 'Extract Selected'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* AI-Assisted Manual Correction Form */}
      {showManualForm && (
        <div className="bg-[#0b0f1d] p-6 rounded-xl border border-dashed border-blue-500/30 flex flex-col gap-6 shrink-0 animate-in slide-in-from-top-4 text-left">
          <div className="flex justify-between items-center border-b border-white/10 pb-4">
            <div>
              <h3 className="text-sm font-bold text-white serif-title flex items-center gap-2">
                <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                AI Manual Entry Assistant
              </h3>
              <p className="text-xs text-slate-400">Describe the change you want to make in plain English. The Swarm Agent will map it to the correct fields and generate a markdown preview.</p>
            </div>
            <button onClick={() => {
              setShowManualForm(false);
              setMarkdownPreview(null);
            }} className="text-slate-500 hover:text-white cursor-pointer">✕</button>
          </div>
          
          <div className="flex flex-col md:flex-row gap-6">
            {/* Step 1: Conversational AI Input */}
            <div className="flex-1 space-y-3 flex flex-col h-[350px]">
              <label className="block text-slate-400 font-bold mb-1 text-xs uppercase tracking-widest font-mono shrink-0">1. Chat with the Assistant</label>
              
              <div className="flex-1 bg-black/50 border border-white/10 rounded-lg p-3 overflow-y-auto custom-scrollbar flex flex-col gap-3">
                {messages.length === 0 ? (
                  <div className="text-xs text-slate-500 italic text-center my-auto">
                    Hi! Tell me what you want to change in the catalog. E.g. "Rename Life Sciences to Biology"
                  </div>
                ) : (
                  messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] p-3 rounded-xl text-xs ${
                        msg.role === 'user' 
                          ? 'bg-blue-600/30 text-blue-100 rounded-tr-sm border border-blue-500/30' 
                          : 'bg-white/5 text-slate-300 rounded-tl-sm border border-white/10'
                      }`}>
                        <div className="prose prose-invert prose-sm max-w-none">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  ))
                )}
                {analyzingNl && (
                  <div className="flex justify-start">
                    <div className="bg-white/5 border border-white/10 p-3 rounded-xl rounded-tl-sm text-xs text-slate-400 animate-pulse">
                      Thinking...
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-2 shrink-0 mt-2">
                <input 
                  type="text"
                  placeholder="Type your instruction..."
                  className="flex-1 bg-black/50 border border-white/10 rounded-lg px-4 py-2 text-white text-sm outline-none focus:border-blue-500"
                  value={currentInput}
                  onChange={(e) => setCurrentInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAnalyzeInstruction();
                  }}
                />
                <button
                  onClick={handleAnalyzeInstruction}
                  disabled={analyzingNl || !currentInput.trim()}
                  className="px-6 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 rounded-lg text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>

            {/* Step 2: Markdown Preview & Submit */}
            <div className="flex-1 flex flex-col h-[350px]">
              <label className="block text-slate-400 font-bold mb-3 text-xs uppercase tracking-widest font-mono shrink-0">2. Review & Submit</label>
              
              {!markdownPreview ? (
                <div className="flex-1 flex items-center justify-center bg-black/30 border border-white/5 rounded-lg text-slate-500 text-xs italic p-6 text-center">
                  Discuss the change with the Assistant. Once finalized, the parsed data will appear here for submission.
                </div>
              ) : (
                <div className="flex-1 flex flex-col space-y-4 overflow-hidden">
                  <div className="bg-[#050811] border border-white/10 rounded-lg p-4 flex-1 overflow-y-auto custom-scrollbar prose prose-invert prose-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownPreview}</ReactMarkdown>
                  </div>
                  
                  <details className="text-xs text-slate-400 shrink-0">
                    <summary className="cursor-pointer font-bold mb-2">View Parsed Data Fields (Advanced)</summary>
                    <div className="grid grid-cols-2 gap-2 mt-2 bg-black/40 p-3 rounded border border-white/5 font-mono">
                      <div><span className="text-slate-500">Table:</span> {manualForm.target_table}</div>
                      <div><span className="text-slate-500">Row ID:</span> {manualForm.target_row_id}</div>
                      <div><span className="text-slate-500">Field:</span> {manualForm.field_name}</div>
                    </div>
                  </details>

                  <button 
                    onClick={handleManualSubmit}
                    disabled={submittingManual}
                    className="w-full px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-bold transition-all shadow-lg cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {submittingManual ? 'Saving...' : 'Looks Good! Submit to Pending Queue'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Split Inspector View */}
      <div className="flex-1 flex gap-6 min-h-[480px] overflow-hidden">
        {/* Left Side: Corrections Log Table */}
        <div className="w-1/2 glass-panel rounded-2xl border border-white/5 overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-white/5 bg-[#0b0f1d] flex justify-between items-center shrink-0">
            <h3 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Correction Submissions</h3>
            <span className="text-[10px] text-slate-500 font-mono font-semibold">{corrections.length} logs found</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/5">
            {loading ? (
              [1, 2, 3].map(i => (
                <div key={i} className="p-5 space-y-2 animate-pulse">
                  <div className="h-4 bg-white/5 w-1/3 rounded"></div>
                  <div className="h-3 bg-white/5 w-2/3 rounded"></div>
                </div>
              ))
            ) : corrections.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs">No corrections logged in this filter.</div>
            ) : (
              corrections.map((corr, idx) => {
                const isSelected = selectedCorrection?.id === corr.id;
                const date = new Date(corr.submitted_at).toLocaleDateString();

                return (
                  <div
                    key={corr.id || idx}
                    onClick={() => setSelectedCorrection(corr)}
                    className={`p-4 cursor-pointer transition-all flex justify-between items-center text-left ${
                      isSelected 
                        ? 'bg-[#8C2232]/10 border-l-4 border-[#8C2232]' 
                        : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="space-y-1 truncate pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-white font-mono uppercase tracking-wide">
                          {corr.target_table} • {corr.field_name}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded font-bold text-[8px] uppercase tracking-wider font-mono ${
                          corr.status === 'pending'
                            ? 'bg-amber-500/10 border border-amber-500/30 text-amber-400'
                            : corr.status === 'applied' || corr.status === 'approved'
                              ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                              : 'bg-red-500/10 border border-red-500/30 text-red-400'
                        }`}>
                          {corr.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 truncate max-w-xs font-sans">
                        Proposed: "{corr.proposed_value.slice(0, 50)}"
                      </div>
                    </div>

                    <div className="shrink-0 text-right font-mono text-[9px] text-slate-500">
                      <div>{date}</div>
                      <div>{corr.submitted_by.split('@')[0]}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Before & After Diff Reviewer Board */}
        <div className="w-1/2 glass-panel rounded-2xl border border-white/5 overflow-hidden flex flex-col">
          {!selectedCorrection ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-xs p-8">
              <svg className="w-12 h-12 mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>
              <span>Please select a correction log from the sidebar to audit values and review status.</span>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden text-left">
              {/* Log Header */}
              <div className="px-6 py-4 border-b border-white/5 bg-[#0b0f1d] shrink-0">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="text-sm font-bold serif-title text-white">
                      Differential Override: {selectedCorrection.target_table} • {selectedCorrection.field_name}
                    </h4>
                    <p className="text-[10px] text-slate-400 font-semibold font-mono mt-1">
                      Submitted by {selectedCorrection.submitted_by} on {new Date(selectedCorrection.submitted_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>

              {/* Diff Details Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* 1. Comparison Diffs Columns */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Left Column: Current parsed value */}
                  <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col">
                    <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-2">Original Current Value</div>
                    <pre className="flex-1 bg-black/25 border border-white/5 rounded-lg p-3 font-mono text-xs text-red-300/90 whitespace-pre-wrap overflow-x-auto min-h-[80px]">
                      - {selectedCorrection.current_value || 'NULL'}
                    </pre>
                  </div>

                  {/* Right Column: Proposed corrected value */}
                  <div className="p-4 bg-white/5 rounded-xl border border-white/5 flex flex-col">
                    <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-2">Proposed Correction Override</div>
                    <pre className="flex-1 bg-[#8C2232]/10 border border-[#8C2232]/25 rounded-lg p-3 font-mono text-xs text-emerald-400 font-bold whitespace-pre-wrap overflow-x-auto min-h-[80px]">
                      + {selectedCorrection.proposed_value}
                    </pre>
                  </div>
                </div>

                {/* 2. Submitter Rationale */}
                <div className="space-y-2">
                  <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Submitter Justification Rationale</h5>
                  <div className="p-4 bg-white/5 rounded-xl border border-white/5 text-xs text-slate-300 font-medium leading-relaxed">
                    {selectedCorrection.reason || 'No description rationale provided.'}
                  </div>
                </div>

                {/* 3. Reviewer Logs if completed */}
                {selectedCorrection.status !== 'pending' && (
                  <div className="p-4 bg-black/20 border border-white/5 rounded-xl text-xs space-y-2 font-mono">
                    <div className="text-[9px] font-bold text-[#B6CFD6] uppercase tracking-widest">Auditing Reviews Logs</div>
                    {selectedCorrection.reviewed_at && (
                      <div className="text-slate-400">Reviewed: {new Date(selectedCorrection.reviewed_at).toLocaleString()}</div>
                    )}
                    {selectedCorrection.applied_at && (
                      <div className="text-emerald-400">Applied/Merged: {new Date(selectedCorrection.applied_at).toLocaleString()}</div>
                    )}
                  </div>
                )}

                {/* 3b. Applied diff (written to the draft during catalog production) */}
                {selectedCorrection.applied_patch?.diffs?.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Applied Changes to Draft</h5>
                    <div className="p-4 bg-black/20 border border-emerald-500/15 rounded-xl text-xs font-mono space-y-1 text-slate-300">
                      {selectedCorrection.applied_patch.diffs.map((d: any, i: number) => (
                        <div key={i}>
                          {d.kind === 'course' && d.after && Object.keys(d.after).map((c) => (
                            <div key={c}>
                              <span className="text-slate-300">{d.code}</span> <span className="text-slate-500">{c}:</span>{' '}
                              <span className="text-red-400">- {JSON.stringify(d.before?.[c])}</span>{' '}
                              <span className="text-emerald-400">+ {JSON.stringify(d.after[c])}</span>
                            </div>
                          ))}
                          {d.kind === 'program' && d.after && (
                            <div>{d.name}: {Object.keys(d.after).map((c) => `${c} → ${d.after[c]}`).join(', ')}</div>
                          )}
                          {d.kind === 'insert' && <div className="text-emerald-400">+ new course {d.code}</div>}
                          {d.kind === 'edge' && <div>{d.op === 'remove' ? '− ' : '+ '}prereq {d.prereq} {d.op === 'remove' ? 'from' : 'to'} {d.course}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 4. Administrative Control Actions */}
              {selectedCorrection.status === 'pending' && (
                <div className="p-6 border-t border-white/5 bg-[#0b0f1d] shrink-0">
                  {isAdmin ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono">Administrative Control Actions:</div>
                        {!isDraftCatalog && (
                          <div className="text-[10px] font-bold text-red-400 uppercase tracking-widest font-mono flex items-center gap-1">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                            Write-Protection Active
                          </div>
                        )}
                      </div>
                      <div className="flex gap-3">
                        <button
                          onClick={() => handleReviewStatus('approved')}
                          disabled={submittingReview || !isDraftCatalog}
                          className={`flex-1 py-2 px-4 text-white rounded-lg text-xs font-bold transition-all shadow-md ${
                            !isDraftCatalog ? 'bg-slate-700 cursor-not-allowed opacity-50' : 'bg-blue-600 hover:bg-blue-700 active:scale-[0.98] cursor-pointer'
                          }`}
                        >
                          Approve Override
                        </button>
                        <button
                          onClick={() => handleReviewStatus('applied')}
                          disabled={submittingReview || !isDraftCatalog}
                          className={`flex-1 py-2 px-4 text-white rounded-lg text-xs font-bold transition-all shadow-md ${
                            !isDraftCatalog ? 'bg-slate-700 cursor-not-allowed opacity-50' : 'bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] cursor-pointer'
                          }`}
                        >
                          Approve & Apply (Merge)
                        </button>
                        <button
                          onClick={() => handleReviewStatus('rejected')}
                          disabled={submittingReview || !isDraftCatalog}
                          className={`flex-1 py-2 px-4 text-white rounded-lg text-xs font-bold transition-all shadow-md ${
                            !isDraftCatalog ? 'bg-slate-700 cursor-not-allowed opacity-50' : 'bg-[#8C2232] hover:bg-[#65121e] active:scale-[0.98] cursor-pointer'
                          }`}
                        >
                          Reject Change
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 py-3 rounded-lg bg-white/5 border border-white/5 text-center text-xs text-slate-500 font-semibold flex items-center justify-center gap-2">
                      🔒 Corrections review and merge triggers are locked to Administrative Roles only.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
