import { NextResponse } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { randomUUID } from 'crypto';
import { norm, extractCodes, auditDocument } from '@/app/api/catalog/audit/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TENANT = 'CCSJ';

const numberOf = (code: string) => norm(code).split(' ')[1] || '';
const prefixOf = (code: string) => norm(code).split(' ')[0] || '';

/** Small Levenshtein (for near-prefix matching, e.g. MATH<->MAT, BGMT<->BSMT). */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

type MechOp = {
  courseId: string;
  courseCode: string;
  before: { prerequisites: string | null; courses: string[] };
  after: { prerequisites: string; courses: string[]; json: any };
  substitutions: { from: string; to: string }[];
};
type Judgment = { type: string; course: string; detail: string; proposed: string };

/**
 * Classify the catalog's data-quality findings into a mechanical lane (auto-fixable: prefix-typo
 * remaps + text/json drift) and a judgment lane (genuinely-missing courses + cycles → review queue).
 * Pure reads; returns the planned writes without performing them.
 */
async function buildPlan(catalogId: string) {
  const courses = await query(
    `SELECT id, course_code, prerequisites, prerequisites_json FROM courses WHERE document_id = $1`,
    [catalogId]
  );
  const codeSet = new Set(courses.map((c) => norm(c.course_code)));
  const idByCode = new Map(courses.map((c) => [norm(c.course_code), c.id]));
  const byNumber = new Map<string, string[]>();
  for (const c of courses) {
    const code = norm(c.course_code);
    const n = numberOf(code);
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n)!.push(code);
  }

  // Unique near-prefix, same-number remap target for a dangling code (else null).
  const remapTarget = (bad: string): string | null => {
    const cands = (byNumber.get(numberOf(bad)) || []).filter(
      (cand) => cand !== bad && editDistance(prefixOf(cand), prefixOf(bad)) <= 2
    );
    return cands.length === 1 ? cands[0] : null;
  };

  const mechanical: MechOp[] = [];
  const judgment: Judgment[] = [];

  for (const c of courses) {
    const code = norm(c.course_code);
    const text: string = c.prerequisites || '';
    const jsonCodes: string[] = Array.isArray(c.prerequisites_json?.courses)
      ? c.prerequisites_json.courses.map(norm)
      : [];

    const referenced = new Set<string>([...jsonCodes, ...extractCodes(text)]);
    const dangling = [...referenced].filter((r) => !codeSet.has(r));
    const subs: { from: string; to: string }[] = [];
    const missing: string[] = [];
    for (const d of dangling) {
      const t = remapTarget(d);
      if (t) subs.push({ from: d, to: t });
      else missing.push(d);
    }

    // Conservative: a genuinely-missing course is a judgment call — do NOT auto-edit this course.
    if (missing.length > 0) {
      for (const m of missing) {
        judgment.push({
          type: 'dangling',
          course: code,
          detail: `${code} requires "${m}", which is not a course in this catalog.`,
          proposed: `Resolve dangling prerequisite for ${code}: "${m}" is not a course in this catalog — add ${m}, correct the code, or remove it from the prerequisites.`,
        });
      }
      continue;
    }

    // Don't auto-derive prereqs from empty text (that would wipe a course whose prereqs live only
    // in json) — leave those as warnings / judgment rather than risk a destructive reconcile.
    if (!text.trim()) continue;

    // Mechanical: apply prefix remaps to the text, then reconcile json to the (corrected) text.
    let newText = text;
    for (const s of subs) newText = newText.replace(new RegExp(`\\b${s.from.replace(/\s+/g, '\\s*')}\\b`, 'gi'), s.to);
    const finalCodes = Array.from(new Set(extractCodes(newText).filter((x) => codeSet.has(x))));

    const sameCourses = finalCodes.length === jsonCodes.length && finalCodes.every((x, i) => x === jsonCodes[i]);
    if (newText === text && sameCourses) continue; // already consistent

    const lower = newText.toLowerCase();
    const json = {
      courses: finalCodes,
      raw_text: newText,
      conditions: /concurrent/i.test(newText) ? ['Concurrent enrollment required'] : [],
      logic_type: finalCodes.length <= 1 ? 'SINGLE' : lower.includes(' or ') ? 'OR' : 'AND',
    };
    mechanical.push({
      courseId: c.id,
      courseCode: code,
      before: { prerequisites: c.prerequisites, courses: jsonCodes },
      after: { prerequisites: newText, courses: finalCodes, json },
      substitutions: subs,
    });
  }

  // Cycles -> judgment (reuse the audit analyzer).
  const audit = await auditDocument(catalogId);
  for (const f of audit.findings) {
    if (f.type === 'cycle') {
      judgment.push({ type: 'cycle', course: f.course, detail: f.detail, proposed: `Break prerequisite cycle: ${f.detail} Decide which prerequisite to remove.` });
    }
  }

  return { courses, codeSet, idByCode, mechanical, judgment };
}

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
    return NextResponse.json({ error: 'Forbidden: Only registrars and owners can remediate.' }, { status: 403 });
  }

  const { catalogId, mode = 'preview' } = await req.json();
  if (!catalogId) return NextResponse.json({ error: 'catalogId is required.' }, { status: 400 });

  try {
    return await runRemediation({ catalogId, mode, userId });
  } catch (e: any) {
    console.error('Remediate Error:', e);
    return NextResponse.json({ error: e.message || 'Remediation failed.' }, { status: 500 });
  }
}

