import { NextResponse } from 'next/server';
import { query, queryWithAuth } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID, FEATURES } from '@/lib/brand';
import { callLLM, extractJson, getGcpCredentials } from '@/lib/llm';
import { retrieveGroundedChunks } from '@/app/api/assistant/route';

const WRITE_ROLES = ['admin', 'registrar', 'owner'];

/** A normalized improvement-plan row as stored/returned. */
interface PlanRow {
  id: string;
  catalog_id: string | null;
  title: string;
  description: string | null;
  rationale: string | null;
  ai_detail: string | null;
  category: string | null;
  accreditor_code: string | null;
  criterion_code: string | null;        // generic criterion code (any accreditor)
  criterion_title: string | null;  // generic criterion title (any accreditor)
  status: string;
  target_year: string | null;
  plan_state: string;
  depends_on: string[];
  node_x: number | null;
  node_y: number | null;
  source: string;
}

/** An accreditor relevant to the tenant, with grounding availability flags. */
interface AccreditorInfo {
  id: string;
  code: string;
  name: string;
  criteria_count: number;        // structured criteria rows loaded
  has_reference_doc: boolean;    // accreditor's standards document ingested as chunks
}

/** A single stored accreditation criterion used to ground generation. */
interface CriterionRow {
  accreditor_code: string;
  standard_code: string;
  title: string;
  description: string | null;
  hierarchy_level: number | null;
}

/** An accreditor's ingested standards document available for RAG grounding. */
interface AccreditorDoc {
  code: string;
  name: string;
  document_id: string;
}

const SELECT_COLS = `id, catalog_id, title, description, rationale, ai_detail, category,
  accreditor_code, criterion_code, criterion_title, status, target_year, plan_state,
  depends_on, node_x, node_y, source`;

/**
 * Looks up the role for a user from the user_roles table.
 *
 * @param userId - The authenticated user id.
 * @returns The role string, or null if none.
 */
async function getUserRole(userId: string): Promise<string | null> {
  const rows = await query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
  return rows.length > 0 ? rows[0].role : null;
}

/**
 * Fetches all improvement-plan rows for the tenant, ordered for the flow canvas.
 *
 * @param userId - The authenticated user id (for RLS context).
 * @returns The list of plan rows.
 */
async function listPlans(userId: string): Promise<PlanRow[]> {
  return await queryWithAuth(
    `SELECT ${SELECT_COLS} FROM improvement_plans
     WHERE tenant_id = $1
     ORDER BY target_year ASC NULLS LAST, created_at ASC;`,
    [TENANT_ID],
    userId
  );
}

/**
 * Resolves the accreditor(s) relevant to the tenant: those it has compliance
 * obligations against, or — if none are linked yet — every accreditor with
 * criteria loaded, falling back to all known accreditors. Multi-school ready.
 *
 * @param userId - The authenticated user id (for RLS context).
 * @returns The accreditors with a count of how many criteria are loaded.
 */
async function resolveAccreditors(userId: string): Promise<AccreditorInfo[]> {
  // Accreditation schema (accreditors / accreditation_criteria / compliance_obligations)
  // is omitted from spokes with accreditation disabled — never query it there.
  if (!FEATURES.accreditation) return [];
  const all: AccreditorInfo[] = await queryWithAuth(
    `SELECT a.id, a.code, a.name,
            (SELECT count(*)::int FROM accreditation_criteria c WHERE c.accreditor_id = a.id) AS criteria_count,
            EXISTS (
              SELECT 1 FROM documents d
              JOIN semantic_chunks sc ON sc.document_id = d.id
              WHERE lower(d.domain_id) LIKE '%' || lower(a.code) || '%' AND sc.tenant_id = $1
            ) AS has_reference_doc
     FROM accreditors a
     ORDER BY a.code;`,
    [TENANT_ID],
    userId
  );

  // Prefer accreditors this tenant actually has obligations against.
  const linked: { accreditor_id: string }[] = await queryWithAuth(
    `SELECT DISTINCT accreditor_id FROM compliance_obligations WHERE tenant_id = $1 AND accreditor_id IS NOT NULL;`,
    [TENANT_ID],
    userId
  );
  if (linked.length > 0) {
    const ids = new Set(linked.map(r => r.accreditor_id));
    return all.filter(a => ids.has(a.id));
  }

  // Otherwise prefer those with structured criteria, then those with an ingested
  // reference document, then fall back to all known accreditors.
  const withCriteria = all.filter(a => a.criteria_count > 0);
  if (withCriteria.length > 0) return withCriteria;
  const withDoc = all.filter(a => a.has_reference_doc);
  return withDoc.length > 0 ? withDoc : all;
}

