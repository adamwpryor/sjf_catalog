#!/usr/bin/env node
/**
 * backfill_course_codes.mjs — repair truncated 4-digit course codes in the spoke DB.
 *
 * ROOT CAUSE (upstream, see docs/HUB_COURSE_CODE_TRUNCATION.md): the Hub course
 * populator extracted course numbers with a `\d{3}` regex, so a 4-digit code like
 * "AFAM 1001" was stored as "AFAM 100" and the orphaned 4th digit ("1") was shoved onto
 * the front of the title ("1 Civil Rights & Civil Wrongs"). Worse, distinct courses that
 * share a 3-digit prefix collided (AFAM 1001/1002/1003 -> "AFAM 100") and all but one were
 * silently dropped.
 *
 * The authoritative record survives untouched in each course chunk's breadcrumb:
 *   [Header 1: Academic Programs > Header 2: AFAM-1001 Civil Rights & Civil Wrongs (3)]
 * and `courses.source_chunk_id` links most courses to their chunk. This script uses that
 * linkage to (1) FIX the code/title of truncated rows in place and (2) RECOVER courses
 * lost to collisions by inserting them from their orphaned chunks.
 *
 * SAFETY: dry-run by default (prints a plan, writes it to scratchpad, mutates nothing).
 * Pass --apply to run UPDATEs + INSERTs inside a single transaction. Idempotent: a second
 * run finds nothing to do. FK-safe: prerequisite/requirement links reference course UUIDs,
 * not the code text, so rewriting course_code cannot orphan them.
 *
 * Usage:
 *   node scripts/backfill_course_codes.mjs                 # dry-run, 2025-2026-undergraduate
 *   node scripts/backfill_course_codes.mjs --version 2025-2026-graduate
 *   node scripts/backfill_course_codes.mjs --apply         # write changes
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const verIdx = process.argv.indexOf('--version');
const VERSION = verIdx !== -1 ? process.argv[verIdx + 1] : '2025-2026-undergraduate';
const SCRATCH = process.env.SCRATCH_DIR || './artifacts/scratch';

function loadDbUrl() {
  const envFile = path.resolve(process.cwd(), '.env.local');
  const m = fs.readFileSync(envFile, 'utf8').match(/^DATABASE_URL=(\S+)/m);
  if (!m) throw new Error('DATABASE_URL not found in .env.local');
  return m[1];
}

/**
 * Parse a chunk's `Header 2:` breadcrumb into a course record.
 * @returns {null | {prefix:string,num:string,suffix:string,code:string,title:string,credits:number|null}}
 */
function parseHeader(content) {
  // Grab the Header 2 segment up to the next `>` (further header) or the closing `]`.
  const seg = content.match(/Header 2:\s*([^\]>]+?)\s*(?:>|\])/);
  if (!seg) return null;
  const body = seg[1].trim();
  // CODE = 2-4 letters, hyphen/space, 3-4 digits, optional single-letter suffix.
  const cm = body.match(/^([A-Z]{2,4})\s*[- ]\s*(\d{3,4})([A-Z]?)\b\s*(.*)$/);
  if (!cm) return null;
  const [, prefix, num, suffix, rest] = cm;
  // Trailing "(3)" / "(1-4)" credit annotation, if present.
  let title = rest.trim();
  let credits = null;
  const crm = title.match(/\((\d+)(?:\s*-\s*\d+)?\)\s*$/);
  if (crm) {
    credits = parseInt(crm[1], 10);
    title = title.slice(0, crm.index).trim();
  }
  title = title.replace(/[\s.\-:]+$/, '').trim();
  if (!title) return null;
  return { prefix, num, suffix, code: `${prefix} ${num}${suffix}`, title, credits };
}

/** Strip the leading breadcrumb + markdown noise from a chunk to recover description prose. */
function chunkDescription(content) {
  return content
    .replace(/^\[Header[^\]]*\]\s*/i, '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .trim();
}