/** Shared by the manual route and the cron route. Omit userId for the scheduled/service path
 * (runs as the privileged DB role, bypassing RLS — used by the authenticated cron endpoint). */
export async function runRemediation({ catalogId, mode, userId }: { catalogId: string; mode: string; userId?: string }) {
  const plan = await buildPlan(catalogId);

  const mechPreview = plan.mechanical.map((m) => ({
    course: m.courseCode,
    remaps: m.substitutions,
    before: m.before.prerequisites,
    after: m.after.prerequisites,
  }));
  const summary = { mechanical: plan.mechanical.length, judgment: plan.judgment.length };

  if (mode === 'preview') {
    return NextResponse.json({ catalogId, mode, summary, mechanical: mechPreview, judgment: plan.judgment });
  }

  // apply
  const client = await getClient();
  let appliedMechanical = 0;
  let filedJudgment = 0;
  try {
    await client.query('BEGIN');
    if (userId) {
      // Registrar path: enforce RLS as the acting user.
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT]);
      await client.query(`SET LOCAL ROLE authenticated`);
    }
    // else: scheduled/service path runs as the privileged DB role (RLS bypassed).

    for (const m of plan.mechanical) {
      await client.query(
        `UPDATE courses SET prerequisites = $1, prerequisites_json = $2::jsonb WHERE id = $3 AND document_id = $4`,
        [m.after.prerequisites, JSON.stringify(m.after.json), m.courseId, catalogId]
      );
      // Rebuild this course's prerequisite edges from the corrected json.
      await client.query(`DELETE FROM course_prerequisite_links WHERE course_id = $1 AND tenant_id = $2`, [m.courseId, TENANT]);
      for (const pc of m.after.courses) {
        const prereqId = plan.idByCode.get(pc);
        if (prereqId) {
          await client.query(
            `INSERT INTO course_prerequisite_links (id, course_id, prereq_course_id, tenant_id) VALUES ($1, $2, $3, $4)`,
            [randomUUID(), m.courseId, prereqId, TENANT]
          );
        }
      }
      appliedMechanical++;
    }

    for (const j of plan.judgment) {
      // Dedup: skip if an open proposal with the same text already exists.
      const dup = await client.query(
        `SELECT 1 FROM corrections WHERE tenant_id = $1 AND status IN ('pending','approved') AND proposed_value = $2 LIMIT 1`,
        [TENANT, j.proposed]
      );
      if (dup.rows.length) continue;
      await client.query(
        `INSERT INTO corrections (tenant_id, target_table, target_row_id, field_name, current_value, proposed_value, reason, status, submitted_by)
         VALUES ($1, 'courses', NULL, 'prerequisites', NULL, $2, $3, 'pending', 'Remediation')`,
        [TENANT, j.proposed, `Data-quality remediation (${j.type})`]
      );
      filedJudgment++;
    }

    await client.query('COMMIT');
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }

  return NextResponse.json({ catalogId, mode, appliedMechanical, filedJudgment, summary });
}
