#!/usr/bin/env node
/**
 * backfill_program_requirements.mjs — populate the relational program->course link table
 * (`program_requirement_courses`) for programs that have none.
 *
 * WHY: the Jun 26 seeding covered only ~29 programs per undergraduate catalog (and zero
 * graduate programs), so most programs have no authoritative requirement rows. Everything
 * downstream (curriculum graph, AST explorer, program details) falls back to parsing
 * catalog text at request time; a course that no program names floats unconnected.
 *
 * HOW: for each uncovered program, find the semantic chunks whose leading
 * `[Header 1: ... > Header N: <program section>]` breadcrumb names the program's own
 * catalog section. Matching handles both naming families ("Physics B.S." in the DB vs
 * "B.S. in Physics" in breadcrumbs), expands to sibling Requirements chunks for
 * single-title sections (minors nest as `> Minor > Requirements`), and validates every
 * course code against the catalog's own course rows. Rows are inserted as:
 *   group_name  = requirement heading (breadcrumb tail like "Core Requirements – 45
 *                 credits", or an in-chunk section heading)
 *   is_required = false when the block reads as an elective/choice pool, else true
 *   or_group_id = NULL (alternatives can't be inferred reliably from prose)
 *
 * PRECISION OVER RECALL:
 *  - a needle that matches more than MAX_NEEDLE_CHUNKS chunks is non-discriminating
 *    (e.g. a bare "Minor") and is dropped rather than risking a catalog-wide sweep;
 *  - category-header pseudo-programs ("Certificate", "Degrees and Certificates") are
 *    excluded up front;
 *  - a program whose normalized name duplicates an already-covered program in the same
 *    document (the table holds both "Biology B.A." and "Bachelor of Arts (B.A.) in
 *    Biology") is skipped as a duplicate rather than double-linked;
 *  - a program yielding more than MAX_COURSES distinct courses is flagged and skipped.
 *
 * SAFETY: dry-run by default (prints a plan, writes it to scratchpad, mutates nothing).
 * --apply runs inside a single transaction and writes a rollback manifest (inserted row
 * ids). Idempotent: programs that already have any prc rows are skipped, so a second run
 * finds nothing to do.
 *
 * Usage:
 *   node scripts/backfill_program_requirements.mjs                    # dry-run, 2025-2026-undergraduate
 *   node scripts/backfill_program_requirements.mjs --version 2025-2026-graduate
 *   node scripts/backfill_program_requirements.mjs --all              # every catalog version
 *   node scripts/backfill_program_requirements.mjs --apply            # write changes
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const verIdx = process.argv.indexOf('--version');
const VERSION = verIdx !== -1 ? process.argv[verIdx + 1] : '2025-2026-undergraduate';
const SCRATCH = process.env.SCRATCH_DIR || path.resolve(process.cwd(), 'scripts');
const MAX_COURSES = 80;        // more distinct courses than any real program requires -> review
const MAX_NEEDLE_CHUNKS = 40;  // a needle matching more chunks than this is too generic to trust
const MAX_SIBLING_SUBTREE = 15; // sibling expansion only inside small section subtrees

function loadDbUrl() {
  const envFile = path.resolve(process.cwd(), '.env.local');
  const m = fs.readFileSync(envFile, 'utf8').match(/^DATABASE_URL=(\S+)/m);
  if (!m) throw new Error('DATABASE_URL not found in .env.local');
  return m[1];
}

/**
 * Category-only headers the Hub extractor mistook for programs ("Certificate",
 * "Degrees and Certificates"). Mirrors isNonProgramHeader in src/app/api/db/route.ts;
 * matching against these would sweep in unrelated sections, so they are never processed.
 */
