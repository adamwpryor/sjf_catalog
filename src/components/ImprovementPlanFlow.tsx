'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FEATURES } from '@/lib/brand';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

/** A persisted improvement-plan item (mirrors the improvement_plans row). */
export interface PlanItem {
  id: string;
  catalog_id: string | null;
  title: string;
  description: string | null;
  rationale: string | null;
  ai_detail: string | null;
  category: string | null;
  accreditor_code: string | null;
  criterion_code: string | null;
  criterion_title: string | null;
  status: 'planned' | 'in_progress';
  target_year: string | null;
  plan_state: 'suggested' | 'selected_current' | 'amended_current' | 'amended_future';
  depends_on: string[];
  node_x: number | null;
  node_y: number | null;
  source: 'ai' | 'manual';
}

interface ImprovementPlanFlowProps {
  plans: PlanItem[];
  currentYear: string;
  yearOptions: string[];
  canEdit: boolean;
  onPatch: (id: string, fields: Partial<PlanItem>) => Promise<void>;
  onExplain: (id: string) => Promise<string>;
  onDelete: (id: string) => Promise<void>;
  onDeleteYear: (year: string) => Promise<void>;
  onAddManual: () => void;
}

// Stable color per criterion so the same criterion reads consistently.
const CRITERION_COLORS = ['#8C2232', '#B6CFD6', '#d9a441', '#5b8c5a', '#7b6cb0', '#3b82a0', '#c0673a'];
function criterionColor(criterion: string | null): string {
  if (!criterion) return '#64748b';
  let h = 0;
  for (let i = 0; i < criterion.length; i++) h = (h * 31 + criterion.charCodeAt(i)) >>> 0;
  return CRITERION_COLORS[h % CRITERION_COLORS.length];
}

const PLAN_STATE_LABEL: Record<PlanItem['plan_state'], string> = {
  suggested: 'Suggested',
  selected_current: 'Selected · current year',
  amended_current: 'Amended · current year',
  amended_future: 'Amended · future year',
};

type InitiativeNodeData = { item: PlanItem; selected: boolean };

