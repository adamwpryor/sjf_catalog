import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Executes a basic health and schema check against the database.
 * Retrieves table schemas, catalog versions, and sample data.
 *
 * @returns A JSON response detailing columns, catalogs, and sampled data.
 */
export async function GET() {
  try {
    // 1. Fetch all columns for relevant tables: programs, semantic_chunks, courses, documents
    const columns = await query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' 
        AND table_name IN ('programs', 'semantic_chunks', 'courses', 'documents')
      ORDER BY table_name, ordinal_position;
    `);

    // 2. Fetch the catalog versions in the DB
    const catalogs = await query(`
      SELECT id, version, domain_id, created_at FROM documents ORDER BY created_at DESC;
    `);

    // 3. Try to fetch a small sample of programs to see if markdown_url has actual data
    const programSample = await query(`
      SELECT id, name, markdown_url FROM programs WHERE markdown_url IS NOT NULL LIMIT 5;
    `);

    // 4. Try to fetch a sample of semantic_chunks with markdown_url
    const chunkSample = await query(`
      SELECT id, section_header, page_number, markdown_url FROM semantic_chunks WHERE markdown_url IS NOT NULL LIMIT 5;
    `);

    return NextResponse.json({
      success: true,
      columns,
      catalogs,
      samples: {
        programs: programSample,
        chunks: chunkSample
      }
    });
  } catch (err: any) {
    console.error('Schema Check Error:', err);
    return NextResponse.json({
      success: false,
      error: err.message,
      stack: err.stack
    }, { status: 500 });
  }
}
