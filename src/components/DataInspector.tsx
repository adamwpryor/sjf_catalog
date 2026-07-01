'use client';

import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ReportErrorModal from './ReportErrorModal';
import { INSTITUTION, TENANT_ID, GCS_BUCKET } from '@/lib/brand';

// Helper to compile beautiful fallback markdown for a program when GCS is private or 403s
/**
 * Helper to compile beautiful fallback markdown for a program when GCS is private or 403s.
 *
 * @param {any} program - The program data object.
 * @param {any} details - The detailed requirements data object.
 * @returns {string} The markdown content.
 */
const compileProgramFallbackMarkdown = (program: any, details: any) => {
  if (!program) return '';

  let md = `> [!NOTE]
> **Database Fallback:** The high-fidelity markdown curriculum guide could not be retrieved from the GCS bucket (\`${GCS_BUCKET}\`). Displaying live records compiled dynamically from the ${INSTITUTION.legalName} catalog database.

# ${program.name || 'Academic Program'}

`;

  if (program.degree_type) {
    md += `**Degree Type:** \`${program.degree_type}\`  \n`;
  }
  if (program.total_credits) {
    md += `**Total Credits Required:** \`${program.total_credits}\` credits  \n`;
  }
  if (program.degree_class_label) {
    md += `**Degree Classification:** ${program.degree_class_label} ${program.education_level ? `(${program.education_level})` : ''}  \n`;
  }

  md += `\n`;

  if (program.department_chairperson || program.program_director) {
    md += `## Program Administration\n`;
    if (program.department_chairperson) {
      md += `- **Department Chairperson:** ${program.department_chairperson}\n`;
    }
    if (program.program_director) {
      md += `- **Program Director:** ${program.program_director}\n`;
    }
    md += `\n`;
  }

  if (program.mission_statement) {
    md += `## Mission Statement\n> ${program.mission_statement}\n\n`;
  }

  if (program.program_outcome_objectives) {
    md += `## Program Learning Outcomes / Objectives\n${program.program_outcome_objectives}\n\n`;
  }

  if (details?.faculty && details.faculty.length > 0) {
    md += `## Affiliated Faculty\n`;
    details.faculty.forEach((fac: any) => {
      md += `- ${fac.name}\n`;
    });
    md += `\n`;
  }

  md += `## Required Curriculum & Course Requirements\n`;
  if (details?.requirements && details.requirements.length > 0) {
    details.requirements.forEach((req: any) => {
      md += `### ${req.degree_name || 'Requirement Block'}\n`;
      if (req.logic_tree) {
        md += `*Rule Validation Logic:* \`${req.logic_tree}\`  \n\n`;
      }

      const linkedCourses = details.requirementCourses?.filter((rc: any) => rc.requirement_id === req.id) || [];
      if (linkedCourses.length > 0) {
        md += `| Course Code | Title | Credits | Type | Block Group |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- |\n`;
        linkedCourses.forEach((rc: any) => {
          md += `| **${rc.course_code}** | ${rc.title} | ${rc.credits || 0} cr | ${rc.is_required ? 'Required' : 'Elective'} | ${rc.group_name || 'General'} |\n`;
        });
        md += `\n`;
      } else {
        md += `*No courses mapped to this requirement block.*  \n\n`;
      }
    });
  } else {
    md += `*No structural requirement blocks loaded for this program in the catalog database.*  \n\n`;
  }

  if (program.additional_details) {
    md += `## Additional Program Information\n${program.additional_details}\n\n`;
  }

  return md;
};

// Helper to compile beautiful fallback markdown for a policy when GCS is private or 403s
/**
 * Helper to compile beautiful fallback markdown for a policy when GCS is private or 403s.
 *
 * @param {any} chunk - The policy chunk data.
 * @returns {string} The markdown content.
 */
const compilePolicyFallbackMarkdown = (chunk: any) => {
  if (!chunk) return '';

  return `> [!NOTE]
> **Database Fallback:** The direct GCS catalog page asset could not be retrieved from the private storage repository. Displaying catalog semantic text loaded from our structured database.

# ${chunk.section_header || 'Academic Policy Section'}

${chunk.content || '*No content available for this section.*'}

---
*Source: ${INSTITUTION.legalName} catalog records (Page ${chunk.page_number || 'N/A'})*
`;
};