/**
 * Resolves each in-scope accreditor's most recent ingested standards document
 * (matched by domain_id containing the accreditor code) that actually has chunks.
 *
 * @param userId - The authenticated user id (for RLS context).
 * @returns One reference document per accreditor code, newest first.
 */
async function resolveAccreditorDocuments(userId: string): Promise<AccreditorDoc[]> {
  if (!FEATURES.accreditation) return [];
  return await queryWithAuth(
    `SELECT DISTINCT ON (a.code) a.code, a.name, d.id AS document_id
     FROM accreditors a
     JOIN documents d ON lower(d.domain_id) LIKE '%' || lower(a.code) || '%'
     WHERE EXISTS (SELECT 1 FROM semantic_chunks sc WHERE sc.document_id = d.id AND sc.tenant_id = $1)
     ORDER BY a.code, d.created_at DESC;`,
    [TENANT_ID],
    userId
  );
}

/**
 * Retrieves relevant excerpts from each accreditor's standards document, to
 * ground generation/explanation in the accreditor's own language.
 *
 * @param docs - The accreditor reference documents to pull from.
 * @param queryStr - The retrieval query.
 * @param gcp - GCP credentials for embedding-based retrieval.
 * @param geminiKey - Optional Gemini API key for embeddings.
 * @param perDoc - Max chunks to include per document.
 * @returns A formatted reference block, or empty string when nothing is found.
 */
async function fetchAccreditorReference(
  docs: AccreditorDoc[],
  queryStr: string,
  gcp: { projectId: string; location: string; accessToken: string },
  geminiKey: string | undefined,
  perDoc = 10
): Promise<string> {
  const blocks: string[] = [];
  for (const doc of docs) {
    try {
      const { chunks } = await retrieveGroundedChunks(queryStr, TENANT_ID, doc.document_id, gcp, geminiKey);
      const text = chunks
        .slice(0, perDoc)
        .map((c: any) => `- ${c.section_header || 'Standard'}: ${(c.content || '').slice(0, 500)}`)
        .join('\n');
      if (text) blocks.push(`Accreditor reference — ${doc.name} (${doc.code}):\n${text}`);
    } catch (err: any) {
      console.warn('[Improvement] accreditor reference retrieval failed:', err.message);
    }
  }
  return blocks.join('\n\n');
}

/**
 * Fetches the stored criteria for the given accreditors, to ground generation.
 *
 * @param userId - The authenticated user id (for RLS context).
 * @param accreditorIds - Accreditor ids to pull criteria for.
 * @returns The criterion rows (capped to a prompt-safe size).
 */
async function fetchCriteria(userId: string, accreditorIds: string[]): Promise<CriterionRow[]> {
  if (!FEATURES.accreditation || accreditorIds.length === 0) return [];
  return await queryWithAuth(
    `SELECT a.code AS accreditor_code, c.standard_code, c.title, c.description, c.hierarchy_level
     FROM accreditation_criteria c
     JOIN accreditors a ON a.id = c.accreditor_id
     WHERE c.accreditor_id = ANY($1::uuid[])
     ORDER BY a.code, c.standard_code
     LIMIT 250;`,
    [accreditorIds],
    userId
  );
}