async function main() {
  const client = new pg.Client({ connectionString: loadDbUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;

  const doc = (await q(`SELECT id FROM documents WHERE version = $1`, [VERSION]))[0];
  if (!doc) throw new Error(`No document with version ${VERSION}`);
  const DOC = doc.id;
  // documents has no tenant_id; derive it from the doc's own course rows (all share one tenant).
  const tenantRow = (await q(`SELECT tenant_id FROM courses WHERE document_id = $1 LIMIT 1`, [DOC]))[0];
  if (!tenantRow) throw new Error(`No courses found for document ${VERSION}; cannot resolve tenant.`);
  const TENANT = tenantRow.tenant_id;
  console.log(`\n=== backfill_course_codes  version=${VERSION}  doc=${DOC}  mode=${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

  // Authoritative catalog from chunk breadcrumbs. One code may span many chunks; keep the
  // one with the longest content as the representative (fullest description).
  const chunks = await q(
    `SELECT id, content, length(content) AS len FROM semantic_chunks WHERE document_id = $1`, [DOC]);
  const chunkParse = new Map();          // chunk_id -> parsed record
  const byCode = new Map();              // code -> { rec, chunkId, len }
  for (const ch of chunks) {
    const rec = parseHeader(ch.content);
    if (!rec) continue;
    chunkParse.set(ch.id, rec);
    const prev = byCode.get(rec.code);
    if (!prev || ch.len > prev.len) byCode.set(rec.code, { rec, chunkId: ch.id, len: ch.len, content: ch.content });
  }
  console.log(`Authoritative: ${byCode.size} distinct course codes across ${chunkParse.size} course chunks.`);

  // Current stored courses for this document.
  const courses = await q(
    `SELECT id, course_code, title, credits, subject_id, source_chunk_id, is_ghost, institution_id
     FROM courses WHERE document_id = $1`, [DOC]);
  const storedByCode = new Map(courses.map((c) => [c.course_code, c]));

  // Subject + institution resolution for inserts.
  const subjects = await q(`SELECT id, upper(prefix) AS prefix FROM subjects WHERE tenant_id = $1`, [TENANT]);
  const subjectByPrefix = new Map(subjects.map((s) => [s.prefix, s.id]));
  const institutionId = courses.find((c) => c.institution_id)?.institution_id || null;

  // ---- FIX PASS: reconstruct truncated 4-digit codes SELF-CONTAINED from each row ----
  // The dropped 4th digit is deterministically preserved as an orphaned leading digit on
  // the title ("AFAM 100" / "1 Civil Rights..." <- "AFAM 1001 Civil Rights..."), so we
  // rebuild from the row's OWN data. We deliberately do NOT trust source_chunk_id: the dry
  // run showed some links point at the wrong chunk, which would relabel correct courses.
  // The authoritative chunk map is used only to (a) confirm the rebuilt code is a real
  // catalog code and (b) supply credits when the stored value is null — never the title.
  const updates = [];
  const toTargets = new Map();
  for (const c of courses) {
    const title = (c.title || '').trim();
    const om = title.match(/^(\d)(?=\D|$)\s*([\s\S]*)$/);   // leading lone digit = dropped 4th digit
    if (!om) continue;
    const cm = (c.course_code || '').match(/^([A-Z]{2,4})\s+(\d{3})$/); // exactly 3 digits, no suffix
    if (!cm) continue;
    const orphan = om[1];
    const cleanTitle = om[2].trim();
    if (!cleanTitle) continue;                              // don't strip a title down to nothing
    const newCode = `${cm[1]} ${cm[2]}${orphan}`;
    const auth = byCode.get(newCode);
    updates.push({
      id: c.id, from_code: c.course_code, to_code: newCode,
      from_title: c.title, to_title: cleanTitle,
      credits: c.credits == null && auth ? auth.rec.credits : c.credits,
      validated: !!auth, codeChanged: true, titleChanged: true,
    });
    toTargets.set(newCode, (toTargets.get(newCode) || 0) + 1);
  }
  // Drop any reconstruction that would land on a code already owned by an untouched row,
  // or that two rows both claim — those are ambiguous and must not be auto-applied.
  const ownedByUntouched = new Set(
    courses.filter((c) => !updates.find((u) => u.id === c.id)).map((c) => c.course_code));
  const safeUpdates = updates.filter((u) => toTargets.get(u.to_code) === 1 && !ownedByUntouched.has(u.to_code));
  const droppedUpdates = updates.filter((u) => !safeUpdates.includes(u));
  updates.length = 0;
  updates.push(...safeUpdates);

  // Codes that WILL exist after the fix pass (for collision-safe recovery).
  const codesAfterFix = new Set(courses.map((c) => c.course_code));
  for (const u of updates) { codesAfterFix.delete(u.from_code); codesAfterFix.add(u.to_code); }

  // ---- RECOVER PASS: insert courses whose chunk exists but no row points to it ----
  const linkedChunkIds = new Set(courses.map((c) => c.source_chunk_id).filter(Boolean));
  const inserts = [];
  for (const [code, { rec, chunkId, content }] of byCode) {
    if (codesAfterFix.has(code)) continue;          // already represented after fixes
    if (linkedChunkIds.has(chunkId)) continue;       // chunk already owned by a course
    const subjectId = subjectByPrefix.get(rec.prefix) || null;
    inserts.push({
      code, title: rec.title, credits: rec.credits, subject_id: subjectId,
      source_chunk_id: chunkId, description: chunkDescription(content).slice(0, 4000),
      missingSubject: !subjectId,
    });
    codesAfterFix.add(code);
  }

  // ---- REPORT ----
  console.log(`\nFIX PASS  -> ${updates.length} rows to update  (${updates.filter((u) => u.validated).length} confirmed against a catalog chunk code)`);
  if (droppedUpdates.length) {
    console.log(`   ${droppedUpdates.length} ambiguous reconstruction(s) SKIPPED (target code collides with another row):`);
    droppedUpdates.slice(0, 8).forEach((u) => console.log(`     ~ ${u.from_code} "${(u.from_title || '').slice(0, 30)}" -> ${u.to_code} (skipped)`));
  }
  console.log('   samples:');
  updates.slice(0, 10).forEach((u) => console.log(`     ${u.from_code.padEnd(10)} "${(u.from_title || '').slice(0, 34)}"  ->  ${u.to_code.padEnd(10)} "${u.to_title.slice(0, 34)}"${u.validated ? '' : '  [unconfirmed]'}`));

  console.log(`\nRECOVER PASS -> ${inserts.length} courses to insert`);
  console.log(`   missing subject mapping: ${inserts.filter((i) => i.missingSubject).length}`);
  console.log('   samples:');
  inserts.slice(0, 10).forEach((i) => console.log(`     + ${i.code.padEnd(10)} "${i.title.slice(0, 40)}"  (cr ${i.credits ?? '?'})`));

  const plan = { version: VERSION, doc: DOC, updates, droppedUpdates, inserts };
  const planPath = path.join(SCRATCH, `backfill_plan_${VERSION}.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`\nFull plan written to: ${planPath}`);
  console.log(`Projected course count: ${courses.length} -> ${courses.length + inserts.length}`);

  if (!APPLY) {
    console.log('\nDRY-RUN complete. Re-run with --apply to write these changes.\n');
    await client.end();
    return;
  }

  // ---- APPLY (transactional) ----
  // Capture a pre-image of every row we touch so the commit is reversible after the fact
  // (the transaction only guarantees atomicity, not undo-after-commit).
  const preImage = updates.map((u) => {
    const c = courses.find((x) => x.id === u.id);
    return { id: c.id, course_code: c.course_code, title: c.title, credits: c.credits };
  });
  console.log('\nAPPLYING in a transaction...');
  const insertedIds = [];
  await client.query('BEGIN');
  try {
    for (const u of updates) {
      await client.query(
        `UPDATE courses SET course_code = $1, title = $2, credits = $3 WHERE id = $4`,
        [u.to_code, u.to_title, u.credits, u.id]);
    }
    for (const i of inserts) {
      const r = await client.query(
        `INSERT INTO courses (tenant_id, document_id, course_code, title, credits, subject_id,
                              source_chunk_id, description, is_ghost, institution_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9) RETURNING id`,
        [TENANT, DOC, i.code, i.title, i.credits, i.subject_id, i.source_chunk_id, i.description, institutionId]);
      insertedIds.push(r.rows[0].id);
    }
    await client.query('COMMIT');
    console.log(`COMMIT ok: ${updates.length} updated, ${inserts.length} inserted.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK — apply failed:', e.message);
    await client.end();
    process.exit(1);
  }

  // Rollback manifest: `UPDATE` each pre-image back, then `DELETE` the inserted ids.
  const rollbackPath = path.join(SCRATCH, `backfill_rollback_${VERSION}.json`);
  fs.writeFileSync(rollbackPath, JSON.stringify({ version: VERSION, doc: DOC, preImage, insertedIds }, null, 2));
  console.log(`Rollback manifest written to: ${rollbackPath}`);

  const after = await q(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE course_code ~ ' [0-9]{4}([A-Z])?$')::int four_digit,
            count(*) FILTER (WHERE title ~ '^[0-9]([^0-9]|$)')::int orphan_titles
     FROM courses WHERE document_id = $1`, [DOC]);
  console.log('\nPOST-APPLY verification:', JSON.stringify(after[0]));
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
