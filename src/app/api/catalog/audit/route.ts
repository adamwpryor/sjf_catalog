import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export const norm = (s: any): string => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export type AuditFinding = { severity: 'critical' | 'warning'; type: string; course: string; detail: string };

// Conjunctions / short words that look like a 2-4 letter subject but never are one.
const CODE_STOPWORDS = new Set(['AND', 'OR', 'THE', 'FOR', 'GPA', 'CCSJ', 'ONE', 'TWO', 'SEE', 'FEE', 'NOT', 'ANY', 'ALL', 'MIN', 'MAX', 'PER', 'NONE']);

/**
 * Extract catalog course codes from prerequisite text, honoring the catalog's shorthand where a bare
 * number inherits the previous subject (e.g. "PSY 100 and 210" -> PSY 100, PSY 210; "MATH 104, 110,
 * or 171" -> MATH 104/110/171). Subjects must be UPPERCASE in the source, so lowercase words like
 * "and"/"or"/"permission" are ignored rather than mis-read as prefixes ("AND 210").
 */
export function extractCodes(text: string): string[] {
  const out = new Set<string>();
  const tokens = String(text || '').match(/\b[A-Z]{2,4}\b|\b\d{3}[A-Z]?\b/g) || [];
  let subject = '';
  for (const t of tokens) {
    if (/^\d/.test(t)) { if (subject) out.add(`${subject} ${t}`); }
    else if (!CODE_STOPWORDS.has(t)) subject = t;
  }
  return Array.from(out);
}

/** Find cycles in a code->prereq-codes adjacency map via DFS. Returns cycle paths. */
export function findCycles(adj: Map<string, Set<string>>): string[][] {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const dfs = (node: string) => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (!adj.has(next)) continue; // only follow edges within the draft graph
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        const idx = stack.indexOf(next);
        const cycle = stack.slice(idx).concat(next);
        const key = [...cycle].sort().join('>');
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
      } else if (c === WHITE) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of adj.keys()) if ((color.get(node) ?? WHITE) === WHITE) dfs(node);
  return cycles;
}

type Finding = { severity: 'critical' | 'warning'; type: string; course: string; detail: string };
const sig = (f: Finding) => `${f.type}|${f.course}|${f.detail}`;

/** Deterministic, document-scoped curriculum-graph findings (dangling / orphan_edge / cycle / drift). */
export async function auditDocument(docId: string): Promise<{ findings: Finding[]; courses: number; edges: number }> {
  const courses = await query(
    `SELECT id, course_code, prerequisites, prerequisites_json FROM courses WHERE document_id = $1`,
    [docId]
  );
  const links = await query(
    `SELECT course_id, prereq_course_id FROM course_prerequisite_links
      WHERE course_id IN (SELECT id FROM courses WHERE document_id = $1)`,
    [docId]
  );

  const codeSet = new Set(courses.map((c) => norm(c.course_code)));
  const docCourseIds = new Set(courses.map((c) => c.id));
  const codeById = new Map(courses.map((c) => [c.id, norm(c.course_code)]));
  const findings: Finding[] = [];
  const adj = new Map<string, Set<string>>();

  for (const c of courses) {
    const code = norm(c.course_code);
    if (!adj.has(code)) adj.set(code, new Set());
    const jsonCodes: string[] = Array.isArray(c.prerequisites_json?.courses)
      ? c.prerequisites_json.courses.map(norm)
      : [];
    for (const pc of jsonCodes) {
      adj.get(code)!.add(pc);
      if (!codeSet.has(pc)) {
        findings.push({ severity: 'critical', type: 'dangling', course: code, detail: `requires "${pc}", which is not a course in this catalog.` });
      }
    }
    const textCodes = new Set(extractCodes(c.prerequisites || '').filter((x) => codeSet.has(x)));
    const jsonSet = new Set(jsonCodes);
    for (const t of textCodes) if (!jsonSet.has(t)) findings.push({ severity: 'warning', type: 'drift', course: code, detail: `prerequisites text mentions "${t}" but it is missing from the structured prerequisites_json.` });
    for (const j of jsonSet) if (codeSet.has(j) && !textCodes.has(j)) findings.push({ severity: 'warning', type: 'drift', course: code, detail: `prerequisites_json lists "${j}" but it is not mentioned in the prerequisites text.` });
  }

  for (const l of links) {
    if (!docCourseIds.has(l.prereq_course_id)) {
      findings.push({ severity: 'critical', type: 'orphan_edge', course: codeById.get(l.course_id) || '(unknown)', detail: `has a prerequisite link to a course outside this catalog.` });
    }
  }
  for (const cycle of findCycles(adj)) {
    findings.push({ severity: 'critical', type: 'cycle', course: cycle[0], detail: `prerequisite cycle: ${cycle.join(' → ')}.` });
  }

  return { findings, courses: courses.length, edges: links.length };
}

/**
 * Curriculum Graph Audit (Catalog Production Step 3), provenance-aware.
 *
 * Runs the deterministic graph audit on the draft and (if a source catalog is given) on the source,
 * then labels each draft finding `new` (introduced this cycle) vs `inherited` (already in the source).
 * Publish gates only on NEW criticals; inherited findings are an informational data-quality backlog.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !session.user) {
    return NextResponse.json({ error: 'Forbidden: Authentication required.' }, { status: 401 });
  }

  const { draftId, sourceCatalogId } = await req.json();
  if (!draftId) return NextResponse.json({ error: 'draftId is required.' }, { status: 400 });

  const doc = await query('SELECT id, version FROM documents WHERE id = $1', [draftId]);
  if (!doc.length) return NextResponse.json({ error: 'Catalog not found.' }, { status: 404 });

  const draft = await auditDocument(draftId);

  // Provenance: a draft finding is "inherited" if the same signature exists in the source catalog.
  let sourceSigs = new Set<string>();
  if (sourceCatalogId && sourceCatalogId !== draftId) {
    const src = await auditDocument(sourceCatalogId);
    sourceSigs = new Set(src.findings.map(sig));
  }
  const haveSource = sourceSigs.size > 0 || (sourceCatalogId && sourceCatalogId !== draftId);

  const findings = draft.findings.map((f) => ({
    ...f,
    origin: haveSource ? (sourceSigs.has(sig(f)) ? 'inherited' : 'new') : 'new',
  }));

  const count = (origin: 'new' | 'inherited', sev: 'critical' | 'warning') =>
    findings.filter((f) => f.origin === origin && f.severity === sev).length;

  const summary = {
    courses: draft.courses,
    edges: draft.edges,
    hasSource: !!haveSource,
    new: { critical: count('new', 'critical'), warning: count('new', 'warning') },
    inherited: { critical: count('inherited', 'critical'), warning: count('inherited', 'warning') },
    critical: findings.filter((f) => f.severity === 'critical').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    passed: count('new', 'critical') === 0,
  };

  // New findings first so the registrar sees what this cycle introduced.
  findings.sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'new' ? -1 : 1));

  return NextResponse.json({ draftId, version: doc[0].version, summary, findings });
}
