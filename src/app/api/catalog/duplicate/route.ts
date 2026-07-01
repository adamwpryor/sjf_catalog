import { NextResponse } from 'next/server';
import { query, getClient } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { randomUUID } from 'crypto';

/**
 * Duplicates an existing catalog into a new draft version.
 * Clones the master document, courses, programs, semantic chunks, and all of
 * their relationship tables.
 *
 * The clone is a *complete, functional* copy: every insertable column is carried
 * forward verbatim (embeddings, content hashes, markdown links, and any columns
 * added to the schema later), so a draft can be edited year-over-year instead of
 * rebuilt from scratch. Only remapped keys (primary keys, document_id, foreign
 * keys, tenant_id) are overridden.
 *
 * The entire clone runs inside a single transaction with one RLS-authenticated
 * client, so it is atomic: either the full draft is created or nothing is.
 *
 * @param req - The incoming POST request containing source catalog ID and new version.
 * @returns A JSON response indicating success and the new catalog ID.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !session.user) {
    return NextResponse.json({ error: "Forbidden: Authentication required." }, { status: 401 });
  }
  const userId = session.user.id;

  const roleQuery = await query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
  const userRole = roleQuery.length > 0 ? roleQuery[0].role : null;

  // Only registrars and owners may start a new catalog project. This mirrors the
  // "Write Access" RLS policy on the catalog tables (admins are intentionally
  // excluded — they manage the system, but don't author catalog versions).
  if (!userRole || !['registrar', 'owner'].includes(userRole)) {
    return NextResponse.json({ error: "Forbidden: Only registrars and owners can create a new catalog." }, { status: 403 });
  }

  const { sourceCatalogId, newVersion } = await req.json();

  if (!sourceCatalogId || !newVersion) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  const tenantId = 'CCSJ';
  const newCatalogId = randomUUID();

  const client = await getClient();

  // Cache of insertable columns (with type info) per table. We deliberately
  // exclude generated and identity columns: SELECT * returns their values, but
  // Postgres rejects writing to them. Introspecting the live schema is what makes
  // the clone future-proof — new columns are picked up automatically without
  // touching this route.
  const colCache = new Map<string, { name: string; isJson: boolean }[]>();
  const insertableCols = async (table: string): Promise<{ name: string; isJson: boolean }[]> => {
    if (!colCache.has(table)) {
      const r = await client.query(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND is_generated = 'NEVER'
            AND is_identity = 'NO'`,
        [table]
      );
      colCache.set(table, r.rows.map((x: any) => ({
        name: x.column_name,
        isJson: x.data_type === 'json' || x.data_type === 'jsonb',
      })));
    }
    return colCache.get(table)!;
  };

  /**
   * Clones one row into `table`, carrying forward every insertable column from
   * `sourceRow` and applying `overrides` to remapped keys. Columns present in
   * `overrides` always win (even if absent from the source row).
   *
   * json/jsonb values are re-serialized with JSON.stringify: node-postgres parses
   * them into JS objects/arrays on read, and a JS array passed back as a parameter
   * would otherwise be sent as a Postgres array literal `{...}` rather than JSON.
   */
  const cloneRow = async (
    table: string,
    sourceRow: Record<string, any>,
    overrides: Record<string, any>
  ) => {
    const meta = (await insertableCols(table)).filter(c => c.name in overrides || c.name in sourceRow);
    const cols = meta.map(c => c.name);
    const values = meta.map(c => {
      const v = c.name in overrides ? overrides[c.name] : sourceRow[c.name];
      return c.isJson && v != null ? JSON.stringify(v) : v;
    });
    const colList = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    try {
      return await client.query(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`, values);
    } catch (err: any) {
      // Tag the failing table and surface Postgres' diagnostic fields, which pin
      // down which column/value the driver rejected (e.g. a json round-trip).
      const parts = [
        `cloneRow failed on "${table}"`,
        err.message,
        err.detail && `detail: ${err.detail}`,
        err.column && `column: ${err.column}`,
        err.where && `where: ${err.where}`,
        err.routine && `routine: ${err.routine}`,
      ].filter(Boolean);
      throw new Error(parts.join(' | '));
    }
  };

  try {
    await client.query('BEGIN');
    // Establish the RLS auth context once for the whole transaction.
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    // The relationship tables (course_prerequisite_links, program_requirements,
    // program_faculty, policy_mentions_*) are guarded ONLY by a tenant-isolation RLS
    // policy (tenant_id = current_setting('app.current_tenant')). Without this, their
    // SELECTs return 0 rows under the authenticated role and the clone silently copies
    // none of them — so set the tenant GUC for the whole transaction.
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await client.query(`SET LOCAL ROLE authenticated`);

    // 0. Verify the source catalog is actually visible/exists under this context.
    //    Without this guard, an INSERT ... SELECT against a missing source would
    //    silently insert zero rows and the route would report a phantom success.
    //    We pull the full row so step 1 can carry every document column forward.
    const sourceCheck = await client.query(`SELECT * FROM documents WHERE id = $1`, [sourceCatalogId]);
    if (sourceCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: "Source catalog not found or not accessible." }, { status: 404 });
    }
    const sourceDoc = sourceCheck.rows[0];

    // 1. Create the draft document. RETURNING + row-count check guarantees the
    //    clone genuinely persisted before we report success downstream.
    const docInsert = await cloneRow('documents', sourceDoc, {
      id: newCatalogId,
      version: newVersion,
      created_at: new Date(),
    });
    if (docInsert.rowCount !== 1) {
      throw new Error("Failed to create draft document (0 rows inserted). Check write permissions (RLS) for your role.");
    }

    // 2. Clone courses (re-mapping IDs in memory).
    const courses = (await client.query(`SELECT * FROM courses WHERE document_id = $1`, [sourceCatalogId])).rows;
    const courseIdMap = new Map();
    for (const c of courses) {
      const newId = randomUUID();
      courseIdMap.set(c.id, newId);
      await cloneRow('courses', c, { id: newId, document_id: newCatalogId, tenant_id: tenantId });
    }

    // 3. Clone programs.
    const programs = (await client.query(`SELECT * FROM programs WHERE document_id = $1`, [sourceCatalogId])).rows;
    const programIdMap = new Map();
    for (const p of programs) {
      const newId = randomUUID();
      programIdMap.set(p.id, newId);
      await cloneRow('programs', p, { id: newId, document_id: newCatalogId, tenant_id: tenantId });
    }

    // 4. Clone semantic chunks (carries embeddings, content_hash, markdown_url, …).
    const chunks = (await client.query(`SELECT * FROM semantic_chunks WHERE document_id = $1`, [sourceCatalogId])).rows;
    const chunkIdMap = new Map();
    for (const sc of chunks) {
      const newId = randomUUID();
      chunkIdMap.set(sc.id, newId);
      await cloneRow('semantic_chunks', sc, { id: newId, document_id: newCatalogId, tenant_id: tenantId });
    }

    // 5. Clone Relationship Tables
    const oldCourseIds = Array.from(courseIdMap.keys());
    const oldProgramIds = Array.from(programIdMap.keys());
    const oldChunkIds = Array.from(chunkIdMap.keys());

    // 5A. Course Prerequisite Links
    if (oldCourseIds.length > 0) {
      const prereqs = (await client.query(`SELECT * FROM course_prerequisite_links WHERE course_id = ANY($1) AND tenant_id = $2`, [oldCourseIds, tenantId])).rows;
      for (const pr of prereqs) {
        const newCourseId = courseIdMap.get(pr.course_id);
        const newPrereqId = courseIdMap.get(pr.prereq_course_id);
        if (newCourseId && newPrereqId) {
          await cloneRow('course_prerequisite_links', pr, {
            id: randomUUID(),
            course_id: newCourseId,
            prereq_course_id: newPrereqId,
            tenant_id: tenantId,
          });
        }
      }
    }

    // 5B. Program Requirements and Requirement Courses
    if (oldProgramIds.length > 0) {
      const reqs = (await client.query(`SELECT * FROM program_requirements WHERE program_id = ANY($1) AND tenant_id = $2`, [oldProgramIds, tenantId])).rows;
      const reqIdMap = new Map();
      for (const r of reqs) {
        const newReqId = randomUUID();
        reqIdMap.set(r.id, newReqId);
        const newProgramId = programIdMap.get(r.program_id);
        if (newProgramId) {
          await cloneRow('program_requirements', r, { id: newReqId, program_id: newProgramId, tenant_id: tenantId });
        }
      }

      const oldReqIds = Array.from(reqIdMap.keys());
      if (oldReqIds.length > 0) {
        const reqCourses = (await client.query(`SELECT * FROM program_requirement_courses WHERE requirement_id = ANY($1) AND tenant_id = $2`, [oldReqIds, tenantId])).rows;
        for (const rc of reqCourses) {
          const newReqId = reqIdMap.get(rc.requirement_id);
          const newCourseId = courseIdMap.get(rc.course_id);
          if (newReqId && newCourseId) {
            await cloneRow('program_requirement_courses', rc, {
              id: randomUUID(),
              requirement_id: newReqId,
              course_id: newCourseId,
              tenant_id: tenantId,
            });
          }
        }
      }

      // 5C. Program Faculty
      const programFaculty = (await client.query(`SELECT * FROM program_faculty WHERE program_id = ANY($1) AND tenant_id = $2`, [oldProgramIds, tenantId])).rows;
      for (const pf of programFaculty) {
        const newProgramId = programIdMap.get(pf.program_id);
        if (newProgramId) {
          // faculty_id intentionally not remapped: faculty are shared, not cloned.
          await cloneRow('program_faculty', pf, { id: randomUUID(), program_id: newProgramId, tenant_id: tenantId });
        }
      }
    }

    // 5D. Policy Mentions
    if (oldChunkIds.length > 0) {
      // Policy mentions courses
      const pmc = (await client.query(`SELECT * FROM policy_mentions_courses WHERE policy_chunk_id = ANY($1) AND tenant_id = $2`, [oldChunkIds, tenantId])).rows;
      for (const p of pmc) {
        const newChunkId = chunkIdMap.get(p.policy_chunk_id);
        const newCourseId = courseIdMap.get(p.course_id);
        if (newChunkId && newCourseId) {
          await cloneRow('policy_mentions_courses', p, {
            id: randomUUID(),
            policy_chunk_id: newChunkId,
            course_id: newCourseId,
            tenant_id: tenantId,
          });
        }
      }

      // Policy mentions programs
      const pmp = (await client.query(`SELECT * FROM policy_mentions_programs WHERE policy_chunk_id = ANY($1) AND tenant_id = $2`, [oldChunkIds, tenantId])).rows;
      for (const p of pmp) {
        const newChunkId = chunkIdMap.get(p.policy_chunk_id);
        const newProgramId = programIdMap.get(p.program_id);
        if (newChunkId && newProgramId) {
          await cloneRow('policy_mentions_programs', p, {
            id: randomUUID(),
            policy_chunk_id: newChunkId,
            program_id: newProgramId,
            tenant_id: tenantId,
          });
        }
      }
    }

    await client.query('COMMIT');

    return NextResponse.json({
      status: "success",
      message: "Catalog successfully duplicated to Draft version.",
      catalogId: newCatalogId,
      counts: {
        courses: courses.length,
        programs: programs.length,
        chunks: chunks.length
      }
    });

  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
    console.error("Duplicate Catalog Error: ", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  } finally {
    client.release();
  }
}
