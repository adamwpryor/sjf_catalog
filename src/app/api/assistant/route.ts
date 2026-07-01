import { NextResponse } from 'next/server';
import { query, queryWithAuth } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';
import { TENANT_ID, INSTITUTION } from '@/lib/brand';
import { getGcpCredentials } from '@/lib/llm';

/**
 * Validates a SQL query to ensure it is a safe read-only operation.
 * Prevents destructive commands and multiple statement executions.
 *
 * @param sql - The SQL query string to validate.
 * @returns True if the query is safe and read-only, otherwise false.
 */
function isReadOnlyQuery(sql: string): boolean {
  const cleanSql = sql.trim().toUpperCase();
  // Must start with SELECT or WITH
  if (!cleanSql.startsWith('SELECT') && !cleanSql.startsWith('WITH')) {
    return false;
  }
  // Check for destructive keywords
  const destructiveKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 
    'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE', 'RENAME', 'EXEC'
  ];
  for (const keyword of destructiveKeywords) {
    // Word boundary check
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(cleanSql)) {
      return false;
    }
  }
  // Ensure no multiple statements (SQL injection check)
  if (cleanSql.includes(';')) {
    const parts = cleanSql.split(';').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      return false;
    }
  }
  return true;
}

/**
 * Calculates the impact blast radius of modifying or removing a course.
 * Identifies downstream courses and programs that rely on the target course.
 *
 * @param courseCode - The code of the course to analyze.
 * @param catalogId - The document ID of the active catalog.
 * @returns An object containing the target course and its impacted courses and programs.
 */
async function getCourseBlastRadius(courseCode: string, catalogId: string) {
  const tenantId = TENANT_ID;
  const cleanCode = courseCode.toUpperCase().trim().replace('-', ' ');
  
  // Find course first
  const courses = await query(
    `SELECT id, title FROM courses WHERE course_code = $1 AND document_id = $2 AND tenant_id = $3;`,
    [cleanCode, catalogId, tenantId]
  );
  
  if (courses.length === 0) {
    return { error: `Course ${cleanCode} not found in catalog version ${catalogId}.` };
  }
  
  const courseId = courses[0].id;
  const courseTitle = courses[0].title;
  
  // Downstream Courses (Courses that require this course as a prerequisite)
  const downstreamCourses = await query(
    `SELECT DISTINCT c_src.course_code, c_src.title
     FROM course_prerequisite_links cpl
     JOIN courses c_src ON cpl.course_id = c_src.id
     JOIN courses c_target ON cpl.prereq_course_id = c_target.id
     WHERE c_target.id = $1 AND c_src.document_id = $2 AND cpl.tenant_id = $3;`,
    [courseId, catalogId, tenantId]
  );
  
  // Downstream Programs (Programs that require this course directly in a requirement block)
  const downstreamPrograms = await query(
    `SELECT DISTINCT p.name as program_name, p.degree_type
     FROM program_requirement_courses prc
     JOIN program_requirements pr ON prc.requirement_id = pr.id
     JOIN programs p ON pr.program_id = p.id
     JOIN courses c ON prc.course_id = c.id
     WHERE c.id = $1 AND c.document_id = $2 AND prc.tenant_id = $3 AND pr.tenant_id = $3 AND p.tenant_id = $3;`,
    [courseId, catalogId, tenantId]
  );
  
  return {
    target: { course_code: cleanCode, title: courseTitle },
    impacted_courses: downstreamCourses.map((r: any) => ({ course_code: r.course_code, title: r.title })),
    impacted_programs: downstreamPrograms.map((r: any) => ({ program_name: r.program_name, degree_type: r.degree_type }))
  };
}

/**
 * Constructs a multi-hop prerequisite tree for a given course.
 * Uses a recursive CTE to find all direct and indirect prerequisites.
 *
 * @param courseCode - The code of the target course.
 * @param catalogId - The document ID of the active catalog.
 * @returns An object detailing the course and its multi-hop prerequisites.
 */
