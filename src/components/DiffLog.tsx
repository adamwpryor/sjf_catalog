'use client';

import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DiffLogProps {
  catalogs: any[];
  activeCatalogId: string;
}

/**
 * Normalize free text so cosmetic differences (whitespace, line breaks, smart
 * quotes, en/em dashes) do not affect comparison or matching.
 *
 * @param s - The raw string.
 * @returns The normalized string.
 */
function normalizeText(s: string): string {
  return s
    .replace(/\u00a0/g, ' ')                 // non-breaking spaces
    .replace(/[\u2018\u2019]/g, "'")         // curly single quotes
    .replace(/[\u201c\u201d]/g, '"')         // curly double quotes
    .replace(/[\u2013\u2014]/g, '-')         // en / em dashes
    .replace(/\s+/g, ' ')             // collapse whitespace runs
    .trim();
}

/**
 * Reduce a string to a set of lowercase word tokens for similarity scoring.
 *
 * @param s - The input string.
 * @returns A set of normalized word tokens.
 */
function tokenSet(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    normalizeText(s)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Jaccard similarity between two token sets (intersection / union), 0..1.
 *
 * @param a - First token set.
 * @param b - Second token set.
 * @returns Similarity score between 0 and 1.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const POLICY_MATCH_THRESHOLD = 0.25;   // lexical (Jaccard) acceptance floor
const POLICY_COSINE_THRESHOLD = 0.55;  // embedding (cosine) acceptance floor

export type PolicyMatch = {
  node: any | null;
  method: 'exact-id' | 'header' | 'similarity' | 'none';
  score: number;          // overall confidence used for display
  cosine?: number;        // embedding similarity of the chosen match (0..1)
  jaccard?: number;       // lexical similarity of the chosen match (0..1)
};

/**
 * Align a policy chunk from the base catalog to its best counterpart in the
 * comparison catalog using content similarity, since chunk boundaries, headers,
 * and page numbers drift between separate ingestions.
 *
 * Strategy (in order of confidence):
 *   1. Exact id match.
 *   2. Unique normalized section-header match.
 *   3. Best content-similarity match above {@link POLICY_MATCH_THRESHOLD},
 *      tie-broken by header agreement and page proximity.
 *
 * @param baseNode - The selected policy chunk from the base catalog.
 * @param candidates - All policy chunks from the comparison catalog.
 * @returns The matched node plus how it was found and a confidence score.
 */
function matchPolicyChunk(
  baseNode: any,
  candidates: any[],
  cosineById?: Map<string, number>
): PolicyMatch {
  if (!baseNode) return { node: null, method: 'none', score: 0 };

  // 1. Exact id (same row carried across catalogs)
  const byId = candidates.find(c => c.id === baseNode.id);
  if (byId) return { node: byId, method: 'exact-id', score: 1, cosine: 1, jaccard: 1 };

  const baseHeader = normalizeText(baseNode.section_header || '').toLowerCase();
  const headerMeaningful = baseHeader && baseHeader !== 'none';

  // 2. Unique normalized header match
  if (headerMeaningful) {
    const headerMatches = candidates.filter(
      c => normalizeText(c.section_header || '').toLowerCase() === baseHeader
    );
    if (headerMatches.length === 1) {
      const m = headerMatches[0];
      return {
        node: m,
        method: 'header',
        score: 1,
        cosine: cosineById?.get(m.id),
        jaccard: jaccard(tokenSet(baseNode.content), tokenSet(m.content)),
      };
    }
  }

  // 3. Fused similarity: combine embedding cosine and lexical Jaccard, with
  //    header agreement and page proximity as tie-breakers.
  const baseTokens = tokenSet(baseNode.content);
  const haveCosine = !!cosineById && cosineById.size > 0;

  let best: any = null;
  let bestFused = -1;
  let bestJaccard = 0;
  let bestCosine = 0;

  for (const c of candidates) {
    const lex = jaccard(baseTokens, tokenSet(c.content));
    const cos = cosineById?.get(c.id) ?? 0;
    // When embeddings are available, weight meaning (cosine) above wording
    // (Jaccard); otherwise fall back to lexical-only.
    const similarity = haveCosine ? cos * 0.6 + lex * 0.4 : lex;

    const headerBonus =
      headerMeaningful &&
      normalizeText(c.section_header || '').toLowerCase() === baseHeader
        ? 0.15
        : 0;
    const pageDiff = Math.abs((c.page_number ?? 0) - (baseNode.page_number ?? 0));
    const pageBonus = 0.05 / (1 + pageDiff);
    const fused = similarity * 0.8 + headerBonus + pageBonus;

    if (fused > bestFused) {
      bestFused = fused;
      bestJaccard = lex;
      bestCosine = cos;
      best = c;
    }
  }

  // Accept only on real agreement: lexical overlap, embedding similarity, or a
  // matching heading. Otherwise the section is treated as new/removed.
  const headerAgrees =
    headerMeaningful &&
    best &&
    normalizeText(best.section_header || '').toLowerCase() === baseHeader;
  const accepted =
    best &&
    (bestJaccard >= POLICY_MATCH_THRESHOLD ||
      (haveCosine && bestCosine >= POLICY_COSINE_THRESHOLD) ||
      headerAgrees);

  if (accepted) {
    // Display confidence: the stronger of the two signals available.
    const score = haveCosine ? Math.max(bestCosine, bestJaccard) : bestJaccard;
    return { node: best, method: 'similarity', score, cosine: haveCosine ? bestCosine : undefined, jaccard: bestJaccard };
  }

  return { node: null, method: 'none', score: 0 };
}

/**
 * DiffLog component to display differences between two catalog versions.
 *
 * @param {DiffLogProps} props - The component properties.
 * @returns {JSX.Element} The diff log component.
 */
export default function DiffLog({ catalogs, activeCatalogId }: DiffLogProps) {
  const [baseCatalogId, setBaseCatalogId] = useState<string>(activeCatalogId || '');
  const [compareCatalogId, setCompareCatalogId] = useState<string>('');
  
  const [nodeType, setNodeType] = useState<'Course' | 'Program' | 'Policy'>('Course');
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  
  const [baseData, setBaseData] = useState<any>(null);
  const [compareData, setCompareData] = useState<any>(null);
  const [matchInfo, setMatchInfo] = useState<PolicyMatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});

  // AI editorial review state
  const [editorialText, setEditorialText] = useState<string>('');
  const [editorialModel, setEditorialModel] = useState<string>('');
  const [editorialLoading, setEditorialLoading] = useState(false);
  const [editorialError, setEditorialError] = useState<string>('');

  // Clear any prior editorial review whenever the comparison target changes.
  useEffect(() => {
    setEditorialText('');
    setEditorialModel('');
    setEditorialError('');
  }, [selectedNodeId, compareCatalogId, nodeType, baseCatalogId]);

  const toggleCard = (key: string) =>
    setOpenCards(prev => ({ ...prev, [key]: !prev[key] }));

  const filteredCatalogs = catalogs.filter(cat => !(cat.version + (cat.domain_id || '')).toLowerCase().includes('hlc'));

  // When base catalog or node type changes, fetch the list of available nodes
  useEffect(() => {
    if (!baseCatalogId) return;

    async function loadNodes() {
      setLoading(true);
      try {
        const action = nodeType === 'Course' ? 'get_courses' : nodeType === 'Program' ? 'get_programs' : 'get_semantic_chunks';
        const res = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, catalogId: baseCatalogId })
        });
        if (res.ok) {
          const data = await res.json();
          setNodes(data);
          if (data.length > 0) {
             setSelectedNodeId(data[0].id);
             setBaseData(data[0]);
          } else {
             setSelectedNodeId('');
             setBaseData(null);
             setCompareData(null);
          }
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadNodes();
  }, [baseCatalogId, nodeType]);

  // When selected node or comparison catalog changes, fetch the specific node from both catalogs
  useEffect(() => {
    if (!selectedNodeId || !baseCatalogId) return;

    // Find the base data from already fetched nodes
    const baseNode = nodes.find(n => n.id === selectedNodeId);
    setBaseData(baseNode || null);

    async function loadComparison() {
      if (!compareCatalogId) {
        setCompareData(null);
        setMatchInfo(null);
        return;
      }

      setLoading(true);
      try {
        const action = nodeType === 'Course' ? 'get_courses' : nodeType === 'Program' ? 'get_programs' : 'get_semantic_chunks';
        const compRes = await fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, catalogId: compareCatalogId })
        });
        
        if (compRes.ok) {
          const compDataList = await compRes.json();

          if (nodeType === 'Policy') {
            // Chunk boundaries, headers, and page numbers drift between
            // ingestions, so align policies by fused embedding (cosine) +
            // lexical (Jaccard) similarity instead of exact header/page.
            let cosineById: Map<string, number> | undefined;
            try {
              const simRes = await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'match_policy_chunk',
                  baseCatalogId,
                  compareCatalogId,
                  baseChunkId: selectedNodeId,
                }),
              });
              if (simRes.ok) {
                const simData = await simRes.json();
                if (simData.hasEmbeddings && Array.isArray(simData.scores)) {
                  cosineById = new Map(simData.scores.map((s: any) => [s.id, s.cosine]));
                }
              }
            } catch (simErr) {
              console.warn('Cosine scoring unavailable, falling back to lexical match.', simErr);
            }

            const match = matchPolicyChunk(baseNode, compDataList, cosineById);
            setMatchInfo(match);
            setCompareData(match.node);
          } else {
            // Courses and programs have stable identifiers (code / name).
            let compNode = compDataList.find((n: any) => n.id === selectedNodeId);
            if (!compNode && baseNode) {
              if (nodeType === 'Course') compNode = compDataList.find((n: any) => n.course_code === baseNode.course_code);
              else if (nodeType === 'Program') compNode = compDataList.find((n: any) => n.name === baseNode.name);
            }
            setMatchInfo(null);
            setCompareData(compNode || null);
          }
        } else {
          setMatchInfo(null);
          setCompareData(null);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    loadComparison();
  }, [selectedNodeId, compareCatalogId, nodes, nodeType]);

  // --- Helpers for plain-language change summaries ---------------------------

  // Fields that reflect how a catalog was ingested/positioned rather than its
  // actual content. Differences here are artifacts of the import, not real
  // catalog changes, so they are excluded from the diff entirely.
  const IGNORED_FIELDS = new Set([
    'id', 'catalog_id', 'document_id', 'tenant_id', 'subject_id',
    'embedding', 'metadata', 'markdown_url', 'page_number', 'sequence_order',
  ]);

  // Produce a canonical, comparison-safe representation of any value.
  // Two values are considered "the same" if their canonical forms match.
  const canonical = (v: any): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return normalizeText(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return JSON.stringify(v.map(canonical));
    if (typeof v === 'object') {
      return JSON.stringify(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
    }
    return String(v);
  };

  const isEmpty = (v: any): boolean =>
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0);

  const isScalar = (v: any): boolean => v === null || v === undefined || typeof v !== 'object';

  // A value short enough to show inline as "before -> after"
  const isShortScalar = (v: any): boolean =>
    isScalar(v) && (typeof v !== 'string' || (v.length <= 40 && !v.includes('\n')));

  const humanizeKey = (key: string): string =>
    key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Render a scalar value as a readable string (for chips / inline summaries)
  const asText = (v: any): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
  };

  type ChangeKind = 'added' | 'removed' | 'modified';

  const classifyChange = (bVal: any, cVal: any): ChangeKind => {
    if (isEmpty(bVal) && !isEmpty(cVal)) return 'added';
    if (!isEmpty(bVal) && isEmpty(cVal)) return 'removed';
    return 'modified';
  };

  // Word-level diff using an LCS over whitespace-delimited tokens.
  type Seg = { type: 'same' | 'add' | 'remove'; text: string };
  const wordDiff = (oldStr: string, newStr: string): Seg[] => {
    const tokenize = (s: string) => s.split(/(\s+)/).filter(t => t.length > 0);
    const a = tokenize(oldStr);
    const b = tokenize(newStr);
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const segs: Seg[] = [];
    const push = (type: Seg['type'], text: string) => {
      const last = segs[segs.length - 1];
      if (last && last.type === type) last.text += text;
      else segs.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('remove', a[i]); i++; }
      else { push('add', b[j]); j++; }
    }
    while (i < n) { push('remove', a[i]); i++; }
    while (j < m) { push('add', b[j]); j++; }
    return segs;
  };

  // Inline highlighted word diff (green = added, red strikethrough = removed)
  const renderWordDiff = (oldStr: string, newStr: string): React.ReactNode => {
    // Normalize first so re-flowed line breaks / spacing are not highlighted
    const segs = wordDiff(normalizeText(oldStr), normalizeText(newStr));
    return (
      <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
        {segs.map((s, idx) => {
          if (s.type === 'same') return <span key={idx} className="text-slate-300">{s.text}</span>;
          if (s.type === 'add')
            return <span key={idx} className="bg-emerald-500/20 text-emerald-200 rounded px-0.5">{s.text}</span>;
          return <span key={idx} className="bg-red-500/20 text-red-300/90 line-through rounded px-0.5">{s.text}</span>;
        })}
      </p>
    );
  };

  // Compare two arrays by stringified items -> added / removed lists
  const diffArrays = (bArr: any[], cArr: any[]) => {
    const bStr = bArr.map(canonical);
    const cStr = cArr.map(canonical);
    const added = cArr.filter((_, i) => !bStr.includes(cStr[i]));
    const removed = bArr.filter((_, i) => !cStr.includes(bStr[i]));
    return { added, removed };
  };

  const itemLabel = (item: any): string =>
    isScalar(item) ? asText(item) : (item?.name || item?.title || item?.course_code || JSON.stringify(item));

  // The plain-language summary shown at the top of each change card
  const renderChangeSummary = (bVal: any, cVal: any): React.ReactNode => {
    const kind = classifyChange(bVal, cVal);

    if (kind === 'added') {
      return (
        <div className="text-sm text-emerald-200">
          <span className="text-emerald-400/80 font-medium">Added: </span>
          {isShortScalar(cVal)
            ? <span>{asText(cVal)}</span>
            : <span className="text-emerald-100/90 whitespace-pre-wrap break-words">{Array.isArray(cVal) ? `${cVal.length} item${cVal.length === 1 ? '' : 's'}` : asText(cVal)}</span>}
        </div>
      );
    }
    if (kind === 'removed') {
      return (
        <div className="text-sm text-red-300">
          <span className="text-red-400/80 font-medium">Removed: </span>
          {isShortScalar(bVal)
            ? <span className="line-through">{asText(bVal)}</span>
            : <span className="text-red-200/80 whitespace-pre-wrap break-words line-through">{Array.isArray(bVal) ? `${bVal.length} item${bVal.length === 1 ? '' : 's'}` : asText(bVal)}</span>}
        </div>
      );
    }

    // modified
    if (Array.isArray(bVal) || Array.isArray(cVal)) {
      const { added, removed } = diffArrays(Array.isArray(bVal) ? bVal : [], Array.isArray(cVal) ? cVal : []);
      return (
        <div className="text-sm space-y-2">
          <div className="text-slate-300">
            {added.length > 0 && <span className="text-emerald-400">{added.length} added</span>}
            {added.length > 0 && removed.length > 0 && <span className="text-slate-500">, </span>}
            {removed.length > 0 && <span className="text-red-400">{removed.length} removed</span>}
            {added.length === 0 && removed.length === 0 && <span className="text-slate-400 italic">Items reordered or edited</span>}
          </div>
          <ul className="space-y-1">
            {added.map((it, i) => (
              <li key={`a${i}`} className="text-emerald-300 text-sm flex gap-1.5"><span className="text-emerald-500">+</span><span className="break-words">{itemLabel(it)}</span></li>
            ))}
            {removed.map((it, i) => (
              <li key={`r${i}`} className="text-red-300/90 text-sm flex gap-1.5"><span className="text-red-500">-</span><span className="break-words line-through">{itemLabel(it)}</span></li>
            ))}
          </ul>
        </div>
      );
    }

    if (isShortScalar(bVal) && isShortScalar(cVal)) {
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="bg-red-500/15 text-red-300 line-through rounded px-2 py-0.5">{asText(bVal) || '(blank)'}</span>
          <span className="text-slate-500">{'\u2192'}</span>
          <span className="bg-emerald-500/15 text-emerald-200 rounded px-2 py-0.5">{asText(cVal) || '(blank)'}</span>
        </div>
      );
    }

    if (typeof bVal === 'string' && typeof cVal === 'string') {
      const tokenCount = (bVal.length + cVal.length) / 4; // rough token estimate
      if (tokenCount <= 2400) return renderWordDiff(bVal, cVal);
      // Too large to diff inline - summarise and rely on details panel
      return (
        <div className="text-sm text-slate-400 italic">
          Text rewritten ({bVal.length} {'\u2192'} {cVal.length} characters). Open details to compare.
        </div>
      );
    }

    return <div className="text-sm text-slate-400 italic">Details changed - open below to compare.</div>;
  };

  const renderValue = (val: any, depth = 0): React.ReactNode => {
    if (val === undefined || val === null) return <span className="italic text-slate-600">-- Missing --</span>;
    if (typeof val !== 'object') {
      return <span className="whitespace-pre-wrap">{String(val)}</span>;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return <span className="italic text-slate-500">Empty</span>;
      return (
        <ul className={`list-disc ${depth === 0 ? 'pl-4' : 'pl-6'} space-y-1 my-1`}>
          {val.map((item, i) => (
            <li key={i} className="pl-1">{renderValue(item, depth + 1)}</li>
          ))}
        </ul>
      );
    }
    
    // Object rendering
    const entries = Object.entries(val);
    if (entries.length === 0) return <span className="italic text-slate-500">Empty Object</span>;
    return (
      <div className={`flex flex-col space-y-1 ${depth > 0 ? 'mt-1 border-l border-white/10 pl-3 ml-1' : ''}`}>
        {entries.map(([k, v]) => (
          <div key={k} className="flex flex-col sm:flex-row sm:gap-2 sm:items-start">
            <span className="font-bold text-white/40 text-[11px] uppercase tracking-wider mt-0.5">{k.replace(/_/g, ' ')}:</span>
            <div className="text-white/90 text-sm">{renderValue(v, depth + 1)}</div>
          </div>
        ))}
      </div>
    );
  };

  // Render any value as a plain, readable string for the editorial prompt.
  const toReadable = (v: any): string => {
    if (isEmpty(v)) return '';
    if (typeof v === 'string') return normalizeText(v);
    if (isScalar(v)) return asText(v);
    if (Array.isArray(v)) return v.map(itemLabel).join('; ');
    return JSON.stringify(v);
  };

  // Compute the same set of meaningful changes the cards display, as a
  // serializable payload for the editorial endpoint.
  const computeChanges = () => {
    const allKeys = Array.from(new Set([...Object.keys(baseData || {}), ...Object.keys(compareData || {})]));
    return allKeys
      .filter(k => !IGNORED_FIELDS.has(k) && canonical(baseData?.[k]) !== canonical(compareData?.[k]))
      .map(k => ({
        field: k,
        kind: classifyChange(baseData ? baseData[k] : undefined, compareData ? compareData[k] : undefined),
        before: toReadable(baseData ? baseData[k] : undefined),
        after: toReadable(compareData ? compareData[k] : undefined),
      }));
  };

  const catalogLabel = (id: string) => {
    const cat = filteredCatalogs.find(c => c.id === id);
    return cat ? `Catalog ${cat.version}` : 'Catalog';
  };

  // Ask the AI editorial assistant to summarize the current diff.
  const handleGenerateEditorial = async () => {
    if (!baseData || !compareData) return;
    const changes = computeChanges();
    if (changes.length === 0) return;

    setEditorialLoading(true);
    setEditorialError('');
    setEditorialText('');
    setEditorialModel('');

    const identity =
      nodeType === 'Course' ? (baseData.course_code || 'Course')
      : nodeType === 'Program' ? (baseData.name || 'Program')
      : (baseData.section_header && baseData.section_header !== 'None'
          ? baseData.section_header
          : `Policy section (chunk ${baseData.sequence_order ?? ''})`);

    try {
      const res = await fetch('/api/diff-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeType,
          baseLabel: catalogLabel(baseCatalogId),
          compareLabel: catalogLabel(compareCatalogId),
          identity,
          changes,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setEditorialText(data.summary || '');
        setEditorialModel(data.model || '');
      } else {
        const err = await res.json().catch(() => ({}));
        setEditorialError(err.error || 'Failed to generate the editorial review.');
      }
    } catch (err: any) {
      setEditorialError(err.message || 'Failed to generate the editorial review.');
    } finally {
      setEditorialLoading(false);
    }
  };

  // The collapsible AI editorial review panel shown above the change cards.
  const renderEditorialPanel = (hasChanges = true) => (
    <div className="bg-[#090d16] border border-[#8C2232]/25 rounded-xl p-5 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-[#8C2232]" fill="currentColor" viewBox="0 0 24 24"><path d="M11 2l1.6 4.6L17 8l-4.4 1.4L11 14l-1.6-4.6L5 8l4.4-1.4L11 2zm7 9l.9 2.6L21 14l-2.1.4L18 17l-.9-2.6L15 14l2.1-.4L18 11z"/></svg>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">Editorial Review</h3>
        </div>
        {hasChanges && (
          <button
            onClick={handleGenerateEditorial}
            disabled={editorialLoading}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#8C2232] text-white hover:bg-[#a32a3c] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {editorialLoading ? 'Reviewing…' : editorialText ? 'Regenerate' : 'Generate review'}
          </button>
        )}
      </div>

      {!hasChanges && (
        <p className="text-xs text-slate-500 mt-2">
          These two versions match for this {nodeType.toLowerCase()} — there is nothing to review.
        </p>
      )}
      {hasChanges && !editorialText && !editorialLoading && !editorialError && (
        <p className="text-xs text-slate-500 mt-2">
          Have the AI editorial assistant summarize these changes in plain language and flag anything that may need a closer look.
        </p>
      )}
      {editorialError && <p className="text-xs text-red-400 mt-3">{editorialError}</p>}
      {editorialLoading && (
        <div className="flex items-center gap-3 text-xs text-slate-400 mt-3">
          <div className="w-4 h-4 border-2 border-[#8C2232] border-t-transparent rounded-full animate-spin"></div>
          Reading the differences and writing a review…
        </div>
      )}
      {editorialText && (
        <div className="mt-3 text-sm text-slate-300">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h2: ({node, ...props}) => <h2 className="text-xs font-bold uppercase tracking-wider text-[#B6CFD6] mt-4 mb-1.5 first:mt-0" {...props} />,
              h3: ({node, ...props}) => <h3 className="text-xs font-bold text-white mt-3 mb-1" {...props} />,
              p: ({node, ...props}) => <p className="mb-2 leading-relaxed text-slate-300" {...props} />,
              ul: ({node, ...props}) => <ul className="list-disc pl-5 space-y-1 mb-2 text-slate-300" {...props} />,
              li: ({node, ...props}) => <li className="leading-relaxed" {...props} />,
              strong: ({node, ...props}) => <strong className="font-semibold text-white" {...props} />,
              code: ({node, ...props}) => <code className="bg-black/40 px-1 py-0.5 rounded text-[#B6CFD6] text-[12px]" {...props} />,
            }}
          >
            {editorialText}
          </ReactMarkdown>
          {editorialModel && (
            <p className="text-[10px] text-slate-600 mt-3 italic border-t border-white/5 pt-2">
              Generated by {editorialModel}. AI-assisted — verify against the details below before acting.
            </p>
          )}
        </div>
      )}
    </div>
  );

  const renderDiffCards = () => {
    if (!compareCatalogId) {
      return (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm italic">
          Select a comparison catalog to view differences.
        </div>
      );
    }
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm italic">
          <div className="w-5 h-5 border-2 border-[#8C2232] border-t-transparent rounded-full animate-spin mr-3"></div>
          Analyzing diffs...
        </div>
      );
    }

    if (!baseData && !compareData) {
      return <div className="text-slate-500 text-center mt-10">No data found in either catalog.</div>;
    }

    // Policies are aligned by content similarity; when nothing comparable is
    // found, say so plainly rather than showing every field as "removed".
    if (nodeType === 'Policy' && matchInfo && matchInfo.method === 'none') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-sm p-8 max-w-md mx-auto">
          <svg className="w-12 h-12 text-amber-500/50 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <p className="text-slate-300 font-medium mb-1">No matching section found in the comparison catalog</p>
          <p className="text-slate-500">This policy section appears to be <span className="text-amber-400">new, removed, or substantially rewritten</span> between these two versions, so there is no close counterpart to compare against.</p>
        </div>
      );
    }

    // Banner describing how a policy chunk was aligned across the two versions.
    const matchBanner =
      nodeType === 'Policy' && matchInfo && (matchInfo.method === 'similarity' || matchInfo.method === 'header') ? (
        <div className="bg-[#0b0f1d] border border-[#B6CFD6]/15 rounded-xl px-4 py-2.5 flex items-center gap-2 text-xs">
          <svg className="w-4 h-4 text-[#B6CFD6] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span className="text-slate-400">
            {matchInfo.method === 'header'
              ? 'Sections aligned by matching heading.'
              : <>
                  Sections aligned by similarity
                  {typeof matchInfo.cosine === 'number'
                    ? <> (<span className="text-[#B6CFD6] font-semibold">{Math.round(matchInfo.cosine * 100)}% meaning</span>, <span className="text-[#B6CFD6] font-semibold">{Math.round((matchInfo.jaccard ?? 0) * 100)}% wording</span>)</>
                    : <> (<span className="text-[#B6CFD6] font-semibold">{Math.round((matchInfo.jaccard ?? matchInfo.score) * 100)}% wording</span>)</>}
                  {' '}— headings and page numbers differ between the two ingestions.
                </>}
          </span>
        </div>
      ) : null;

    const allKeys = Array.from(new Set([...Object.keys(baseData || {}), ...Object.keys(compareData || {})]));
    const changedKeys = allKeys.filter(k => {
      if (IGNORED_FIELDS.has(k)) return false;
      // Compare canonical (whitespace/quote-normalized) forms so cosmetic
      // ingestion differences and blank-vs-null do not count as changes.
      return canonical(baseData?.[k]) !== canonical(compareData?.[k]);
    });

    if (changedKeys.length === 0) {
      return (
        <div className="max-w-5xl mx-auto w-full space-y-4">
          {matchBanner}
          <div className="flex flex-col items-center justify-center text-slate-500 text-sm p-8">
            <svg className="w-12 h-12 text-emerald-500/50 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            No meaningful differences found between these versions for this {nodeType.toLowerCase()}.
          </div>
          {renderEditorialPanel(false)}
        </div>
      );
    }

    // Classify every change so we can build a plain-language summary up front
    const summarized = changedKeys.map(key => ({
      key,
      label: humanizeKey(key),
      kind: classifyChange(baseData ? baseData[key] : undefined, compareData ? compareData[key] : undefined),
    }));

    const kindStyles: Record<ChangeKind, { chip: string; word: string }> = {
      added: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', word: 'added' },
      removed: { chip: 'bg-red-500/15 text-red-300 border-red-500/30', word: 'removed' },
      modified: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30', word: 'changed' },
    };

    // Build a readable sentence, e.g. "Title and Credits were changed. Prerequisites were added."
    const sentenceFor = (kind: ChangeKind, verb: string) => {
      const items = summarized.filter(s => s.kind === kind).map(s => s.label);
      if (items.length === 0) return null;
      const list =
        items.length === 1 ? items[0]
        : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
      return `${list} ${items.length === 1 ? 'was' : 'were'} ${verb}.`;
    };
    const sentences = [
      sentenceFor('modified', 'changed'),
      sentenceFor('added', 'added'),
      sentenceFor('removed', 'removed'),
    ].filter(Boolean);

    return (
      <div className="space-y-4 max-w-5xl mx-auto w-full">
        {matchBanner}
        {/* Plain-language summary banner */}
        <div className="bg-[#090d16] border border-[#B6CFD6]/10 rounded-xl p-5 shadow-lg">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-bold text-white serif-title">{changedKeys.length}</span>
            <span className="text-sm text-slate-300 font-medium">
              {changedKeys.length === 1 ? 'field changed' : 'fields changed'} in this {nodeType.toLowerCase()}
            </span>
          </div>
          <p className="text-sm text-slate-400 leading-relaxed mb-3">{sentences.join(' ')}</p>
          <div className="flex flex-wrap gap-2">
            {summarized.map(s => (
              <span key={s.key} className={`text-[11px] font-medium border px-2 py-0.5 rounded-full ${kindStyles[s.kind].chip}`}>
                {s.label} {'\u00b7'} {kindStyles[s.kind].word}
              </span>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 mt-3 italic">
            Wording is compared by meaning - differences in spacing, line breaks, and quotes are ignored, as are ingestion fields like page number and source file.
          </p>
        </div>

        {/* AI editorial review */}
        {renderEditorialPanel()}

        {/* Per-field change cards: friendly summary first, raw details on demand */}
        {summarized.map(({ key, label, kind }) => {
          const bVal = baseData ? baseData[key] : undefined;
          const cVal = compareData ? compareData[key] : undefined;
          const isOpen = !!openCards[key];

          return (
            <div key={key} className="bg-[#090d16] border border-white/5 rounded-xl overflow-hidden shadow-lg animate-in fade-in slide-in-from-bottom-2">
              <div className="bg-black/40 px-4 py-2 border-b border-white/5 flex items-center justify-between">
                <span className="text-xs font-bold text-[#B6CFD6] uppercase tracking-widest font-mono">{label}</span>
                <span className={`text-[10px] font-medium border px-2 py-0.5 rounded ${kindStyles[kind].chip}`}>
                  {kindStyles[kind].word.charAt(0).toUpperCase() + kindStyles[kind].word.slice(1)}
                </span>
              </div>

              {/* Friendly, plain-language summary of what changed */}
              <div className="p-4">
                {renderChangeSummary(bVal, cVal)}
              </div>

              {/* Collapsible technical / side-by-side details */}
              <div className="border-t border-white/5">
                <button
                  onClick={() => toggleCard(key)}
                  className="w-full flex items-center justify-between px-4 py-2 text-[11px] font-mono uppercase tracking-wider text-slate-400 hover:text-[#B6CFD6] hover:bg-white/5 transition-colors"
                >
                  <span>{isOpen ? 'Hide details' : 'View details'}</span>
                  <svg className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {isOpen && (
                  <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-white/5 border-t border-white/5">
                    <div className="flex-1 p-4 bg-red-900/5">
                      <div className="text-[10px] text-red-400/70 font-mono mb-2 uppercase font-bold tracking-wider">Base Catalog</div>
                      <div className="text-sm text-slate-300 font-sans break-words">
                        {bVal !== undefined ? renderValue(bVal) : <span className="italic text-slate-600">-- Missing in Base --</span>}
                      </div>
                    </div>
                    <div className="flex-1 p-4 bg-emerald-900/5">
                      <div className="text-[10px] text-emerald-400/70 font-mono mb-2 uppercase font-bold tracking-wider">Comparison Catalog</div>
                      <div className="text-sm text-emerald-100 font-sans break-words">
                        {cVal !== undefined ? renderValue(cVal) : <span className="italic text-slate-600">-- Missing in Compare --</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col gap-6 animate-in fade-in duration-300 font-sans">
      {/* Header */}
      <div className="bg-[#0b0f1d] p-6 rounded-xl border border-[#B6CFD6]/10 shrink-0 shadow-lg relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-5">
           <svg className="w-32 h-32" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        </div>
        <h2 className="text-xl font-bold text-white serif-title mb-2">Catalog Diff Log</h2>
        <p className="text-xs text-slate-400 font-medium">Pick two catalog versions to see a plain-language summary of what changed for a course, program, or policy - open any item for the full side-by-side detail.</p>
        
        <div className="mt-6 flex flex-col md:flex-row gap-4 md:items-end relative z-10">
          <div className="w-full md:flex-1 min-w-0 md:min-w-[200px]">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Base Catalog</label>
            <select
              value={baseCatalogId}
              onChange={(e) => setBaseCatalogId(e.target.value)}
              className="w-full bg-[#090d16] border border-[#B6CFD6]/20 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232] transition-colors shadow-inner truncate"
            >
              {filteredCatalogs.map(cat => (
                <option key={cat.id} value={cat.id}>Catalog {cat.version}</option>
              ))}
            </select>
          </div>
          
          <div className="hidden md:flex items-center justify-center h-10 px-2 shrink-0 text-slate-500">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
          </div>
          <div className="md:hidden flex justify-center text-slate-500 py-1">
            <svg className="w-5 h-5 rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
          </div>

          <div className="w-full md:flex-1 min-w-0 md:min-w-[200px]">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Comparison Catalog</label>
            <select
              value={compareCatalogId}
              onChange={(e) => setCompareCatalogId(e.target.value)}
              className="w-full bg-[#090d16] border border-[#B6CFD6]/20 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232] transition-colors shadow-inner truncate"
            >
              <option value="">-- Select Catalog to Compare --</option>
              {filteredCatalogs.filter(c => c.id !== baseCatalogId).map(cat => (
                <option key={cat.id} value={cat.id}>Catalog {cat.version}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-col md:flex-row gap-4 md:items-end relative z-10">
          <div className="w-full md:w-[150px] shrink-0">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Chunk Type</label>
            <select
              value={nodeType}
              onChange={(e) => setNodeType(e.target.value as any)}
              className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232] shadow-inner"
            >
              <option value="Course">Courses</option>
              <option value="Program">Programs</option>
              <option value="Policy">Policies</option>
            </select>
          </div>

          <div className="w-full md:flex-1 min-w-0 md:min-w-[300px]">
            <label className="block text-[10px] font-bold text-[#B6CFD6] uppercase tracking-widest mb-1 font-mono">Select {nodeType}</label>
            <select
              value={selectedNodeId}
              onChange={(e) => setSelectedNodeId(e.target.value)}
              className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[#8C2232] shadow-inner truncate"
              disabled={loading || nodes.length === 0}
            >
              {nodes.map(node => (
                <option key={node.id} value={node.id}>
                  {nodeType === 'Course' ? node.course_code : nodeType === 'Program' ? node.name : `Section: ${node.section_header} (Page ${node.page_number})`}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Structured Diff View */}
      <div className="flex-1 bg-[#0b0f1d] border border-white/5 rounded-xl overflow-y-auto custom-scrollbar p-6 shadow-xl flex flex-col relative">
        <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
           <svg className="w-64 h-64 text-[#B6CFD6]" fill="currentColor" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        </div>
        <div className="relative z-10 w-full flex-1 flex flex-col">
          <div className="flex items-center gap-2 mb-6">
            <svg className="w-5 h-5 text-[#8C2232]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">Semantic Differences</h3>
          </div>
          {renderDiffCards()}
        </div>
      </div>
    </div>
  );
}
