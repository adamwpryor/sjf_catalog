import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { getStorageClient, resolveBucketName } from '@/lib/gcs';
import { buildCatalogHtml, renderCatalogPdf } from '@/lib/catalogPdf';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // a full catalog render can take a while

/**
 * Step 4 — generate and publish the catalog-of-record PDF.
 *
 * Assembles branded HTML from the corrected DB, renders it to PDF on Cloud Run (WeasyPrint),
 * uploads it to GCS, records the URL on the document, and strips the "(Draft)" tag. The PDF is
 * rendered as the FINAL (non-draft) document.
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
    return NextResponse.json({ error: 'Forbidden: Only registrars and owners can publish.' }, { status: 403 });
  }

  const { draftId } = await req.json();
  if (!draftId) return NextResponse.json({ error: 'draftId is required.' }, { status: 400 });

  const docRows = await query('SELECT id, version FROM documents WHERE id = $1', [draftId]);
  if (!docRows.length) return NextResponse.json({ error: 'Catalog not found.' }, { status: 404 });
  const version = String(docRows[0].version || '').replace(/\s*\(Draft\)/i, '').trim() || 'Catalog';

  try {
    // 1. Assemble HTML (final, no draft watermark) and render to PDF.
    const html = await buildCatalogHtml(draftId, { versionLabel: version, draft: false });
    const pdfBuffer = await renderCatalogPdf(html);

    // 2. Upload to GCS.
    const storage = await getStorageClient(req);
    const bucketName = resolveBucketName();
    const slug = version.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || draftId;
    const objectPath = `catalogs/${slug}/catalog.pdf`;
    await storage.bucket(bucketName).file(objectPath).save(pdfBuffer, {
      contentType: 'application/pdf',
      resumable: false,
    });
    const gsUrl = `gs://${bucketName}/${objectPath}`;

    // 3. Record the PDF and publish (strip the draft tag).
    await query(
      `UPDATE documents
          SET catalog_pdf_url = $1, catalog_pdf_generated_at = now(),
              version = REPLACE(version, ' (Draft)', '')
        WHERE id = $2`,
      [gsUrl, draftId]
    );

    return NextResponse.json({
      status: 'success',
      message: 'Catalog PDF generated and published.',
      bytes: pdfBuffer.length,
      pdfUrl: `/api/catalog/pdf?catalogId=${encodeURIComponent(draftId)}`,
    });
  } catch (e: any) {
    console.error('Publish Error:', e);
    return NextResponse.json({ error: e.message || 'Failed to publish catalog.' }, { status: 500 });
  }
}
