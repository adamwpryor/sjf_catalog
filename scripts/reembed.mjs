/**
 * reembed.mjs — one-time (idempotent) batch re-embed of semantic_chunks.
 *
 * Standardizes every SJFU chunk on gemini-embedding-001 @ 1536 so that stored
 * vectors share one space with the app's query embeddings (src/app/api/assistant
 * generateEmbedding uses the identical model + dimension). This is BUILD_PLAN P3.
 *
 * TWO AUTH PATHS — the same model + dimension either way:
 *   1. Vertex AI (DEFAULT for Adam's business account): keyless. Uses Application
 *      Default Credentials / a service account (GOOGLE_APPLICATION_CREDENTIALS),
 *      never an API key — required because the business GCP org disallows API keys.
 *      Endpoint: {location}-aiplatform.googleapis.com .../gemini-embedding-001:predict
 *   2. Google AI Studio API key (for CLIENT HANDOFF): set GEMINI_API_KEY and the
 *      script uses generativelanguage.googleapis.com .../gemini-embedding-001:embedContent.
 *
 * Provider selection: --provider vertex|gemini, else auto (Vertex if GCP creds
 * resolve, otherwise the API key). Both write vector(1536) — interchangeable.
 *
 * Idempotent: only rows WHERE embedding IS NULL are processed, so it is safe to
 * re-run (e.g. to retry rows that errored, or after a fresh data load).
 *
 * Usage:
 *   node scripts/reembed.mjs                       # auto provider, all NULL chunks
 *   node scripts/reembed.mjs --provider vertex     # force Vertex (Adam)
 *   node scripts/reembed.mjs --provider gemini     # force API key (client)
 *   node scripts/reembed.mjs --limit 20 --dry-run  # smoke test, embed nothing
 *   node scripts/reembed.mjs --concurrency 8 --batch 500
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const MODEL = 'gemini-embedding-001';
const DIMENSION = 1536;

// ── Minimal .env.local loader (Node scripts don't auto-load it like Next.js). ──
// Strips ` # inline comments` (space-hash, matching the file's own style) and
// surrounding quotes. Does not overwrite variables already set in the real env.
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

// ── Arg parsing ──
function parseArgs(argv) {
  const out = { provider: 'auto', batch: 500, concurrency: 8, limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i];
    else if (a.startsWith('--provider=')) out.provider = a.split('=')[1];
    else if (a === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (a.startsWith('--batch=')) out.batch = parseInt(a.split('=')[1], 10);
    else if (a === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
    else if (a.startsWith('--concurrency=')) out.concurrency = parseInt(a.split('=')[1], 10);
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.split('=')[1], 10);
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Auth: resolve an embedder closure for the selected provider ──
async function resolveEmbedder(provider) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const gcpProjectId = process.env.GCP_PROJECT_ID;
  const gcpLocation = process.env.GCP_LOCATION || 'us-central1';

  const wantVertex = provider === 'vertex' || (provider === 'auto' && !!gcpProjectId);
  const wantGemini = provider === 'gemini' || (provider === 'auto' && !gcpProjectId && !!geminiKey);

  if (wantVertex) {
    if (!gcpProjectId) throw new Error('Vertex selected but GCP_PROJECT_ID is not set.');
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
    const client = await auth.getClient(); // reads GOOGLE_APPLICATION_CREDENTIALS (ADC/SA)
    // getAccessToken() caches and auto-refreshes, so it is safe to call per request.
    const embedUrl = `https://${gcpLocation}-aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/${gcpLocation}/publishers/google/models/${MODEL}:predict`;
    console.log(`[auth] Vertex AI (keyless) — project=${gcpProjectId} location=${gcpLocation}`);
    return {
      label: `Vertex AI (${gcpProjectId}/${gcpLocation})`,
      embed: async (text) => {
        const { token } = await client.getAccessToken();
        const res = await fetch(embedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ instances: [{ content: text }], parameters: { outputDimensionality: DIMENSION } }),
        });
        if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
        const data = await res.json();
        const vec = data.predictions?.[0]?.embeddings?.values;
        if (!Array.isArray(vec)) return { ok: false, status: res.status, error: 'no embedding in response' };
        return { ok: true, vec };
      },
    };
  }

  if (wantGemini || geminiKey) {
    if (!geminiKey) throw new Error('Gemini API-key provider selected but GEMINI_API_KEY is not set.');
    const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${geminiKey}`;
    console.log('[auth] Google AI Studio API key (client-handoff path)');
    return {
      label: 'Google AI Studio (API key)',
      embed: async (text) => {
        const res = await fetch(embedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `models/${MODEL}`, content: { parts: [{ text }] }, outputDimensionality: DIMENSION }),
        });
        if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
        const data = await res.json();
        const vec = data.embedding?.values;
        if (!Array.isArray(vec)) return { ok: false, status: res.status, error: 'no embedding in response' };
        return { ok: true, vec };
      },
    };
  }

  throw new Error('No embedding provider available. Set GCP creds (Vertex) or GEMINI_API_KEY.');
}

// ── Embed one chunk with exponential backoff on 429/5xx ──
async function embedWithRetry(embedder, text, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let r;
    try {
      r = await embedder.embed(text);
    } catch (err) {
      r = { ok: false, status: 0, error: err.message };
    }
    if (r.ok) {
      if (r.vec.length !== DIMENSION) {
        return { ok: false, error: `unexpected dim ${r.vec.length} (want ${DIMENSION})` };
      }
      return r;
    }
    const retryable = r.status === 429 || r.status >= 500 || r.status === 0;
    if (!retryable || attempt === maxAttempts) return r;
    const backoff = Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
    console.warn(`  retry ${attempt}/${maxAttempts - 1} after ${r.status}: waiting ${backoff}ms`);
    await sleep(backoff);
  }
  return { ok: false, error: 'exhausted retries' };
}

// pgvector literal: '[v1,v2,...]'
const toVectorLiteral = (vec) => `[${vec.join(',')}]`;

async function main() {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not set (check .env.local).');

  const embedder = await resolveEmbedder(args.provider);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const { rows: [{ pending }] } = await client.query(
      `SELECT count(*)::int AS pending FROM semantic_chunks WHERE embedding IS NULL AND content IS NOT NULL AND length(trim(content)) > 0`
    );
    const target = args.limit ? Math.min(args.limit, pending) : pending;
    console.log(`[reembed] provider=${embedder.label}  model=${MODEL}@${DIMENSION}`);
    console.log(`[reembed] ${pending} chunk(s) need embeddings; will process ${target}${args.dryRun ? ' (DRY RUN)' : ''}.`);
    if (args.dryRun || target === 0) {
      console.log('[reembed] Nothing to write. Done.');
      return;
    }

    let lastId = 0;
    let done = 0;
    let failed = 0;
    const startedAt = Date.now();

    while (done + failed < target) {
      const remaining = target - (done + failed);
      const pageSize = Math.min(args.batch, remaining);
      const { rows } = await client.query(
        `SELECT id, content FROM semantic_chunks
         WHERE id > $1 AND embedding IS NULL AND content IS NOT NULL AND length(trim(content)) > 0
         ORDER BY id LIMIT $2`,
        [lastId, pageSize]
      );
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id; // keyset advance (past failures too — re-run retries them)

      // Bounded concurrency over the page.
      let cursor = 0;
      const worker = async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          const r = await embedWithRetry(embedder, row.content);
          if (!r.ok) {
            failed++;
            console.warn(`  chunk ${row.id} FAILED: ${r.error}`);
            continue;
          }
          await client.query(
            `UPDATE semantic_chunks SET embedding = $1::vector WHERE id = $2`,
            [toVectorLiteral(r.vec), row.id]
          );
          done++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(args.concurrency, rows.length) }, worker));

      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const eta = rate > 0 ? Math.round((target - done - failed) / rate) : 0;
      console.log(`[reembed] ${done} embedded, ${failed} failed / ${target}  (${rate.toFixed(1)}/s, ETA ${eta}s)`);
    }

    console.log(`\n[reembed] Complete: ${done} embedded, ${failed} failed.`);
    if (failed > 0) {
      console.log('[reembed] Failed rows are still NULL — re-run the script to retry only those.');
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[reembed] FATAL: ${err.message}`);
  process.exit(1);
});
