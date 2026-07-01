import { NextResponse } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID } from '@/lib/brand';
import { SWARM_BASE_URL, swarmAuthHeaders } from '@/lib/swarm';
import { getGcpCredentials } from '@/lib/llm';
import { generateEmbedding } from '@/app/api/assistant/route';
import { getProgramStructure, buildCatalogHtml, renderCatalogPdf, type PresentationOverride } from '@/lib/catalogPdf';
import { PDFDocument } from 'pdf-lib';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TENANT = TENANT_ID;
const API_BASE_URL = SWARM_BASE_URL;

// --- Cost guardrails (tunable via env) ---
const DAILY_LIMIT = Number.parseInt(process.env.CORRECTION_DAILY_LIMIT || '150', 10); // agent calls/user/day
const MAX_VISION_PAGES = 3;     // rendered pages attached per request
const MAX_MESSAGES = 12;        // conversation turns sent to the model
const MAX_CANDIDATES = 15;      // grounding rows per type
const MAX_REWRITES = 25;        // chunk rewrites applied per batch
const MAX_DELETE_MATCH = 4;     // refuse a delete whose match is broader than this (safety)
const MAX_RESTRUCTURE = 100;    // refuse a promote whose match spans more chunks than this (safety)

const codeKey = (s: any): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const labelKey = (s: any): string => String(s ?? '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();

/**
 * Heading-level restructure: rewrite a hierarchical section_header so the segment matching `label`
 * becomes Header 1 (a top-level section); its descendants renumber up and its ancestors are dropped.
 * Returns null if the label is not a heading segment, or is already top-level.
 * e.g. "Header 1: 2025-2026 College Calendar > Header 2: General Information about the University > Header 3: X"
 *   -> "Header 1: General Information about the University > Header 2: X"
 */
function promoteHeaderPath(sectionHeader: string, label: string): string | null {
  const parts = String(sectionHeader || '').split('>').map((p) => p.trim());
  const want = labelKey(label);
  const idx = parts.findIndex((p) => {
    const m = p.match(/^Header\s*\d+:\s*([^\n]*)/i);
    return m ? labelKey(m[1]) === want : false;
  });
  if (idx <= 0) return null; // not found (-1) or already top-level (0)
  return parts.slice(idx).map((p, k) => {
    const m = p.match(/^Header\s*\d+:\s*([\s\S]+)$/i);
    return `Header ${k + 1}: ${(m ? m[1] : p).trim()}`;
  }).join(' > ');
}

/** Top-level heading label of a section_header. */
const header1Of = (sh: any): string => {
  const m = String(sh ?? '').match(/Header\s*1:\s*([^>\n]+)/i);
  return ((m ? m[1] : String(sh ?? '').split('>')[0]) || '').trim();
};

/** Replace the Header 1 label of a section_header (keeping its sub-levels). */
function setHeader1(sh: string, label: string): string {
  const parts = String(sh || '').split('>').map((p) => p.trim());
  if (!parts.length) return `Header 1: ${label}`;
  parts[0] = `Header 1: ${label}`;
  return parts.join(' > ');
}

/** Strip a leading academic-year prefix so "2026-2027 College Calendar" ~ "2025-2026 College Calendar". */
const stripYear = (s: string): string => s.replace(/^\d{4}\s*[-–]\s*\d{4}\s*/, '').replace(/^\d{4}\s*/, '').trim();

/**
 * Resolve a label the agent produced (which may paraphrase) to an ACTUAL section label present in
 * the document — exact, then containment, then year-insensitive. Lenient like the promote/rewrite
 * paths so merges don't silently no-op on "Information about the University" vs "General Information about the University".
 */
function resolveSection(queryLabel: string, labels: string[]): string | null {
  const q = labelKey(queryLabel);
  if (!q) return null;
  let hit = labels.find((l) => labelKey(l) === q);
  if (hit) return hit;
  hit = labels.find((l) => { const lk = labelKey(l); return lk.includes(q) || q.includes(lk); });
  if (hit) return hit;
  const qn = stripYear(q);
  hit = labels.find((l) => { const lk = stripYear(labelKey(l)); return !!qn && (lk === qn || lk.includes(qn) || qn.includes(lk)); });
  return hit || null;
}

/** Registrar/owner gate shared by both phases. */
async function authorize(): Promise<{ userId: string } | NextResponse> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return NextResponse.json({ error: 'Forbidden: Authentication required.' }, { status: 401 });
  const role = (await query('SELECT role FROM user_roles WHERE user_id = $1', [session.user.id]))[0]?.role;
  if (!role || !['registrar', 'owner'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden: Only registrars and owners can make catalog corrections.' }, { status: 403 });
  }
  return { userId: session.user.id };
}

/** Per-user daily call cap (cost guardrail). */
async function underDailyLimit(userId: string): Promise<boolean> {
  const row = (await query(
    `SELECT count(*)::int AS n FROM catalog_agent_usage
       WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId]
  ))[0];
  return (row?.n ?? 0) < DAILY_LIMIT;
}

async function logUsage(userId: string, documentId: string, kind: string, visionPages: number, detail: any) {
  try {
    await query(
      `INSERT INTO catalog_agent_usage (user_id, tenant_id, document_id, kind, vision_pages, detail)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, TENANT, documentId, kind, visionPages, JSON.stringify(detail ?? {})]
    );
  } catch (e: any) { console.error('[assistant] usage log failed:', e.message); }
}

