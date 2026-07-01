import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { INSTITUTION } from '@/lib/brand';

export const dynamic = 'force-dynamic';

/**
 * Performs comprehensive database sanitization, deduplication, and standardization.
 * Requires a valid secret token for access.
 *
 * @param req - The incoming HTTP request containing query parameters.
 * @returns A JSON response outlining the results of the cleanup operation.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');

  // Enforce zero-trust security access control
  const validSecret = process.env.DB_CLEANUP_SECRET;
  if (!validSecret || secret !== validSecret) {
    return NextResponse.json({ 
      error: "UNAUTHORIZED", 
      message: "Access denied. Provide the correct security query parameter: ?secret=..." 
    }, { status: 401 });
  }

  try {
    console.log('[DB Cleanup Agent] Starting comprehensive database sanitization and standardization...');
    
    // ----------------------------------------------------------------
    // TRANSACTION 1: DEDUPLICATE COURSES
    // ----------------------------------------------------------------
    console.log('[DB Cleanup Agent] Deduplicating courses table...');
    // Audit duplicates before deleting
    const courseDupsBefore = await query(`
      SELECT prefix, number, document_id, COUNT(*) as count 
      FROM courses 
      GROUP BY prefix, number, document_id 
      HAVING COUNT(*) > 1;
    `);
    
    // Delete duplicate course listings, retaining only the oldest ID
    const courseDeleteRes = await query(`
      DELETE FROM courses a USING courses b
      WHERE a.id > b.id 
        AND a.prefix = b.prefix 
        AND a.number = b.number 
        AND a.document_id = b.document_id;
    `);
    const coursesRemoved = courseDupsBefore.reduce((acc, curr) => acc + (parseInt(curr.count) - 1), 0);

    // ----------------------------------------------------------------
    // TRANSACTION 2: DEDUPLICATE PROGRAMS
    // ----------------------------------------------------------------
    console.log('[DB Cleanup Agent] Deduplicating programs table...');
    // Audit duplicates before deleting
    const programDupsBefore = await query(`
      SELECT name, document_id, COUNT(*) as count 
      FROM programs 
      GROUP BY name, document_id 
      HAVING COUNT(*) > 1;
    `);

    // Delete duplicate program listings, retaining only the oldest ID
    const programDeleteRes = await query(`
      DELETE FROM programs a USING programs b
      WHERE a.id > b.id 
        AND a.name = b.name 
        AND a.document_id = b.document_id;
    `);
    const programsRemoved = programDupsBefore.reduce((acc, curr) => acc + (parseInt(curr.count) - 1), 0);

    // ----------------------------------------------------------------
    // TRANSACTION 3: DEDUPLICATE SEMANTIC CHUNKS (POLICIES)
    // ----------------------------------------------------------------
    console.log('[DB Cleanup Agent] Deduplicating policy chunks...');
    // Audit duplicates
    const chunkDupsBefore = await query(`
      SELECT chunk_hash, COUNT(*) as count 
      FROM semantic_chunks 
      WHERE chunk_hash IS NOT NULL
      GROUP BY chunk_hash 
      HAVING COUNT(*) > 1;
    `);

    // Delete duplicate semantic chunks, retaining only the oldest ID
    const chunkDeleteRes = await query(`
      DELETE FROM semantic_chunks a USING semantic_chunks b
      WHERE a.id > b.id 
        AND a.chunk_hash = b.chunk_hash;
    `);
    const chunksRemoved = chunkDupsBefore.reduce((acc, curr) => acc + (parseInt(curr.count) - 1), 0);

    // ----------------------------------------------------------------
    // TRANSACTION 4: DYNAMIC DEGREE CLASSIFICATION AUTO-MAPPING
    // ----------------------------------------------------------------
    console.log('[DB Cleanup Agent] Running semantic auto-mapping for unclassified programs...');
    
    // Fetch all available degree classifications
    const classifications = await query(`SELECT id, label FROM degree_classifications;`);
    
    // Fetch all programs currently missing a classification
    const unclassifiedPrograms = await query(`
      SELECT id, name FROM programs WHERE degree_classification_id IS NULL;
    `);

    let autoMappedProgramsCount = 0;
    const mappedReport: Array<{ programName: string; classificationLabel: string }> = [];

    for (const prog of unclassifiedPrograms) {
      const nameLower = prog.name.toLowerCase();
      let matchedId = null;
      let matchedLabel = '';

      // Match semantic keywords
      for (const classification of classifications) {
        const labelLower = classification.label.toLowerCase();
        
        // Define major keyword anchors
        let anchorWord = '';
        if (labelLower.includes('business') || labelLower.includes('accounting')) anchorWord = 'business';
        else if (labelLower.includes('criminal') || labelLower.includes('justice') || labelLower.includes('law')) anchorWord = 'criminal';
        else if (labelLower.includes('science') || labelLower.includes('biology')) anchorWord = 'science';
        else if (labelLower.includes('psychology') || labelLower.includes('human services')) anchorWord = 'human';
        else if (labelLower.includes('education') || labelLower.includes('teach')) anchorWord = 'education';
        else if (labelLower.includes('english') || labelLower.includes('humanities')) anchorWord = 'humanities';

        if (anchorWord && nameLower.includes(anchorWord)) {
          matchedId = classification.id;
          matchedLabel = classification.label;
          break;
        }
      }

      if (matchedId) {
        await query(`
          UPDATE programs 
          SET degree_classification_id = $1 
          WHERE id = $2;
        `, [matchedId, prog.id]);
        autoMappedProgramsCount++;
        mappedReport.push({ programName: prog.name, classificationLabel: matchedLabel });
      }
    }

    // ----------------------------------------------------------------
    // TRANSACTION 5: STANDARDIZE NULL VALUES (COURSES AND PROGRAMS)
    // ----------------------------------------------------------------
    console.log('[DB Cleanup Agent] Patching null values with sensible standards...');
    
    // Default null/0 course credits to 3 (most common course format at the institution)
    const patchedCoursesCredits = await query(`
      UPDATE courses 
      SET credits = 3 
      WHERE credits IS NULL OR credits = 0;
    `);

    // Standardize empty mission statements and outcome objectives to safe placeholders
    const patchedProgramsMission = await query(`
      UPDATE programs 
      SET mission_statement = 'Academic program guidelines compiled under ${INSTITUTION.legalName} active curricula.'
      WHERE mission_statement IS NULL OR mission_statement = '' OR mission_statement = 'NULL';
    `);

    const patchedProgramsOutcomes = await query(`
      UPDATE programs 
      SET program_outcome_objectives = 'Demonstrate foundational learning outcomes, core curriculum objectives, and professional career readiness.'
      WHERE program_outcome_objectives IS NULL OR program_outcome_objectives = '' OR program_outcome_objectives = 'NULL';
    `);

    console.log('[DB Cleanup Agent] Database cleanup pipeline successfully completed!');

    return NextResponse.json({
      status: "success",
      message: `${INSTITUTION.legalName} catalog database successfully sanitized, standardized, and repaired.`,
      timestamp: new Date().toISOString(),
      deduplicated: {
        coursesRemovedCount: coursesRemoved,
        programsRemovedCount: programsRemoved,
        policyChunksRemovedCount: chunksRemoved,
      },
      autoMapped: {
        programsClassifiedCount: autoMappedProgramsCount,
        mappings: mappedReport,
      },
      standardized: {
        coursesPatchedTo3Credits: patchedCoursesCredits ? 'Applied' : 'Skipped',
        programsMissionsPatched: patchedProgramsMission ? 'Applied' : 'Skipped',
        programsOutcomesPatched: patchedProgramsOutcomes ? 'Applied' : 'Skipped',
      }
    });

  } catch (err: any) {
    console.error('[DB Cleanup Agent Error]:', err.message);
    return NextResponse.json({
      status: "error",
      message: "Database cleanup pipeline failed during execution.",
      error: err.message,
    }, { status: 500 });
  }
}