/**
 * GET — list all improvement-plan items plus the tenant's accreditor context.
 */
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

    const [plans, accreditors] = await Promise.all([
      listPlans(session.user.id),
      resolveAccreditors(session.user.id).catch(() => [] as AccreditorInfo[]),
    ]);
    return NextResponse.json({ plans, accreditors });
  } catch (e: any) {
    console.error('Improvement Plan GET error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

type GroundingMode = 'structured' | 'reference' | 'none';

/**
 * Builds the accreditor-neutral generation system prompt. Three grounding modes:
 *  - 'structured': map only to the supplied authoritative criteria list.
 *  - 'reference': identify criteria from the accreditor's own standards excerpts.
 *  - 'none': rely on the model's general knowledge of the accreditor.
 *
 * @param accreditorLabel - Human label of the accreditor(s) in scope.
 * @param mode - The grounding mode.
 * @returns The system prompt string.
 */
function buildGenerateSystemPrompt(accreditorLabel: string, mode: GroundingMode): string {
  const inputs =
    mode === 'structured' ? ", plus the AUTHORITATIVE list of accreditation criteria for the accreditor(s)"
    : mode === 'reference' ? ", plus excerpts from the accreditor's own standards documents"
    : '';
  const criterionRule =
    mode === 'structured'
      ? 'Map every item to a criterion FROM THE PROVIDED LIST ONLY — copy its accreditor_code and standard_code exactly. Do not invent criteria.'
    : mode === 'reference'
      ? 'Identify the relevant criteria from the provided accreditor reference excerpts, and cite their codes/titles exactly as they appear in those excerpts. Do not invent codes that are not supported by the excerpts.'
      : 'Cover only criteria that are genuinely relevant to what you see in the catalog. Do not fabricate coverage.';

  return `You are the Catalog Improvement strategist for an academic institution. You help align its academic catalog to the accreditation requirements of: ${accreditorLabel}.

You are given grounded excerpts from the institution's catalog${inputs}. Propose a forward-looking improvement plan.

Return ONLY a single valid JSON object with this exact shape:
{
  "initiatives": [
    {
      "title": "string (short, action-oriented)",
      "description": "string (1-3 sentences on the concrete catalog change)",
      "category": "Formatting | Organizational | Policy | Accessibility | Assessment",
      "accreditor_code": "string (optional framework code, or null)",
      "criterion_code": "string (the criterion's standard code, e.g. '2.A')",
      "criterion_title": "string (the criterion's title)",
      "rationale": "string (explicitly how this change helps satisfy the cited criterion)",
      "status": "planned | in_progress",
      "target_year": "string academic year, e.g. '2026-2027'",
      "depends_on": ["exact title of a prerequisite initiative in this list", "..."]
    }
  ]
}

STRICT RULES:
- ${criterionRule}
- Prioritize the criteria with the clearest catalog gaps — focus on roughly 5-8 criteria, you need NOT cover every criterion in one plan.
- For each criterion you DO address, propose between 2 and 5 improvement items — never just one (if you can only think of one item for a criterion, add a second or drop that criterion). Keep the whole plan to about 15-25 items total (a focused, sequenced plan, not exhaustive).
- NONE of the items may be "completed" — every item is either "planned" or "in_progress".
- EVERY item MUST include a target_year and a status.
- Use "depends_on" to express ordering ("do X first, then Y") by referencing the exact titles of other items. Use [] when an item has no prerequisites.
- Each "rationale" must tie the recommendation directly to the cited criterion.
- Prefer realistic, sequenced, multi-year planning (spread target years across the next 1-4 academic years).
- Output JSON only. No prose, no markdown fences.`;
}

/**
 * Formats stored criteria into an authoritative list for the user prompt.
 *
 * @param criteria - The criterion rows to render.
 * @returns A formatted block, or an empty string when no criteria are loaded.
 */
function buildCriteriaText(criteria: CriterionRow[]): string {
  if (criteria.length === 0) return '';
  const lines = criteria.map(c => {
    const desc = c.description ? `: ${c.description.slice(0, 300)}` : '';
    return `- [${c.accreditor_code} ${c.standard_code}] ${c.title}${desc}`;
  });
  return `Authoritative accreditation criteria (map items to these exact codes only):\n${lines.join('\n')}\n\n`;
}

const VALID_STATUS = ['planned', 'in_progress'];

/**
 * Normalizes a single LLM-proposed initiative into safe stored values.
 */
function sanitizeInitiative(raw: any): Omit<PlanRow, 'id' | 'depends_on' | 'node_x' | 'node_y'> & { dependsOnTitles: string[] } {
  const status = VALID_STATUS.includes(String(raw?.status)) ? String(raw.status) : 'planned';
  const accreditorCode = raw?.accreditor_code ? String(raw.accreditor_code).trim() : null;
  // The model sometimes prefixes the code with the accreditor (e.g. "STD 2.A");
  // strip it so the stored standard_code matches accreditation_criteria.
  let criterion = raw?.criterion_code ? String(raw.criterion_code).trim() : null;
  if (criterion && accreditorCode && criterion.toUpperCase().startsWith(accreditorCode.toUpperCase() + ' ')) {
    criterion = criterion.slice(accreditorCode.length).trim();
  }
  return {
    catalog_id: null, // filled by caller
    title: String(raw?.title || 'Untitled initiative').slice(0, 240),
    description: raw?.description ? String(raw.description) : null,
    rationale: raw?.rationale ? String(raw.rationale) : null,
    ai_detail: null,
    category: raw?.category ? String(raw.category) : null,
    accreditor_code: accreditorCode,
    criterion_code: criterion,
    criterion_title: raw?.criterion_title ? String(raw.criterion_title) : null,
    status,
    target_year: raw?.target_year ? String(raw.target_year) : null,
    plan_state: 'suggested',
    source: 'ai',
    dependsOnTitles: Array.isArray(raw?.depends_on) ? raw.depends_on.map((t: any) => String(t)) : [],
  };
}

/**
 * Generates a fresh AI improvement plan grounded in the catalog, replacing only
 * the prior "suggested" items (selected/amended items are preserved).
 */
async function handleGenerate(userId: string, catalogId: string, req: Request): Promise<PlanRow[]> {
  const gcp = await getGcpCredentials(req);
  const geminiKey = process.env.GEMINI_API_KEY;

  // 1. Resolve the tenant's accreditor(s) and any loaded criteria to ground on.
  const accreditors = await resolveAccreditors(userId);
  const groundedAccreditors = accreditors.filter(a => a.criteria_count > 0);
  const criteria = await fetchCriteria(userId, groundedAccreditors.map(a => a.id));
  const hasStructured = criteria.length > 0;
  // Which accreditor to attribute items to when the model omits it.
  const scope = hasStructured ? groundedAccreditors : accreditors;
  const defaultAccreditorCode = scope.length === 1 ? scope[0].code : null;
  const accreditorLabel = scope.length > 0
    ? scope.map(a => `${a.name} (${a.code})`).join(', ')
    : "the institution's accreditor(s)";

  // 2. If structured criteria aren't loaded, bridge by grounding in the
  //    accreditor's ingested standards document(s).
  let referenceText = '';
  if (!hasStructured) {
    const scopeCodes = new Set(scope.map(a => a.code));
    const refDocs = (await resolveAccreditorDocuments(userId)).filter(d => scopeCodes.has(d.code));
    if (refDocs.length > 0) {
      const refQuery =
        'accreditation criteria standards core components assumed practices requirements expectations evidence';
      referenceText = await fetchAccreditorReference(refDocs, refQuery, gcp, geminiKey, 12);
    }
  }

  const mode: GroundingMode = hasStructured ? 'structured' : (referenceText ? 'reference' : 'none');

  // 3. Ground against the catalog text (policy/governance areas).
  const retrievalQuery =
    'general education requirements, academic and student policies, credit hour definitions, ' +
    'grievance and appeals, assessment of student learning, faculty qualifications, ' +
    'mission and integrity, program requirements, admissions and continuation';
  let contextText = '';
  try {
    const { chunks } = await retrieveGroundedChunks(retrievalQuery, TENANT_ID, catalogId, gcp, geminiKey);
    contextText = chunks
      .slice(0, 30)
      .map((c: any, i: number) => `[Chunk ${i + 1} - ${c.section_header || 'Narrative'}]\n${(c.content || '').slice(0, 1200)}`)
      .join('\n\n');
  } catch (err: any) {
    console.warn('[Improvement Generate] retrieval failed:', err.message);
  }

  const system = buildGenerateSystemPrompt(accreditorLabel, mode);
  const referenceBlock = referenceText ? `${referenceText}\n\n` : '';
  const userPrompt =
    `${buildCriteriaText(criteria)}${referenceBlock}Catalog grounding excerpts:\n\n${contextText || '(no catalog excerpts retrieved)'}\n\nProduce the improvement plan JSON now.`;
  const result = await callLLM({ system, user: userPrompt, req, json: true, maxTokens: 8000 });

  if (!result) {
    // No provider configured — leave existing rows untouched.
    return listPlans(userId);
  }

  const parsed = extractJson<{ initiatives: any[] }>(result.text);
  const initiatives = Array.isArray(parsed?.initiatives) ? parsed!.initiatives : [];
  if (initiatives.length === 0) {
    return listPlans(userId);
  }

  // Replace only prior AI suggestions for this catalog; keep committed items.
  await queryWithAuth(
    `DELETE FROM improvement_plans
     WHERE tenant_id = $1 AND catalog_id = $2 AND plan_state = 'suggested' AND source = 'ai';`,
    [TENANT_ID, catalogId],
    userId
  );

  // Insert new suggestions, capturing title -> id for dependency resolution.
  const titleToId = new Map<string, string>();
  const insertedIds: string[] = [];
  for (const raw of initiatives) {
    const s = sanitizeInitiative(raw);
    const accreditorCode = s.accreditor_code || defaultAccreditorCode;
    const rows = await queryWithAuth(
      `INSERT INTO improvement_plans
        (tenant_id, catalog_id, title, description, rationale, category,
         accreditor_code, criterion_code, criterion_title, status, target_year, plan_state, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'suggested','ai')
       RETURNING id;`,
      [TENANT_ID, catalogId, s.title, s.description, s.rationale, s.category,
       accreditorCode, s.criterion_code, s.criterion_title, s.status, s.target_year],
      userId
    );
    const id = rows[0].id;
    insertedIds.push(id);
    titleToId.set(s.title.trim().toLowerCase(), id);
    (raw as any).__id = id;
  }

  // Resolve depends_on titles -> ids (within the generated set) and persist.
  for (const raw of initiatives) {
    const s = sanitizeInitiative(raw);
    const depIds = s.dependsOnTitles
      .map(t => titleToId.get(t.trim().toLowerCase()))
      .filter((x): x is string => !!x && x !== (raw as any).__id);
    if (depIds.length > 0) {
      await queryWithAuth(
        `UPDATE improvement_plans SET depends_on = $1::jsonb, updated_at = now()
         WHERE id = $2 AND tenant_id = $3;`,
        [JSON.stringify(depIds), (raw as any).__id, TENANT_ID],
        userId
      );
    }
  }

  return listPlans(userId);
}

const EXPLAIN_SYSTEM_PROMPT = `You are an accreditation advisor. Explain, in clear plain language for a non-technical catalog editor, how a proposed catalog improvement relates to the cited accreditation criterion.

Respond in Markdown with three short sections:
## The connection
One paragraph linking the recommendation to what the criterion requires.
## Why it matters
2-4 bullet points on the accreditation risk it reduces or the evidence it strengthens.
## How to know it's done
2-3 concrete, observable signs the catalog now satisfies this criterion (do NOT claim it is already done).

Be specific and grounded in the provided criterion text and catalog context. Respond with Markdown only, no preamble.`;

/**
 * Generates and caches a deeper explanation linking an initiative to its
 * accreditation criterion, grounded in the authoritative criterion text when
 * the accreditor's criteria are loaded.
 */
async function handleExplain(userId: string, id: string, req: Request): Promise<{ ai_detail: string; model: string } | null> {
  const rows = await queryWithAuth(
    `SELECT ${SELECT_COLS} FROM improvement_plans WHERE id = $1 AND tenant_id = $2;`,
    [id, TENANT_ID],
    userId
  );
  if (rows.length === 0) return null;
  const item: PlanRow = rows[0];

  // Pull the authoritative criterion definition if it's loaded for this accreditor.
  let criterionText = '';
  if (item.criterion_code) {
    try {
      const critRows = await queryWithAuth(
        `SELECT a.code AS accreditor_code, a.name AS accreditor_name, c.standard_code, c.title, c.description
         FROM accreditation_criteria c
         JOIN accreditors a ON a.id = c.accreditor_id
         WHERE c.standard_code = $1 ${item.accreditor_code ? 'AND a.code = $2' : ''}
         LIMIT 1;`,
        item.accreditor_code ? [item.criterion_code, item.accreditor_code] : [item.criterion_code],
        userId
      );
      if (critRows.length > 0) {
        const c = critRows[0];
        criterionText = `Authoritative criterion (${c.accreditor_name} ${c.standard_code} — ${c.title}):\n${c.description || '(no description on file)'}`;
      }
    } catch (err: any) {
      console.warn('[Improvement Explain] criterion lookup failed:', err.message);
    }
  }

  const gcp = await getGcpCredentials(req);
  const geminiKey = process.env.GEMINI_API_KEY;

  // Bridge: if the structured criterion text isn't loaded, ground in the
  // accreditor's ingested standards document instead.
  if (!criterionText && item.accreditor_code) {
    try {
      const refDocs = (await resolveAccreditorDocuments(userId)).filter(d => d.code === item.accreditor_code);
      if (refDocs.length > 0) {
        const q = `${item.criterion_code || ''} ${item.criterion_title || ''} ${item.title}`;
        const ref = await fetchAccreditorReference(refDocs, q, gcp, geminiKey, 6);
        if (ref) criterionText = ref;
      }
    } catch (err: any) {
      console.warn('[Improvement Explain] accreditor reference lookup failed:', err.message);
    }
  }
  let contextText = '';
  if (item.catalog_id) {
    try {
      const q = `${item.criterion_code || ''} ${item.criterion_title || ''} ${item.title} ${item.description || ''}`;
      const { chunks } = await retrieveGroundedChunks(q, TENANT_ID, item.catalog_id, gcp, geminiKey);
      contextText = chunks.slice(0, 8).map((c: any) => `- ${c.section_header || 'Policy'}: ${(c.content || '').slice(0, 600)}`).join('\n');
    } catch (err: any) {
      console.warn('[Improvement Explain] retrieval failed:', err.message);
    }
  }

  const userPrompt = `Proposed improvement:
- Title: ${item.title}
- Description: ${item.description || '(none)'}
- Accreditor: ${item.accreditor_code || '(unspecified)'}
- Criterion: ${item.criterion_code || '(unspecified)'} — ${item.criterion_title || ''}
- Current rationale: ${item.rationale || '(none)'}
- Target year: ${item.target_year || '(unset)'}; Status: ${item.status}

${criterionText || '(The accreditor\'s criterion text is not loaded; rely on your knowledge of this criterion.)'}

Relevant catalog context:
${contextText || '(no specific catalog context retrieved)'}

Explain the relationship between this recommendation and the accreditation criterion.`;

  const result = await callLLM({ system: EXPLAIN_SYSTEM_PROMPT, user: userPrompt, req, maxTokens: 1500 });
  if (!result) return null;

  await queryWithAuth(
    `UPDATE improvement_plans SET ai_detail = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3;`,
    [result.text, id, TENANT_ID],
    userId
  );
  return { ai_detail: result.text, model: result.model };
}

/**
 * POST — actions: generate | explain | save.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const userId = session.user.id;

    const body = await req.json();
    const { action } = body;

    if (action === 'generate') {
      if (!body.catalogId) return NextResponse.json({ error: 'catalogId required.' }, { status: 400 });
      const plans = await handleGenerate(userId, body.catalogId, req);
      return NextResponse.json({ plans });
    }

    if (action === 'explain') {
      if (!body.id) return NextResponse.json({ error: 'id required.' }, { status: 400 });
      const result = await handleExplain(userId, body.id, req);
      if (!result) {
        return NextResponse.json({
          ai_detail: 'The AI explanation is unavailable — no AI provider is configured on the server.',
          model: 'unavailable',
        });
      }
      return NextResponse.json(result);
    }

    if (action === 'save') {
      const i = body.initiative || {};
      if (!i.title) return NextResponse.json({ error: 'title required.' }, { status: 400 });
      const planState = ['suggested', 'selected_current', 'amended_current', 'amended_future'].includes(i.plan_state)
        ? i.plan_state : 'selected_current';
      const status = VALID_STATUS.includes(i.status) ? i.status : 'planned';
      const rows = await queryWithAuth(
        `INSERT INTO improvement_plans
          (tenant_id, catalog_id, title, description, rationale, category,
           accreditor_code, criterion_code, criterion_title, status, target_year, plan_state, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13)
         RETURNING ${SELECT_COLS};`,
        [TENANT_ID, i.catalog_id || null, i.title, i.description || null, i.rationale || null,
         i.category || null, i.accreditor_code || null, i.criterion_code || null, i.criterion_title || null,
         status, i.target_year || null, planState, session.user.email],
        userId
      );
      return NextResponse.json({ plan: rows[0] });
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e: any) {
    console.error('Improvement Plan POST error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * PATCH — update an item's editable fields (state transitions, edits, positions).
 */
export async function PATCH(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const userId = session.user.id;

    const body = await req.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: 'id required.' }, { status: 400 });

    // Build a dynamic, whitelisted update.
    const sets: string[] = [];
    const params: any[] = [];
    let p = 1;
    const setField = (col: string, val: any) => { sets.push(`${col} = $${p++}`); params.push(val); };

    if (body.plan_state !== undefined && ['suggested', 'selected_current', 'amended_current', 'amended_future'].includes(body.plan_state)) {
      setField('plan_state', body.plan_state);
    }
    if (body.status !== undefined && VALID_STATUS.includes(body.status)) setField('status', body.status);
    if (body.title !== undefined) setField('title', String(body.title).slice(0, 240));
    if (body.description !== undefined) setField('description', body.description);
    if (body.rationale !== undefined) setField('rationale', body.rationale);
    if (body.category !== undefined) setField('category', body.category);
    if (body.target_year !== undefined) setField('target_year', body.target_year);
    if (body.depends_on !== undefined) { sets.push(`depends_on = $${p++}::jsonb`); params.push(JSON.stringify(body.depends_on)); }
    if (body.node_x !== undefined) setField('node_x', body.node_x);
    if (body.node_y !== undefined) setField('node_y', body.node_y);

    if (sets.length === 0) return NextResponse.json({ error: 'No updatable fields provided.' }, { status: 400 });
    sets.push('updated_at = now()');

    params.push(id, TENANT_ID);
    const rows = await queryWithAuth(
      `UPDATE improvement_plans SET ${sets.join(', ')}
       WHERE id = $${p++} AND tenant_id = $${p}
       RETURNING ${SELECT_COLS};`,
      params,
      userId
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    return NextResponse.json({ plan: rows[0] });
  } catch (e: any) {
    console.error('Improvement Plan PATCH error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * DELETE — remove a single item ({ id }) or clear a whole year ({ action: 'delete_year', targetYear }).
 */
export async function DELETE(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const userId = session.user.id;

    const role = await getUserRole(userId);
    if (!role || !WRITE_ROLES.includes(role)) {
      return NextResponse.json({ error: 'Forbidden: elevated access required.' }, { status: 403 });
    }

    const body = await req.json();

    if (body.action === 'delete_year') {
      if (!body.targetYear) return NextResponse.json({ error: 'targetYear required.' }, { status: 400 });
      const rows = await queryWithAuth(
        `DELETE FROM improvement_plans WHERE tenant_id = $1 AND target_year = $2 RETURNING id;`,
        [TENANT_ID, body.targetYear],
        userId
      );
      return NextResponse.json({ deleted: rows.length });
    }

    if (!body.id) return NextResponse.json({ error: 'id required.' }, { status: 400 });
    const rows = await queryWithAuth(
      `DELETE FROM improvement_plans WHERE id = $1 AND tenant_id = $2 RETURNING id;`,
      [body.id, TENANT_ID],
      userId
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    return NextResponse.json({ deleted: 1 });
  } catch (e: any) {
    console.error('Improvement Plan DELETE error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
