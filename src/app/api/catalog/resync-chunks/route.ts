import { NextResponse } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID } from '@/lib/brand';
import { getGcpCredentials } from '@/lib/llm';
import { generateEmbedding } from '@/app/api/assistant/route';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

const TENANT = TENANT_ID;
const API_BASE_URL = process.env.NEXT_PUBLIC_SWARM_API_URL || 'http://localhost:8080';

const norm = (s: any): string => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** Ask the Cloud Run agent to rewrite a chunk if the correction applies to it. */
async function rewriteChunk(instruction: string, chunkContent: string): Promise<{ changed: boolean; content: string } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/agent/rewrite-chunk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, chunk_content: chunkContent }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Re-sync narrative chunks after delta corrections are applied (apply, narrative phase).
 *
 * For each applied correction, finds the affected semantic_chunks in the draft, rewrites their
 * `content` to match the change (via the Cloud Run agent), and creates course-description chunks
 * for ADDed courses. Every changed/created chunk gets `embedding = NULL` so the upstream 4096-d
 * ingestion pipeline re-embeds exactly those. No embeddings are generated here.
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
    return NextResponse.json({ error: 'Forbidden: Only registrars and owners can re-sync chunks.' }, { status: 403 });
  }

  const { draftId, correctionIds } = await req.json();
  if (!draftId) return NextResponse.json({ error: 'draftId is required.' }, { status: 400 });

  // Target corrections: those applied to this draft (optionally narrowed).
  let sql = `SELECT id, proposed_value, reason, applied_patch FROM corrections
              WHERE tenant_id = $1 AND status = 'applied' AND applied_to_document_id = $2`;
  const params: any[] = [TENANT, draftId];
  if (Array.isArray(correctionIds) && correctionIds.length) {
    sql += ` AND id = ANY($3)`;
    params.push(correctionIds);
  }
  const corrections = await query(sql, params);

  // Plan writes by inspecting each correction's stored diff, then calling the agent per candidate.
  const updates = new Map<string, string>(); // chunkId -> new content
  const seenChunks = new Set<string>();
  const inserts: { section_header: string; content: string }[] = [];
  let candidatesConsidered = 0;

  for (const corr of corrections) {
    const diffs: any[] = corr.applied_patch?.diffs || [];
    const courseCodes = new Set<string>();
    const programNames = new Set<string>();
    const insertCodes: { code: string; title: string }[] = [];

    for (const d of diffs) {
      if (d.kind === 'course' && d.after) courseCodes.add(norm(d.code));
      else if (d.kind === 'edge') courseCodes.add(norm(d.course));
      else if (d.kind === 'program' && d.after) programNames.add(d.before?.name || d.name);
      else if (d.kind === 'insert' && d.after) insertCodes.push({ code: norm(d.code), title: d.after.title });
    }

    // Candidate chunks for amended courses (course-description entries first).
    for (const code of courseCodes) {
      const pat = `\\y${code}\\y`;
      const cands = await query(
        `SELECT id, content FROM semantic_chunks
          WHERE document_id = $1 AND (content ~* $2 OR section_header ~* $2)
          ORDER BY (section_header ~* $2) DESC NULLS LAST
          LIMIT 10`,
        [draftId, pat]
      );
      for (const ch of cands) {
        if (seenChunks.has(ch.id)) continue;
        seenChunks.add(ch.id);
        candidatesConsidered++;
        const r = await rewriteChunk(corr.proposed_value, ch.content);
        if (r?.changed && r.content && r.content !== ch.content) updates.set(ch.id, r.content);
      }
    }

    // Candidate chunks for program renames / program-level text.
    for (const name of programNames) {
      if (!name || String(name).length < 4) continue;
      const cands = await query(
        `SELECT id, content FROM semantic_chunks
          WHERE document_id = $1 AND (content ILIKE $2 OR section_header ILIKE $2) LIMIT 10`,
        [draftId, `%${name}%`]
      );
      for (const ch of cands) {
        if (seenChunks.has(ch.id)) continue;
        seenChunks.add(ch.id);
        candidatesConsidered++;
        const r = await rewriteChunk(corr.proposed_value, ch.content);
        if (r?.changed && r.content && r.content !== ch.content) updates.set(ch.id, r.content);
      }
    }

    // New course-description chunks for ADDed courses.
    for (const ins of insertCodes) {
      const exists = await query(
        `SELECT 1 FROM semantic_chunks WHERE document_id = $1 AND section_header ILIKE $2 LIMIT 1`,
        [draftId, `%${ins.code}%Course Descriptions%`]
      );
      if (exists.length) continue;
      const courseRow = (await query(
        `SELECT course_code, title, credits, description, prerequisites FROM courses
          WHERE document_id = $1 AND course_code = $2 LIMIT 1`,
        [draftId, ins.code]
      ))[0];
      if (!courseRow) continue;
      const header = `Header 1: Course Descriptions > Header 2: ${courseRow.course_code}. ${courseRow.title}`;
      const content =
        `[${header}]\n\n${courseRow.course_code} ${courseRow.title}` +
        `${courseRow.credits != null ? ` (${courseRow.credits} hours)` : ''}\n` +
        `${courseRow.description || ''}\n` +
        `Prerequisite: ${courseRow.prerequisites || 'None'}`;
      inserts.push({ section_header: header, content });
    }
  }

  if (updates.size === 0 && inserts.length === 0) {
    return NextResponse.json({ draftId, updated: 0, created: 0, candidatesConsidered, embedded: 0 });
  }

  // Re-embed changed/created chunks with the standardized model (gemini-embedding-001 @ 1536),
  // so the corrected narrative is immediately searchable. On failure, store NULL (a later
  // scripts/reembed.mjs pass fills it) so the content write still succeeds.
  const gcp = await getGcpCredentials(req);
  const geminiKey = process.env.GEMINI_API_KEY;
  const embedLiteral = async (content: string): Promise<string | null> => {
    try {
      const v = await generateEmbedding(content, gcp, geminiKey);
      return v && v.length ? `[${v.join(',')}]` : null;
    } catch {
      return null;
    }
  };

  const updateRows = await Promise.all(
    Array.from(updates).map(async ([id, content]) => ({ id, content, emb: await embedLiteral(content) }))
  );
  const insertRows = await Promise.all(
    inserts.map(async (ins) => ({ ...ins, emb: await embedLiteral(ins.content) }))
  );
  const embedded = updateRows.filter((r) => r.emb).length + insertRows.filter((r) => r.emb).length;

  // Apply all narrative writes in one RLS transaction.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT]);
    await client.query(`SET LOCAL ROLE authenticated`);

    for (const u of updateRows) {
      await client.query(
        `UPDATE semantic_chunks SET content = $1, embedding = $2::vector WHERE id = $3 AND document_id = $4`,
        [u.content, u.emb, u.id, draftId]
      );
    }

    let maxSeq = (await client.query(
      `SELECT COALESCE(MAX(sequence_order), 0) AS m FROM semantic_chunks WHERE document_id = $1`,
      [draftId]
    )).rows[0].m as number;

    for (const ins of insertRows) {
      maxSeq += 1;
      await client.query(
        `INSERT INTO semantic_chunks (id, document_id, tenant_id, section_header, content, sequence_order, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [randomUUID(), draftId, TENANT, ins.section_header, ins.content, maxSeq, ins.emb]
      );
    }

    await client.query('COMMIT');
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('Resync Chunks Error:', e);
    return NextResponse.json({ error: e.message || 'Failed to re-sync chunks.' }, { status: 500 });
  } finally {
    client.release();
  }

  return NextResponse.json({
    draftId,
    updated: updates.size,
    created: inserts.length,
    candidatesConsidered,
    embedded,
  });
}
