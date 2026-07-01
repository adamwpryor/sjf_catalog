'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';

// Dynamically import ForceGraph2D on browser client-side to bypass Next.js SSR canvas errors
const ForceGraph2D = dynamic(
  () => import('react-force-graph-2d').then(mod => mod.default),
  { ssr: false }
);

interface ProgramNode {
  id: string;
  name: string;
  prefixes?: string[];
  degree_type?: string;
}

interface AstNode {
  id: string;
  label: string;
  title: string;
  group: 'program' | 'block' | 'course'; // program = root, block = block, course = leaf
  logic_type?: string;
  required_value?: number;
  degree_type?: string;
  total_credits?: number;
  credits?: number;
  description?: string;
  x?: number;
  y?: number;
}

interface AstLink {
  source: string | { id: string };
  target: string | { id: string };
  type: 'GOVERNS' | 'BELONGS_TO';
  is_required?: boolean;
}

interface AstExplorerProps {
  catalogId: string;
}

/**
 * Renders an AST explorer visualization for a selected program's requirements.
 *
 * @param {AstExplorerProps} props - The component properties.
 * @returns {JSX.Element} The AST explorer component.
 */
export default function AstExplorer({ catalogId }: AstExplorerProps) {
  const fgRef = useRef<any>(null);
  const [programs, setPrograms] = useState<ProgramNode[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>('');
  const [astData, setAstData] = useState<{ nodes: AstNode[]; links: AstLink[]; blocks: any[] }>({ nodes: [], links: [], blocks: [] });
  const [loading, setLoading] = useState(false);
  const [showJsonPanel, setShowJsonPanel] = useState(true);
  const [showLegend, setShowLegend] = useState(true);
  const [selectedNode, setSelectedNode] = useState<AstNode | null>(null);
  const [hoverNode, setHoverNode] = useState<AstNode | null>(null);
  const [neighbors, setNeighbors] = useState<Map<string, Set<string>>>(new Map());

  // 1. Fetch academic programs list on mount/catalogId change
  useEffect(() => {
    if (!catalogId) return;
    async function loadPrograms() {
      try {
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_programs', catalogId })
        });
        if (res.ok) {
          const data = await res.json();
          setPrograms(data);
          if (data.length > 0) {
            setSelectedProgramId(data[0].id);
          }
        }
      } catch (err) {
        console.error("AstExplorer: Error fetching programs list:", err);
      }
    }
    loadPrograms();
  }, [catalogId]);

  // 2. Fetch AST graph data on selectedProgramId change
  useEffect(() => {
    if (!selectedProgramId) return;
    async function loadAst() {
      try {
        setLoading(true);
        setSelectedNode(null);
        setHoverNode(null);
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_program_ast', targetId: selectedProgramId })
        });
        if (res.ok) {
          const data = await res.json();
          
          // Precompute Neighbors Map for O(1) hover lookups
          const nMap = new Map<string, Set<string>>();
          data.links.forEach((l: any) => {
            const s = typeof l.source === 'string' ? l.source : l.source.id;
            const t = typeof l.target === 'string' ? l.target : l.target.id;
            if (!nMap.has(s)) nMap.set(s, new Set());
            if (!nMap.has(t)) nMap.set(t, new Set());
            nMap.get(s)!.add(t);
            nMap.get(t)!.add(s);
          });
          setNeighbors(nMap);
          setAstData({
            nodes: data.nodes,
            links: data.links,
            blocks: data.blocks
          });
        }
      } catch (err) {
        console.error("AstExplorer: Error loading AST graph:", err);
      } finally {
        setLoading(false);
      }
    }
    loadAst();
  }, [selectedProgramId]);
 
  // Configure forces once ForceGraph is initialized to dampen and stabilize coordinates
  useEffect(() => {
    if (fgRef.current && astData.nodes.length > 0) {
      fgRef.current.d3Force('charge').strength(-100);
      fgRef.current.d3Force('link').distance(40);
      fgRef.current.d3Force('center').strength(0.85);
    }
  }, [astData]);

  // Zoom-to-fit trigger
  const handleResetView = useCallback(() => {
    if (fgRef.current) {
      fgRef.current.zoomToFit(400, 70);
    }
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(node);
    if (fgRef.current) {
      fgRef.current.centerAt(node.x, node.y, 800);
      fgRef.current.zoom(4.5, 800);
    }
  }, []);

  // Hover highlighting
  const handleNodeHover = useCallback((node: any) => {
    setHoverNode(node || null);
  }, []);

  // Colors based on CCSJ brand colors
  const getNodeColor = (node: AstNode) => {
    switch (node.group) {
      case 'program':
        return '#ea580c'; // Orange root
      case 'block':
        return '#0284c7'; // Sky blue requirement block
      case 'course':
        return '#8C2232'; // Crimson course leaves
      default:
        return '#475569';
    }
  };

  const getLinkColor = (link: any, isSelected: boolean, isFaded: boolean) => {
    if (isFaded) return 'rgba(148, 163, 184, 0.09)';
    if (isSelected) return '#B6CFD6';

    return link.is_required 
      ? 'rgba(34, 197, 94, 0.5)'   // Required edge (Vibrant Green)
      : 'rgba(168, 85, 247, 0.5)';  // Choice/Elective edge (Vibrant Purple)
  };

  return (
    <div className="flex flex-col h-full overflow-hidden space-y-4">
      {/* Title & Control Panel Toolbar */}
      <div className="bg-[#0b0f1d] p-5 rounded-2xl border border-[#B6CFD6]/10 flex flex-wrap gap-4 items-center justify-between shadow-xl relative z-10">
        <div>
          <h2 className="text-xl font-bold text-white serif-title flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-[#ea580c] rounded-full animate-ping"></span>
            Abstract Syntax Tree (AST) Visual Explorer
          </h2>
          <p className="text-xs text-slate-400 font-medium mt-1">Explore parsed logical requirement hierarchies, elective credit constraints, and course blocks dynamically.</p>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Target Program Structure:</label>
          <select
            value={selectedProgramId}
            onChange={(e) => setSelectedProgramId(e.target.value)}
            className="bg-[#090d16] border border-[#B6CFD6]/20 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-[#8C2232] cursor-pointer font-semibold max-w-xs md:max-w-md shadow-md"
          >
            {programs.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => setShowJsonPanel(!showJsonPanel)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer font-mono ${
              showJsonPanel
                ? 'bg-[#8C2232]/20 border-[#8C2232]/50 text-white'
                : 'bg-white/5 border-white/10 text-slate-300 hover:text-white hover:bg-white/10'
            }`}
          >
            {showJsonPanel ? 'Hide AST Code' : 'Show AST Code'}
          </button>

          <button
            onClick={handleResetView}
            className="px-3 py-1.5 rounded-lg text-xs font-bold border border-[#B6CFD6]/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 transition-all cursor-pointer font-mono"
          >
            Reset Camera
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-4 overflow-y-auto lg:overflow-hidden relative min-h-0">
        {/* LEFT COLUMN: Dynamic AST Structural JSON Code Panel */}
        {showJsonPanel && (
          <div className="w-full lg:w-[380px] lg:shrink-0 h-[280px] lg:h-auto bg-[#0b0f1d] border border-[#B6CFD6]/10 rounded-2xl p-5 flex flex-col shadow-xl animate-in slide-in-from-left-4 duration-300 relative z-10">
            <h3 className="text-sm font-bold text-white border-b border-white/5 pb-2 mb-3 flex items-center justify-between font-serif-title">
              <span>Dynamic AST Program JSON</span>
              <span className="px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 font-bold text-[8px] uppercase tracking-wider border border-sky-500/20 font-mono">Compiler v2</span>
            </h3>
            
            <div className="flex-1 overflow-y-auto font-mono text-[10px] text-emerald-400 leading-normal p-4 bg-black/45 rounded-xl border border-white/5 space-y-4">
              {loading ? (
                <div className="animate-pulse space-y-2">
                  <div className="h-4 bg-white/5 rounded w-3/4"></div>
                  <div className="h-4 bg-white/5 rounded w-1/2"></div>
                  <div className="h-4 bg-white/5 rounded w-5/6"></div>
                </div>
              ) : astData.blocks.length === 0 ? (
                <div className="text-slate-500 italic text-center py-10 font-sans">No requirement blocks extracted yet.</div>
              ) : (
                <pre className="whitespace-pre-wrap">{JSON.stringify(
                  {
                    program: programs.find(p => p.id === selectedProgramId)?.name || 'Unknown Program',
                    degree_type: astData.nodes.find(n => n.id === 'root')?.degree_type || '',
                    total_credits: astData.nodes.find(n => n.id === 'root')?.total_credits || 0,
                    requirement_blocks: astData.blocks
                  },
                  null,
                  2
                )}</pre>
              )}
            </div>
          </div>
        )}

        {/* MIDDLE CANVAS: Force-Directed 2D D3 Interactive Visualization */}
        <div className="flex-1 min-h-[420px] lg:min-h-0 bg-[#050811] border border-[#B6CFD6]/10 rounded-2xl overflow-hidden relative shadow-2xl">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[#050811]/90 z-20 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <div className="w-10 h-10 border-4 border-[#8C2232] border-t-transparent rounded-full animate-spin"></div>
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest font-mono">Compiling AST Geometry...</span>
              </div>
            </div>
          ) : astData.nodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 font-medium">Select a program to render AST.</div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              graphData={{ nodes: astData.nodes, links: astData.links }}
              nodeRelSize={1}
              nodeVal={(node: any) => node.group === 'program' ? 6.5 : (node.group === 'block' ? 4 : 2.5)}
              nodeColor={(node: any) => getNodeColor(node)}
              linkColor={(link: any) => {
                const isSelected = selectedNode ? (selectedNode.id === link.source.id || selectedNode.id === link.target.id) : false;
                const isFaded = hoverNode ? !(hoverNode.id === link.source.id || hoverNode.id === link.target.id) : false;
                return getLinkColor(link, isSelected, isFaded);
              }}
              linkWidth={(link: any) => {
                const isSelected = selectedNode ? (selectedNode.id === link.source.id || selectedNode.id === link.target.id) : false;
                return isSelected ? 2.5 : 1.25;
              }}
              linkDirectionalParticles={1}
              linkDirectionalParticleSpeed={0.015}
              linkDirectionalParticleWidth={(link: any) => (selectedNode?.id === link.source.id || selectedNode?.id === link.target.id) ? 2 : 1}
              onNodeClick={handleNodeClick}
              onNodeHover={handleNodeHover}
              cooldownTicks={160}
              d3AlphaDecay={0.045}
              d3VelocityDecay={0.45}
              nodeCanvasObject={(node: any, ctx, globalScale) => {
                const isSelected = selectedNode?.id === node.id;
                const isHovered = hoverNode?.id === node.id;
                const isNeighbor = hoverNode ? (neighbors.get(hoverNode.id)?.has(node.id) || hoverNode.id === node.id) : false;
                const isFaded = hoverNode ? !isNeighbor : false;

                const size = node.group === 'program' ? 6 : (node.group === 'block' ? 4.5 : 3.5);
                const color = getNodeColor(node);

                // Set alpha dynamically
                ctx.globalAlpha = isFaded ? 0.12 : (isSelected || isHovered || isNeighbor ? 1.0 : 0.85);

                // A. Draw Shadow Glow for Program Roots or Selected nodes
                if (node.group === 'program' || isSelected) {
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, size + 3.5 / globalScale, 0, 2 * Math.PI, false);
                  ctx.fillStyle = isSelected ? 'rgba(242, 169, 0, 0.15)' : 'rgba(234, 88, 12, 0.1)';
                  ctx.fill();
                }

                // B. Draw Main Sphere
                ctx.beginPath();
                ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
                ctx.fillStyle = color;
                ctx.fill();

                // C. Add Border Ring
                if (isSelected) {
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, size + 3.0 / globalScale, 0, 2 * Math.PI, false);
                  ctx.strokeStyle = '#f2a900';
                  ctx.lineWidth = 2.0 / globalScale;
                  ctx.stroke();
                } else {
                  ctx.lineWidth = 1.25 / globalScale;
                  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
                  ctx.stroke();
                }

                // D. Render Node Text Labels
                const fontSize = node.group === 'program' ? 10 / globalScale : (node.group === 'block' ? 8.5 / globalScale : 7.5 / globalScale);
                ctx.font = node.group === 'program' ? `bold ${fontSize}px serif` : `600 ${fontSize}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                const textY = node.y + size + 7 / globalScale;
                const label = node.label || '';

                if (globalScale > 1.2 || node.group === 'program') {
                  ctx.fillStyle = isSelected ? '#ffffff' : (isFaded ? 'rgba(148,163,184,0.1)' : 'rgba(255,255,255,0.85)');
                  ctx.fillText(label, node.x, textY);
                }
              }}
            />
          )}

          {/* FLOATING LEGEND (COLLAPSIBLE BOTTOM LEFT) */}
          <div className="absolute bottom-6 left-6 z-10 flex gap-2">
            <button
              onClick={() => setShowLegend(!showLegend)}
              className={`p-2 rounded-lg shadow-md border transition-all cursor-pointer flex items-center justify-center ${
                showLegend 
                  ? 'bg-[#8C2232] text-white border-[#8C2232]/50 shadow-[#8C2232]/20' 
                  : 'bg-[#0b0f1d]/90 text-slate-300 border-[#B6CFD6]/15 hover:bg-white/5'
              }`}
              title="Toggle Legends"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </button>

            {showLegend && (
              <div className="bg-[#0b0f1d]/90 rounded-xl shadow-lg border border-[#B6CFD6]/10 p-4 pointer-events-none w-52 animate-in fade-in slide-in-from-left-2 duration-200 backdrop-blur-md text-left space-y-4">
                <div>
                  <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider mb-2 border-b border-white/5 pb-1 font-mono">AST Nodes</h4>
                  <ul className="space-y-1.5 text-xs text-slate-300 font-semibold font-sans">
                    <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#ea580c] inline-block"></span> Root Program</li>
                    <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#0284c7] inline-block"></span> Requirement Block</li>
                    <li className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full bg-[#8C2232] inline-block"></span> Leaf Course</li>
                  </ul>
                </div>
                <div>
                  <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider mb-2 border-b border-white/5 pb-1 font-mono">AST Edge Operators</h4>
                  <ul className="space-y-1.5 text-xs text-slate-300 font-semibold font-sans">
                    <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#22c55e] inline-block"></span> Required Course Edge</li>
                    <li className="flex items-center gap-2"><span className="w-4 h-1 rounded bg-[#a855f7] inline-block"></span> Elective Choice Edge</li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Absolutely Positioned Glassmorphism Inspect Sidebar Drawer */}
        {selectedNode && (
          <div className="absolute top-0 right-0 w-full sm:w-[350px] h-full z-20 bg-[#0b0f1d]/90 backdrop-blur-md border-l border-[#B6CFD6]/15 flex flex-col p-6 shadow-2xl animate-in slide-in-from-right-4 duration-300 text-left">
            {/* Header info */}
            <div className="flex justify-between items-start border-b border-white/5 pb-4 mb-4">
              <div>
                <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider font-mono border ${
                  selectedNode.group === 'program'
                    ? 'bg-[#ea580c]/10 text-[#ea580c] border-[#ea580c]/25'
                    : selectedNode.group === 'block'
                      ? 'bg-sky-500/10 text-sky-400 border-sky-500/25'
                      : 'bg-[#8C2232]/10 text-[#B6CFD6] border-[#8C2232]/25'
                }`}>
                  {selectedNode.group === 'program' ? 'Root Degree' : selectedNode.group === 'block' ? 'Requirement Block' : 'Course Leaf'}
                </span>
                <h3 className="text-base font-bold text-white serif-title mt-2 truncate w-60">{selectedNode.title || selectedNode.label}</h3>
              </div>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-slate-400 hover:text-white p-1 hover:bg-white/5 rounded transition-colors cursor-pointer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Scrolling Node details content */}
            <div className="flex-1 overflow-y-auto space-y-6">
              {/* If it's a program root */}
              {selectedNode.group === 'program' && (
                <div className="space-y-4">
                  <div className="p-4 bg-white/5 rounded-xl border border-white/5 font-mono text-[11px] space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Total Graduation Hours:</span>
                      <span className="text-emerald-400 font-bold">{selectedNode.total_credits || '120'} hrs</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Degree Classification:</span>
                      <span className="text-emerald-400 font-bold">{selectedNode.degree_type || 'B.S.'}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Description</h4>
                    <p className="text-xs text-slate-400 leading-relaxed font-medium">This node acts as the mathematical root of the parsed Abstract Syntax Tree (AST), representing the total program graduation pathway.</p>
                  </div>
                </div>
              )}

              {/* If it's a requirement block */}
              {selectedNode.group === 'block' && (
                <div className="space-y-4 flex flex-col h-full min-h-0">
                  <div className="p-4 bg-white/5 rounded-xl border border-white/5 font-mono text-[11px] space-y-2 shrink-0">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Block Operator:</span>
                      <span className="text-emerald-400 font-bold font-mono">{selectedNode.logic_type}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Requirement Value:</span>
                      <span className="text-emerald-400 font-bold">{selectedNode.required_value || '0'} hrs</span>
                    </div>
                  </div>
                  <div className="space-y-2 flex-1 flex flex-col min-h-0">
                    <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Original Catalog Section Text</h4>
                    <div className="flex-1 overflow-y-auto text-xs text-slate-300 leading-relaxed font-medium bg-black/45 p-4 rounded-xl border border-white/5 whitespace-pre-wrap font-sans">
                      {selectedNode.description || 'No section text available in this active catalog.'}
                    </div>
                  </div>
                  <div className="pt-2 border-t border-white/5 text-[9px] text-slate-500 font-medium leading-relaxed shrink-0">
                    <span className="font-bold text-slate-400">AST Rule:</span> The operator <code className="text-sky-400 font-mono text-[9px]">{selectedNode.logic_type}</code> indicates whether students must take all courses listed, or satisfy credit limits from this elective pool.
                  </div>
                </div>
              )}

              {/* If it's a course leaf node */}
              {selectedNode.group === 'course' && (
                <div className="space-y-4">
                  <div className="p-4 bg-white/5 rounded-xl border border-white/5 font-mono text-[11px] space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Course Code:</span>
                      <span className="text-[#B6CFD6] font-bold">{selectedNode.label}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Course Title:</span>
                      <span className="text-emerald-400 font-bold truncate max-w-[150px]" title={selectedNode.title}>{selectedNode.title}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Credit Hours:</span>
                      <span className="text-emerald-400 font-bold">{selectedNode.credits || '3'} hrs</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-[10px] font-bold text-[#B6CFD6] uppercase tracking-wider font-mono">Catalog Description</h4>
                    <p className="text-xs text-slate-400 leading-relaxed font-medium">
                      {selectedNode.description || 'No course description available in the active catalog version.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