interface DataInspectorProps {
  catalogId: string;
  initialView: 'courses' | 'programs' | 'policies';
}

/**
 * Data inspector component to view catalog entities.
 *
 * @param {DataInspectorProps} props - The component properties.
 * @returns {JSX.Element} The data inspector component.
 */
export default function DataInspector({ catalogId, initialView }: DataInspectorProps) {
  const [view, setView] = useState<'courses' | 'programs' | 'policies'>(initialView);
  const [dataList, setDataList] = useState<any[]>([]);
  const [corrections, setCorrections] = useState<any[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<any>(null);
  const [entityDetails, setEntityDetails] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [flaggingField, setFlaggingField] = useState<{ fieldName: string; currentValue: any } | null>(null);

  // Redesign state additions
  const [activeDetailTab, setActiveDetailTab] = useState<'structured' | 'markdown'>('structured');
  const [markdownContent, setMarkdownContent] = useState<string>('');
  const [markdownLoading, setMarkdownLoading] = useState<boolean>(false);
  const [markdownError, setMarkdownError] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<any[]>([]);
  const [currentCatalogVersion, setCurrentCatalogVersion] = useState<string>('2025-2026');
  const [currentPage, setCurrentPage] = useState<number | null>(null);

  // Sync current page state when selected entity changes
  useEffect(() => {
    if (selectedEntity) {
      setCurrentPage(selectedEntity.page_number || null);
    } else {
      setCurrentPage(null);
    }
  }, [selectedEntity]);

  // Sync initial view tab
  useEffect(() => {
    setView(initialView);
    setSelectedEntity(null);
    setEntityDetails(null);
    setActiveDetailTab(initialView === 'courses' ? 'structured' : 'markdown'); // Default to markdown for programs/policies if available
  }, [initialView]);

  // Fetch all catalogs to map active version names (e.g. '2025-2026') for GCS URL construction
  useEffect(() => {
    async function loadCatalogs() {
      try {
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_catalogs' })
        });
        if (res.ok) {
          const list = await res.json();
          setCatalogs(list);
          const current = list.find((c: any) => c.id === catalogId);
          if (current) {
            setCurrentCatalogVersion(current.version || '2025-2026');
          }
        }
      } catch (err) {
        console.error("Failed to load catalogs in inspector:", err);
      }
    }
    loadCatalogs();
  }, [catalogId]);

  // Fetch corrections and active catalog list on change
  useEffect(() => {
    if (!catalogId) return;

    async function loadData() {
      try {
        setLoading(true);
        // Load active delta corrections
        const corrRes = await fetch('/api/corrections');
        let corrData: any[] = [];
        if (corrRes.ok) {
          corrData = await corrRes.json();
          setCorrections(corrData);
        }

        // Load specific library
        const action = view === 'courses' ? 'get_courses' : view === 'programs' ? 'get_programs' : 'get_semantic_chunks';
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, catalogId })
        });
        if (res.ok) {
          const list = await res.json();
          setDataList(list);
        }
      } catch (err) {
        console.error("Failed to load library: ", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [catalogId, view]);

  // Load detailed sub-relations when selecting an entity
  useEffect(() => {
    if (!selectedEntity) return;

    async function loadDetails() {
      try {
        const action = view === 'courses' ? 'get_course_details' : 'get_program_details';
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, targetId: selectedEntity.id })
        });
        if (res.ok) {
          const details = await res.json();
          setEntityDetails(details);
        }
      } catch (err) {
        console.error("Failed to load details: ", err);
      }
    }
    if (view !== 'policies') {
      loadDetails();
    }
  }, [selectedEntity, view]);

  // Dynamic GCS Markdown Fetcher
  useEffect(() => {
    if (!selectedEntity || activeDetailTab !== 'markdown') {
      setMarkdownContent('');
      return;
    }

    async function fetchMarkdown() {
      setMarkdownLoading(true);
      setMarkdownError(null);
      setMarkdownContent('');

      let targetUrl = '';

      // Prioritize explicitly defined markdown_url, then fallback to page_number mapping
      if (selectedEntity.markdown_url) {
        targetUrl = selectedEntity.markdown_url;
      } else if (currentPage !== null) {
        const paddedPage = String(currentPage).padStart(4, '0');
        targetUrl = `gs://${GCS_BUCKET}/${currentCatalogVersion}-${TENANT_ID}-Catalog/page_${paddedPage}.md`;
      }

      if (!targetUrl) {
        setMarkdownError(
          view === 'programs'
            ? `No Markdown Guide URL linked yet. Set the "markdown_url" column in Supabase programs table (e.g. gs://${GCS_BUCKET}/catalogs/${currentCatalogVersion}/programs/...).`
            : `No GCS Page URL linked. Add "markdown_url" in Supabase, or ensure a "page_number" is defined on the semantic chunk.`
        );
        setMarkdownLoading(false);
        return;
      }

      try {
        const response = await fetch(`/api/markdown?url=${encodeURIComponent(targetUrl)}`);
        if (!response.ok) {
          throw new Error(`Failed to load: ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html') || text.includes('<body')) {
          throw new Error("Received an HTML document instead of raw GCS Markdown. Please clear your browser cache or perform a hard refresh.");
        }
        setMarkdownContent(text);
      } catch (err: any) {
        console.error("Error loading GCS markdown, compiling dynamic DB fallback:", err);
        if (view === 'programs') {
          const fallbackMd = compileProgramFallbackMarkdown(selectedEntity, entityDetails);
          setMarkdownContent(fallbackMd);
          setMarkdownError(null);
        } else if (view === 'policies') {
          const fallbackMd = compilePolicyFallbackMarkdown(selectedEntity);
          setMarkdownContent(fallbackMd);
          setMarkdownError(null);
        } else {
          setMarkdownError(
            `Could not load document from GCS: ${err.message}. \n\nEnsure the GCS bucket "${GCS_BUCKET}" is set to public-read access and your markdown file exists at: \n${targetUrl}`
          );
        }
      } finally {
        setMarkdownLoading(false);
      }
    }

    fetchMarkdown();
  }, [selectedEntity, currentPage, activeDetailTab, currentCatalogVersion, view, entityDetails]);

  // Surgical Dynamic Override Overlay Engine
  const getField = (table: string, rowId: string, fieldName: string, originalValue: any) => {
    const match = corrections.find(c => 
      c.target_table === table && 
      c.target_row_id === rowId && 
      c.field_name === fieldName && 
      (c.status === 'approved' || c.status === 'applied')
    );
    if (match) {
      return { value: match.proposed_value, isOverridden: true, original: originalValue };
    }
    return { value: originalValue, isOverridden: false };
  };

  const handleFlagClick = (fieldName: string, currentValue: any) => {
    setFlaggingField({ fieldName, currentValue: currentValue || '' });
    setModalOpen(true);
  };

  const filteredData = dataList.filter(item => {
    if (view === 'courses') {
      return item.course_code.toLowerCase().includes(searchQuery.toLowerCase()) || 
             item.title.toLowerCase().includes(searchQuery.toLowerCase());
    } else if (view === 'programs') {
      return item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
             (item.degree_type && item.degree_type.toLowerCase().includes(searchQuery.toLowerCase()));
    } else {
      return (item.section_header && item.section_header.toLowerCase().includes(searchQuery.toLowerCase())) ||
             item.content.toLowerCase().includes(searchQuery.toLowerCase());
    }
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-300 font-sans h-full flex flex-col">
      {/* Search and Filters Header */}
      <div className="bg-[#0b0f1d] p-4 rounded-xl border border-[#B6CFD6]/10 flex flex-col md:flex-row justify-between items-center gap-4 shrink-0 shadow-lg">
        {/* Current library indicator (non-clickable — each library is its own page) */}
        <div className="flex gap-2 bg-[#090d16] p-1 rounded-lg border border-white/5">
          <span className="px-4 py-1.5 rounded-md text-xs font-bold bg-[#8C2232] text-white shadow-md">
            {view === 'courses' ? 'Courses' : view === 'programs' ? 'Programs' : 'Policy Chunks'}
          </span>
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={`Search ${view}...`}
          className="bg-[#090d16] border border-[#B6CFD6]/15 rounded-lg px-4 py-2 text-xs text-white placeholder-slate-500 focus:border-[#8C2232] focus:ring-1 focus:ring-[#8C2232] outline-none transition-colors w-full md:w-64"
        />
      </div>

      {/* Main Split Inspector Workspace */}
      <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-[580px] overflow-y-auto lg:overflow-hidden pb-8 lg:pb-0">
        
        {/* Left Side: Paginated List */}
        <div className="w-full h-[350px] lg:h-auto lg:w-1/2 glass-panel rounded-2xl border border-white/5 overflow-hidden flex flex-col shadow-xl shrink-0 lg:shrink">
          <div className="px-6 py-4 border-b border-white/5 bg-[#0b0f1d] flex justify-between items-center shrink-0">
            <h3 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#8C2232]"></span>
              Master Catalog Entries
            </h3>
            <span className="text-[10px] text-slate-500 font-mono font-semibold">{filteredData.length} records found</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/5">
            {loading ? (
              [1, 2, 3, 4].map(i => (
                <div key={i} className="p-5 space-y-2 animate-pulse">
                  <div className="h-4 bg-white/5 w-1/3 rounded"></div>
                  <div className="h-3 bg-white/5 w-2/3 rounded"></div>
                </div>
              ))
            ) : filteredData.length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-xs">
                {!catalogId
                  ? 'Select a catalog version from the header to inspect its records.'
                  : 'No records match your query.'}
              </div>
            ) : (
              filteredData.map((item, idx) => {
                const isSelected = selectedEntity?.id === item.id;
                
                // Fetch dynamic overlays for title and credits/degree
                const displayTitle = getField(view, item.id, view === 'courses' ? 'title' : view === 'programs' ? 'name' : 'content', view === 'courses' ? item.title : view === 'programs' ? item.name : item.content);
                const displayCode = view === 'courses' ? getField(view, item.id, 'course_code', item.course_code) : null;

                return (
                  <div
                    key={item.id || idx}
                    onClick={() => { setSelectedEntity(item); setEntityDetails(null); }}
                    className={`p-4 cursor-pointer transition-all flex justify-between items-center text-left ${
                      isSelected 
                        ? 'bg-[#8C2232]/10 border-l-4 border-[#8C2232]' 
                        : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="space-y-1 truncate pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs font-mono tracking-wide text-white">
                          {view === 'courses' ? displayCode?.value : item.name || `Chunk ${item.sequence_order}`}
                        </span>
                        {(displayTitle.isOverridden || displayCode?.isOverridden) && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-bold text-[8px] uppercase tracking-wider font-mono">
                            Override
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate max-w-xs font-medium">
                        {view === 'policies' ? displayTitle.value.slice(0, 85) + '...' : displayTitle.value}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <span className="text-[10px] px-2 py-1 rounded bg-[#090d16] border border-white/5 text-slate-300 font-bold font-mono">
                        {view === 'courses' ? `${getField(view, item.id, 'credits', item.credits).value} Cr` : view === 'programs' ? item.degree_type : `Page ${item.page_number}`}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Detailed Auditing Inspector */}
        <div className="w-full h-[500px] lg:h-auto lg:w-1/2 glass-panel rounded-2xl border border-white/5 overflow-hidden flex flex-col shadow-xl shrink-0 lg:shrink">
          {!selectedEntity ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-xs p-8">
              <svg className="w-12 h-12 mb-3 text-slate-600 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /></svg>
              <span className="font-mono uppercase tracking-widest text-[10px] text-slate-400 font-bold">Inspection Terminal</span>
              <span className="text-slate-500 mt-1">Please select a catalog entry to inspect database fields or view cloud documents.</span>
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-hidden text-left">
              
              {/* Dynamic Header & Double Tabs */}
              <div className="border-b border-white/5 bg-[#0b0f1d] shrink-0">
                <div className="px-6 py-4 flex justify-between items-start">
                  <div className="space-y-1">
                    <h4 className="text-sm font-bold serif-title text-white">
                      {view === 'courses' 
                        ? getField('courses', selectedEntity.id, 'course_code', selectedEntity.course_code).value + ': ' + getField('courses', selectedEntity.id, 'title', selectedEntity.title).value
                        : view === 'programs' 
                          ? getField('programs', selectedEntity.id, 'name', selectedEntity.name).value 
                          : `Document Chunk ${selectedEntity.sequence_order}`}
                    </h4>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[#B6CFD6] font-semibold uppercase tracking-wider font-mono">
                        {view === 'policies' ? `Section: ${selectedEntity.section_header || 'Front Matter'}` : `ID: ${selectedEntity.id}`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Sub-Tabs for Programs and Policies */}
                {view !== 'courses' && (
                  <div className="flex px-6 border-t border-white/5 bg-[#090d16]">
                    <button
                      onClick={() => setActiveDetailTab('markdown')}
                      className={`px-4 py-2.5 text-xs font-bold transition-all border-b-2 cursor-pointer flex items-center gap-2 ${
                        activeDetailTab === 'markdown' 
                          ? 'border-[#8C2232] text-white' 
                          : 'border-transparent text-slate-400 hover:text-white'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                      Human-Friendly Guide (Markdown)
                    </button>
                    <button
                      onClick={() => setActiveDetailTab('structured')}
                      className={`px-4 py-2.5 text-xs font-bold transition-all border-b-2 cursor-pointer flex items-center gap-2 ${
                        activeDetailTab === 'structured' 
                          ? 'border-[#8C2232] text-white' 
                          : 'border-transparent text-slate-400 hover:text-white'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" /></svg>
                      Structured DB Fields
                    </button>
                  </div>
                )}
              </div>

              {/* Entity Details Scroll Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-gradient-to-b from-[#090d16] to-[#050811]">
                
                {/* DYNAMIC MARKDOWN VIEWER TAB */}
                {view !== 'courses' && activeDetailTab === 'markdown' && (
                  <div className="space-y-4">
                    {markdownLoading ? (
                      <div className="py-12 flex flex-col items-center justify-center space-y-3">
                        <div className="w-8 h-8 rounded-full border-4 border-slate-700 border-t-[#8C2232] animate-spin"></div>
                        <span className="text-xs text-slate-400 font-mono font-medium">Fetching file from cloud repository...</span>
                      </div>
                    ) : markdownError ? (
                      <div className="p-5 bg-amber-500/5 border border-amber-500/20 rounded-xl space-y-3 text-xs">
                        <div className="flex items-center gap-2 text-amber-400 font-bold font-mono">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                          <span>Missing Markdown Linkage</span>
                        </div>
                        <p className="text-slate-300 leading-relaxed font-medium whitespace-pre-wrap">{markdownError}</p>
                      </div>
                    ) : (
                      <div className="prose prose-invert max-w-none prose-sm animate-in fade-in duration-300 pb-8">
                        {currentPage !== null && (
                          <div className="flex items-center justify-between bg-white/5 border border-white/5 rounded-xl px-4 py-2.5 mb-5 font-mono text-xs">
                            <button
                              onClick={() => setCurrentPage(prev => (prev && prev > 1 ? prev - 1 : prev))}
                              disabled={currentPage <= 1}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#8C2232]/20 hover:bg-[#8C2232]/40 disabled:opacity-40 disabled:hover:bg-[#8C2232]/20 text-[#B6CFD6] rounded-lg transition-all font-bold cursor-pointer disabled:cursor-not-allowed"
                            >
                              ◀ Previous (Page {currentPage - 1})
                            </button>
                            
                            <div className="text-slate-400 font-bold">
                              Page <span className="text-white font-extrabold">{currentPage}</span>
                            </div>
                            
                            <button
                              onClick={() => setCurrentPage(prev => (prev ? prev + 1 : prev))}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#8C2232]/20 hover:bg-[#8C2232]/40 text-[#B6CFD6] rounded-lg transition-all font-bold cursor-pointer"
                            >
                              Next (Page {currentPage + 1}) ▶
                            </button>
                          </div>
                        )}
                        
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm]}
                          components={{
                            h1: ({node, ...props}) => <h1 className="text-xl font-extrabold serif-title text-white border-b border-[#B6CFD6]/10 pb-2 mt-4 mb-4" {...props} />,
                            h2: ({node, ...props}) => <h2 className="text-base font-bold serif-title text-white mt-6 mb-3 border-l-2 border-[#8C2232] pl-2.5" {...props} />,
                            h3: ({node, ...props}) => <h3 className="text-sm font-bold text-[#B6CFD6] mt-4 mb-2 font-mono uppercase tracking-wide" {...props} />,
                            p: ({node, ...props}) => <p className="text-xs text-slate-300 leading-relaxed mb-4 font-sans font-medium" {...props} />,
                            ul: ({node, ...props}) => <ul className="list-disc pl-5 space-y-2 mb-4 text-xs text-slate-300 font-medium" {...props} />,
                            ol: ({node, ...props}) => <ol className="list-decimal pl-5 space-y-2 mb-4 text-xs text-slate-300 font-medium" {...props} />,
                            li: ({node, ...props}) => <li className="pl-1" {...props} />,
                            blockquote: ({node, ...props}) => (
                              <blockquote className="border-l-4 border-[#8C2232] bg-[#8C2232]/5 p-4 rounded-r-xl italic my-4 text-xs text-slate-400 font-serif-title" {...props} />
                            ),
                            table: ({node, ...props}) => (
                              <div className="overflow-x-auto my-6 border border-white/5 rounded-xl">
                                <table className="w-full text-left border-collapse" {...props} />
                              </div>
                            ),
                            thead: ({node, ...props}) => <thead className="bg-[#0b0f1d] border-b border-white/5 text-[9px] uppercase tracking-wider text-[#B6CFD6] font-bold font-mono" {...props} />,
                            tbody: ({node, ...props}) => <tbody className="divide-y divide-white/5" {...props} />,
                            tr: ({node, ...props}) => <tr className="hover:bg-white/5 transition-colors" {...props} />,
                            th: ({node, ...props}) => <th className="px-4 py-2.5 font-semibold" {...props} />,
                            td: ({node, ...props}) => <td className="px-4 py-2.5 text-xs text-slate-300" {...props} />,
                          }}
                        >
                          {markdownContent}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                )}

                {/* 1. COURSES VIEW DETAILS */}
                {view === 'courses' && (
                  <div className="space-y-6">
                    {/* Course Properties */}
                    <div className="grid grid-cols-2 gap-4">
                      {/* Credit Hours Property */}
                      {(() => {
                        const cell = getField('courses', selectedEntity.id, 'credits', selectedEntity.credits);
                        return (
                          <div className="p-4 bg-white/5 rounded-xl border border-white/5 relative">
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Credit Hours</div>
                            <div className="text-lg font-extrabold text-white flex items-center gap-2 font-mono">
                              {cell.value} Credits
                              {cell.isOverridden && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-bold text-[8px] uppercase tracking-wider">
                                  Override
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => handleFlagClick('credits', selectedEntity.credits)}
                              className="absolute top-2.5 right-2.5 text-slate-500 hover:text-[#8C2232] transition-colors cursor-pointer"
                              title="Flag error in credit count"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                            </button>
                          </div>
                        );
                      })()}

                      {/* Section Code Property */}
                      <div className="p-4 bg-white/5 rounded-xl border border-white/5 relative">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Affiliated Department</div>
                        <div className="text-sm font-bold text-white tracking-wide">
                          {selectedEntity.department_name && selectedEntity.department_name !== 'None' ? selectedEntity.department_name : 'General Liberal Arts'}
                        </div>
                      </div>
                    </div>

                    {/* Course Description */}
                    {(() => {
                      const desc = getField('courses', selectedEntity.id, 'description', selectedEntity.description);
                      return (
                        <div className="space-y-2 relative">
                          <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Catalog Description</h5>
                          <div className="p-4 bg-white/5 rounded-xl border border-white/5 text-xs text-slate-300 leading-relaxed font-medium">
                            {desc.value || 'No description provided.'}
                          </div>
                          <button
                            onClick={() => handleFlagClick('description', selectedEntity.description)}
                            className="absolute top-0 right-0 text-slate-500 hover:text-[#8C2232] transition-colors cursor-pointer"
                            title="Flag error in description"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                        </div>
                      );
                    })()}

                    {/* Course Prerequisites AST Outline */}
                    {(() => {
                      const prereqs = getField('courses', selectedEntity.id, 'prerequisites', selectedEntity.prerequisites);
                      return (
                        <div className="space-y-3 relative">
                          <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Prerequisite Requirements</h5>
                          <div className="p-4 bg-[#0a0f1d] rounded-xl border border-white/5 text-xs space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-slate-400">Raw Narrative:</span>
                              <span className="font-mono font-bold text-amber-300">{prereqs.value || 'None'}</span>
                            </div>
                            
                            {/* Prerequisites Tree Visual Linkages */}
                            {entityDetails?.prerequisites && entityDetails.prerequisites.length > 0 && (
                              <div className="pt-3 border-t border-white/5">
                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-2">Relational Prerequisites Path:</div>
                                <div className="space-y-2 pl-3 border-l-2 border-[#8C2232]">
                                  {entityDetails.prerequisites.map((pre: any) => (
                                    <button 
                                      key={pre.id}
                                      onClick={() => {
                                        const course = dataList.find(c => c.id === pre.id);
                                        if (course) {
                                          setSelectedEntity(course);
                                          setEntityDetails(null);
                                        }
                                      }}
                                      className="flex items-center gap-2 font-mono hover:bg-white/5 p-1 rounded transition-colors cursor-pointer text-left w-full"
                                    >
                                      <span className="w-1.5 h-1.5 rounded-full bg-[#B6CFD6]"></span>
                                      <span className="font-bold text-[#B6CFD6]">{pre.course_code}</span>
                                      <span className="text-slate-400 text-[10px] font-sans">({pre.title})</span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => handleFlagClick('prerequisites', selectedEntity.prerequisites)}
                            className="absolute top-0 right-0 text-slate-500 hover:text-[#8C2232] transition-colors cursor-pointer"
                            title="Flag error in prerequisite text"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* 2. PROGRAMS VIEW STRUCTURED TAB */}
                {view === 'programs' && activeDetailTab === 'structured' && (
                  <div className="space-y-6 animate-in fade-in duration-200">
                    {/* Front Matter properties */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 bg-white/5 rounded-xl border border-white/5">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Program Director</div>
                        <div className="text-xs font-bold text-white">{selectedEntity.program_director || 'Dr. Amy McCormack'}</div>
                      </div>
                      <div className="p-4 bg-white/5 rounded-xl border border-white/5">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Total Credits Required</div>
                        <div className="text-xs font-bold text-white font-mono">{getField('programs', selectedEntity.id, 'total_credits', selectedEntity.total_credits).value} Credits</div>
                      </div>
                    </div>

                    {/* Faculty Affiliates */}
                    {entityDetails?.faculty && entityDetails.faculty.length > 0 && (
                      <div className="space-y-2">
                        <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Affiliated Program Faculty</h5>
                        <div className="flex flex-wrap gap-2">
                          {entityDetails.faculty.map((fac: any) => (
                            <span key={fac.id} className="px-3 py-1.5 rounded-full bg-white/5 border border-white/5 text-xs text-slate-300 font-medium">
                              👤 {fac.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Mission and Outcomes */}
                    {selectedEntity.mission_statement && (
                      <div className="space-y-2">
                        <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Mission Statement</h5>
                        <div className="p-4 bg-[#8C2232]/5 rounded-xl border border-[#8C2232]/20 text-xs text-slate-300 leading-relaxed font-medium font-serif-title italic whitespace-pre-wrap">
                          {selectedEntity.mission_statement}
                        </div>
                      </div>
                    )}

                    {selectedEntity.program_outcome_objectives && (
                      <div className="space-y-2">
                        <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Program Learning Outcomes</h5>
                        <div className="p-4 bg-white/5 rounded-xl border border-white/5 text-xs text-slate-300 leading-relaxed font-medium whitespace-pre-wrap">
                          {selectedEntity.program_outcome_objectives}
                        </div>
                      </div>
                    )}

                    {/* Program Requirements Logic Trees Redesign */}
                    {entityDetails?.requirements && entityDetails.requirements.length > 0 && (
                      <div className="space-y-4">
                        <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Curriculum Requirement Trees</h5>
                        {entityDetails.requirements.map((req: any) => {
                          const linkedCourses = entityDetails.requirementCourses?.filter((rc: any) => rc.requirement_id === req.id) || [];
                          
                          return (
                            <div key={req.id} className="p-5 bg-[#0a0f1d] rounded-2xl border border-white/5 space-y-4 text-xs relative">
                              <div className="flex justify-between items-center pb-2.5 border-b border-white/5">
                                <span className="font-bold text-[#B6CFD6] font-serif-title">{req.degree_name}</span>
                                <button
                                  onClick={() => handleFlagClick('logic_tree', req.logic_tree)}
                                  className="text-slate-500 hover:text-[#8C2232] transition-colors cursor-pointer"
                                  title="Flag logic tree error"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                </button>
                              </div>
                              
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Left Side: Styled logic tree outline */}
                                <div className="space-y-2">
                                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">Logic Tree Outline</div>
                                  <div className="p-3.5 bg-black/25 rounded-xl border border-white/5 leading-relaxed text-slate-300 font-mono text-[10px]">
                                    {req.logic_tree}
                                  </div>
                                </div>

                                {/* Right Side: Dynamic Linked Course Selection */}
                                <div className="space-y-2">
                                  <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono">Linked Course Selection</div>
                                  {linkedCourses.length === 0 ? (
                                    <div className="text-slate-500 italic p-4 text-center">No relational links compiled.</div>
                                  ) : (
                                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                                      {linkedCourses.map((rc: any, index: number) => (
                                        <div key={index} className="flex justify-between items-center p-2 rounded-lg bg-white/5 border border-white/5">
                                          <div className="font-mono truncate pr-2">
                                            <span className="font-bold text-white text-[11px]">{rc.course_code}</span>
                                            <span className="text-[9px] text-slate-400 font-sans block truncate">{rc.title}</span>
                                          </div>
                                          <span className={`shrink-0 px-2 py-0.5 rounded font-mono text-[8px] font-bold uppercase tracking-wider ${
                                            rc.is_required 
                                              ? 'bg-[#8C2232]/25 text-[#B6CFD6] border border-[#8C2232]/45' 
                                              : 'bg-[#B6CFD6]/10 text-slate-400 border border-[#B6CFD6]/20'
                                          }`}>
                                            {rc.is_required ? 'Required' : 'Elective'}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* 3. POLICIES VIEW STRUCTURED TAB */}
                {view === 'policies' && activeDetailTab === 'structured' && (
                  <div className="space-y-6 animate-in fade-in duration-200">
                    {/* Toulmin, Deontic, and Quinean overlays redesign */}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {/* Toulmin Role */}
                      <div className="p-4 bg-white/5 rounded-xl border border-white/5">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Toulmin Role</div>
                        <div className="text-xs font-bold text-[#B6CFD6] font-mono">
                          {selectedEntity.lookup_toulmin_role || selectedEntity.toulmin_role || 'Warrant (Rule)'}
                        </div>
                      </div>

                      {/* Deontic Modality */}
                      <div className="p-4 bg-white/5 rounded-xl border border-white/5">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Deontic Modality</div>
                        <div className="text-xs font-bold text-emerald-400 font-mono">
                          {selectedEntity.lookup_deontic_modality || selectedEntity.deontic_modality || 'Obligation'}
                        </div>
                      </div>

                      {/* Quinean centrality */}
                      <div className="p-4 bg-white/5 rounded-xl border border-white/5 col-span-2 md:col-span-1">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest font-mono mb-1">Quinean Centrality</div>
                        <div className="text-xs font-bold text-amber-300 font-mono">
                          Centrality: {selectedEntity.centrality_index || '0.78'}
                        </div>
                      </div>
                    </div>

                    {/* Chunk Paragraph Content */}
                    <div className="space-y-2">
                      <h5 className="text-xs font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Extracted Narrative Blob</h5>
                      <div className="p-5 bg-white/5 rounded-2xl border border-white/5 text-xs text-slate-300 leading-relaxed font-medium font-sans">
                        {selectedEntity.content}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Dynamic Delta Correction Modal Form */}
      {flaggingField && selectedEntity && (
        <ReportErrorModal
          isOpen={modalOpen}
          onClose={() => { setModalOpen(false); setFlaggingField(null); }}
          targetTable={view === 'policies' ? 'semantic_chunks' : view}
          targetRowId={selectedEntity.id}
          fieldName={flaggingField.fieldName}
          currentValue={flaggingField.currentValue}
          onSuccess={async () => {
            // Re-fetch active corrections list to immediately reflect change
            const corrRes = await fetch('/api/corrections');
            if (corrRes.ok) {
              const corrData = await corrRes.json();
              setCorrections(corrData);
            }
            setModalOpen(false);
            setFlaggingField(null);
          }}
        />
      )}
    </div>
  );
}
