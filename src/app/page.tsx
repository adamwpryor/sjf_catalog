'use client';

import React, { useState, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';
import { INSTITUTION } from '@/lib/brand';
import LandingPage from '@/components/LandingPage';
import DiagnosticsDashboard from '@/components/DiagnosticsDashboard';
import DataInspector from '@/components/DataInspector';
import GraphViewer from '@/components/GraphViewer';
import TrackingDashboard from '@/components/TrackingDashboard';
import CatalogAssistantChat from '@/components/CatalogAssistantChat';
import AstExplorer from '@/components/AstExplorer';
import ImprovementPlan from '@/components/ImprovementPlan';
import DiffLog from '@/components/DiffLog';
import CatalogProductionWizard from '@/components/CatalogProductionWizard';
import IntakeFilingSystem from '@/components/IntakeFilingSystem';
import CatalogPdfView from '@/components/CatalogPdfView';

/**
 * Main dashboard page component.
 *
 * @returns {JSX.Element} The rendered dashboard.
 */
export default function DashboardPage() {
  const [user, setUser] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [catalogId, setCatalogId] = useState<string>('');
  const [catalogs, setCatalogs] = useState<any[]>([]);
  const [expandedSections, setExpandedSections] = useState<string[]>(['overview']);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadCatalogs = async () => {
    try {
      const res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_catalogs' })
      });
      if (res.ok) {
        const data = await res.json();
        setCatalogs(data);
        // Intentionally do NOT auto-select a catalog. Silently defaulting to the
        // newest one previously pointed the Production Wizard at an unexpected
        // source (e.g. a stale draft), producing the wrong target year and
        // "Source catalog not found" errors. Requiring an explicit pick also
        // keeps the door open for selecting among multiple drafts to compare.
        // If the currently selected catalog no longer exists, clear the stale id.
        if (catalogId && !data.some((c: any) => c.id === catalogId)) {
          setCatalogId('');
        }
      }
    } catch (err) {
      console.error("DashboardPage: Network or unexpected error loading catalogs:", err);
    }
  };

  const handleDeleteCatalog = async () => {
    if (!catalogId) return;
    const catalog = catalogs.find(c => c.id === catalogId);
    if (!catalog) return;
    
    // Safety check: Prevent deleting non-draft catalogs
    if (!(catalog.version + (catalog.domain_id || '')).toLowerCase().includes('draft')) {
      alert("Error: You can only delete Draft catalogs. Published or Active catalogs are protected.");
      return;
    }

    if (!confirm(`Are you absolutely sure you want to permanently delete the catalog: ${catalog.version} (${catalog.domain_id})?\n\nThis will cascade and delete ALL related courses, programs, policies, and graphs. This action cannot be undone.`)) {
      return;
    }

    setIsDuplicating(true); // Re-use loading state to prevent rapid clicks
    try {
      const res = await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_catalog', catalogId })
      });
      if (res.ok) {
        alert("Catalog successfully deleted.");
        
        // Refresh catalogs, and explicitly set the newly loaded newest catalog
        const catalogsRes = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_catalogs' })
        });
        if (catalogsRes.ok) {
          const freshData = await catalogsRes.json();
          setCatalogs(freshData);
          // The catalog that was active just got deleted. Clear the selection
          // and require an explicit re-pick rather than silently jumping to the
          // newest remaining catalog (which may be an unrelated draft).
          setCatalogId('');
        }
        
        setActiveTab('overview');
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete catalog.");
      }
    } catch (err) {
      console.error(err);
      alert("Network error occurred while trying to delete catalog.");
    } finally {
      setIsDuplicating(false);
    }
  };

  // Fetch catalogs dynamically on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      setSidebarOpen(true);
    }
    loadCatalogs();
    const fetchUser = async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (session?.user) {
        const supabaseUser = session.user;
        const { data: roleData } = await supabase.from('user_roles').select('role').eq('user_id', supabaseUser.id).single();
        
        setUser({
          name: supabaseUser.email?.split('@')[0] || 'User',
          email: supabaseUser.email,
          role: roleData?.role || 'viewer',
        });
      } else {
        window.location.href = '/login';
      }
    };
    fetchUser();
  }, []);

  // Auto-expand relevant sidebar section based on active tab
  useEffect(() => {
    const tabToSectionMap: Record<string, string> = {
      overview: 'overview',
      diagnostics: 'overview',
      assistant: 'overview',
      filing_cabinet: 'overview',
      ast_explorer: 'visuals',
      graph: 'visuals',
      policy_graph: 'visuals',
      courses: 'data',
      programs: 'data',
      policies: 'data',
      diff_log: 'tools',
      tracking: 'tools',
      produce: 'tools',
      catalog_pdf: 'tools',
      improvement: 'tools'
    };
    const section = tabToSectionMap[activeTab];
    if (section) {
      setExpandedSections([section]);
    }
  }, [activeTab]);

  const handleWizardComplete = async (newCatalogId: string) => {
    await loadCatalogs();
    setCatalogId(newCatalogId);
    setActiveTab('overview');
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev =>
      prev.includes(section) ? prev.filter(s => s !== section) : [...prev, section]
    );
  };

  /**
   * Tab button component for navigation.
   *
   * @param {Object} props - The component props.
   * @param {string} props.id - The tab identifier.
   * @param {string} props.label - The display label.
   * @param {React.ReactNode} props.icon - The icon element.
   * @returns {JSX.Element} The rendered tab button.
   */
  const TabButton = ({ id, label, icon }: { id: string; label: string; icon: React.ReactNode }) => {
    const isActive = activeTab === id;
    return (
      <button
        onClick={() => {
          setActiveTab(id);
          // On mobile the sidebar is an overlay drawer; close it after a
          // selection so it doesn't sit on top of the content the user picked.
          if (typeof window !== 'undefined' && window.innerWidth < 768) {
            setSidebarOpen(false);
          }
        }}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-semibold tracking-wide transition-all text-left cursor-pointer ${
          isActive
            ? 'bg-[#8C2232] text-white shadow-lg shadow-[#8C2232]/10 border-l-4 border-[#B6CFD6]'
            : 'text-slate-300 hover:bg-white/5 hover:text-white'
        }`}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#050811] text-slate-100 font-sans">
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden transition-opacity" 
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* SIDEBAR NAVIGATION PANEL */}
      <aside
        // When collapsed the panel is off-canvas (mobile) or zero-width (desktop)
        // but its links stay in the DOM; `inert` removes them from the tab order
        // and the accessibility tree so keyboard/screen-reader users don't land
        // on hidden controls.
        inert={!sidebarOpen}
        aria-hidden={!sidebarOpen}
        className={`${sidebarOpen ? 'translate-x-0 w-64' : '-translate-x-full w-64 md:translate-x-0 md:w-0'} fixed md:relative inset-y-0 left-0 z-50 md:z-10 h-full shrink-0 flex flex-col bg-[#0b0f1d] border-r border-[#B6CFD6]/10 overflow-hidden transition-all duration-300 ease-in-out`}
      >
        {/* Institutional Branding Header */}
        <div className="p-6 border-b border-[#B6CFD6]/10 flex flex-col gap-1 bg-[#090d16]">
          <div className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono">
            Catalog Tool
          </div>
          <h2 className="text-lg font-bold serif-title text-white tracking-tight">
            {INSTITUTION.shortName}
          </h2>
          <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#808285]">
            {INSTITUTION.legalName}
          </div>
        </div>

        {/* Dynamic Sidebar Links */}
        <nav className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Overview Section */}
          <div className="border border-white/5 rounded-xl bg-white/5 overflow-hidden">
            <button
              onClick={() => toggleSection('overview')}
              className="w-full flex justify-between items-center px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <h3 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono flex items-center gap-1.5">
                <span>📁</span> Overview
              </h3>
              <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${expandedSections.includes('overview') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {expandedSections.includes('overview') && (
              <div className="p-2 space-y-1 bg-black/10">
                <TabButton id="overview" label="Welcome" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>} />
                <TabButton id="diagnostics" label="Metrics" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} />
                <TabButton id="assistant" label="AI Catalog Assistant" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>} />
                <TabButton id="filing_cabinet" label="Intake Filing Cabinet" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>} />
              </div>
            )}
          </div>

          {/* Visuals Section */}
          <div className="border border-white/5 rounded-xl bg-white/5 overflow-hidden">
            <button
              onClick={() => toggleSection('visuals')}
              className="w-full flex justify-between items-center px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <h3 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono flex items-center gap-1.5">
                <span>🎨</span> Visuals
              </h3>
              <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${expandedSections.includes('visuals') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {expandedSections.includes('visuals') && (
              <div className="p-2 space-y-1 bg-black/10">
                <TabButton id="ast_explorer" label="Program Diagrams" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>} />
                <TabButton id="graph" label="Course Graph" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>} />
                <TabButton id="policy_graph" label="Policy Graph" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>} />
              </div>
            )}
          </div>

          {/* Data Libraries */}
          {user && user.role !== 'viewer' && (
          <div className="border border-white/5 rounded-xl bg-white/5 overflow-hidden">
            <button
              onClick={() => toggleSection('data')}
              className="w-full flex justify-between items-center px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <h3 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono flex items-center gap-1.5">
                <span>📖</span> Data Libraries
              </h3>
              <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${expandedSections.includes('data') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {expandedSections.includes('data') && (
              <div className="p-2 space-y-1 bg-black/10">
                <TabButton id="courses" label="Course Library" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>} />
                <TabButton id="programs" label="Program Library" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>} />
                <TabButton id="policies" label="Policy Library" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>} />
              </div>
            )}
          </div>
          )}

          {/* Catalog Tools */}
          {user && user.role !== 'viewer' && (
          <div className="border border-white/5 rounded-xl bg-white/5 overflow-hidden">
            <button
              onClick={() => toggleSection('tools')}
              className="w-full flex justify-between items-center px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <h3 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest font-mono flex items-center gap-1.5">
                <span>⚙️</span> Catalog Tools
              </h3>
              <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${expandedSections.includes('tools') ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {expandedSections.includes('tools') && (
              <div className="p-2 space-y-1 bg-black/10">
                <TabButton id="diff_log" label="Diff Log" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>} />
                <TabButton id="produce" label="Catalog Production" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>} />
                <TabButton id="tracking" label="New Catalog Builder" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>} />
                <TabButton id="catalog_pdf" label="Catalog PDF" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>} />
                <TabButton id="improvement" label="Catalog Improvement Plan" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>} />
              </div>
            )}
          </div>
          )}
        </nav>

        {/* User Session Info Footer */}
        <div className="p-4 border-t border-[#B6CFD6]/10 flex flex-col gap-3 bg-[#090d16]">
          {user && (
            <div className="flex items-center justify-between text-xs text-slate-400">
              <div className="flex flex-col truncate pr-2">
                <span className="font-bold text-white truncate">{user.name}</span>
                <span className="text-[10px] text-slate-500 font-mono truncate">{user.email}</span>
              </div>
              <span className="px-2 py-0.5 rounded bg-[#8C2232]/25 text-[#B6CFD6] font-bold text-[9px] uppercase tracking-wider border border-[#8C2232]/45 font-mono">
                {user.role || 'Tester'}
              </span>
            </div>
          )}
          <button
            onClick={async () => {
              const supabase = createClient();
              await supabase.auth.signOut();
              window.location.href = '/login';
            }}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold bg-white/5 border border-white/10 hover:bg-[#8C2232]/25 hover:border-[#8C2232]/45 hover:text-white transition-all cursor-pointer font-mono"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>Disconnect</span>
          </button>
        </div>
      </aside>

      {/* MAIN VIEWPORT CANVAS */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Global Toolbar Header */}
        <header className="h-16 shrink-0 flex justify-between items-center px-4 md:px-8 border-b border-[#B6CFD6]/10 bg-[#0b0f1d] relative z-20">
          {/* Sidebar Collapse Toggle */}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="p-1.5 -ml-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-all cursor-pointer"
            title={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
            aria-label={sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/* Database Selector Dropdown */}
          <div className="flex items-center gap-2 md:gap-3">
            <label className="hidden md:block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Active Catalog Version:</label>
            <select
              value={catalogId}
              onChange={(e) => setCatalogId(e.target.value)}
              className="bg-[#090d16] border border-[#B6CFD6]/20 rounded-lg px-2 py-1.5 md:px-3 md:py-1.5 text-xs text-white outline-none focus:border-[#8C2232] transition-colors font-semibold max-w-[150px] sm:max-w-xs truncate"
              disabled={isDuplicating}
            >
              <option value="" disabled>
                Select a catalog…
              </option>
              {catalogs.map(cat => (
                <option key={cat.id} value={cat.id}>
                  Catalog {cat.version} ({cat.domain_id})
                </option>
              ))}
            </select>
            
            {/* Delete Catalog Button */}
            {user && user.role !== 'viewer' && catalogId && catalogs.find(c => c.id === catalogId && (c.version + (c.domain_id || '')).toLowerCase().includes('draft')) && (
              <button
                onClick={handleDeleteCatalog}
                disabled={isDuplicating}
                className="p-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg transition-all cursor-pointer group relative"
                title="Permanently Delete Draft Catalog"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            )}
          </div>
        </header>

        <main className={`flex-1 ${
          activeTab === 'graph' || activeTab === 'policy_graph' || activeTab === 'ast_explorer' || activeTab === 'catalog_pdf' ? 'overflow-hidden' : 'overflow-y-auto'
        } p-6 md:p-8 bg-[#090d16] relative z-0`}>
          <div className="animate-in fade-in duration-300 slide-in-from-bottom-2 h-full">
            {activeTab === 'overview' && (
              <LandingPage onTabChange={setActiveTab} catalogId={catalogId} />
            )}

            {activeTab === 'filing_cabinet' && (
              <IntakeFilingSystem />
            )}

            {activeTab === 'diagnostics' && (
              <DiagnosticsDashboard catalogId={catalogId} />
            )}

            {activeTab === 'courses' && (
              <DataInspector catalogId={catalogId} initialView="courses" />
            )}

            {activeTab === 'programs' && (
              <DataInspector catalogId={catalogId} initialView="programs" />
            )}

            {activeTab === 'policies' && (
              <DataInspector catalogId={catalogId} initialView="policies" />
            )}

            {activeTab === 'graph' && (
              <div className="space-y-4 h-full flex flex-col">
                <div className="bg-[#0b0f1d] p-4 rounded-xl border border-[#B6CFD6]/10 shrink-0">
                  <h2 className="text-lg font-bold text-white serif-title">Institutional Prerequisite Graph</h2>
                  <p className="text-xs text-slate-400 font-medium">Explore required courses and curriculum pathways for {INSTITUTION.legalName}.</p>
                </div>
                <div className="flex-1 bg-[#0b0f1d] rounded-xl border border-[#B6CFD6]/10 overflow-hidden relative">
                  <GraphViewer catalogId={catalogId} mode="curriculum" />
                </div>
              </div>
            )}

            {activeTab === 'policy_graph' && (
              <div className="space-y-4 h-full flex flex-col">
                <div className="bg-[#0b0f1d] p-4 rounded-xl border border-[#B6CFD6]/10 shrink-0">
                  <h2 className="text-lg font-bold text-white serif-title">Institutional Policy Graph</h2>
                  <p className="text-xs text-slate-400 font-medium">Explore narrative policies, deontic rules, and semantic chunk relationships for {INSTITUTION.legalName}.</p>
                </div>
                <div className="flex-1 bg-[#0b0f1d] rounded-xl border border-[#B6CFD6]/10 overflow-hidden relative">
                  <GraphViewer catalogId={catalogId} mode="policy" />
                </div>
              </div>
            )}

            {activeTab === 'ast_explorer' && (
              <AstExplorer catalogId={catalogId} />
            )}

            {activeTab === 'improvement' && (
              <ImprovementPlan catalogId={catalogId} catalogs={catalogs} canEdit={!!user && user.role !== 'viewer'} />
            )}

            {activeTab === 'tracking' && (
              <TrackingDashboard catalogId={catalogId} catalogs={catalogs} />
            )}

            {activeTab === 'diff_log' && (
              <DiffLog catalogs={catalogs} activeCatalogId={catalogId} />
            )}

            {activeTab === 'catalog_pdf' && (
              <CatalogPdfView catalogId={catalogId} catalogs={catalogs} />
            )}

            {activeTab === 'produce' && (
              <CatalogProductionWizard
                sourceCatalogId={catalogId} 
                sourceCatalogVersion={catalogs.find(c => c.id === catalogId)?.version || ''}
                onComplete={handleWizardComplete}
                onDraftCreated={loadCatalogs}
                isDraft={!!catalogs.find(c => c.id === catalogId && (c.version + (c.domain_id || '')).toLowerCase().includes('draft'))}
              />
            )}

            {activeTab === 'assistant' && (
              <CatalogAssistantChat catalogId={catalogId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
