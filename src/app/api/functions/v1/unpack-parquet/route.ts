import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

/**
 * Webhook handler to trigger background unpacking of Parquet files via Python agent.
 * Verifies the hub webhook secret before launching the subprocess.
 *
 * @param request - The incoming POST request containing file details.
 * @returns A JSON response acknowledging the request and indicating background processing.
 */
export async function POST(request: Request) {
  // Security validation: Zero-Trust explicit check
  const authHeader = request.headers.get('authorization');
  const expectedToken = process.env.HUB_WEBHOOK_SECRET;

  if (!expectedToken) {
    console.warn("⚠️ HUB_WEBHOOK_SECRET is not set in the environment. Webhook rejecting all requests.");
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  if (authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    // `dataset` ('criteria' for accreditation-criteria parquets) and `accreditor`
    // are optional; when omitted the agent auto-detects by columns.
    const { tenantId, fileName, dataset, accreditor } = body;

    if (!fileName || !tenantId) {
      return NextResponse.json({ error: 'Missing tenantId or fileName in payload' }, { status: 400 });
    }

    // Determine path to the Python unpacking agent script
    const scriptPath = path.join(process.cwd(), 'spoke_workspace', 'scripts', 'unpack_agent.py');

    const pyArgs = [scriptPath, '--file', fileName, '--tenant', tenantId];
    if (dataset) pyArgs.push('--dataset', String(dataset));
    if (accreditor) pyArgs.push('--accreditor', String(accreditor));

    // Spawn python subprocess
    console.log(`🚀 [Unpack Webhook] Triggering unpacking agent for file: ${fileName} (Tenant: ${tenantId}${dataset ? `, dataset: ${dataset}` : ''})`);

    const pythonProcess = spawn('python', pyArgs);

    pythonProcess.stdout.on('data', (data) => {
      console.log(`[Unpack Agent] ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`[Unpack Agent Error] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
      console.log(`[Unpack Agent] Process exited with code ${code}`);
    });

    // Return immediate 202 Accepted because unpacking and AST sync runs asynchronously
    return NextResponse.json({ 
      message: 'Unpacking process started', 
      fileName,
      status: 'Processing in background'
    }, { status: 202 });

  } catch (error) {
    console.error("❌ Webhook processing error:", error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