/** Ask the Cloud Run agent to rewrite a chunk if the correction applies to it. */
async function rewriteChunk(instruction: string, chunkContent: string): Promise<{ changed: boolean; content: string } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/agent/rewrite-chunk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...swarmAuthHeaders() },
      body: JSON.stringify({ instruction, chunk_content: chunkContent }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Gather candidate course/program rows that match terms in the registrar's request (grounding). */
async function gatherCandidates(catalogId: string, text: string) {
  const codes = Array.from(new Set((text.match(/\b[A-Z]{2,4}\s*-?\s*\d{3}[A-Z]?\b/g) || []).map(codeKey)));
  const words = Array.from(new Set((text.match(/[A-Za-z][A-Za-z&'-]{3,}/g) || []).map((w) => w.toLowerCase())))
    .filter((w) => !['the', 'this', 'that', 'with', 'under', 'should', 'change', 'program', 'programs', 'catalog', 'please', 'make', 'into', 'from', 'their', 'them', 'page'].includes(w))
    .slice(0, 6);
  const like = words.length ? words.map((w) => `%${w}%`) : ['% %'];

  const courses = await query(
    `SELECT course_code, title, credits, description, prerequisites FROM courses
       WHERE document_id = $1
         AND (regexp_replace(upper(course_code), '[^A-Z0-9]', '', 'g') = ANY($2) OR title ILIKE ANY($3))
       LIMIT ${MAX_CANDIDATES}`,
    [catalogId, codes.length ? codes : [''], like]
  );
  const programs = await query(
    `SELECT name, degree_type, total_credits FROM programs
       WHERE document_id = $1 AND name ILIKE ANY($2) LIMIT ${MAX_CANDIDATES}`,
    [catalogId, like]
  );
  return { courses, programs };
}

/**
 * Render the catalog and extract the referenced page(s) as a small PDF (base64) for vision grounding.
 * Page numbers match the PDF footer (1-indexed). Capped at MAX_VISION_PAGES to bound cost.
 */
async function extractPages(catalogId: string, pages: number[]): Promise<{ b64: string; label: string } | null> {
  if (!pages.length) return null;
  try {
    const html = await buildCatalogHtml(catalogId);
    const full = await renderCatalogPdf(html);
    const srcDoc = await PDFDocument.load(full);
    const total = srcDoc.getPageCount();
    const wanted = Array.from(new Set(pages)).filter((p) => p >= 1 && p <= total).slice(0, MAX_VISION_PAGES);
    if (!wanted.length) return null;
    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(srcDoc, wanted.map((p) => p - 1));
    copied.forEach((pg) => outDoc.addPage(pg));
    const bytes = await outDoc.save();
    const b64 = Buffer.from(bytes).toString('base64');
    const label = wanted.length === 1 ? `page ${wanted[0]}` : `pages ${wanted.join(', ')}`;
    return { b64, label };
  } catch (e: any) {
    console.error('[assistant] page extraction failed:', e.message);
    return null;
  }
}

/**
 * In-PDF catalog correction agent.
 *
 * mode "propose": classify the request (rendering | data | clarify) and return a structured plan to
 *   preview. When the message references a page ("page 11"), the rendered page is attached so the
 *   agent sees exactly what the registrar sees. No writes.
 * mode "apply": execute a previously proposed/staged batch — rendering ops become reversible
 *   presentation overrides; data ops update course rows or rewrite/delete narrative chunks.
 * Registrar/owner only; scoped to `catalogId`; rate-limited and logged per user.
 */
export async function POST(req: Request) {
  const auth = await authorize();
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  const body = await req.json();
  const { catalogId, mode } = body;
  if (!catalogId) return NextResponse.json({ error: 'catalogId is required.' }, { status: 400 });

  const exists = (await query('SELECT 1 FROM documents WHERE id = $1', [catalogId])).length > 0;
  if (!exists) return NextResponse.json({ error: 'Catalog not found.' }, { status: 404 });

  if (!(await underDailyLimit(userId))) {
    return NextResponse.json(
      { error: `Daily correction limit reached (${DAILY_LIMIT}). This cap controls model cost — it resets at midnight, or an owner can raise CORRECTION_DAILY_LIMIT.` },
      { status: 429 }
    );
  }

  // -------- propose --------
  if (mode !== 'apply') {
    const allMessages: { role: string; content: string }[] = Array.isArray(body.messages) ? body.messages : [];
    if (!allMessages.length) return NextResponse.json({ error: 'messages is required.' }, { status: 400 });
    const messages = allMessages.slice(-MAX_MESSAGES); // bound context
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

    // Vision grounding only when a page is referenced (keeps cost bounded).
    const pageRefs = Array.from(new Set((lastUser.match(/\bp(?:age|g)?\.?\s*(\d{1,3})\b/gi) || [])
      .map((m) => Number.parseInt((m.match(/\d{1,3}/) || ['0'])[0], 10)).filter((n) => n > 0)));

    const [structure, candidates, page] = await Promise.all([
      getProgramStructure(catalogId),
      gatherCandidates(catalogId, lastUser),
      extractPages(catalogId, pageRefs),
    ]);

    // Optional uploaded source document (authoritative content, e.g. next year's calendar).
    const file = body.file && body.file.base64 ? body.file : null;
    const docType = file ? (/pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '') ? 'pdf' : 'docx') : '';

    const res = await fetch(`${API_BASE_URL}/api/agent/catalog-correction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...swarmAuthHeaders() },
      body: JSON.stringify({
        messages, catalogId, structure, candidates,
        page_pdf_base64: page?.b64 || '', page_label: page?.label || '',
        doc_base64: file?.base64 || '', doc_name: file?.name || '', doc_type: docType,
      }),
    });
    await logUsage(userId, catalogId, 'propose', page ? 1 : 0, { lastUser: lastUser.slice(0, 300), pageRefs, doc: file?.name || null });
    if (!res.ok) {
      return NextResponse.json({ error: `Correction agent failed: ${res.status} ${await res.text()}` }, { status: 502 });
    }
    const proposal = await res.json();
    return NextResponse.json({ proposal, visionUsed: !!page, pageLabel: page?.label || null });
  }

  // -------- apply --------
  const operations: any[] = Array.isArray(body.operations) ? body.operations : [];
  if (!operations.length) return NextResponse.json({ error: 'No operations to apply.' }, { status: 400 });

  // Each op carries a single `action` discriminator (see Cloud Run CORRECTION_OP).
  const RENDERING_ACTIONS = ['regroup', 'rename', 'hide'];
  const ops = operations.filter((o) => o && o.action && o.match);
  const applied: string[] = [];

  // Rendering actions -> presentation overrides.
  const newOverrides: PresentationOverride[] = ops
    .filter((o) => RENDERING_ACTIONS.includes(o.action))
    .map((o) => ({
      id: randomUUID(),
      type: o.action,
      ...(o.scope ? { scope: o.scope } : {}),
      match: String(o.match),
      ...(o.value ? { value: String(o.value) } : {}),
      note: o.detail || '',
    }));

  // set_course_field -> course-table writes (whitelisted columns) keyed by course_code.
  const courseWrites = ops
    .filter((o) => o.action === 'set_course_field' && ['title', 'credits', 'description', 'prerequisites'].includes(o.column) && o.match)
    .map((o) => ({ code: String(o.match), column: o.column as string, value: o.value, detail: o.detail }));

  // rewrite_text (capped) and delete_text (guarded against broad matches).
  const chunkUpdates = new Map<string, string>();
  const deleteIds = new Set<string>();
  const seen = new Set<string>();
  for (const op of ops.filter((o) => o.action === 'delete_text')) {
    const cands = await query(
      `SELECT id FROM semantic_chunks WHERE document_id = $1 AND (content ILIKE $2 OR section_header ILIKE $2) LIMIT ${MAX_DELETE_MATCH + 1}`,
      [catalogId, `%${op.match}%`]
    );
    if (!cands.length) { applied.push(`${op.detail || `Delete "${op.match}"`} (nothing matched — skipped)`); continue; }
    if (cands.length > MAX_DELETE_MATCH) { applied.push(`${op.detail || `Delete "${op.match}"`} (matched ${cands.length}+ blocks — too broad, skipped for safety)`); continue; }
    cands.forEach((c: any) => deleteIds.add(c.id));
    applied.push(`${op.detail || `Deleted "${op.match}"`} (${cands.length} block${cands.length > 1 ? 's' : ''})`);
  }
  for (const op of ops.filter((o) => o.action === 'rewrite_text' && o.instruction)) {
    if (chunkUpdates.size >= MAX_REWRITES) break;
    const cands = await query(
      `SELECT id, content FROM semantic_chunks WHERE document_id = $1 AND (content ILIKE $2 OR section_header ILIKE $2) LIMIT 15`,
      [catalogId, `%${op.match}%`]
    );
    let touched = 0;
    for (const ch of cands) {
      if (seen.has(ch.id) || chunkUpdates.size >= MAX_REWRITES) continue;
      seen.add(ch.id);
      const r = await rewriteChunk(op.instruction, ch.content);
      if (r?.changed && r.content && r.content !== ch.content) { chunkUpdates.set(ch.id, r.content); touched++; }
    }
    if (touched) applied.push(op.detail || `Rewrote ${touched} section(s) for "${op.match}"`);
  }

  // promote -> heading-level restructure: promote a subsection to its own top-level section (rewrites
  // section_header on the affected chunks; the renderer groups by Header 1, so it becomes a section).
  const headerUpdates: { id: string; sh: string }[] = [];
  for (const op of ops.filter((o) => o.action === 'promote')) {
    const cands = await query(
      `SELECT id, section_header FROM semantic_chunks
         WHERE document_id = $1 AND section_header ILIKE $2 AND section_header NOT ILIKE '%table of contents%'
         LIMIT ${MAX_RESTRUCTURE + 1}`,
      [catalogId, `%${op.match}%`]
    );
    const ups = cands
      .map((c: any) => ({ id: c.id as string, sh: promoteHeaderPath(c.section_header, op.match) }))
      .filter((u): u is { id: string; sh: string } => !!u.sh);
    if (!ups.length) { applied.push(`${op.detail || `Promote "${op.match}"`} (no matching heading found — skipped)`); continue; }
    if (ups.length > MAX_RESTRUCTURE) { applied.push(`${op.detail || `Promote "${op.match}"`} (matched ${ups.length}+ chunks — too broad, skipped for safety)`); continue; }
    headerUpdates.push(...ups);
    applied.push(`${op.detail || `Promoted "${op.match}" to a top-level section`} (${ups.length} chunk${ups.length > 1 ? 's' : ''})`);
  }

  // merge -> absorb a section into a target heading (only occurrences AFTER the target's first chunk,
  // so a same-named section earlier in the document is left alone).
  const mergeOps = ops.filter((o) => o.action === 'merge' && o.value);
  if (mergeOps.length) {
    const all = await query(
      `SELECT id, section_header, sequence_order FROM semantic_chunks
         WHERE document_id = $1 AND (section_header IS NULL OR section_header NOT ILIKE '%table of contents%')`,
      [catalogId]
    );
    const labels = Array.from(new Set(all.map((c: any) => header1Of(c.section_header)).filter(Boolean)));
    for (const op of mergeOps) {
      const target = resolveSection(op.value, labels);   // lenient: paraphrase -> actual label
      const source = resolveSection(op.match, labels);
      if (!target) { applied.push(`Merge into "${op.value}" (target section not found — skipped)`); continue; }
      if (!source) { applied.push(`Merge "${op.match}" (section to merge not found — skipped)`); continue; }
      const tk = labelKey(target);
      const sk = labelKey(source);
      if (tk === sk) { applied.push(`Merge "${op.match}" into "${op.value}" (same section — skipped)`); continue; }
      const targetSeq = Math.min(...all.filter((c: any) => labelKey(header1Of(c.section_header)) === tk).map((c: any) => c.sequence_order ?? Infinity));
      // Prefer a source section AFTER the target (disambiguates a same-named section elsewhere); if
      // there is none, fall back to merging the source wherever it is (e.g. it precedes the target).
      let toMerge = all.filter((c: any) => labelKey(header1Of(c.section_header)) === sk && (c.sequence_order ?? 0) > targetSeq);
      if (!toMerge.length) toMerge = all.filter((c: any) => labelKey(header1Of(c.section_header)) === sk);
      if (!toMerge.length) { applied.push(`Merge "${source}" into "${target}" (section not found — skipped)`); continue; }
      if (toMerge.length > MAX_RESTRUCTURE * 2) { applied.push(`Merge "${source}" into "${target}" (matched ${toMerge.length}+ chunks — too broad, skipped for safety)`); continue; }
      for (const c of toMerge) headerUpdates.push({ id: c.id, sh: setHeader1(c.section_header, target) });
      applied.push(`${op.detail || `Merged "${source}" into "${target}"`} (${toMerge.length} chunk${toMerge.length > 1 ? 's' : ''})`);
    }
  }

  // replace_section -> swap an entire section's chunks for new content (e.g. from an uploaded doc).
  const replacements: { label: string; content: string; seq: number; deleteIds: string[] }[] = [];
  const replaceOps = ops.filter((o) => o.action === 'replace_section' && o.value);
  if (replaceOps.length) {
    const all = await query(
      `SELECT id, section_header, sequence_order FROM semantic_chunks
         WHERE document_id = $1 AND (section_header IS NULL OR section_header NOT ILIKE '%table of contents%')`,
      [catalogId]
    );
    const labels = Array.from(new Set(all.map((c: any) => header1Of(c.section_header)).filter(Boolean)));
    for (const op of replaceOps) {
      const target = resolveSection(op.match, labels);
      if (!target) { applied.push(`Replace "${op.match}" (section not found — skipped)`); continue; }
      const tk = labelKey(target);
      const secChunks = all.filter((c: any) => labelKey(header1Of(c.section_header)) === tk);
      if (!secChunks.length) { applied.push(`Replace "${target}" (no content found — skipped)`); continue; }
      if (secChunks.length > MAX_RESTRUCTURE * 3) { applied.push(`Replace "${target}" (section spans ${secChunks.length}+ chunks — too broad, skipped for safety)`); continue; }
      const seq = Math.min(...secChunks.map((c: any) => c.sequence_order ?? Infinity));
      replacements.push({ label: target, content: String(op.value), seq, deleteIds: secChunks.map((c: any) => c.id) });
      applied.push(`${op.detail || `Replaced the "${target}" section`} (replaced ${secChunks.length} chunk${secChunks.length > 1 ? 's' : ''})`);
    }
  }

  // Re-embed rewritten + replacement chunks (gemini-embedding-001 @ 1536); NULL on failure.
  let embedded = 0;
  const gcp = await getGcpCredentials(req);
  const geminiKey = process.env.GEMINI_API_KEY;
  const embedLiteral = async (content: string): Promise<string | null> => {
    try { const v = await generateEmbedding(content, gcp, geminiKey); return v?.length ? `[${v.join(',')}]` : null; } catch { return null; }
  };
  const chunkRows = await Promise.all(
    Array.from(chunkUpdates).map(async ([id, content]) => {
      const emb = await embedLiteral(content);
      if (emb) embedded++;
      return { id, content, emb };
    })
  );
  const replaceRows = await Promise.all(
    replacements.map(async (r) => {
      const content = `[Header 1: ${r.label}]\n\n${r.content}`;
      const emb = await embedLiteral(content);
      if (emb) embedded++;
      return { ...r, content, emb };
    })
  );

  // Commit everything in one RLS transaction scoped to the draft.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT]);
    await client.query(`SET LOCAL ROLE authenticated`);

    if (newOverrides.length) {
      await client.query(
        `UPDATE documents SET presentation_overrides = COALESCE(presentation_overrides, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify(newOverrides), catalogId]
      );
      for (const o of newOverrides) applied.push(o.note || `${o.type} ${o.match}`);
    }

    for (const w of courseWrites) {
      const val = w.column === 'credits' ? (Number.parseInt(String(w.value), 10) || null) : (w.value ?? null);
      const r = await client.query(
        `UPDATE courses SET ${w.column} = $1
           WHERE document_id = $2 AND regexp_replace(upper(course_code), '[^A-Z0-9]', '', 'g') = regexp_replace(upper($3), '[^A-Z0-9]', '', 'g')`,
        [val, catalogId, w.code]
      );
      applied.push(`${w.detail || `Set ${w.code} ${w.column}`}${r.rowCount ? '' : ' (no matching course found)'}`);
    }

    for (const u of chunkRows) {
      await client.query(
        `UPDATE semantic_chunks SET content = $1, embedding = $2::vector WHERE id = $3 AND document_id = $4`,
        [u.content, u.emb, u.id, catalogId]
      );
    }

    for (const u of headerUpdates) {
      await client.query(
        `UPDATE semantic_chunks SET section_header = $1 WHERE id = $2 AND document_id = $3`,
        [u.sh, u.id, catalogId]
      );
    }

    if (deleteIds.size) {
      await client.query(
        `DELETE FROM semantic_chunks WHERE document_id = $1 AND id = ANY($2::uuid[])`,
        [catalogId, Array.from(deleteIds)]
      );
    }

    for (const r of replaceRows) {
      await client.query(
        `DELETE FROM semantic_chunks WHERE document_id = $1 AND id = ANY($2::uuid[])`,
        [catalogId, r.deleteIds]
      );
      await client.query(
        `INSERT INTO semantic_chunks (id, document_id, tenant_id, section_header, content, sequence_order, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [randomUUID(), catalogId, TENANT, `Header 1: ${r.label}`, r.content, r.seq, r.emb]
      );
    }

    await client.query('COMMIT');
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[Catalog assistant apply] failed:', e.message);
    return NextResponse.json({ error: e.message || 'Failed to apply correction.' }, { status: 500 });
  } finally {
    client.release();
  }

  await logUsage(userId, catalogId, 'apply', 0, {
    overrides: newOverrides.length, courses: courseWrites.length, rewrites: chunkRows.length,
    deletes: deleteIds.size, restructured: headerUpdates.length, replaced: replaceRows.length,
  });

  // Never report false success: if nothing actually changed, say so explicitly.
  const changed = newOverrides.length + courseWrites.length + chunkRows.length + deleteIds.size + headerUpdates.length + replaceRows.length;
  if (changed === 0) {
    return NextResponse.json({
      applied: applied.length ? applied : ['No changes were applied — the requested target could not be located in this catalog.'],
      nothingApplied: true,
      overridesAdded: 0, coursesUpdated: 0, chunksUpdated: 0, chunksDeleted: 0, chunksRestructured: 0, embedded: 0,
    });
  }

  return NextResponse.json({
    applied,
    overridesAdded: newOverrides.length,
    coursesUpdated: courseWrites.length,
    chunksUpdated: chunkRows.length,
    chunksDeleted: deleteIds.size,
    chunksRestructured: headerUpdates.length,
    sectionsReplaced: replaceRows.length,
    embedded,
  });
}