/** Custom React Flow node rendering an initiative as a styled card. */
function InitiativeNode({ data }: NodeProps) {
  const { item, selected } = data as unknown as InitiativeNodeData;
  const color = criterionColor(item.criterion_code);
  const suggested = item.plan_state === 'suggested';
  return (
    <div
      className={`w-[230px] rounded-xl border bg-[#0b0f1d] shadow-lg transition-all ${
        selected ? 'border-[#B6CFD6] ring-2 ring-[#B6CFD6]/40' : 'border-white/10 hover:border-white/25'
      } ${suggested ? 'border-dashed' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-[#B6CFD6] !w-2 !h-2" />
      <div className="h-1 rounded-t-xl" style={{ background: color }} />
      <div className="p-3">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span
            className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded uppercase tracking-wider"
            style={{ background: `${color}22`, color }}
          >
            {[FEATURES.accreditation ? item.accreditor_code : null, item.criterion_code].filter(Boolean).join(' ') || 'General'}
          </span>
          <span className="text-[9px] font-mono text-slate-400">{item.target_year || '—'}</span>
        </div>
        <h4 className="text-xs font-bold text-white leading-snug mb-2 line-clamp-3">{item.title}</h4>
        <div className="flex items-center justify-between gap-1">
          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${
            item.status === 'in_progress'
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
          }`}>
            {item.status === 'in_progress' ? 'In Progress' : 'Planned'}
          </span>
          {suggested && <span className="text-[9px] font-mono text-[#B6CFD6]/70">suggested</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-[#B6CFD6] !w-2 !h-2" />
    </div>
  );
}

const nodeTypes = { initiative: InitiativeNode };

/** Deterministic column-by-year layout for items without a saved position. */
function computeLayout(plans: PlanItem[]): Record<string, { x: number; y: number }> {
  const years = Array.from(new Set(plans.map(p => p.target_year || 'Unscheduled'))).sort();
  const colIndex = new Map(years.map((y, i) => [y, i]));
  const rowCounter = new Map<string, number>();
  const pos: Record<string, { x: number; y: number }> = {};
  for (const p of plans) {
    const yr = p.target_year || 'Unscheduled';
    const col = colIndex.get(yr) ?? 0;
    const row = rowCounter.get(yr) ?? 0;
    rowCounter.set(yr, row + 1);
    pos[p.id] = { x: col * 300 + 40, y: row * 150 + 60 };
  }
  return pos;
}

function FlowInner(props: ImprovementPlanFlowProps) {
  const { plans, currentYear, yearOptions, canEdit, onPatch, onExplain, onDelete, onDeleteYear, onAddManual } = props;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Build/refresh nodes & edges whenever the plan data or selection changes.
  useEffect(() => {
    const layout = computeLayout(plans);
    const nextNodes: Node[] = plans.map(p => ({
      id: p.id,
      type: 'initiative',
      position: {
        x: p.node_x ?? layout[p.id].x,
        y: p.node_y ?? layout[p.id].y,
      },
      data: { item: p, selected: p.id === selectedId } as unknown as Record<string, unknown>,
    }));

    const idSet = new Set(plans.map(p => p.id));
    const nextEdges: Edge[] = [];
    for (const p of plans) {
      for (const dep of p.depends_on || []) {
        if (!idSet.has(dep)) continue;
        nextEdges.push({
          id: `${dep}->${p.id}`,
          source: dep,
          target: p.id,
          animated: false,
          style: { stroke: '#B6CFD6', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#B6CFD6' },
        });
      }
    }
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, [plans, selectedId, setNodes, setEdges]);

  const onNodeClick = useCallback((_e: React.MouseEvent, node: Node) => setSelectedId(node.id), []);
  const onNodeDragStop = useCallback((_e: MouseEvent | TouchEvent, node: Node) => {
    onPatch(node.id, { node_x: node.position.x, node_y: node.position.y });
  }, [onPatch]);

  const selected = plans.find(p => p.id === selectedId) || null;
  const priorYears = useMemo(
    () => Array.from(new Set(plans.map(p => p.target_year).filter((y): y is string => !!y && y < currentYear))).sort(),
    [plans, currentYear]
  );

  return (
    <div className="relative flex-1 rounded-xl border border-[#B6CFD6]/10 bg-[#080d16] overflow-hidden">
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2">
        <button
          onClick={onAddManual}
          className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white transition-colors flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
          Add item
        </button>
        {canEdit && priorYears.map(y => (
          <button
            key={y}
            onClick={() => onDeleteYear(y)}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-red-900/20 hover:bg-red-900/40 border border-red-500/20 text-red-300 transition-colors"
            title={`Delete all ${y} plan items`}
          >
            Clear {y}
          </button>
        ))}
      </div>

      {plans.length === 0 ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 text-slate-500">
          <svg className="w-12 h-12 text-[#8C2232]/40 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
          <p className="text-sm font-medium text-slate-300 mb-1">No improvement plan yet</p>
          <p className="text-xs max-w-xs">Use the assistant on the left to <span className="text-[#B6CFD6]">Generate a Plan</span>, or add an item manually. Suggested initiatives will appear here as a dependency map.</p>
        </div>
      ) : (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
          <Controls className="!bg-[#0b0f1d] !border !border-white/10 [&>button]:!bg-[#0b0f1d] [&>button]:!border-white/10 [&>button]:!fill-slate-300" />
        </ReactFlow>
      )}

      {/* Pop-out detail drawer */}
      {selected && (
        <DetailDrawer
          key={selected.id}
          item={selected}
          currentYear={currentYear}
          yearOptions={yearOptions}
          canEdit={canEdit}
          onClose={() => setSelectedId(null)}
          onPatch={onPatch}
          onExplain={onExplain}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

interface DetailDrawerProps {
  item: PlanItem;
  currentYear: string;
  yearOptions: string[];
  canEdit: boolean;
  onClose: () => void;
  onPatch: (id: string, fields: Partial<PlanItem>) => Promise<void>;
  onExplain: (id: string) => Promise<string>;
  onDelete: (id: string) => Promise<void>;
}

/** The right-hand pop-out card with details, state actions, and AI explanation. */
function DetailDrawer({ item, currentYear, yearOptions, canEdit, onClose, onPatch, onExplain, onDelete }: DetailDrawerProps) {
  const color = criterionColor(item.criterion_code);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    title: item.title,
    description: item.description || '',
    target_year: item.target_year || currentYear,
    status: item.status,
  });
  const [explain, setExplain] = useState<string>(item.ai_detail || '');
  const [explaining, setExplaining] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fields: Partial<PlanItem>) => {
    setBusy(true);
    try { await onPatch(item.id, fields); } finally { setBusy(false); }
  };

  const saveAmendment = async () => {
    const planState = draft.target_year === currentYear ? 'amended_current' : 'amended_future';
    await act({
      title: draft.title,
      description: draft.description,
      target_year: draft.target_year,
      status: draft.status,
      plan_state: planState,
    });
    setEditing(false);
  };

  const runExplain = async () => {
    setExplaining(true);
    try { setExplain(await onExplain(item.id)); } finally { setExplaining(false); }
  };

  return (
    <div className="absolute top-0 right-0 h-full w-full sm:w-[380px] bg-[#0b0f1d] border-l border-[#B6CFD6]/20 shadow-2xl z-20 flex flex-col animate-in slide-in-from-right duration-200">
      <div className="px-4 py-3 border-b border-white/10 bg-black/40 flex items-center justify-between shrink-0">
        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded uppercase tracking-wider" style={{ background: `${color}22`, color }}>
          {[FEATURES.accreditation ? item.accreditor_code : null, item.criterion_code].filter(Boolean).join(' ') || 'General'} {item.criterion_title ? `· ${item.criterion_title}` : ''}
        </span>
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        {!editing ? (
          <>
            <h3 className="text-base font-bold text-white serif-title leading-snug">{item.title}</h3>
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
              <span className="px-2 py-0.5 rounded bg-black/40 border border-white/10 text-slate-300">{item.target_year || 'Unscheduled'}</span>
              <span className={`px-2 py-0.5 rounded-full border ${item.status === 'in_progress' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-slate-500/10 text-slate-400 border-slate-500/30'}`}>
                {item.status === 'in_progress' ? 'In Progress' : 'Planned'}
              </span>
              <span className="px-2 py-0.5 rounded bg-[#B6CFD6]/10 text-[#B6CFD6] border border-[#B6CFD6]/20">{PLAN_STATE_LABEL[item.plan_state]}</span>
            </div>
            {item.description && <p className="text-sm text-slate-300 leading-relaxed">{item.description}</p>}
            {item.rationale && (
              <div className="border-l-2 border-[#8C2232] bg-[#8C2232]/5 p-3 rounded-r-lg">
                <div className="text-[9px] uppercase tracking-widest text-[#8C2232] font-mono font-bold mb-1">Why this maps to {item.criterion_code || 'the criterion'}</div>
                <p className="text-xs text-slate-300 leading-relaxed">{item.rationale}</p>
              </div>
            )}

            {/* AI deeper explanation */}
            <div>
              <button
                onClick={runExplain}
                disabled={explaining}
                className="w-full text-xs font-semibold px-3 py-2 rounded-lg bg-[#8C2232] hover:bg-[#a32a3c] disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2"
              >
                {explaining ? (
                  <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Explaining…</>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M11 2l1.6 4.6L17 8l-4.4 1.4L11 14l-1.6-4.6L5 8l4.4-1.4L11 2z" /></svg>
                    {explain ? 'Regenerate explanation' : 'Explain the accreditation link'}
                  </>
                )}
              </button>
              {explain && (
                <div className="mt-3 text-sm text-slate-300 bg-black/30 border border-white/5 rounded-lg p-3">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h2: ({ node, ...props }) => <h2 className="text-[11px] font-bold uppercase tracking-wider text-[#B6CFD6] mt-3 mb-1 first:mt-0" {...props} />,
                      p: ({ node, ...props }) => <p className="mb-2 leading-relaxed text-slate-300 text-xs" {...props} />,
                      ul: ({ node, ...props }) => <ul className="list-disc pl-4 space-y-1 mb-2 text-slate-300 text-xs" {...props} />,
                      li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
                      strong: ({ node, ...props }) => <strong className="font-semibold text-white" {...props} />,
                    }}
                  >
                    {explain}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Title</label>
              <input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232]" />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Description</label>
              <textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}
                className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232] h-24" />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Target Year</label>
                <select value={draft.target_year} onChange={e => setDraft({ ...draft, target_year: e.target.value })}
                  className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232]">
                  {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Status</label>
                <select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as PlanItem['status'] })}
                  className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232]">
                  <option value="planned">Planned</option>
                  <option value="in_progress">In Progress</option>
                </select>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Action bar */}
      <div className="px-4 py-3 border-t border-white/10 bg-black/40 shrink-0 space-y-2">
        {!editing ? (
          <>
            {canEdit && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => act({ plan_state: 'selected_current', target_year: currentYear })}
                  disabled={busy}
                  className="text-[11px] font-bold px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors"
                >
                  Select for {currentYear}
                </button>
                <button
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  className="text-[11px] font-bold px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-50 text-white transition-colors"
                >
                  Amend…
                </button>
              </div>
            )}
            {canEdit && (
              <button
                onClick={() => onDelete(item.id)}
                className="w-full text-[11px] font-semibold px-3 py-1.5 rounded-lg text-red-400 hover:bg-red-900/20 transition-colors"
              >
                Delete item
              </button>
            )}
          </>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button onClick={saveAmendment} disabled={busy}
              className="text-[11px] font-bold px-3 py-2 rounded-lg bg-[#8C2232] hover:bg-[#a32a3c] disabled:opacity-50 text-white transition-colors">
              Save amendment
            </button>
            <button onClick={() => setEditing(false)} disabled={busy}
              className="text-[11px] font-bold px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white transition-colors">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Wraps the flow in a provider so React Flow hooks work. */
export default function ImprovementPlanFlow(props: ImprovementPlanFlowProps) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}
