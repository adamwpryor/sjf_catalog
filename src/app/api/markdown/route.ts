import { NextResponse } from 'next/server';
import { getStorageClient, resolveBucketName } from '@/lib/gcs';
import { TENANT_ID, GCS_BUCKET } from '@/lib/brand';

/**
 * Fetches markdown content from a designated Google Cloud Storage bucket.
 * Implements a dynamic dual-connector authentication system via the shared GCS library.
 *
 * @param req - The incoming GET request containing the target GCS URL parameter.
 * @returns A NextResponse sending the file content as text/markdown or error details.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'URL parameter is required.' }, { status: 400 });
  }

  try {
    const storage = await getStorageClient(req);

    // 2. Parse GCS URI or HTTP URL into bucket and file path
    let cleanPath = url;
    if (cleanPath.startsWith('gs://')) {
      cleanPath = cleanPath.replace(/^gs:\/\//, '');
    } else if (cleanPath.startsWith('https://storage.googleapis.com/')) {
      cleanPath = cleanPath.replace(/^https:\/\/storage\.googleapis\.com\//, '');
    }

    const firstSlashIndex = cleanPath.indexOf('/');
    if (firstSlashIndex === -1) {
      return NextResponse.json({ error: `Invalid GCS path format: ${url}` }, { status: 400 });
    }

    let bucketName = cleanPath.substring(0, firstSlashIndex);
    let filePath = decodeURIComponent(cleanPath.substring(firstSlashIndex + 1));

    // Resolve to the institution's configured asset bucket (honors GCP_BUCKET_NAME).
    bucketName = resolveBucketName(bucketName);

    // Dynamic Path-Healing & Noise Sanitization:
    // If the path contains space-appended parser noise (e.g. "bs_in_life_science the_following_courses_are_required:.md")
    // extract only the core program filename.
    if (filePath.includes(' ')) {
      const pathSegments = filePath.split('/');
      const filename = pathSegments[pathSegments.length - 1];
      if (filename.includes(' ')) {
        const firstSpaceIndex = filename.indexOf(' ');
        const coreName = filename.substring(0, firstSpaceIndex);
        const extension = filename.endsWith('.md') ? '.md' : '';
        pathSegments[pathSegments.length - 1] = `${coreName}${extension}`;
        const sanitizedPath = pathSegments.join('/');
        console.log(`[GCS SDK Proxy] Sanitized noisy path from "${filePath}" to "${sanitizedPath}"`);
        filePath = sanitizedPath;
      }
    }

    console.log(`[GCS SDK Proxy] Fetching from Bucket: "${bucketName}", File Path: "${filePath}"`);

    const bucket = storage.bucket(bucketName);
    let fileObj = bucket.file(filePath);

    let contentBuffer;
    try {
      const [data] = await fileObj.download();
      contentBuffer = data;
    } catch (sdkErr: any) {
      // Dynamic Path-Healing Engine (auto-adjusting "/<tenant>/" offsets)
      if (sdkErr.code === 404) {
        let alternativePath = '';
        const tenantSegment = `catalogs/${TENANT_ID}/`;
        if (filePath.includes(tenantSegment)) {
          alternativePath = filePath.replace(tenantSegment, 'catalogs/');
        } else if (filePath.includes('catalogs/')) {
          alternativePath = filePath.replace('catalogs/', tenantSegment);
        }

        if (alternativePath && alternativePath !== filePath) {
          console.log(`[GCS SDK Proxy] Got 404. Attempting auto-healing to: "${alternativePath}"`);
          fileObj = bucket.file(alternativePath);
          const [data] = await fileObj.download();
          contentBuffer = data;
          console.log(`[GCS SDK Proxy] Path healed successfully!`);
        } else {
          throw sdkErr;
        }
      } else {
        throw sdkErr;
      }
    }

    const markdownText = contentBuffer.toString('utf-8');

    return new NextResponse(markdownText, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600', // Cache federated page downloads for 1 hour
      },
    });

  } catch (err: any) {
    console.error('[GCS SDK Proxy Error]:', err.message);

    if (err.code === 403 || err.message?.includes('caller does not have')) {
      return NextResponse.json({
        error: "ACCESS_FORBIDDEN",
        status: 403,
        message: `Authentication succeeded but the Service Account lacks permission to read the bucket.`,
        remedy: {
          steps: [
            "1. Open your GCP Console and go to IAM & Admin.",
            `2. Verify that the Service Account (${process.env.GCP_SERVICE_ACCOUNT_EMAIL || 'your-service-account'}) has been granted the 'Storage Object Viewer' role on bucket '${process.env.GCP_BUCKET_NAME || GCS_BUCKET}'.`,
            "3. If using Workload Identity, verify the principalSet matches Vercel's OIDC federation subject."
          ]
        }
      }, { status: 403 });
    }

    if (err.code === 404) {
      return NextResponse.json({
        error: "FILE_NOT_FOUND",
        status: 404,
        message: `The catalog file does not exist in your GCS bucket.`,
        target: url
      }, { status: 404 });
    }

    return NextResponse.json(
      { error: `GCS Secure Fetch failed: ${err.message}` },
      { status: 500 }
    );
  }
}