async function getPrerequisiteTree(courseCode: string, catalogId: string) {
  const tenantId = TENANT_ID;
  const cleanCode = courseCode.toUpperCase().trim().replace('-', ' ');
  
  // Find course first
  const courses = await query(
    `SELECT id, title FROM courses WHERE course_code = $1 AND document_id = $2 AND tenant_id = $3;`,
    [cleanCode, catalogId, tenantId]
  );
  
  if (courses.length === 0) {
    return { error: `Course ${cleanCode} not found in catalog version ${catalogId}.` };
  }
  
  const results = await query(
    `WITH RECURSIVE prereq_tree AS (
        -- Base case: immediate prerequisites for the course in this catalog
        SELECT 
            cpl.prereq_course_id as required_course_id,
            c_target.course_code as required_code,
            c_target.title as required_title,
            1 as depth,
            c_source.course_code || ' -> ' || c_target.course_code as path
        FROM course_prerequisite_links cpl
        JOIN courses c_source ON cpl.course_id = c_source.id
        JOIN courses c_target ON cpl.prereq_course_id = c_target.id
        WHERE c_source.course_code = $1 
          AND c_source.document_id = $2 
          AND c_source.tenant_id = $3 
          AND cpl.tenant_id = $3

        UNION
        
        -- Recursive step: prerequisites of prerequisites
        SELECT
            cpl.prereq_course_id as required_course_id,
            c_target.course_code as required_code,
            c_target.title as required_title,
            pt.depth + 1 as depth,
            pt.path || ' -> ' || c_target.course_code as path
        FROM prereq_tree pt
        JOIN course_prerequisite_links cpl ON pt.required_course_id = cpl.course_id
        JOIN courses c_target ON cpl.prereq_course_id = c_target.id
        WHERE cpl.tenant_id = $3 
          AND c_target.document_id = $2
          AND pt.path NOT LIKE '%' || c_target.course_code || '%'
    )
    SELECT required_code as "requiredCode", required_title as "requiredTitle", depth, path
    FROM prereq_tree
    ORDER BY depth, required_code;`,
    [cleanCode, catalogId, tenantId]
  );
  
  return {
    course: cleanCode,
    title: courses[0].title,
    multi_hop_prerequisites: results
  };
}

/**
 * Generates vector embeddings for text using either Vertex AI or Google AI Studio.
 *
 * @param text - The input text to embed.
 * @param gcp - Optional GCP credentials containing projectId, location, and accessToken.
 * @param geminiKey - Optional Google AI Studio API key.
 * @returns A numerical array representing the embedding vector, or null if generation fails.
 */
export async function generateEmbedding(
  text: string,
  gcp?: { projectId: string; location: string; accessToken: string },
  geminiKey?: string
): Promise<number[] | null> {
  // 1. If Vertex AI credentials are active, use Vertex AI gemini-embedding-001 @ 1536.
  // The stored chunk embeddings are produced by this same model+dimension (see the
  // embedding_1536_hnsw migration), so query and stored vectors share one space.
  if (gcp && gcp.accessToken) {
    try {
      console.log(`[Vertex AI Embedding] Generating embedding via Vertex AI gemini-embedding-001 @ 1536...`);
      const embedUrl = `https://${gcp.location}-aiplatform.googleapis.com/v1/projects/${gcp.projectId}/locations/${gcp.location}/publishers/google/models/gemini-embedding-001:predict`;
      const res = await fetch(embedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gcp.accessToken}`
        },
        body: JSON.stringify({
          instances: [{ content: text }],
          parameters: { outputDimensionality: 1536 }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data.predictions?.[0]?.embeddings?.values;
        if (Array.isArray(embedding)) {
          console.log(`[Vertex AI Embedding] Successfully generated ${embedding.length}-D embedding.`);
          return embedding;
        }
      } else {
        console.warn(`[Vertex AI Embedding] API returned status ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      console.warn(`[Vertex AI Embedding] Failed. Details: ${err.message}`);
    }
  }

  // 2. Fallback to Google AI Studio gemini-embedding-001 if geminiKey is active
  if (geminiKey) {
    try {
      console.log(`[Google AI Studio Embedding] Generating embedding via gemini-embedding-001 @ 1536...`);
      const embedUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiKey}`;
      const res = await fetch(embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "models/gemini-embedding-001",
          content: { parts: [{ text }] },
          outputDimensionality: 1536
        })
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data.embedding?.values;
        if (Array.isArray(embedding)) {
          console.log(`[Google AI Studio Embedding] Successfully generated ${embedding.length}-D embedding.`);
          return embedding;
        }
      } else {
        console.warn(`[Google AI Studio Embedding] API returned status ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      console.warn(`[Google AI Studio Embedding] Failed. Details: ${err.message}`);
    }
  }

  return null;
}

/**
 * Retrieves relevant catalog content chunks using a hybrid search approach.
 * Attempts vector similarity search, falling back to full-text search, regex keyword search, or sequential chunks.
 *
 * @param message - The user's query or search terms.
 * @param tenantId - The tenant identifier.
 * @param catalogId - The active catalog document ID.
 * @param gcp - Optional GCP credentials for embedding generation.
 * @param geminiKey - Optional Google AI Studio API key for embedding generation.
 * @returns An object containing the retrieved chunks and the search method used.
 */
