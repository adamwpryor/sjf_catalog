/**
 * backfill_source_pages.mjs — repair `markdown_url` provenance across the catalog.
 *
 * THE TWO DEFECTS THIS FIXES
 *
 *   1. WRONG BUCKET. Stored URLs may point to a legacy or misconfigured bucket
 *      that contains no objects for the current deployment.
 *      The valid assets live in the configured bucket under the identical path suffix,
 *      so only the bucket segment is wrong.
 *
 *   2. EVERY COURSE AND CHUNK POINTS AT PAGE 1. `semantic_chunks.page_number` is 1
 *      for all 39,544 rows (a web-scrape artifact), and the original backfill derived
 *      `markdown_url` from that number — so all 8 catalogs collapse onto `page_0001.md`.
 *      The real per-page assets DO exist (e.g. 771 pages for 2025-2026-undergraduate);
 *      the database simply lost the mapping. This script rebuilds it from the assets.
 *
 * HOW A COURSE IS MAPPED
 *   A course code appears on many pages — most of them program requirement listings
 *   ("* HIST 301 - P1 Japanese History through Film (3)"). Those are mentions, not
 *   sources. The authoritative source is the course-description entry, which is a
 *   markdown heading: "## HIST-301 P1 Japanese Hist Thru Film (3)". We index ONLY
 *   headings, so a course links to the page that actually describes it. Note the dual
 *   numbering ("HIST 301" in the DB vs "HIST-301" in the heading) — codes are
 *   normalised to "SUBJ NNN" on both sides before comparison.
 *
 * HOW A CHUNK IS MAPPED
 *   Chunk bodies are verbatim runs of catalog prose (after their "[Header 1: ...]"
 *   breadcrumb prefix). We index every 8-word shingle of every page, then look up the
 *   chunk's opening shingle — an O(1) exact match rather than a fuzzy score, so a hit
 *   is a genuine textual identity, not a guess. Several offsets are tried before a
 *   chunk is declared unmatched.
 *
 * UNMATCHED ROWS ARE NULLED, NOT GUESSED. A row we cannot place gets `markdown_url =
 * NULL`, which makes the UI fall back to its (accurate) database-compiled view. Leaving
 * a wrong-but-plausible page 1 link would render confidently incorrect provenance —
 * strictly worse than admitting we don't know.
 *
 * HOW A PROGRAM IS MAPPED
 *   The stored `programs.markdown_url` values (.../programs/biochemistry_bs.md) are pure
 *   fiction — zero objects exist under any `programs/` prefix, and every one of them named
 *   the same catalog (2022-2023-graduate) whatever the program. There is no per-program
 *   asset to point at, but each program IS described on a catalog page, so we link to that
 *   page via its heading ("## B.S. in Biochemistry"). Programs are matched through
 *   `documents.version`, since their own URL cannot say which catalog they belong to.
 *
 * Every prior value is copied into `source_page_backfill_backup` before any write, so
 * the whole operation is reversible (see --restore).
 *
 * Usage:
 *   node scripts/backfill_source_pages.mjs                 # dry run — reports, writes nothing
 *   node scripts/backfill_source_pages.mjs --apply         # perform the backfill
 *   node scripts/backfill_source_pages.mjs --restore       # roll back from the backup table
 *   node scripts/backfill_source_pages.mjs --version 2025-2026-undergraduate --apply
 *   node scripts/backfill_source_pages.mjs --pages-dir <dir>   # read pages from a local cache
 *                                                              # instead of GCS (avoids ADC expiry):
 *     gcloud storage cp -r "gs://sjfu-assets/catalogs/SJFU/*" <dir>/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { Storage } from '@google-cloud/storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SHINGLE_WORDS = 8;
// Word offsets to try when a chunk's opening shingle misses (leading boilerplate,
// a stray bullet, reflowed whitespace). Later offsets are progressively deeper into
// the body, where the text is more likely to be a clean verbatim run.
const PROBE_OFFSETS = [0, 2, 4, 8, 12, 16, 24];

// ── Minimal .env.local loader (Node scripts don't auto-load it like Next.js). ──
function loadEnvLocal() {
  const envPath = path.join(REPO_ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    const hash = val.indexOf(' #'); // inline comment delimiter
    if (hash !== -1) val = val.slice(0, hash);
    val = val.trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const out = { apply: false, restore: false, version: null, concurrency: 24, pagesDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--restore') out.restore = true;
    else if (a === '--version') out.version = argv[++i];
    else if (a.startsWith('--version=')) out.version = a.split('=')[1];
    else if (a === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
    else if (a === '--pages-dir') out.pagesDir = argv[++i];
    else if (a.startsWith('--pages-dir=')) out.pagesDir = a.split('=')[1];
  }
  return out;
}

const BUCKET = process.env.GCP_BUCKET_NAME || process.env.GCS_BUCKET || 'sjfu-assets';

/** Collapse whitespace and lowercase, so PDF line wrapping can't defeat a comparison. */
function normText(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** "HIST-301" / "hist 301" / "HIST  301" → "HIST 301". */
function normCode(code) {
  return code.toUpperCase().replace(/[\s\-–—_]+/g, ' ').trim();
}

/** Strip the "[Header 1: ... > Header 2: ...]" breadcrumb the chunker prepends. */
function chunkBody(content) {
  return content.replace(/^\s*\[[^\]]*\]\s*/, '');
}

