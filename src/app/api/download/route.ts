import { NextResponse } from 'next/server';
import { getStorageClient, resolveBucketName } from '@/lib/gcs';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const fileParam = searchParams.get('file');

    if (!fileParam) {
      return NextResponse.json({ error: "Missing file parameter." }, { status: 400 });
    }

    const storage = await getStorageClient(req);
    const bucketName = resolveBucketName();
    const bucket = storage.bucket(bucketName);
    
    // Construct the correct GCS path
    const gcsPath = `intake/${fileParam}`;
    const gcsFile = bucket.file(gcsPath);

    const [exists] = await gcsFile.exists();
    if (!exists) {
      return NextResponse.json({ error: "File not found in the intake directory." }, { status: 404 });
    }

    // To avoid credential issues with getSignedUrl when using local Application Default Credentials,
    // we stream the file directly through the Next.js API.
    const [metadata] = await gcsFile.getMetadata();
    const contentType = metadata.contentType || 'application/octet-stream';

    const stream = gcsFile.createReadStream();

    // Convert Node.js readable stream to a Web ReadableStream
    const readableStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      }
    });

    return new NextResponse(readableStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileParam.split('/').pop() || 'download')}"`
      }
    });

  } catch (e: any) {
    console.error("Download API Error:", e);
    return NextResponse.json({ error: e.message || "Failed to generate download link." }, { status: 500 });
  }
}
