import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import mammoth from 'mammoth';
import { TENANT_ID } from '@/lib/brand';

const execAsync = util.promisify(exec);

/**
 * Processes incoming document uploads by saving files and extracting curriculum data.
 * Executes Python scripts or mammoth library extraction to read committee minutes.
 *
 * @param req - The incoming POST request containing multipart form data.
 * @returns A JSON response with the extracted content and generated AI prompts.
 */
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    // Prepare intake directory in a writable temp space (Vercel compatible)
    const intakeDir = path.join(os.tmpdir(), `${TENANT_ID.toLowerCase()}_intake`);
    await fs.mkdir(intakeDir, { recursive: true });

    // Sanitize filename and save
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const filePath = path.join(intakeDir, sanitizedName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    console.log(`Saved uploaded file to ${filePath}. Spawning extraction script...`);

    let stdout = '';
    let extractionError: string | null = null;

    try {
      // Execute the python extraction script synchronously
      const scriptPath = path.join(process.cwd(), 'spoke_workspace', 'scripts', 'extract_minutes.py');

      // Wrap in quotes to handle spaces in paths
      const command = `python "${scriptPath}" "${filePath}"`;

      const result = await execAsync(command);
      stdout = result.stdout;

      if (result.stderr) {
         console.warn("Extraction script warning/error:", result.stderr);
      }
      console.log("Extraction output:", stdout);
    } catch (scriptErr: any) {
      // Surface the real failure instead of fabricating a successful extraction,
      // so a broken/unavailable Python environment is visible rather than masked.
      extractionError = scriptErr.message || 'Python extraction script failed.';
      console.error("Python extraction failed:", extractionError);
    }

    // Extract raw text using mammoth
    let rawText = "Unable to extract text. Not a valid .docx file.";
    try {
       const result = await mammoth.extractRawText({ buffer });
       rawText = result.value;
    } catch (err) {
       console.warn("Mammoth extraction failed:", err);
    }

    const aiPrompt = `You are an expert academic registrar assistant. Your task is to extract all approved curricular changes from the provided committee minutes.
Pay close attention to changes involving degree requirements, course credit hours, prerequisites, and new or discontinued programs.

Return ONLY a valid JSON array of objects, where each object represents a distinct curricular change. Each object MUST contain these exact keys:
- "program_name": The name of the specific academic program, degree, or department affected. Use "General Education" if it applies universally.
- "action": Must be exactly one of "ADD", "DELETE", or "AMEND".
- "semantic_instruction": A clear, plain-English, actionable instruction representing the change. Synthesize the change into a direct command (e.g., 'Add BIO 101 to the core requirements', 'Change the credit hours of MAT 200 from 3 to 4').

Important constraints:
- Ignore general discussion, table approvals, or administrative remarks that do not directly change curriculum.
- If a change affects multiple programs, create a separate object for each program.
- Ensure the JSON is well-formed. Do not include markdown code blocks or any other text outside the JSON array.

Committee Minutes:
[DOCUMENT TEXT INJECTED HERE]
`;

    return NextResponse.json({
      status: extractionError ? "extraction_failed" : "success",
      message: extractionError
        ? "File was uploaded, but the extraction script failed. See extractionError for details."
        : "File successfully uploaded and parsed by the Intake Funnel.",
      output: stdout,
      extractionError,
      filePath: `/api/download?file=${encodeURIComponent(sanitizedName)}`,
      rawText,
      aiPrompt
    });

  } catch (e: any) {
    console.error("Upload API Error: ", e);
    return NextResponse.json({ error: e.message || "Failed to process upload." }, { status: 500 });
  }
}
