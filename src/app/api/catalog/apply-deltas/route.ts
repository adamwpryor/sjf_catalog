import { NextResponse } from 'next/server';
import { query, getClient, queryWithAuth } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID } from '@/lib/brand';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const TENANT = TENANT_ID;
const API_BASE_URL = process.env.NEXT_PUBLIC_SWARM_API_URL || 'http://localhost:8080';

const COURSE_COLS = ['prerequisites', 'prerequisites_json', 'credits', 'description', 'title'];
const PROGRAM_COLS = ['name', 'mission_statement', 'program_outcome_objectives'];

type ReadFn = (sql: string, params: any[]) => Promise<any[]>;

/** Escape regex metacharacters so a label can be used literally inside a Postgres regex. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const CODE_STOPWORDS = new Set(['AND', 'OR', 'THE', 'FOR', 'GPA', 'SJF', 'ONE', 'TWO', 'SEE', 'FEE', 'NOT', 'ANY', 'ALL', 'MIN', 'MAX', 'PER', 'NONE']);

/**
 * Extract course codes from free text, honoring shorthand where a bare number inherits the previous
 * subject ("PSY 100 and 210" -> PSY 100, PSY 210). Subjects must be UPPERCASE, so "and"/"or" are not
 * mis-read as prefixes.
 */
function extractCourseCodes(text: string): string[] {
  const out = new Set<string>();
  const tokens = String(text || '').match(/\b[A-Z]{2,4}\b|\b\d{3}[A-Z]?\b/g) || [];
  let subject = '';
  for (const t of tokens) {
    if (/^\d/.test(t)) { if (subject) out.add(`${subject} ${t}`); }
    else if (!CODE_STOPWORDS.has(t)) subject = t;
  }
  return Array.from(out);
}