function pageUrl(version, page) {
  const padded = String(page).padStart(4, '0');
  return `gs://${BUCKET}/catalogs/SJFU/${version}/pages/page_${padded}.md`;
}

/**
 * Read a catalog version's pages from a local cache directory.
 *
 * Offered because the GCS client authenticates via gcloud ADC locally, whose reauth
 * token expires within the hour — long enough to fail midway through an 8-catalog run.
 * Populate the cache with the (separately authenticated) CLI:
 *   gcloud storage cp -r "gs://sjfu-assets/catalogs/SJFU/*" <dir>/
 */
function loadPagesFromDisk(pagesDir, version) {
  const dir = path.join(pagesDir, version, 'pages');
  if (!fs.existsSync(dir)) return [];

  const pages = [];
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/page_(\d+)\.md$/);
    if (!m) continue;
    pages.push({ page: parseInt(m[1], 10), text: fs.readFileSync(path.join(dir, name), 'utf-8') });
  }
  pages.sort((a, b) => a.page - b.page);
  return pages;
}

/** Download every page_NNNN.md for a catalog version. Returns [{page, text}] ascending. */
async function loadPages(storage, version, concurrency) {
  const prefix = `catalogs/SJFU/${version}/pages/`;
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix });
  const mdFiles = files.filter((f) => f.name.endsWith('.md'));

  const pages = [];
  let cursor = 0;
  async function worker() {
    while (cursor < mdFiles.length) {
      const file = mdFiles[cursor++];
      const m = file.name.match(/page_(\d+)\.md$/);
      if (!m) continue;
      const [buf] = await file.download();
      pages.push({ page: parseInt(m[1], 10), text: buf.toString('utf-8') });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, mdFiles.length) }, worker));

  pages.sort((a, b) => a.page - b.page);
  return pages;
}

/**
 * Index course-description headings → page.
 *
 * Matches "## HIST-301 P1 Japanese Hist Thru Film (3)" and tolerates the spaced
 * variant. Only headings count; a bare mention in a requirements list does not.
 * Earliest page wins (descriptions are listed once; a later repeat is an index/appendix).
 */
function indexCourseHeadings(pages) {
  const index = new Map();
  // {3,4} digits, not {3}: this catalog runs dual numbering — legacy three-digit codes
  // (HIST 301) alongside four-digit ones (CRIM 1299). A {3} pattern silently drops every
  // four-digit course, which is ~20% of the undergraduate catalog.
  const headingRe = /^#{1,6}\s+([A-Z]{2,6})[\s\-–—]\s*(\d{3,4}[A-Z]?)\b/gm;

  for (const { page, text } of pages) {
    for (const m of text.matchAll(headingRe)) {
      const key = normCode(`${m[1]} ${m[2]}`);
      if (!index.has(key)) index.set(key, page);
    }
  }
  return index;
}

/** Index every 8-word shingle of every page → earliest page containing it. */
function indexShingles(pages) {
  const index = new Map();

  for (const { page, text } of pages) {
    const words = normText(text).split(' ');
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
      const key = words.slice(i, i + SHINGLE_WORDS).join(' ');
      if (!index.has(key)) index.set(key, page);
    }
  }
  return index;
}

