import { NextResponse } from 'next/server';
import path from 'path';
import { promises as fs } from 'fs';
import { queryWithAuth } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID } from '@/lib/brand';
import os from 'os';
import { getStorageClient, resolveBucketName } from '@/lib/gcs';
import { Blob } from 'buffer';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let tmpFilePath: string | null = null;
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;

    const { filePath, catalogId } = await req.json();
    if (!filePath) {
      return NextResponse.json({ error: "No file path provided" }, { status: 400 });
    }

    const storage = await getStorageClient(req);
    const bucketName = resolveBucketName();
    const bucket = storage.bucket(bucketName);
    
    // The GCS file path is intake/ + the relative path passed from the client
    const gcsPath = `intake/${filePath}`;
    const gcsFile = bucket.file(gcsPath);

    const [exists] = await gcsFile.exists();
    if (!exists) {
      return NextResponse.json({ error: "File does not exist in the intake directory" }, { status: 404 });
    }

    // Download to a temporary file for the Python script to read
    const sanitizedName = path.basename(filePath).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    tmpFilePath = path.join(os.tmpdir(), `extract_${Date.now()}_${sanitizedName}`);
    
    console.log(`[Extract Intake] Downloading ${gcsPath} to ${tmpFilePath}`);
    await gcsFile.download({ destination: tmpFilePath });

    console.log(`Extracting minutes from: ${tmpFilePath}`);

    const apiUrl = process.env.NEXT_PUBLIC_SWARM_API_URL || 'http://localhost:8080';
    let stdout = '';
    let actualPrompt = '';
    
    try {
      // Read the downloaded file into a Blob
      const fileBuffer = await fs.readFile(tmpFilePath);
      const blob = new Blob([fileBuffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      
      const formData = new FormData();
      // Cast around the @types/node Blob vs DOM Blob mismatch (Uint8Array generic).
      formData.append('file', blob as any, path.basename(filePath));

      console.log(`Sending file to FastAPI backend at ${apiUrl}/api/agent/extract-minutes`);
      
      const response = await fetch(`${apiUrl}/api/agent/extract-minutes`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`FastAPI returned ${response.status}: ${await response.text()}`);
      }
      
      const data = await response.json();
      actualPrompt = data.aiPrompt || 'Prompt hidden in backend.';
      stdout = JSON.stringify(data.parsed_deltas, null, 2);
      
      if (data.parsed_deltas && Array.isArray(data.parsed_deltas)) {
        for (const rec of data.parsed_deltas) {
          // Intake deltas are semantic proposals (by program/subject name), not yet
          // mapped to a concrete row — target_row_id stays NULL until a registrar
          // resolves it during review. The affected name + action go in `reason`.
          await queryWithAuth(
            `INSERT INTO corrections (tenant_id, target_table, target_row_id, field_name, current_value, proposed_value, reason, status, submitted_by) VALUES ($1, $2, NULL, $3, $4, $5, $6, 'pending', 'Intake Agent')`,
            [
              TENANT_ID,
              'programs',
              'requirements',
              null,
              rec.semantic_instruction || '(no instruction extracted)',
              `${rec.program_name || 'Unknown'} — ${rec.action || 'AMEND'} (extracted from committee minutes)`,
            ],
            userId
          );
        }
      }

    } catch (scriptErr: any) {
      // Surface extraction failures instead of masking them with mock corrections.
      console.error("[Extract Intake] Extraction failed:", scriptErr.message);
      return NextResponse.json(
        { error: `Extraction failed: ${scriptErr.message || "Unknown error"}` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "File successfully parsed by the Intake Agent.",
      output: stdout,
      filePath: `/api/download?file=${encodeURIComponent(filePath)}`,
      rawText: "Text extraction handled natively via agent.",
      aiPrompt: actualPrompt
    });

  } catch (e: any) {
    console.error("Extract API Error:", e);
    return NextResponse.json({ error: e.message || "Failed to process extraction." }, { status: 500 });
  } finally {
    if (tmpFilePath) {
      try {
        await fs.unlink(tmpFilePath);
        console.log(`[Extract Intake] Cleaned up temporary file: ${tmpFilePath}`);
      } catch (cleanupErr) {
        console.error(`[Extract Intake] Failed to clean up temporary file: ${tmpFilePath}`, cleanupErr);
      }
    }
  }
}
