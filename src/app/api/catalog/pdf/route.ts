import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { getStorageClient, resolveBucketName } from '@/lib/gcs';
import { buildCatalogHtml, renderCatalogPdf, getCatalogMeta } from '@/lib/catalogPdf';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Serve a catalog's PDF for in-browser preview or download.
 *
 * - Published catalogs with a stored PDF stream it from GCS (fast) unless `?fresh=1`.
 * - Drafts (and `?fresh=1`) render a provisional PDF on demand from the current DB state — so you can
 *   preview a draft before it's finalized. On-demand renders are not stored.
 * - `?download=1` forces a download (attachment) rather than inline preview.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session || !session.user) {
    return NextResponse.json({ error: 'Forbidden: Authentication required.' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const catalogId = searchParams.get('catalogId');
  const fresh = searchParams.get('fresh') === '1';
  const download = searchParams.get('download') === '1';
  if (!catalogId) return NextResponse.json({ error: 'catalogId is required.' }, { status: 400 });

  const meta = await getCatalogMeta(catalogId);
  if (!meta) return NextResponse.json({ error: 'Catalog not found.' }, { status: 404 });

  const stored = (await query('SELECT catalog_pdf_url FROM documents WHERE id = $1', [catalogId]))[0]?.catalog_pdf_url;
  const filenameSlug = meta.version.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() + (meta.isDraft ? '-draft' : '');
  const disposition = `${download ? 'attachment' : 'inline'}; filename="ccsj-catalog-${filenameSlug}.pdf"`;

  try {
    // Use the stored published PDF when available and not explicitly regenerating a non-draft.
    if (stored && !fresh && !meta.isDraft) {
      let raw = String(stored).replace(/^gs:\/\//, '');
      const slash = raw.indexOf('/');
      const bucketName = raw.startsWith('catalogs/') || slash === -1 ? resolveBucketName() : resolveBucketName(raw.substring(0, slash));
      const filePath = raw.startsWith('catalogs/') || slash === -1 ? raw : raw.substring(slash + 1);
      const storage = await getStorageClient(req);
      const [data] = await storage.bucket(bucketName).file(filePath).download();
      return new NextResponse(new Uint8Array(data), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition, 'Cache-Control': 'private, max-age=300' },
      });
    }

    // Otherwise render fresh from current DB state (drafts marked provisional). Not stored.
    const html = await buildCatalogHtml(catalogId, { versionLabel: meta.version, draft: meta.isDraft });
    const pdf = await renderCatalogPdf(html);
    return new NextResponse(new Uint8Array(pdf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': disposition, 'Cache-Control': 'no-store' },
    });
  } catch (err: any) {
    console.error('[Catalog PDF] failed:', err.message);
    return NextResponse.json({ error: `Failed to produce catalog PDF: ${err.message}` }, { status: 500 });
  }
}