function isNonProgramHeader(name) {
  const n = (name || '').trim();
  if (!n) return true;
  const CATEGORY = '(?:degrees?|majors?|minors?|concentrations?|certificates?)';
  if (new RegExp(`^${CATEGORY}(?:[\\s,&/]+(?:and\\s+)?${CATEGORY})*$`, 'i').test(n)) return true;
  if (/^(?:earning a second degree|a minor in another discipline)\b/i.test(n)) return true;
  const tokens = n.split(/\s+/).filter((t) => /[a-z]/i.test(t));
  if (tokens.length >= 6) {
    const avgLen = tokens.reduce((s, t) => s + t.replace(/[^a-z]/gi, '').length, 0) / tokens.length;
    if (avgLen < 3) return true;
  }
  return false;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COURSE_LINE_RE = /^[A-Z]{2,4}[-\s]?\d{3,4}[A-Z]?\b/;

/**
 * Course-code lookup that survives the catalog's letter-suffix convention: the text may
 * say "CHEM 103C" where the row is "CHEM 103" or vice versa ("CHEM 103" vs row
 * "CHEM 103C"). Suffix-insensitive fallbacks apply only when unambiguous.
 */
function buildCourseLookup(courses) {
  const exact = new Map();
  const stripped = new Map(); // "CHEM 103" -> [full codes...]
  for (const c of courses) {
    exact.set(c.code, c.id);
    const m = c.code.match(/^([A-Z]{2,4} \d{3,4})[A-Z]?$/);
    if (m) {
      if (!stripped.has(m[1])) stripped.set(m[1], []);
      stripped.get(m[1]).push(c.code);
    }
  }
  return {
    resolve(code) {
      if (exact.has(code)) return code;
      const base = code.replace(/[A-Z]$/, '');
      const variants = stripped.get(base) || [];
      if (variants.length === 1) return variants[0];
      return null;
    },
    idOf(code) { return exact.get(code); },
  };
}

/**
 * Alternate spellings of a program name as breadcrumbs write it. The DB holds two
 * naming families; breadcrumbs mostly use "B.S. in Physics" / "Minor in X" forms.
 */
function nameVariants(name) {
  const variants = new Set([name]);
  const DEG = [
    ['B.A.', 'Bachelor of Arts (B.A.)'],
    ['B.S.', 'Bachelor of Science (B.S.)'],
    ['M.S.', 'Master of Science (M.S.)'],
    ['M.A.', 'Master of Arts (M.A.)'],
  ];
  for (const [abbr, long] of DEG) {
    // "Physics B.S." -> "B.S. in Physics", "Bachelor of Science (B.S.) in Physics"
    const tail = name.match(new RegExp(`^(.+?)\\s+${escapeRe(abbr)}$`));
    if (tail) {
      variants.add(`${abbr} in ${tail[1]}`);
      variants.add(`${long} in ${tail[1]}`);
    }
    // "Bachelor of Science (B.S.) in Physics" -> "B.S. in Physics"
    const long2 = name.match(new RegExp(`^${escapeRe(long)}\\s+in\\s+(.+)$`, 'i'));
    if (long2) variants.add(`${abbr} in ${long2[1]}`);
  }
  return Array.from(variants).filter((v) => v.length >= 8 && !isNonProgramHeader(v));
}

/**
 * Canonical key for duplicate detection across the two naming families:
 * "Biology B.A." and "Bachelor of Arts (B.A.) in Biology" both -> "b.a.|biology".
 */
function canonicalKey(name) {
  let n = ` ${name.trim()} `;
  const markers = [];
  for (const abbr of ['B.A./B.S.', 'B.A.', 'B.S.', 'M.S.', 'M.A.', 'M.B.A.']) {
    if (n.includes(` ${abbr} `) || n.includes(`(${abbr})`) || n.includes(` ${abbr},`)) markers.push(abbr);
  }
  n = n
    .replace(/Bachelor of (Arts|Science)\s*\((B\.A\.|B\.S\.)\)\s*in\s*/gi, '')
    .replace(/Master of (Arts|Science)\s*\((M\.A\.|M\.S\.)\)\s*in\s*/gi, '')
    .replace(/\b(B\.A\.\/B\.S\.|B\.A\.|B\.S\.|M\.S\.|M\.A\.|M\.B\.A\.)\s*in\s*/g, '')
    .replace(/\b(B\.A\.\/B\.S\.|B\.A\.|B\.S\.|M\.S\.|M\.A\.|M\.B\.A\.)\b/g, '')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${markers.sort().join('/') || 'none'}|${n}`;
}

/** Split a breadcrumb "[Header 1: A > Header 2: B]" into its segment texts. */
function breadcrumbSegments(content) {
  if (!content.startsWith('[Header')) return null;
  const end = content.indexOf(']');
  if (end === -1) return null;
  return content
    .slice(1, end)
    .split('>')
    .map((s) => s.replace(/^\s*Header\s*\d+:\s*/i, '').trim())
    .filter(Boolean);
}

const segMatches = (seg, needleRes) => needleRes.some((re) => re.test(seg));

/**
 * Parse requirement blocks out of a program's section chunks.
 *
 * Group names come from the most specific real heading available: the breadcrumb's
 * tail segment when it names a requirement group ("Core Requirements – 45 credits"),
 * else an in-chunk `##`/`**` heading. Bold course lines ("**BIOL 151 – ...**") are
 * content, not headings — their courses accumulate into the current block instead of
 * fragmenting into one block per course.
 */
function parseBlocks(chunks, courseLookup, programName) {
  const courseRegex = /\b([A-Z]{2,4})\s*[-]?\s*(\d{3,4}[A-Z]?)\b/g;
  const blocks = [];

  const CHOICE_RE = /elective|choose|select one|one of the following/i;

  for (const chunk of chunks) {
    const segs = breadcrumbSegments(chunk.content) || [];
    const tail = (segs[segs.length - 1] || '').replace(/^#+\s*/, '').replace(/\*+/g, '').trim();
    const tailIsGroup = tail && tail !== programName && !COURSE_LINE_RE.test(tail);
    const baseGroup = tailIsGroup ? tail : 'Requirements';

    const cleanText = chunk.content.replace(/^\[Header\s+\d+[\s\S]*?\](?:\r?\n|$)/i, '').trim();
    const sections = cleanText.split(/(?=\n##\s+|\n###\s+|\n\*\*)/);

    let current = null; // { title, isChoice, courses: Set }
    const flush = () => {
      if (current && current.courses.size > 0) {
        blocks.push({ title: current.title.slice(0, 120), isRequired: !current.isChoice, courses: Array.from(current.courses) });
      }
      current = null;
    };

    for (const sec of sections) {
      const rawTitle = (sec.trim().split('\n')[0] || '').replace(/^#+\s*/, '').replace(/\*+/g, '').trim();
      const isCourseLine = COURSE_LINE_RE.test(rawTitle);
      const isDivider = /^[-–—=_\s]*$/.test(rawTitle);
      const isRealHeading = rawTitle.length >= 3 && !isCourseLine && !isDivider;

      if (isRealHeading && /faculty|mission statement|vision statement|^notes?\b|^total\b/i.test(rawTitle)) {
        flush();
        continue; // skip boilerplate sections entirely
      }

      if (isRealHeading) {
        flush();
        current = { title: rawTitle, isChoice: false, courses: new Set() };
      } else if (!current) {
        current = { title: baseGroup, isChoice: false, courses: new Set() };
      }

      // The choice keyword may live in the block title itself when the title came from
      // the (stripped) breadcrumb tail, e.g. "Choose ONE disciplinary intro course:".
      if (CHOICE_RE.test(sec) || CHOICE_RE.test(current.title)) current.isChoice = true;

      let m;
      courseRegex.lastIndex = 0;
      while ((m = courseRegex.exec(sec)) !== null) {
        const resolved = courseLookup.resolve(`${m[1].toUpperCase()} ${m[2].toUpperCase()}`);
        if (resolved) current.courses.add(resolved);
      }
    }
    flush();
  }

  // Merge blocks sharing a title (the same heading can span sibling chunks) and
  // de-duplicate (group, course) pairs.
  const byTitle = new Map();
  for (const b of blocks) {
    const key = b.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, { title: b.title, isRequired: b.isRequired, courses: new Set() });
    const agg = byTitle.get(key);
    agg.isRequired = agg.isRequired && b.isRequired;
    b.courses.forEach((c) => agg.courses.add(c));
  }
  return Array.from(byTitle.values()).map((b) => ({ ...b, courses: Array.from(b.courses) }));
}

async function processDocument(q, doc) {
  const DOC = doc.id;
  const tenantRow = (await q(`SELECT tenant_id FROM courses WHERE document_id = $1 LIMIT 1`, [DOC]))[0];
  if (!tenantRow) return { version: doc.version, skipped: 'no courses', plan: [] };
  const TENANT = tenantRow.tenant_id;

  const courses = await q(`SELECT id, upper(course_code) AS code FROM courses WHERE document_id = $1`, [DOC]);
  const courseLookup = buildCourseLookup(courses);

  const programs = await q(`SELECT id, name FROM programs WHERE document_id = $1`, [DOC]);
  const reqs = await q(
    `SELECT pr.id, pr.program_id FROM program_requirements pr
     JOIN programs p ON pr.program_id = p.id WHERE p.document_id = $1`, [DOC]);
  const reqsByProgram = new Map();
  reqs.forEach((r) => {
    if (!reqsByProgram.has(r.program_id)) reqsByProgram.set(r.program_id, []);
    reqsByProgram.get(r.program_id).push(r);
  });

  const coveredRows = await q(
    `SELECT DISTINCT pr.program_id FROM program_requirement_courses prc
     JOIN program_requirements pr ON prc.requirement_id = pr.id
     JOIN programs p ON pr.program_id = p.id WHERE p.document_id = $1`, [DOC]);
  const coveredPrograms = new Set(coveredRows.map((r) => r.program_id));
  const coveredKeys = new Set(
    programs.filter((p) => coveredPrograms.has(p.id)).map((p) => canonicalKey(p.name)));

  const chunks = (await q(`SELECT id, content FROM semantic_chunks WHERE document_id = $1`, [DOC]))
    .map((c) => ({ ...c, segs: breadcrumbSegments(c.content) }))
    .filter((c) => c.segs && c.segs.length > 0);

  // All program names in this doc (for sibling-expansion exclusion).
  const otherProgramRes = new Map(); // program_id -> RegExp[] of its variants
  for (const p of programs) {
    otherProgramRes.set(p.id, nameVariants(p.name).map(
      (v) => new RegExp(`(^|[^A-Za-z])${escapeRe(v)}([^A-Za-z]|$)`)));
  }

  const plan = [];
  const stats = { covered: coveredPrograms.size, junk: 0, duplicate: 0, unmatched: 0, noBlocks: 0, flagged: 0, planned: 0 };
  const claimedKeys = new Set(); // keys planned in THIS run, so twin uncovered dupes don't both write

  for (const p of programs) {
    if (coveredPrograms.has(p.id)) continue;
    if (isNonProgramHeader(p.name)) { stats.junk++; continue; }
    const key = canonicalKey(p.name);
    if (coveredKeys.has(key) || claimedKeys.has(key)) {
      stats.duplicate++;
      plan.push({ program: p.name, programId: p.id, status: 'duplicate', key });
      continue;
    }

    // Needles: name variants that discriminate (drop any matching too many chunks).
    const needleRes = [];
    for (const v of nameVariants(p.name)) {
      const re = new RegExp(`(^|[^A-Za-z])${escapeRe(v)}([^A-Za-z]|$)`);
      const hits = chunks.filter((c) => c.segs.some((s) => re.test(s))).length;
      if (hits > 0 && hits <= MAX_NEEDLE_CHUNKS) needleRes.push(re);
    }
    if (needleRes.length === 0) {
      stats.unmatched++;
      plan.push({ program: p.name, programId: p.id, status: 'unmatched' });
      continue;
    }

    // Direct matches: a needle appears in any breadcrumb segment.
    const matched = chunks.filter((c) => c.segs.some((s) => segMatches(s, needleRes)));

    // Sibling expansion: when the program name is the LAST segment (a title chunk),
    // requirement chunks often sit as siblings (`> Minor > Requirements`). Pull in
    // chunks under the same parent path — but ONLY inside a small subtree (a generic
    // parent like "Program Requirements" holds every program in the catalog and would
    // attach other programs' sections), and never a sibling that is itself some other
    // program's titled section.
    const extra = [];
    const matchedIds = new Set(matched.map((c) => c.id));
    for (const c of matched) {
      const idx = c.segs.findIndex((s) => segMatches(s, needleRes));
      if (idx !== c.segs.length - 1) continue; // program not the tail -> already a content chunk
      // Only expand when the title is nested at least two levels down ("Dept > Minor >
      // Minor in X"). Directly under a page-level Header 1 the "siblings" are unrelated
      // sections (including mis-nested orphan chunks), not this program's content.
      if (idx < 2) continue;
      const parent = c.segs.slice(0, idx).join(' > ');
      if (!parent) continue;
      const subtree = chunks.filter((cand) => cand.segs.length > idx && cand.segs.slice(0, idx).join(' > ') === parent);
      if (subtree.length > MAX_SIBLING_SUBTREE) continue;

      // The subtree must contain exactly ONE program title at this depth: ours. A
      // department page hosting several programs ("B.A./B.S. in Interdisciplinary
      // Studies" AND "B.A. in International Studies" under the same Program
      // Requirements) flattens some sections' nesting, so an orphan sibling like
      // "Additional Courses – 6 credits" could belong to any of them — skip expansion.
      const isProgramTitle = (seg) => {
        if (/\b(B\.A\.|B\.S\.|M\.S\.|M\.A\.|Minor in|Certificate in|Honors in)\b/i.test(seg)) return true;
        for (const [pid, res] of otherProgramRes) {
          if (pid !== p.id && segMatches(seg, res)) return true;
        }
        return false;
      };
      const foreignTitle = subtree.some((cand) => {
        const seg = cand.segs[idx];
        return !segMatches(seg, needleRes) && isProgramTitle(seg);
      });
      if (foreignTitle) continue;

      for (const cand of subtree) {
        if (matchedIds.has(cand.id)) continue;
        // Course-listing pages ("BIOL-107L General Biology Lab (1)") are catalog
        // descriptions, not requirement sections — never treat them as siblings.
        const candTail = (cand.segs[cand.segs.length - 1] || '').replace(/^#+\s*/, '').trim();
        if (COURSE_LINE_RE.test(candTail)) continue;
        matchedIds.add(cand.id);
        extra.push(cand);
      }
    }
    const sectionChunks = [...matched, ...extra];

    const blocks = parseBlocks(sectionChunks, courseLookup, p.name);
    if (blocks.length === 0) {
      stats.noBlocks++;
      plan.push({ program: p.name, programId: p.id, status: 'no-blocks', chunks: sectionChunks.length });
      continue;
    }

    const distinctCourses = new Set(blocks.flatMap((b) => b.courses));
    if (distinctCourses.size > MAX_COURSES) {
      stats.flagged++;
      plan.push({ program: p.name, programId: p.id, status: 'flagged-too-many-courses', courses: distinctCourses.size });
      continue;
    }

    stats.planned++;
    claimedKeys.add(key);
    plan.push({
      program: p.name,
      programId: p.id,
      status: 'planned',
      requirementId: (reqsByProgram.get(p.id) || [])[0]?.id || null, // null -> create on apply
      tenant: TENANT,
      chunks: sectionChunks.length,
      blocks,
      distinctCourses: distinctCourses.size,
    });
  }

  return { version: doc.version, doc: DOC, tenant: TENANT, stats, plan, courseLookup };
}

async function main() {
  const client = new pg.Client({ connectionString: loadDbUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;

  const docs = ALL
    ? await q(`SELECT id, version FROM documents ORDER BY version DESC`)
    : await q(`SELECT id, version FROM documents WHERE version = $1`, [VERSION]);
  if (docs.length === 0) throw new Error(`No document matches version ${VERSION}`);

  console.log(`\n=== backfill_program_requirements  mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  docs=${docs.map((d) => d.version).join(', ')} ===`);

  const results = [];
  for (const doc of docs) {
    const res = await processDocument(q, doc);
    results.push(res);
    if (res.skipped) { console.log(`\n--- ${res.version}: skipped (${res.skipped})`); continue; }
    const s = res.stats;
    console.log(`\n--- ${res.version}`);
    console.log(`    covered: ${s.covered} | junk: ${s.junk} | duplicates: ${s.duplicate} | unmatched: ${s.unmatched} | no-blocks: ${s.noBlocks} | flagged: ${s.flagged} | PLANNED: ${s.planned}`);
    const planned = res.plan.filter((p) => p.status === 'planned');
    planned.slice(0, 8).forEach((p) => {
      console.log(`    + ${p.program.slice(0, 48).padEnd(48)} blocks=${p.blocks.length} courses=${p.distinctCourses}`);
      p.blocks.slice(0, 3).forEach((b) =>
        console.log(`        [${b.isRequired ? 'REQ' : 'CHOICE'}] "${b.title.slice(0, 52)}" -> ${b.courses.slice(0, 6).join(', ')}${b.courses.length > 6 ? ` (+${b.courses.length - 6})` : ''}`));
    });
    if (planned.length > 8) console.log(`    ... +${planned.length - 8} more programs`);
  }

  const planPath = path.join(SCRATCH, `backfill_requirements_plan.json`);
  fs.writeFileSync(planPath, JSON.stringify(results.map(({ courseLookup, ...r }) => r), null, 2));
  const totalRows = results.flatMap((r) => r.plan || []).filter((p) => p.status === 'planned')
    .reduce((sum, p) => sum + p.blocks.reduce((s2, b) => s2 + b.courses.length, 0), 0);
  console.log(`\nTotal link rows to insert: ${totalRows}`);
  console.log(`Full plan written to: ${planPath}`);

  if (!APPLY) {
    console.log('\nDRY-RUN complete. Re-run with --apply to write these changes.\n');
    await client.end();
    return;
  }

  console.log('\nAPPLYING in a transaction...');
  const insertedReqIds = [];
  const insertedPrcIds = [];
  await client.query('BEGIN');
  try {
    for (const res of results) {
      if (res.skipped) continue;
      for (const p of (res.plan || []).filter((x) => x.status === 'planned')) {
        let reqId = p.requirementId;
        if (!reqId) {
          reqId = crypto.randomUUID();
          // Empty JSON shell matches the schema-evolution convention for tree-less rows.
          const shell = JSON.stringify({ type: 'AND', group_name: p.program, children: [] }, null, 2);
          await client.query(
            `INSERT INTO program_requirements (id, tenant_id, program_id, degree_name, logic_tree)
             VALUES ($1, $2, $3, $4, $5)`,
            [reqId, p.tenant, p.programId, p.program.slice(0, 200), shell]);
          insertedReqIds.push(reqId);
        }
        for (const b of p.blocks) {
          for (const code of b.courses) {
            const courseId = res.courseLookup.idOf(code);
            if (!courseId) continue;
            const prcId = crypto.randomUUID();
            await client.query(
              `INSERT INTO program_requirement_courses (id, tenant_id, requirement_id, course_id, group_name, is_required)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [prcId, p.tenant, reqId, courseId, b.title, b.isRequired]);
            insertedPrcIds.push(prcId);
          }
        }
      }
    }
    await client.query('COMMIT');
    console.log(`COMMIT ok: ${insertedReqIds.length} requirement rows + ${insertedPrcIds.length} link rows inserted.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK — apply failed:', e.message);
    await client.end();
    process.exit(1);
  }

  const rollbackPath = path.join(SCRATCH, `backfill_requirements_rollback.json`);
  fs.writeFileSync(rollbackPath, JSON.stringify({ insertedReqIds, insertedPrcIds }, null, 2));
  console.log(`Rollback manifest written to: ${rollbackPath}`);

  const after = await q(`
    SELECT d.version, count(DISTINCT p.id)::int AS total,
           count(DISTINCT p.id) FILTER (WHERE prc.id IS NOT NULL)::int AS covered
    FROM programs p
    JOIN documents d ON p.document_id = d.id
    LEFT JOIN program_requirements pr ON pr.program_id = p.id
    LEFT JOIN program_requirement_courses prc ON prc.requirement_id = pr.id
    GROUP BY d.version ORDER BY d.version`);
  console.log('\nPOST-APPLY coverage:', JSON.stringify(after));
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