/** Cast an LLM string value to the right type for a given column. */
function castValue(col: string, value: string): any {
  if (col === 'credits') {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  if (col === 'prerequisites_json') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/** Stable equality for diffing (handles json objects). */
function eq(a: any, b: any): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Resolve one approved correction into a concrete, draft-scoped plan of writes,
 * with old->new diffs. Pure reads via `read` — no mutations here.
 */
async function resolveCorrection(read: ReadFn, draftId: string, corr: any) {
  const text = `${corr.proposed_value || ''}\n${corr.reason || ''}`;
  const codes = extractCourseCodes(text);
  const action = (corr.reason || '').match(/—\s*(ADD|DELETE|AMEND)/i)?.[1]?.toUpperCase() || '';
  const programHint = (corr.reason || '').split('—')[0].trim();

  // Candidate draft rows the instruction most likely touches.
  const courseRows = codes.length
    ? await read(
        `SELECT id, course_code, title, credits, description, prerequisites, prerequisites_json
           FROM courses WHERE document_id = $1 AND course_code = ANY($2)`,
        [draftId, codes]
      )
    : [];
  const programRows = programHint
    ? await read(
        `SELECT id, name, mission_statement, program_outcome_objectives
           FROM programs WHERE document_id = $1 AND name ILIKE $2 LIMIT 10`,
        [draftId, `%${programHint}%`]
      )
    : [];

  const candidate_rows = [
    ...courseRows.map((r) => ({ table: 'courses', ...r })),
    ...programRows.map((r) => ({ table: 'programs', ...r })),
  ];

  // Ask the backend LLM to map the instruction onto a code-keyed operation spec.
  const resp = await fetch(`${API_BASE_URL}/api/agent/resolve-delta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: corr.proposed_value, action, candidate_rows }),
  });
  if (!resp.ok) {
    return { correctionId: corr.id, reason: corr.reason, status: 'error', note: `resolve-delta ${resp.status}: ${await resp.text()}`, diffs: [], ops: null };
  }
  const spec = await resp.json();

  if (spec.needs_review || spec.confidence !== 'high') {
    return { correctionId: corr.id, reason: corr.reason, status: 'needs_review', note: spec.reason || 'Low confidence / no structured target.', diffs: [], ops: null };
  }

  const diffs: any[] = [];
  const ops: any = { courseUpdates: [], courseInserts: [], programUpdates: [], programRenames: [], edgeAdds: [], edgeRemoves: [] };

  // Helper: resolve a course_code to draft course row ids.
  const courseIdsByCode = async (code: string): Promise<string[]> => {
    const rows = await read(`SELECT id FROM courses WHERE document_id = $1 AND course_code = $2`, [draftId, code]);
    return rows.map((r) => r.id);
  };

  // course_updates (existing rows)
  for (const cu of spec.course_updates || []) {
    const rows = await read(
      `SELECT id, course_code, ${COURSE_COLS.join(', ')} FROM courses WHERE document_id = $1 AND course_code = $2`,
      [draftId, cu.course_code]
    );
    if (rows.length === 0) {
      diffs.push({ kind: 'course', code: cu.course_code, note: 'No matching course in draft — skipped.' });
      continue;
    }
    const set: Record<string, any> = {};
    for (const ch of cu.changes || []) {
      if (!COURSE_COLS.includes(ch.column)) continue;
      set[ch.column] = castValue(ch.column, ch.value);
    }
    for (const row of rows) {
      const before: Record<string, any> = {};
      const after: Record<string, any> = {};
      for (const [col, val] of Object.entries(set)) {
        if (eq(row[col], val)) continue;
        before[col] = row[col]; after[col] = val;
      }
      if (Object.keys(after).length === 0) continue;
      ops.courseUpdates.push({ id: row.id, set: after });
      diffs.push({ kind: 'course', code: cu.course_code, before, after });
    }
  }

  // program_updates (existing rows)
  for (const pu of spec.program_updates || []) {
    const rows = await read(
      `SELECT id, name, ${PROGRAM_COLS.join(', ')} FROM programs WHERE document_id = $1 AND name = $2`,
      [draftId, pu.program_name]
    );
    const targets = rows.length ? rows : await read(
      `SELECT id, name, ${PROGRAM_COLS.join(', ')} FROM programs WHERE document_id = $1 AND name ILIKE $2`,
      [draftId, pu.program_name]
    );
    if (targets.length === 0) {
      diffs.push({ kind: 'program', name: pu.program_name, note: 'No matching program in draft — skipped.' });
      continue;
    }
    const set: Record<string, any> = {};
    for (const ch of pu.changes || []) {
      if (!PROGRAM_COLS.includes(ch.column)) continue;
      set[ch.column] = ch.value;
    }
    // A program RENAME must cascade — the old name also lives in the degree label, section headers,
    // the TOC source, and program prose. Emit a token rename (handled in applyOps) instead of a
    // narrow name field-set, and keep any other column changes for the per-row update below.
    if (set.name !== undefined && String(set.name).trim() && String(set.name).trim().toLowerCase() !== pu.program_name.trim().toLowerCase()) {
      const from = pu.program_name.trim();
      const to = String(set.name).trim();
      ops.programRenames.push({ from, to });
      diffs.push({ kind: 'program', name: pu.program_name, rename: { from, to } });
      delete set.name;
    }
    for (const row of targets) {
      const before: Record<string, any> = {};
      const after: Record<string, any> = {};
      for (const [col, val] of Object.entries(set)) {
        if (eq(row[col], val)) continue;
        before[col] = row[col]; after[col] = val;
      }
      if (Object.keys(after).length === 0) continue;
      ops.programUpdates.push({ id: row.id, set: after });
      diffs.push({ kind: 'program', name: pu.program_name, before, after });
    }
  }

  // course_inserts (ADD). Inherit subject/institution from a draft sibling by prefix.
  for (const ci of spec.course_inserts || []) {
    const exists = await read(`SELECT 1 FROM courses WHERE document_id = $1 AND course_code = $2 LIMIT 1`, [draftId, ci.course_code]);
    if (exists.length) {
      diffs.push({ kind: 'insert', code: ci.course_code, note: 'Already exists in draft — skipped.' });
      continue;
    }
    const prefix = (ci.course_code.split(/\s|\d/)[0] || '').toUpperCase();
    const sib = (await read(
      `SELECT subject_id, institution_id, section FROM courses WHERE document_id = $1 AND course_code ILIKE $2 LIMIT 1`,
      [draftId, `${prefix}%`]
    ))[0] || {};
    const values: Record<string, any> = {
      title: ci.title,
      subject_id: sib.subject_id ?? null,
      institution_id: sib.institution_id ?? null,
      section: sib.section ?? null,
    };
    for (const ch of ci.changes || []) {
      if (!COURSE_COLS.includes(ch.column)) continue;
      values[ch.column] = castValue(ch.column, ch.value);
    }
    // Don't silently insert incomplete courses. Committee ADDs rarely include a full description or
    // credit hours; give a clear placeholder and flag what's missing so it surfaces for completion.
    const missing = [
      (!values.description || !String(values.description).trim()) ? 'description' : null,
      values.credits == null ? 'credits' : null,
    ].filter(Boolean);
    if (!values.description || !String(values.description).trim()) {
      values.description = '(Course added by committee action; description pending completion.)';
    }
    ops.courseInserts.push({ course_code: ci.course_code, values });
    diffs.push({
      kind: 'insert', code: ci.course_code, after: { title: ci.title, ...values },
      ...(missing.length ? { incomplete: true, note: `Inserted without ${missing.join(' & ')} — needs completion.` } : {}),
    });
  }

  // prereq_edge_changes -> structured course_prerequisite_links
  for (const ec of spec.prereq_edge_changes || []) {
    const courseIds = await courseIdsByCode(ec.course_code);
    if (!courseIds.length) continue;
    for (const code of ec.remove || []) {
      const prereqIds = await courseIdsByCode(code);
      for (const cid of courseIds) for (const pid of prereqIds) {
        ops.edgeRemoves.push({ course_id: cid, prereq_course_id: pid });
      }
      diffs.push({ kind: 'edge', op: 'remove', course: ec.course_code, prereq: code });
    }
    for (const code of ec.add || []) {
      const prereqIds = await courseIdsByCode(code);
      for (const cid of courseIds) for (const pid of prereqIds) {
        ops.edgeAdds.push({ course_id: cid, prereq_course_id: pid });
      }
      diffs.push({ kind: 'edge', op: 'add', course: ec.course_code, prereq: code });
    }
  }

  const hasWork =
    ops.courseUpdates.length || ops.courseInserts.length || ops.programUpdates.length ||
    ops.programRenames.length || ops.edgeAdds.length || ops.edgeRemoves.length;

  return {
    correctionId: corr.id,
    reason: corr.reason,
    status: hasWork ? 'ready' : 'needs_review',
    note: hasWork ? '' : 'Resolved to no concrete change against the draft.',
    diffs,
    ops: hasWork ? ops : null,
  };
}

/** Execute one correction's ops against the draft within an open transaction client. */
async function applyOps(client: any, draftId: string, ops: any): Promise<void> {
  for (const u of ops.courseUpdates) {
    const cols = Object.keys(u.set);
    const sets = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
    const vals = cols.map((c) => (c === 'prerequisites_json' ? JSON.stringify(u.set[c]) : u.set[c]));
    await client.query(`UPDATE courses SET ${sets} WHERE id = $1 AND document_id = $${cols.length + 2}`, [u.id, ...vals, draftId]);
  }
  for (const p of ops.programUpdates) {
    const cols = Object.keys(p.set);
    const sets = cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
    const vals = cols.map((c) => p.set[c]);
    await client.query(`UPDATE programs SET ${sets} WHERE id = $1 AND document_id = $${cols.length + 2}`, [p.id, ...vals, draftId]);
  }
  // Program RENAME cascade: replace the old name token everywhere it appears — the programs row, the
  // degree label and section headers (which drive grouping + the TOC), and program prose. Uses a
  // case-sensitive word-boundary match so lowercase field mentions and plurals ("Life Sciences") are
  // left alone.
  for (const r of ops.programRenames || []) {
    const pat = `\\y${escapeRe(r.from)}\\y`;
    await client.query(
      `UPDATE programs SET name = regexp_replace(name, $2, $3, 'g') WHERE document_id = $1 AND name ~ $2`,
      [draftId, pat, r.to]
    );
    await client.query(
      `UPDATE semantic_chunks
          SET section_header = regexp_replace(section_header, $2, $3, 'g'),
              content        = regexp_replace(content, $2, $3, 'g')
        WHERE document_id = $1 AND (section_header ~ $2 OR content ~ $2)`,
      [draftId, pat, r.to]
    );
  }
  for (const ins of ops.courseInserts) {
    const values = { id: randomUUID(), document_id: draftId, tenant_id: TENANT, course_code: ins.course_code, ...ins.values };
    const cols = Object.keys(values);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = cols.map((c) => (c === 'prerequisites_json' ? JSON.stringify((values as any)[c]) : (values as any)[c]));
    await client.query(`INSERT INTO courses (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`, vals);
  }
  for (const e of ops.edgeRemoves) {
    await client.query(`DELETE FROM course_prerequisite_links WHERE course_id = $1 AND prereq_course_id = $2 AND tenant_id = $3`, [e.course_id, e.prereq_course_id, TENANT]);
  }
  for (const e of ops.edgeAdds) {
    await client.query(
      `INSERT INTO course_prerequisite_links (id, course_id, prereq_course_id, tenant_id)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM course_prerequisite_links WHERE course_id = $2 AND prereq_course_id = $3 AND tenant_id = $4)`,
      [randomUUID(), e.course_id, e.prereq_course_id, TENANT]
    );
  }
}

/**
 * Apply approved delta corrections to a draft catalog.
 *
 * mode=preview: resolve each approved correction to a field-level diff (no writes).
 * mode=apply:   write confirmed corrections to the draft in one transaction and mark
 *               them 'applied'. Low-confidence/unresolvable corrections stay 'approved'.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !session.user) {
    return NextResponse.json({ error: 'Forbidden: Authentication required.' }, { status: 401 });
  }
  const userId = session.user.id;

  const roleRows = await query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
  const role = roleRows.length ? roleRows[0].role : null;
  if (!role || !['registrar', 'owner'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden: Only registrars and owners can apply corrections.' }, { status: 403 });
  }

  const { draftId, mode = 'preview', confirmedCorrectionIds } = await req.json();
  if (!draftId) return NextResponse.json({ error: 'draftId is required.' }, { status: 400 });

  const draft = await query("SELECT id, version FROM documents WHERE id = $1", [draftId]);
  if (!draft.length) return NextResponse.json({ error: 'Draft catalog not found.' }, { status: 404 });
  if (!/\(Draft\)/i.test(draft[0].version)) {
    return NextResponse.json({ error: 'Target catalog is not a draft. Corrections can only be applied to a draft.' }, { status: 400 });
  }

  // Approved corrections for the tenant (optionally narrowed to a confirmed set).
  let corrSql = `SELECT id, proposed_value, reason FROM corrections WHERE tenant_id = $1 AND status = 'approved'`;
  const corrParams: any[] = [TENANT];
  if (Array.isArray(confirmedCorrectionIds) && confirmedCorrectionIds.length) {
    corrSql += ` AND id = ANY($2)`;
    corrParams.push(confirmedCorrectionIds);
  }
  corrSql += ` ORDER BY submitted_at ASC`;
  const corrections = await queryWithAuth(corrSql, corrParams, userId);

  try {
    if (mode === 'preview') {
      const read: ReadFn = (sql, params) => queryWithAuth(sql, params, userId);
      const results = [];
      for (const c of corrections) results.push(await resolveCorrection(read, draftId, c));
      return NextResponse.json({ draftId, mode, results });
    }

    if (mode === 'apply') {
      const client = await getClient();
      const applied: any[] = [];
      const skipped: any[] = [];
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
        // Relationship tables (e.g. course_prerequisite_links) are guarded ONLY by a
        // tenant-isolation RLS policy (tenant_id = current_setting('app.current_tenant')),
        // unlike courses/programs which also have a registrar/owner "Write Access" policy.
        // Set the tenant GUC so edge inserts/deletes pass RLS.
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT]);
        await client.query(`SET LOCAL ROLE authenticated`);
        const read: ReadFn = async (sql, params) => (await client.query(sql, params)).rows;

        for (const c of corrections) {
          const plan = await resolveCorrection(read, draftId, c);
          if (plan.status !== 'ready' || !plan.ops) {
            skipped.push({ correctionId: c.id, reason: c.reason, status: plan.status, note: plan.note });
            continue;
          }
          await applyOps(client, draftId, plan.ops);
          await client.query(
            `UPDATE corrections SET status = 'applied', reviewed_at = now(), applied_at = now(),
                    applied_to_document_id = $2, applied_patch = $3
               WHERE id = $1 AND tenant_id = $4`,
            [c.id, draftId, JSON.stringify({ diffs: plan.diffs }), TENANT]
          );
          applied.push({ correctionId: c.id, reason: c.reason, diffs: plan.diffs });
        }
        await client.query('COMMIT');
      } catch (e: any) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
      return NextResponse.json({ draftId, mode, appliedCount: applied.length, applied, needsReview: skipped });
    }

    return NextResponse.json({ error: `Unknown mode '${mode}'.` }, { status: 400 });
  } catch (e: any) {
    console.error('Apply Deltas Error:', e);
    return NextResponse.json({ error: e.message || 'Failed to apply corrections.' }, { status: 500 });
  }
}