/**
 * Index each page's heading lines → the pages carrying that heading.
 *
 * Roughly 45% of chunks are heading-only ("# Attendance Policy"), too short to
 * fingerprint with an 8-word shingle. Their heading text still locates them exactly,
 * provided it is unique in the catalog — hence a page LIST, so ambiguous headings
 * ("## Policies", which recurs on dozens of pages) can be rejected rather than
 * mapped to an arbitrary first hit.
 */
function indexHeadings(pages) {
  const index = new Map();

  for (const { page, text } of pages) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^#{1,6}\s+(.*\S)\s*$/);
      if (!m) continue;
      const key = normText(m[1]);
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(page);
    }
  }
  return index;
}

/**
 * Program-heading "core" form: the normalised heading with a trailing "program(s)" word
 * removed. Catalog headings frequently append it ("Nursing B.S." in the DB vs
 * "Nursing B.S. Program" on the page) — pure ingestion noise, since the heading is the
 * program name plus a fixed suffix. Collapsing both sides to this form lets them match.
 */
function programCoreKey(s) {
  return normText(s).replace(/\s+programs?$/, '').trim();
}

/** Like indexHeadings, but keyed by the program-core form (trailing "program" dropped). */
function indexHeadingsCore(pages) {
  const index = new Map();

  for (const { page, text } of pages) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^#{1,6}\s+(.*\S)\s*$/);
      if (!m) continue;
      const key = programCoreKey(m[1]);
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(page);
    }
  }
  return index;
}

/**
 * Locate a chunk by probing its body's opening shingles against the page index.
 *
 * @returns The page number, or null if the body is too short / not found verbatim.
 */
function locateChunk(shingles, content) {
  const words = normText(chunkBody(content)).split(' ').filter(Boolean);
  if (words.length < SHINGLE_WORDS) return null;

  for (const offset of PROBE_OFFSETS) {
    if (offset + SHINGLE_WORDS > words.length) break;
    const probe = words.slice(offset, offset + SHINGLE_WORDS).join(' ');
    const page = shingles.get(probe);
    if (page !== undefined) return page;
  }
  return null;
}

/**
 * Candidate heading spellings for a program name.
 *
 * The catalog and the database disagree on how a degree is written, and the `programs`
 * table itself carries two naming families for the same degree ("Biology B.A." and
 * "Bachelor of Arts (B.A.) in Biology"), while the page heading is usually a third
 * ("## B.A. in Biology"). Rather than fuzzy-matching — which would happily map a program
 * to a neighbouring department's page — we enumerate the exact spellings the catalog is
 * known to use and require one of them to match a heading verbatim.
 *
 * @param {string} name - The program name as stored in the database.
 * @returns {string[]} Normalised candidate headings, most specific first.
 */
function programHeadingCandidates(name) {
  const out = [];
  const push = (s) => { const k = normText(s); if (k && !out.includes(k)) out.push(k); };
  const n = name.trim();

  push(n);

  // "Bachelor of Science (B.S.) in Biology" → "B.S. in Biology" / "Biology"
  const paren = n.match(/\(([^)]+)\)\s*in\s+(.+)$/i);
  if (paren) { push(`${paren[1]} in ${paren[2]}`); push(paren[2]); }

  // "Public Health B.S." → "B.S. in Public Health" / "Public Health"
  const trailing = n.match(/^(.*?)[,\s]+((?:[A-Z]\.){1,3}|(?:Ed|Ph|Psy)\.[A-Z]\.)$/);
  if (trailing) { push(`${trailing[2]} in ${trailing[1]}`); push(trailing[1]); }

  // "Minor in American Studies" → "American Studies"
  const minor = n.match(/^Minor in\s+(.+)$/i);
  if (minor) push(minor[1]);

  // "Accounting Certificate" → "Certificate in Accounting" / "Accounting"
  const cert = n.match(/^(.*?)\s+(?:Advanced\s+)?Certificate$/i);
  if (cert) { push(`certificate in ${cert[1]}`); push(cert[1]); }

  return out;
}

/**
 * Locate the page describing a program, by heading, requiring an unambiguous hit.
 *
 * A program's own page is not derivable from anything in the database (unlike a course,
 * which has a code), so the heading IS the evidence. Bare-topic candidates like
 * "Biology" match a department overview, a course list AND the degree page, so any
 * candidate landing on multiple pages is rejected outright rather than resolved by
 * picking the first — a wrong program page is worse than an honest database view.
 */