export async function retrieveGroundedChunks(
  message: string,
  tenantId: string,
  catalogId: string,
  gcp?: { projectId: string; location: string; accessToken: string },
  geminiKey?: string
): Promise<{ chunks: any[]; method: string }> {
  let retrievedChunks: any[] = [];
  let rewrittenMessage = message;
  let expansionMethod = '';

  // 0. Course Code Extraction, Typos Mapping & Direct Courses Table Grounding
  try {
    const courseRegex = /\b([A-Za-z]{2,4})\s*[-]?\s*(\d{3})\b/gi;
    let match;
    const detectedCourses: { original: string; prefix: string; num: string; cleanCode: string }[] = [];
    
    while ((match = courseRegex.exec(message)) !== null) {
      const orig = match[0];
      const prefix = match[1].toUpperCase();
      const num = match[2];

      // No institution-specific prefix rewriting here (the old CCSJ ACT/ACC/CT ➔ ACCT
      // map does not generalize to SJFU). Typos are absorbed downstream by the courses
      // lookup, which also matches on the numeric portion (course_code ILIKE %num%).
      const cleanCode = `${prefix} ${num}`;
      detectedCourses.push({ original: orig, prefix, num, cleanCode });
    }

    if (detectedCourses.length > 0) {
      console.log(`[RAG Expansion] Extracted potential course terms:`, detectedCourses);
      
      for (const dc of detectedCourses) {
        // Query the courses table directly to retrieve the course description
        const courses = await query(
          `SELECT course_code, title, description, credits 
           FROM courses 
           WHERE tenant_id = $1 AND document_id = $2 
             AND (course_code = $3 OR course_code ILIKE $4)
           LIMIT 2;`,
          [tenantId, catalogId, dc.cleanCode, `%${dc.num}%`]
        );

        if (courses.length > 0) {
          const course = courses[0];
          console.log(`[RAG Expansion] Grounded course found: ${course.course_code} - "${course.title}"`);
          
          // Inject course details directly as a highly authoritative custom grounded chunk
          retrievedChunks.push({
            section_header: `Official Course Details: ${course.course_code} - ${course.title}`,
            content: `Course Code: ${course.course_code}\nTitle: ${course.title}\nCredits: ${course.credits} Credits\nDescription: ${course.description || 'No description recorded in database.'}`
          });

          // Rewrite typo prefix or code in message string to optimize downstream fallbacks
          rewrittenMessage = rewrittenMessage.replace(new RegExp(dc.original, 'gi'), course.course_code);
          expansionMethod = `Course Expansion (${dc.original} ➔ ${course.course_code})`;
        }
      }
    }
  } catch (err: any) {
    console.warn(`[RAG Expansion] Fuzzy course expansion errored: ${err.message}`);
  }

  // 1. Primary: Vector similarity search (unified Vertex AI / AI Studio generator)
  const vector = await generateEmbedding(rewrittenMessage, gcp, geminiKey);
  if (vector) {
    try {
      console.log(`[RAG Retrieval] Attempting pgvector similarity search with generated embedding...`);
      const vectorString = `[${vector.join(',')}]`;

      const vectorChunks = await query(
        `SELECT section_header, content 
         FROM semantic_chunks 
         WHERE tenant_id = $1 AND document_id = $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $3::vector 
         LIMIT 25;`,
        [tenantId, catalogId, vectorString]
      );
      if (vectorChunks.length > 0) {
        console.log(`[RAG Retrieval] Vector similarity search succeeded! Retrieved ${vectorChunks.length} chunks.`);
        retrievedChunks = [...retrievedChunks, ...vectorChunks];
        return { 
          chunks: retrievedChunks, 
          method: expansionMethod ? `pgvector RAG + ${expansionMethod}` : 'pgvector RAG Retrieval' 
        };
      }
    } catch (err: any) {
      console.warn(`[RAG Retrieval] pgvector query failed or dimension mismatched. Details: ${err.message}`);
    }
  }

  // 2. Secondary Fallback: PostgreSQL Full-Text Search (FTS)
  try {
    console.log(`[RAG Retrieval] Running PostgreSQL Full-Text Search fallback with query: "${rewrittenMessage}"`);
    const ftsChunks = await query(
      `SELECT section_header, content, 
              ts_rank(to_tsvector('english', content), plainto_tsquery('english', $3)) as rank
       FROM semantic_chunks 
       WHERE tenant_id = $1 AND document_id = $2 
         AND to_tsvector('english', content) @@ plainto_tsquery('english', $3)
       ORDER BY rank DESC 
       LIMIT 25;`,
      [tenantId, catalogId, rewrittenMessage]
    );

    if (ftsChunks.length > 0) {
      console.log(`[RAG Retrieval] FTS succeeded! Retrieved ${ftsChunks.length} chunks.`);
      retrievedChunks = [...retrievedChunks, ...ftsChunks];
      return { 
        chunks: retrievedChunks, 
        method: expansionMethod ? `PostgreSQL FTS + ${expansionMethod}` : 'PostgreSQL Full-Text Search' 
      };
    }
  } catch (err: any) {
    console.warn(`[RAG Retrieval] Full-Text Search failed. Details: ${err.message}`);
  }

  // 3. Tertiary Fallback: High-Fidelity Regular Expression Whole-Word Matching (Fuzzy Substring Prevention)
  try {
    console.log(`[RAG Retrieval] Running Whole-Word Regex Search fallback...`);
    const words = rewrittenMessage.match(/\b[A-Za-z0-9]{2,}\b/g) || []; // Support 2+ chars for ACT/CT
    const stopWords = new Set([
      'what', 'is', 'the', 'a', 'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 
      'an', 'about', 'how', 'many', 'would', 'be', 'were', 'make', 'change', 'course',
      'programs', 'effected', 'if', 'we', 'use', 'please', 'can', 'you', 'tell', 'me',
      'there', 'their', 'them', 'they', 'this', 'that', 'these', 'those', 'are', 'was',
      'been', 'has', 'have', 'had', 'does', 'doing', 'done', 'should', 'could', 'would',
      'affected', 'changed', 'learning', 'outcomes', 'sorry'
    ]);
    
    const keywords = words
      .map(w => w.toLowerCase())
      .filter(w => !stopWords.has(w));
      
    if (keywords.length > 0) {
      const params = [tenantId, catalogId];
      const regexClauses: string[] = [];
      
      keywords.forEach((keyword) => {
        const paramIdx = params.length + 1;
        // Case-insensitive regular expression whole-word boundary formatting: \ykeyword\y
        params.push(`\\y${keyword}\\y`);
        regexClauses.push(`(content ~* $${paramIdx} OR section_header ~* $${paramIdx})`);
      });
      
      const sql = `
        SELECT section_header, content 
        FROM semantic_chunks 
        WHERE tenant_id = $1 AND document_id = $2 AND (${regexClauses.join(' OR ')})
        LIMIT 25;
      `;
      
      const regexChunks = await query(sql, params);
      if (regexChunks.length > 0) {
        console.log(`[RAG Retrieval] Regex Keyword Search succeeded! Retrieved ${regexChunks.length} chunks.`);
        retrievedChunks = [...retrievedChunks, ...regexChunks];
        return { 
          chunks: retrievedChunks, 
          method: expansionMethod ? `Regex Keyword Search + ${expansionMethod}` : 'Regex Keyword Search' 
        };
      }
    }
  } catch (err: any) {
    console.warn(`[RAG Retrieval] Regex Keyword Search failed. Details: ${err.message}`);
  }

  // 4. Ultimate Fallback: Sequential catalog chunks
  if (retrievedChunks.length === 0) {
    console.log(`[RAG Retrieval] All search methods yielded 0 results. Falling back to sequential chunks.`);
    try {
      const fallbackChunks = await query(
        `SELECT section_header, content 
         FROM semantic_chunks 
         WHERE tenant_id = $1 AND document_id = $2 
         ORDER BY sequence_order ASC LIMIT 5;`,
        [tenantId, catalogId]
      );
      retrievedChunks = fallbackChunks;
    } catch (err: any) {
      console.error(`[RAG Retrieval] Sequential fallback crashed: ${err.message}`);
    }
  }

  // P1: Parent-Child Retrieval (Expand to Section Context)
  // If we found specific chunks, fetch the surrounding chunks that share the same section_header.
  if (retrievedChunks.length > 0) {
    const sectionHeaders = [...new Set(retrievedChunks.map(c => c.section_header).filter(Boolean))];
    if (sectionHeaders.length > 0) {
      console.log(`[RAG Expansion] Expanding ${retrievedChunks.length} chunks into full parent section context for ${sectionHeaders.length} headers...`);
      try {
        const expandedChunks = await query(
          `SELECT section_header, content 
           FROM semantic_chunks 
           WHERE tenant_id = $1 AND document_id = $2 AND section_header = ANY($3)
           ORDER BY section_header, sequence_order ASC;`,
          [tenantId, catalogId, sectionHeaders]
        );
        if (expandedChunks.length > 0) {
          retrievedChunks = expandedChunks;
          expansionMethod += (expansionMethod ? ' + ' : '') + 'Parent-Child Context Expansion';
        }
      } catch (err: any) {
        console.warn(`[RAG Expansion] Parent-child section expansion failed: ${err.message}`);
      }
    }
  }

  return { 
    chunks: retrievedChunks, 
    method: expansionMethod ? `Default Fallback + ${expansionMethod}` : (retrievedChunks.length > 0 ? expansionMethod : 'Default Sequential Chunks')
  };
}

