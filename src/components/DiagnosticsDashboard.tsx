'use client';

import React, { useState, useEffect } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';

interface DiagnosticsProps {
  catalogId: string;
}

const COLORS = ['#993333', '#FFCC33', '#f57f17', '#e65100', '#7d1218', '#E6B800', '#0f2c52', '#0f766e'];

/**
 * Renders the diagnostics dashboard.
 *
 * @param {DiagnosticsProps} props - The component properties.
 * @returns {JSX.Element} The diagnostics dashboard component.
 */
export default function DiagnosticsDashboard({ catalogId }: DiagnosticsProps) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showGhostNodesModal, setShowGhostNodesModal] = useState(false);
  // Each total is number when loaded, or null when its source endpoint failed
  // (rendered as "—"), so one broken endpoint never blanks the whole panel.
  const [totals, setTotals] = useState<{
    courses: number | null;
    programs: number | null;
    chunks: number | null;
    subjects: number | null;
    // Breakdown of get_programs by program_type so the tile headlines genuine degree
    // programs (majors) rather than a total inflated by minors/certificates.
    programsByType: { major: number; minor: number; certificate: number; concentration: number } | null;
  }>({
    courses: null,
    programs: null,
    chunks: null,
    subjects: null,
    programsByType: null
  });
  const [totalsLoading, setTotalsLoading] = useState(true);

  useEffect(() => {
    if (!catalogId) return;

    async function loadDiagnostics() {
      try {
        setLoading(true);
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_diagnostics', catalogId })
        });
        if (res.ok) {
          const diagnostics = await res.json();
          setData(diagnostics);
        }
      } catch (err) {
        console.error("Failed to load diagnostics: ", err);
      } finally {
        setLoading(false);
      }
    }

    async function loadTotals() {
      setTotalsLoading(true);

      // Fetch one totals action, returning its rows or null on any failure. Each
      // metric resolves independently, so a single failing endpoint (e.g. a schema
      // drift in get_programs) never zeroes out the metrics that did load.
      const fetchAction = async (action: string): Promise<any[] | null> => {
        try {
          const res = await fetch('/api/db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, catalogId })
          });
          if (!res.ok) {
            console.error(`Totals: '${action}' returned HTTP ${res.status}`);
            return null;
          }
          return await res.json();
        } catch (err) {
          console.error(`Totals: '${action}' request failed:`, err);
          return null;
        }
      };

      const [coursesData, progsData, chunksData] = await Promise.all([
        fetchAction('get_courses'),
        fetchAction('get_programs'),
        fetchAction('get_semantic_chunks')
      ]);

      // Tally programs by program_type (falling back to 'major' for rows the API left
      // unclassified), so the tile can distinguish degree programs from minors/certs.
      const tallyTypes = (progs: any[] | null) => {
        if (!progs) return null;
        const t = { major: 0, minor: 0, certificate: 0, concentration: 0 };
        for (const p of progs) {
          const k = p.program_type as keyof typeof t;
          if (k && k in t) t[k] += 1; else t.major += 1;
        }
        return t;
      };

      // courses and subjects both derive from get_courses, so they share its fate.
      setTotals({
        courses: coursesData ? coursesData.length : null,
        programs: progsData ? progsData.length : null,
        chunks: chunksData ? chunksData.length : null,
        subjects: coursesData
          ? new Set(coursesData.map((c: any) => c.subject_prefix).filter(Boolean)).size
          : null,
        programsByType: tallyTypes(progsData)
      });

      setTotalsLoading(false);
    }

    loadDiagnostics();
    loadTotals();
  }, [catalogId]);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-16 bg-white/5 rounded-xl border border-white/5"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="h-80 bg-white/5 rounded-2xl border border-white/5"></div>
          <div className="h-80 bg-white/5 rounded-2xl border border-white/5"></div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-8 text-center text-slate-400 glass-panel rounded-2xl border border-white/5">
        No diagnostics metrics available for the selected catalog.
      </div>
    );
  }

  const { creditDistribution, subjectDistribution, ghostNodesCount, ghostNodes } = data;

  // Headline the degree-program (major) count; summarize the non-degree offerings beneath.
  const bt = totals.programsByType;
  const programHeadline = bt ? bt.major : totals.programs;
  const programSubtitle = (() => {
    if (!bt) return 'Degree Curriculums';
    const parts: string[] = [];
    if (bt.minor) parts.push(`${bt.minor} minor${bt.minor !== 1 ? 's' : ''}`);
    if (bt.concentration) parts.push(`${bt.concentration} conc.`);
    if (bt.certificate) parts.push(`${bt.certificate} cert${bt.certificate !== 1 ? 's' : ''}`);
    return parts.length ? `+ ${parts.join(' · ')}` : 'Degree Curriculums';
  })();

  return (
    <div className="space-y-6 animate-in fade-in duration-300 font-sans">
      {/* Title Bar */}
      <div className="bg-[#521a1a] p-4 rounded-xl border border-[#FFCC33]/10 flex flex-col items-start gap-3 md:flex-row md:justify-between md:items-center">
        <div>
          <h2 className="text-xl font-bold text-white serif-title">Metrics</h2>
          <p className="text-xs text-slate-400 font-medium">A friendly overview of your academic catalog's data, helping you track total courses, subject counts, and visual connections.</p>
        </div>
        
        {/* Total Ghost Nodes Alert Indicator */}
        <button
          onClick={() => { if (ghostNodesCount > 0) setShowGhostNodesModal(true); }}
          disabled={ghostNodesCount === 0}
          className={`shrink-0 px-4 py-2 rounded-lg border font-mono flex items-center gap-2 text-xs font-bold transition-all ${
            ghostNodesCount > 0 
              ? 'bg-amber-500/10 border-amber-500/35 text-amber-300 hover:bg-amber-500/20 active:scale-[0.98] cursor-pointer animate-pulse' 
              : 'bg-emerald-500/10 border-emerald-500/35 text-emerald-300 opacity-80 cursor-default'
          }`}
          title={ghostNodesCount > 0 ? "Click to view missing course details" : "All references exist in database"}
        >
          <span className="w-2 h-2 rounded-full bg-current"></span>
          <span>{ghostNodesCount} Curriculum Ghost Nodes Flagged</span>
        </button>
      </div>

      {/* Catalog Totals Grid */}
      <div className="glass-panel rounded-2xl p-6 border border-white/5 bg-[#521a1a]/30">
        <h3 className="text-sm font-bold text-white serif-title mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#FFCC33]"></span>
          Catalog Totals
        </h3>

        {totalsLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-20 bg-white/5 rounded-xl border border-white/5"></div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Metric 1 */}
            <div className="p-4 rounded-xl bg-white/5 border border-white/5 relative overflow-hidden">
              <div className="text-[10px] font-bold text-[#FFCC33] uppercase tracking-wider font-mono mb-1">Total Courses</div>
              <div className="text-2xl font-extrabold text-white serif-title">{totals.courses ?? '—'}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">Master Catalog Rows</div>
            </div>

            {/* Metric 2 */}
            <div className="p-4 rounded-xl bg-white/5 border border-white/5 relative overflow-hidden">
              <div className="text-[10px] font-bold text-[#FFCC33] uppercase tracking-wider font-mono mb-1">Degree Programs</div>
              <div className="text-2xl font-extrabold text-white serif-title">{programHeadline ?? '—'}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">{programSubtitle}</div>
            </div>

            {/* Metric 3 */}
            <div className="p-4 rounded-xl bg-white/5 border border-white/5 relative overflow-hidden">
              <div className="text-[10px] font-bold text-[#FFCC33] uppercase tracking-wider font-mono mb-1">Subject Areas</div>
              <div className="text-2xl font-extrabold text-white serif-title">{totals.subjects ?? '—'}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">Academic Disciplines</div>
            </div>

            {/* Metric 4 */}
            <div className="p-4 rounded-xl bg-white/5 border border-white/5 relative overflow-hidden">
              <div className="text-[10px] font-bold text-[#FFCC33] uppercase tracking-wider font-mono mb-1">Semantic Chunks</div>
              <div className="text-2xl font-extrabold text-white serif-title">{totals.chunks ?? '—'}</div>
              <div className="text-[10px] text-slate-500 mt-1 font-mono">Parsed PDF Blobs</div>
            </div>
          </div>
        )}
      </div>

      {/* Recharts Graphical Visuals */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Chart 1: Credit Hour Distribution */}
        <div className="glass-panel rounded-2xl p-6 border border-white/5 flex flex-col">
          <h3 className="text-sm font-bold text-white serif-title mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#993333]"></span>
            Course Credit Hour Distribution
          </h3>
          <div className="flex-1 min-h-[280px] w-full text-xs font-mono">
            {creditDistribution.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500">No credits data.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={creditDistribution}>
                  <XAxis dataKey="credits" stroke="#808285" fontSize={10} tickLine={false} />
                  <YAxis stroke="#808285" fontSize={10} tickLine={false} />
                  <Tooltip 
                    contentStyle={{ background: '#521a1a', border: '1px solid rgba(182, 207, 214, 0.15)', borderRadius: '8px' }}
                    labelStyle={{ color: '#FFCC33', fontWeight: 'bold' }}
                    itemStyle={{ color: '#fff' }}
                  />
                  <Bar dataKey="count" fill="#993333" radius={[4, 4, 0, 0]} maxBarSize={45} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Chart 2: Course Counts */}
        <div className="glass-panel rounded-2xl p-6 border border-white/5 flex flex-col">
          <h3 className="text-sm font-bold text-white serif-title mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#FFCC33]"></span>
            Course Counts
          </h3>
          <div className="flex-1 max-h-[300px] overflow-y-auto custom-scrollbar pr-2 text-xs font-mono">
            {subjectDistribution.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500">No subjects data.</div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(280, subjectDistribution.length * 30)}>
                <BarChart data={subjectDistribution} layout="vertical" margin={{ left: 5, right: 20, top: 5, bottom: 5 }}>
                  <XAxis type="number" stroke="#808285" fontSize={10} tickLine={false} />
                  <YAxis dataKey="subject" type="category" stroke="#808285" fontSize={10} tickLine={false} width={45} />
                  <Tooltip 
                    contentStyle={{ background: '#521a1a', border: '1px solid rgba(182, 207, 214, 0.15)', borderRadius: '8px' }}
                    labelStyle={{ color: '#FFCC33', fontWeight: 'bold' }}
                    itemStyle={{ color: '#fff' }}
                  />
                  <Bar dataKey="count" fill="#FFCC33" radius={[0, 4, 4, 0]} maxBarSize={18}>
                    {subjectDistribution.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Ghost Nodes Modal */}
      {showGhostNodesModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#521a1a] border border-[#FFCC33]/30 rounded-xl w-full max-w-2xl flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-white/10 bg-black/50 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2 text-amber-400">
                <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                <h3 className="text-sm font-bold text-white uppercase tracking-wide">Curriculum Ghost Nodes</h3>
              </div>
              <button onClick={() => setShowGhostNodesModal(false)} className="text-slate-500 hover:text-white transition-colors cursor-pointer text-lg">✕</button>
            </div>
            <div className="p-6 max-h-[60vh] overflow-y-auto custom-scrollbar font-mono text-xs">
              <p className="text-xs text-slate-300 font-sans mb-4 leading-relaxed">
                A **Ghost Node** occurs when a course is referenced as a prerequisite or requirement, but its master course record is missing from the database.
              </p>
              <div className="space-y-2">
                {ghostNodes.map((node: any, idx: number) => (
                  <div key={idx} className="bg-black/15 border border-white/5 rounded-xl p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-2 hover:bg-white/5 transition-colors">
                    <div>
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1 md:hidden">Ghost Course Code</div>
                      <div className="font-bold text-amber-300 text-sm">{node.code}</div>
                      <div className="font-sans text-slate-300 mt-0.5">{node.title || 'Untitled Reference'}</div>
                    </div>
                    <div className="mt-2 md:mt-0 text-slate-500 uppercase text-[10px] font-bold tracking-wider shrink-0 bg-[#993333]/10 border border-[#993333]/30 px-2 py-1 rounded">
                      Missing Course Row
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-6 py-4 border-t border-white/10 bg-black/50 flex justify-end gap-3 shrink-0">
              <button onClick={() => setShowGhostNodesModal(false)} className="px-5 py-2 bg-[#993333] hover:bg-[#7a2929] text-white rounded-lg text-xs font-bold transition-all cursor-pointer">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