function locateProgram(headings, headingsCore, name) {
  // Pass 1 — exact heading, any candidate spelling.
  for (const candidate of programHeadingCandidates(name)) {
    const pagesFound = headings.get(candidate);
    if (pagesFound && pagesFound.size === 1) return [...pagesFound][0];
  }
  // Pass 2 — tolerate a trailing "Program" on the page heading. Still requires a UNIQUE
  // page, so an item that appears both in a table-of-contents ("X") and as content
  // ("X Program") stays ambiguous and is declined rather than guessed.
  for (const candidate of programHeadingCandidates(name)) {
    const pagesFound = headingsCore.get(programCoreKey(candidate));
    if (pagesFound && pagesFound.size === 1) return [...pagesFound][0];
  }
  return null;
}

/**
 * Locate a heading-only chunk by its heading text, but ONLY when that heading occurs
 * on exactly one page. A heading appearing on several pages tells us nothing about
 * which one this chunk came from, so we decline and let neighbour inheritance decide.
 */
function locateHeading(headings, content) {
  const body = chunkBody(content).trim();
  const m = body.match(/^#{1,6}\s+(.*\S)\s*$/);
  const key = normText(m ? m[1] : body);
  if (!key) return null;

  const found = headings.get(key);
  return found && found.size === 1 ? [...found][0] : null;
}

/** Capture current values so --restore can put everything back exactly as it was. */
async function backup(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS source_page_backfill_backup (
      table_name   text NOT NULL,
      row_id       uuid NOT NULL,
      markdown_url text,
      page_number  integer,
      backed_up_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (table_name, row_id)
    )
  `);

  // ON CONFLICT DO NOTHING keeps the FIRST (pristine) capture if the script is re-run,
  // so a second pass can never overwrite the backup with already-modified values.
  await client.query(`
    INSERT INTO source_page_backfill_backup (table_name, row_id, markdown_url, page_number)
    SELECT 'courses', id, markdown_url, NULL FROM courses
    ON CONFLICT (table_name, row_id) DO NOTHING
  `);
  await client.query(`
    INSERT INTO source_page_backfill_backup (table_name, row_id, markdown_url, page_number)
    SELECT 'semantic_chunks', id, markdown_url, page_number FROM semantic_chunks
    ON CONFLICT (table_name, row_id) DO NOTHING
  `);
  await client.query(`
    INSERT INTO source_page_backfill_backup (table_name, row_id, markdown_url, page_number)
    SELECT 'programs', id, markdown_url, NULL FROM programs
    ON CONFLICT (table_name, row_id) DO NOTHING
  `);

  const { rows } = await client.query('SELECT count(*)::int AS n FROM source_page_backfill_backup');
  console.log(`  backup table holds ${rows[0].n} original rows`);
}

async function restore(client) {
  const courses = await client.query(`
    UPDATE courses c SET markdown_url = b.markdown_url
    FROM source_page_backfill_backup b
    WHERE b.table_name = 'courses' AND b.row_id = c.id
  `);
  const chunks = await client.query(`
    UPDATE semantic_chunks s SET markdown_url = b.markdown_url, page_number = b.page_number
    FROM source_page_backfill_backup b
    WHERE b.table_name = 'semantic_chunks' AND b.row_id = s.id
  `);
  const programs = await client.query(`
    UPDATE programs p SET markdown_url = b.markdown_url
    FROM source_page_backfill_backup b
    WHERE b.table_name = 'programs' AND b.row_id = p.id
  `);
  console.log(
    `Restored: ${courses.rowCount} courses, ${chunks.rowCount} chunks, ${programs.rowCount} programs.`
  );
}

/** Push a batch of (id → url/page) updates using a single parameterised statement. */
async function updateCourses(client, updates) {
  if (!updates.length) return;
  await client.query(
    `UPDATE courses AS c SET markdown_url = v.url
     FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS url) AS v
     WHERE c.id = v.id`,
    [updates.map((u) => u.id), updates.map((u) => u.url)]
  );
}

async function updateChunks(client, updates) {
  if (!updates.length) return;
  await client.query(
    `UPDATE semantic_chunks AS s SET markdown_url = v.url, page_number = v.page
     FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS url, unnest($3::int[]) AS page) AS v
     WHERE s.id = v.id`,
    [updates.map((u) => u.id), updates.map((u) => u.url), updates.map((u) => u.page)]
  );
}

async function updatePrograms(client, updates) {
  if (!updates.length) return;
  await client.query(
    `UPDATE programs AS p SET markdown_url = v.url
     FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS url) AS v
     WHERE p.id = v.id`,
    [updates.map((u) => u.id), updates.map((u) => u.url)]
  );
}

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not set (check .env.local).');

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    if (args.restore) {
      await restore(client);
      return;
    }

    const mode = args.apply ? 'APPLY' : 'DRY RUN (no writes — pass --apply to commit)';
    console.log(`\nSource-page backfill — ${mode}\nBucket: gs://${BUCKET}\n`);

    // `documents.version` already carries the full "2025-2026-undergraduate" key that
    // names the asset folder. Read it from there rather than parsing it back out of
    // markdown_url — the URLs are the very thing being repaired, and once a prior run
    // has nulled the unmatchable ones they can no longer enumerate the catalogs.
    const { rows: versionRows } = await client.query(
      'SELECT DISTINCT version FROM documents WHERE version IS NOT NULL ORDER BY 1'
    );
    let versions = versionRows.map((r) => r.version).filter(Boolean);
    if (args.version) versions = versions.filter((v) => v === args.version);
    if (!versions.length) throw new Error('No catalog versions found.');

    if (args.apply) {
      console.log('Backing up current values…');
      await backup(client);
      console.log('');
    }

    const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
    const totals = {
      courseMatched: 0, courseUnmatched: 0,
      chunkMatched: 0, chunkUnmatched: 0,
      programMatched: 0, programUnmatched: 0,
    };

    for (const version of versions) {
      console.log(`── ${version}`);
      const pages = args.pagesDir
        ? loadPagesFromDisk(args.pagesDir, version)
        : await loadPages(storage, version, args.concurrency);
      if (!pages.length) {
        console.log('   no page assets available — skipping\n');
        continue;
      }

      // Two distinct indexes, deliberately named apart: `courseHeadings` maps a course
      // CODE to one page; `pageHeadings` maps arbitrary heading TEXT to every page
      // carrying it. They are not interchangeable — passing one where the other is
      // expected silently yields no matches rather than an error.
      const courseHeadings = indexCourseHeadings(pages);
      const pageHeadings = indexHeadings(pages);
      const pageHeadingsCore = indexHeadingsCore(pages);
      const shingles = indexShingles(pages);
      console.log(
        `   ${pages.length} pages · ${courseHeadings.size} course headings · ` +
        `${pageHeadings.size} page headings · ${shingles.size} shingles`
      );

      // Rows are selected by `documents.version`, NOT by their markdown_url. Filtering on
      // the URL would make the script one-way: a row nulled by an earlier run no longer
      // matches any version pattern, so it could never be reconsidered on a re-run (say,
      // after re-ingesting a catalog). Joining the document keeps every run a full,
      // idempotent recomputation from evidence.

      // ── Courses ──
      const { rows: courses } = await client.query(
        `SELECT c.id, c.course_code FROM courses c
         JOIN documents d ON d.id = c.document_id
         WHERE d.version = $1`,
        [version]
      );
      const courseUpdates = [];
      let cMatched = 0;
      for (const c of courses) {
        const page = c.course_code ? courseHeadings.get(normCode(c.course_code)) : undefined;
        if (page !== undefined) {
          courseUpdates.push({ id: c.id, url: pageUrl(version, page) });
          cMatched++;
        } else {
          courseUpdates.push({ id: c.id, url: null }); // don't keep a false page-1 link
        }
      }
      const cUnmatched = courses.length - cMatched;
      totals.courseMatched += cMatched;
      totals.courseUnmatched += cUnmatched;
      console.log(`   courses: ${cMatched} mapped, ${cUnmatched} unmatched → NULL`);

      // ── Semantic chunks: three passes, strongest evidence first ──
      // Read in document order so pass 3 can reason about neighbours.
      const { rows: chunks } = await client.query(
        `SELECT s.id, s.content, s.document_id, s.sequence_order
         FROM semantic_chunks s
         JOIN documents d ON d.id = s.document_id
         WHERE d.version = $1
         ORDER BY s.document_id, s.sequence_order`,
        [version]
      );

      const resolved = new Array(chunks.length).fill(null);
      const via = { body: 0, heading: 0, neighbour: 0 };

      // Pass 1 — verbatim body text (exact, strongest).
      for (let i = 0; i < chunks.length; i++) {
        const page = chunks[i].content ? locateChunk(shingles, chunks[i].content) : null;
        if (page !== null) { resolved[i] = page; via.body++; }
      }

      // Pass 2 — heading-only chunks whose heading is unique in the catalog.
      for (let i = 0; i < chunks.length; i++) {
        if (resolved[i] !== null || !chunks[i].content) continue;
        const page = locateHeading(pageHeadings, chunks[i].content);
        if (page !== null) { resolved[i] = page; via.heading++; }
      }

      // Pass 3 — a heading sits on the page of the section it introduces, so inherit
      // from the next resolved chunk of the SAME document (falling back to the previous
      // one at a document's tail). Confined to one document: bleeding a page number
      // across a document boundary would invent provenance rather than recover it.
      for (let i = 0; i < chunks.length; i++) {
        if (resolved[i] !== null) continue;
        const doc = chunks[i].document_id;

        let inherited = null;
        for (let j = i + 1; j < chunks.length && chunks[j].document_id === doc; j++) {
          if (resolved[j] !== null) { inherited = resolved[j]; break; }
        }
        if (inherited === null) {
          for (let j = i - 1; j >= 0 && chunks[j].document_id === doc; j--) {
            if (resolved[j] !== null) { inherited = resolved[j]; break; }
          }
        }
        if (inherited !== null) { resolved[i] = inherited; via.neighbour++; }
      }

      const chunkUpdates = chunks.map((s, i) =>
        resolved[i] !== null
          ? { id: s.id, url: pageUrl(version, resolved[i]), page: resolved[i] }
          : { id: s.id, url: null, page: null }
      );

      const sMatched = resolved.filter((p) => p !== null).length;
      const sUnmatched = chunks.length - sMatched;
      totals.chunkMatched += sMatched;
      totals.chunkUnmatched += sUnmatched;
      console.log(
        `   chunks:  ${sMatched} mapped (${via.body} body, ${via.heading} heading, ` +
        `${via.neighbour} neighbour), ${sUnmatched} unmatched → NULL`
      );

      const distinctPages = new Set(chunkUpdates.filter((u) => u.page).map((u) => u.page)).size;
      console.log(`   chunks now span ${distinctPages} distinct pages (was 1)`);

      // ── Programs ──
      // Programs are joined through `documents.version` rather than their stored URL:
      // every program's original markdown_url named the same catalog (2022-2023-graduate)
      // regardless of the actual program, so that URL cannot identify its catalog.
      const { rows: programs } = await client.query(
        `SELECT p.id, p.name FROM programs p
         JOIN documents d ON d.id = p.document_id
         WHERE d.version = $1`,
        [version]
      );
      const programUpdates = [];
      let pMatched = 0;
      for (const p of programs) {
        const page = p.name ? locateProgram(pageHeadings, pageHeadingsCore, p.name) : null;
        if (page !== null) {
          programUpdates.push({ id: p.id, url: pageUrl(version, page) });
          pMatched++;
        } else {
          programUpdates.push({ id: p.id, url: null });
        }
      }
      const pUnmatched = programs.length - pMatched;
      totals.programMatched += pMatched;
      totals.programUnmatched += pUnmatched;
      console.log(`   programs: ${pMatched} mapped, ${pUnmatched} unmatched → NULL\n`);

      if (args.apply) {
        const BATCH = 1000;
        for (let i = 0; i < courseUpdates.length; i += BATCH) {
          await updateCourses(client, courseUpdates.slice(i, i + BATCH));
        }
        for (let i = 0; i < chunkUpdates.length; i += BATCH) {
          await updateChunks(client, chunkUpdates.slice(i, i + BATCH));
        }
        for (let i = 0; i < programUpdates.length; i += BATCH) {
          await updatePrograms(client, programUpdates.slice(i, i + BATCH));
        }
      }
    }

    console.log('Totals');
    console.log(`  courses:  ${totals.courseMatched} mapped, ${totals.courseUnmatched} unmatched`);
    console.log(`  chunks:   ${totals.chunkMatched} mapped, ${totals.chunkUnmatched} unmatched`);
    console.log(`  programs: ${totals.programMatched} mapped, ${totals.programUnmatched} unmatched`);
    console.log(
      args.apply
        ? '\nApplied. Re-run with --restore to roll back from source_page_backfill_backup.\n'
        : '\nDry run only — nothing written. Re-run with --apply to commit.\n'
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`\nBackfill failed: ${err.message}\n`);
  process.exit(1);
});