/**
 * Uses a lightweight LLM call to extract structured intent (scope, shape, negations, exact entities).
 */
async function parseQuestionIntent(message: string, geminiKey?: string): Promise<{ keywords: string[], scope: string, answerShape: string, negations: string[] }> {
  if (!geminiKey) return { keywords: [], scope: '', answerShape: '', negations: [] };
  try {
    const prompt = `Extract structured intent from this user question about an academic catalog.
Return ONLY a valid JSON object with these exact keys:
- "keywords": array of exact course codes (e.g. "ACC-101") or specific entities.
- "scope": any specific time, term, or catalog year mentioned (or empty string).
- "answerShape": what the user wants (e.g. "list", "yes/no", "summary").
- "negations": what the user specifically excludes (e.g. "not required").

Question: "${message}"`;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return JSON.parse(text);
    }
  } catch(e) {
    console.warn("[Intent Parser] Failed:", e);
  }
  return { keywords: [], scope: '', answerShape: '', negations: [] };
}

/**
 * Handles incoming chat requests to the Assistant API.
 * Uses hybrid RAG retrieval to ground answers in catalog policies and course details.
 *
 * @param req - The incoming POST request containing chat messages and metadata.
 * @returns A JSON response with the generated text, sources, and debug terminal logs.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user || !session.user.email) {
      return NextResponse.json({ error: "Unauthorized access." }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const { message, catalogId, modelId = 'gemini-2.5-flash', mode = 'RAG', history = [] } = body;

    if (!message || !catalogId) {
      return NextResponse.json({ error: "Missing message or catalogId." }, { status: 400 });
    }

    const tenantId = TENANT_ID;
    const terminalLogs: any[] = [];

    // Resolve pooled GCP credentials (OIDC workload identity, private key, or local ADC)
    const gcp = await getGcpCredentials(req);

    // Map model selection
    let provider = 'gemini';
    let apiModel = 'gemini-2.5-flash';
    const normalizedModel = modelId.toLowerCase();

    if (normalizedModel.includes('gpt')) {
      provider = 'openai';
      apiModel = normalizedModel.includes('mini') ? 'gpt-4o-mini' : 'gpt-4o';
    } else if (normalizedModel.includes('claude')) {
      provider = 'anthropic';
      if (normalizedModel.includes('sonnet')) {
        apiModel = 'claude-3-7-sonnet-20250219';
      } else if (normalizedModel.includes('opus')) {
        apiModel = 'claude-3-opus-20240229';
      } else {
        apiModel = 'claude-3-5-haiku-20241022';
      }
    } else {
      provider = 'gemini';
      if (normalizedModel.includes('3.1-pro') || normalizedModel.includes('2.5-pro')) {
        apiModel = 'gemini-2.5-pro';
      } else if (normalizedModel.includes('3.1-flash') || normalizedModel.includes('2.5-flash')) {
        apiModel = 'gemini-2.5-flash';
      } else if (normalizedModel.includes('1.5-pro')) {
        apiModel = 'gemini-1.5-pro';
      } else if (normalizedModel.includes('1.5-flash')) {
        apiModel = 'gemini-1.5-flash';
      }
    }

    // Dynamic model ID mapping for Vertex AI partner integrations
    let isVertex = false;
    if (gcp.accessToken && (provider === 'gemini' || provider === 'anthropic')) {
      isVertex = true;
      if (provider === 'gemini') {
        if (apiModel.includes('pro')) {
          apiModel = 'gemini-2.5-pro';
        } else {
          apiModel = 'gemini-2.5-flash';
        }
      } else if (provider === 'anthropic') {
        if (apiModel.includes('sonnet')) {
          apiModel = 'claude-3-5-sonnet-v2@20241022';
        } else if (apiModel.includes('opus')) {
          apiModel = 'claude-3-opus@20240229';
        } else {
          apiModel = 'claude-3-5-haiku@20241022';
        }
      }
    }

    // Load keys
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    const isApiKeyConfigured = 
      (provider === 'openai' && openaiKey) || 
      (provider === 'gemini' && (geminiKey || isVertex)) || 
      (provider === 'anthropic' && (anthropicKey || isVertex));

    // P2: Typed Question Parsing Layer
    let intent = { keywords: [] as string[], scope: '', answerShape: '', negations: [] as string[] };
    if (isApiKeyConfigured && geminiKey) {
       intent = await parseQuestionIntent(message, geminiKey);
       console.log(`[Typed Intent] Parsed:`, intent);
    }

    // No AI provider is configured — surface a real error instead of a simulated
    // answer so a misconfigured key/credential is visible rather than masked.
    if (!isApiKeyConfigured) {
      console.error(`[Assistant] No API provider configured for ${provider} (${apiModel}). No GEMINI/OPENAI/ANTHROPIC key or Vertex credential available.`);
      return NextResponse.json({
        error: `No AI provider is configured for "${provider}". Set a GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (or valid Vertex AI credentials) on the server.`
      }, { status: 503 });
    }

    // ==========================================
    // MODE 1: STRICT RAG MODE
    // ==========================================
    if (mode.toUpperCase() === 'RAG') {
      const { chunks: retrievedChunks, method: retrievalMethod } = await retrieveGroundedChunks(
        message,
        tenantId,
        catalogId,
        gcp,
        geminiKey
      );

      const contextText = retrievedChunks.length > 0
        ? retrievedChunks.map((c, idx) => `[Chunk ${idx + 1} - ${c.section_header || 'Narrative'}]:\n${c.content}`).join('\n\n')
        : "No specific catalog chunks found for this query.";

      const systemPrompt = `You are the AI Catalog Assistant for ${INSTITUTION.legalName} (Mode: STRICT RAG).
Your task is to answer user questions about courses, credits, and policies.
You MUST answer user questions based STRICTLY on the official academic policies, course details, and program requirements provided in the Grounded Catalog Chunks below.
Do not assume or hallucinate. Scan ALL the provided chunks to compile a complete, comprehensive, and exhaustive list of all answers to the user's question (for example, if asked what programs require or list a course, trace every program requirement chunk provided and list every match found).

IMPORTANT CITATION RULE: Whenever you reference a specific policy code (e.g., FRONT_MATTER_POL_1) or a specific course identifier (e.g., BIO-101), format it precisely in square brackets like [FRONT_MATTER_POL_1] or [BIO-101].

[USER INTENT GUIDERAILS]
- Scope: ${intent.scope || 'General'}
- Requested Answer Format: ${intent.answerShape || 'Narrative'}
- Exclusions/Negations to honor: ${intent.negations.join(', ') || 'None'}

Keep your tone academic, helpful, professional, and slightly warm.

Grounded Catalog Chunks:
${contextText}`;

      // Call selected LLM Provider
      let responseText = '';
      if (provider === 'openai' && openaiKey) {
        const openaiBaseUrl = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
        const chatMessages = [
          { role: 'system', content: systemPrompt },
          ...history.slice(-10).map((h: any) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
          { role: 'user', content: message }
        ];
        const res = await fetch(`${openaiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
          body: JSON.stringify({ model: apiModel, messages: chatMessages, temperature: 0.4 })
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.choices?.[0]?.message?.content || 'No response.';
        } else {
          throw new Error(`OpenAI API returned status ${res.status}: ${await res.text()}`);
        }
      } else if (isVertex) {
        // Dynamic Vertex AI Pooled Route (OIDC Workload Identity / Service Account keyless OIDC auth)
        if (provider === 'gemini') {
          console.log(`[Vertex AI RAG] Routing ${apiModel} through Google Cloud projects/${gcp.projectId}/locations/${gcp.location}...`);
          const completionUrl = `https://${gcp.location}-aiplatform.googleapis.com/v1/projects/${gcp.projectId}/locations/${gcp.location}/publishers/google/models/${apiModel}:generateContent`;
          const contents = [
            ...history.slice(-10).map((h: any) => ({
              role: h.role === 'user' ? 'user' : 'model',
              parts: [{ text: h.content }]
            })),
            { role: 'user', parts: [{ text: message }] }
          ];
          const res = await fetch(completionUrl, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${gcp.accessToken}`
            },
            body: JSON.stringify({
              contents: contents,
              systemInstruction: { parts: [{ text: systemPrompt }] }
            })
          });
          if (res.ok) {
            const data = await res.json();
            responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
          } else {
            throw new Error(`Vertex AI Gemini API returned status ${res.status}: ${await res.text()}`);
          }
        } else if (provider === 'anthropic') {
          console.log(`[Vertex AI RAG] Routing ${apiModel} (Claude) through Google Cloud projects/${gcp.projectId}/locations/${gcp.location}...`);
          const completionUrl = `https://${gcp.location}-aiplatform.googleapis.com/v1/projects/${gcp.projectId}/locations/${gcp.location}/publishers/anthropic/models/${apiModel}:rawPredict`;
          const anthropicMessages = [
            ...history.slice(-10).map((h: any) => ({
              role: h.role === 'user' ? 'user' : 'assistant',
              content: h.content
            })),
            { role: 'user', content: message }
          ];
          const res = await fetch(completionUrl, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${gcp.accessToken}`
            },
            body: JSON.stringify({
              anthropic_version: "vertex-2024-03-07",
              messages: anthropicMessages,
              system: systemPrompt,
              max_tokens: 4096,
              temperature: 0.4
            })
          });
          if (res.ok) {
            const data = await res.json();
            responseText = data.content?.[0]?.text || 'No response.';
          } else {
            throw new Error(`Vertex AI Claude API returned status ${res.status}: ${await res.text()}`);
          }
        }
      } else if (provider === 'anthropic' && anthropicKey) {
        const chatMessages = [
          ...history.slice(-10).map((h: any) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content })),
          { role: 'user', content: message }
        ];
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model: apiModel, max_tokens: 2048, system: systemPrompt, messages: chatMessages, temperature: 0.4 })
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.content?.[0]?.text || 'No response.';
        } else {
          throw new Error(`Anthropic API returned status ${res.status}: ${await res.text()}`);
        }
      } else if (geminiKey) {
        // Standard Gemini call
        const completionUrl = `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${geminiKey}`;
        const contents = [
          ...history.slice(-10).map((h: any) => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }]
          })),
          { role: 'user', parts: [{ text: message }] }
        ];
        const res = await fetch(completionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: contents,
            systemInstruction: { parts: [{ text: systemPrompt }] }
          })
        });
        if (res.ok) {
          const data = await res.json();
          responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
        } else {
          throw new Error(`Gemini API returned status ${res.status}: ${await res.text()}`);
        }
      }

      // P2: Deterministic Absence Validation
      if (intent.keywords && intent.keywords.length > 0) {
        const negativePhrases = ['no changes found', 'not found', 'does not exist', 'no changes', 'cannot find', 'no mention'];
        const isNegativeResponse = negativePhrases.some(p => responseText.toLowerCase().includes(p));
        
        if (isNegativeResponse) {
          // Check if any intent keywords actually exist in the retrieved chunks' raw text
          const allChunkText = retrievedChunks.map(c => c.content.toLowerCase()).join(' ');
          const missedKeywords = intent.keywords.filter(kw => allChunkText.includes(kw.toLowerCase()));
          
          if (missedKeywords.length > 0) {
             responseText += `\n\n> [!WARNING]\n> **Audit Flag**: The AI indicated no information was found, but the exact keywords (${missedKeywords.join(', ')}) **were** found in the retrieved catalog documents. Please verify manually.`;
          }
        }
      }

      const sourcesMap = new Map<string, string>();
      for (const chunk of retrievedChunks) {
        const title = chunk.section_header || 'Catalog Chapter';
        const content = chunk.content || '';
        if (sourcesMap.has(title)) {
          sourcesMap.set(title, sourcesMap.get(title) + '\n\n---\n\n' + content);
        } else {
          sourcesMap.set(title, content);
        }
      }
      const sourcesList = Array.from(sourcesMap.entries()).map(([title, content]) => ({
        title,
        content
      }));

      return NextResponse.json({
        response: responseText,
        sources: sourcesList,
        vectorSearch: retrievalMethod.includes('pgvector'),
        terminalLogs: [],
        systemPrompt: systemPrompt
      });
    }

    // ==========================================
    // MODE 2: GENERAL REASONING AGENT MODE (TOOL CALLING)
    // ==========================================
    else {
      // Setup the tool maps
      const toolMap: Record<string, Function> = {
        query_catalog_database: async (args: { sql: string }) => {
          if (!isReadOnlyQuery(args.sql)) {
            return JSON.stringify({ error: "Access Denied: Only read-only SELECT or WITH statements are allowed." });
          }
          try {
            const rows = await query(args.sql);
            return JSON.stringify(rows).substring(0, 15000);
          } catch (err: any) {
            return JSON.stringify({ error: `Database Error: ${err.message}` });
          }
        },
        get_course_blast_radius: async (args: { courseCode: string }) => {
          try {
            const blast = await getCourseBlastRadius(args.courseCode, catalogId);
            return JSON.stringify(blast);
          } catch (err: any) {
            return JSON.stringify({ error: `Blast Radius Error: ${err.message}` });
          }
        },
        get_prerequisite_tree: async (args: { courseCode: string }) => {
          try {
            const tree = await getPrerequisiteTree(args.courseCode, catalogId);
            return JSON.stringify(tree);
          } catch (err: any) {
            return JSON.stringify({ error: `Prerequisite Tree Error: ${err.message}` });
          }
        }
      };

      const systemPrompt = `You are the AI Catalog Assistant Agent for ${INSTITUTION.legalName} (Mode: General Reasoning).
IMPORTANT: You are assisting the user with Catalog Version ID: ${catalogId}.
When executing custom database queries, you MUST strictly filter by document_id = ${catalogId} and tenant_id = '${TENANT_ID}' to prevent bleeding across catalogs.

Core Available Tables:
- courses: Master course catalogs (id, course_code, title, credits, description, document_id)
- programs: Degree majors (id, name, degree_type, total_credits, document_id)
- semantic_chunks: Narrative catalog chapters and paragraphs (id, section_header, content, page_number, sequence_order, document_id)
- course_prerequisite_links: Course-to-course prereq connections (course_id, prereq_course_id, tenant_id)
- program_requirement_courses: Requirement links connecting courses to degree programs

Tools at your disposal:
1. query_catalog_database(sql): Execute a SELECT read-only SQL query against pg. Keep it extremely performant.
2. get_course_blast_radius(courseCode): Analyzes downstream ramifications (what courses require it, what programs depend on it).
3. get_prerequisite_tree(courseCode): Retrieves multi-hop recursive prerequisite tree.

Be proactive! Use SQL to discover information. If the user asks a complex prerequisite question, ALWAYS call get_prerequisite_tree first.
Translate JSON outputs into beautiful academic narratives.
IMPORTANT CITATION RULE: Whenever you reference a specific policy code or course identifier, format it precisely in square brackets like [FRONT_MATTER_POL_1] or [BIO-101] so the frontend can hook it.`;

      // Tools definition for Gemini
      const geminiTools = [
        {
          functionDeclarations: [
            {
              name: "query_catalog_database",
              description: "Execute a SELECT read-only SQL query against the catalog database to explore courses, programs, or policies. Always include 'document_id = <catalogId>' filter.",
              parameters: {
                type: "OBJECT",
                properties: {
                  sql: {
                    type: "STRING",
                    description: "The SELECT SQL query string to run."
                  }
                },
                required: ["sql"]
              }
            },
            {
              name: "get_course_blast_radius",
              description: "Calculates downstream dependencies for a course code (courses and programs that require it).",
              parameters: {
                type: "OBJECT",
                properties: {
                  courseCode: {
                    type: "STRING",
                    description: "The course identifier to audit (e.g. 'ACCT 210')."
                  }
                },
                required: ["courseCode"]
              }
            },
            {
              name: "get_prerequisite_tree",
              description: "Retrieves the full multi-hop recursive prerequisite tree for a course code.",
              parameters: {
                type: "OBJECT",
                properties: {
                  courseCode: {
                    type: "STRING",
                    description: "The course code to map (e.g. 'ACCT 211')."
                  }
                },
                required: ["courseCode"]
              }
            }
          ]
        }
      ];

      // Execute Agent Loop (up to 8 turns)
      let turn = 0;
      const maxTurns = 8;
      const agentConversation: any[] = [
        ...history.slice(-10).map((h: any) => ({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.content }]
        })),
        { role: 'user', parts: [{ text: message }] }
      ];

      let finalResponseText = '';

      while (turn < maxTurns) {
        turn++;
        
        const completionUrl = isVertex
          ? `https://${gcp.location}-aiplatform.googleapis.com/v1/projects/${gcp.projectId}/locations/${gcp.location}/publishers/google/models/${apiModel}:generateContent`
          : `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:generateContent?key=${geminiKey}`;
          
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (isVertex) {
          headers['Authorization'] = `Bearer ${gcp.accessToken}`;
        }
        
        const res = await fetch(completionUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            contents: agentConversation,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            tools: geminiTools
          })
        });

        if (!res.ok) {
          throw new Error(`Gemini Agent API returned status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json();
        const candidate = data.candidates?.[0];
        const content = candidate?.content;
        const parts = content?.parts || [];

        // Find function calls
        const functionCallPart = parts.find((p: any) => p.functionCall);

        if (functionCallPart) {
          const call = functionCallPart.functionCall;
          const funcName = call.name;
          const args = call.args || {};

          // Record execution log
          console.log(`[Oracle Agent Turn ${turn}] Calling tool ${funcName} with args:`, args);
          const toolStart = Date.now();

          let toolOutput = '';
          if (toolMap[funcName]) {
            toolOutput = await toolMap[funcName](args);
          } else {
            toolOutput = JSON.stringify({ error: `Tool ${funcName} not supported.` });
          }

          terminalLogs.push({
            query: `${funcName}(${JSON.stringify(args)})`,
            result: toolOutput.length > 200 ? toolOutput.substring(0, 200) + '...' : toolOutput,
            timestamp: new Date().toISOString()
          });

          // Add models function call turn
          agentConversation.push({
            role: 'model',
            parts: [functionCallPart]
          });

          // Add function response turn
          agentConversation.push({
            role: 'function',
            parts: [
              {
                functionResponse: {
                  name: funcName,
                  response: { output: toolOutput }
                }
              }
            ]
          });
        } else {
          // Final text response reached
          finalResponseText = parts.find((p: any) => p.text)?.text || 'No response generated.';
          break;
        }
      }

      if (turn >= maxTurns && !finalResponseText) {
        finalResponseText = "The General Reasoning Assistant reached the maximum turn limit while processing your multi-hop query. Try asking a slightly simpler sub-question.";
      }

      return NextResponse.json({
        response: finalResponseText,
        sources: ['Database Query Tool', 'Prerequisite CTE Engine', 'Impact Analysis Service'],
        vectorSearch: false,
        terminalLogs: terminalLogs
      });
    }

  } catch (e: any) {
    console.error("Assistant Gateway Error: ", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
