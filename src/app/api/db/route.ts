import { NextResponse } from 'next/server';
import { query, queryWithAuth } from '@/lib/db';
import { createClient } from '@/utils/supabase/server';

/**
 * Cleans the description text by removing header markdown artifacts.
 *
 * @param desc - The raw description string.
 * @returns The cleaned description.
 */
function cleanDescription(desc: string | null | undefined): string {
  if (!desc) return '';
  
  // Regex designed to target the '## [Header]' separator and extract the clean second segment (Capture Group 1)
  const regex = /(?:\r?\n|^)##\s+[^\r\n]+(?:\r?\n)([\s\S]*)$/;
  const match = desc.match(regex);
  if (match && match[1]) {
    return match[1].trim();
  }
  return desc.trim();
}

/**
 * Handles database operations requested by the frontend.
 * Supports varied actions like fetching graphs, catalogs, courses, and programs.
 *
 * @param req - The incoming POST request specifying an action and payload.
 * @returns A JSON response corresponding to the requested action.
 */
export async function POST(req: Request) {
  try {

    const body = await req.json();
    const { action, catalogId, targetId, ids } = body;

    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;

    // Enforce Tenant Scope Isolation
    const tenantId = 'CCSJ';

    // 2. Route Action to corresponding SQL Transaction
    switch (action) {
      case 'get_graph': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });
        
        // 1. Fetch all course nodes
        const courses = await query(
          `SELECT c.id, c.course_code, c.title, c.credits, c.description, c.prerequisites as prerequisites_raw, c.subject_id
           FROM courses c
           WHERE c.tenant_id = $1 AND c.document_id = $2;`,
          [tenantId, catalogId]
        );

        // 2. Fetch all course prerequisite links (scoped to current catalog)
        const prereqLinks = await query(
          `SELECT cpl.course_id as source, cpl.prereq_course_id as target 
           FROM course_prerequisite_links cpl
           JOIN courses c1 ON cpl.course_id = c1.id
           JOIN courses c2 ON cpl.prereq_course_id = c2.id
           WHERE cpl.tenant_id = $1 AND c1.document_id = $2 AND c2.document_id = $2;`,
          [tenantId, catalogId]
        );

        // 3. Fetch all program nodes
        const programs = await query(
          `SELECT id, name, degree_type, NULL as description, total_credits, department_id 
           FROM programs 
           WHERE tenant_id = $1 AND document_id = $2;`,
          [tenantId, catalogId]
        );

        // 4. Fetch all program course linkages (Program -> Course)
        const programRequirementLinks = await query(
          `SELECT pr.program_id as source, prc.course_id as target, prc.is_required
           FROM program_requirement_courses prc
           JOIN program_requirements pr ON prc.requirement_id = pr.id
           JOIN courses c ON prc.course_id = c.id
           WHERE prc.tenant_id = $1 AND pr.tenant_id = $1 AND c.document_id = $2;`,
          [tenantId, catalogId]
        );

        // 4.5 Fetch program requirements plain-text structures (logic_tree strings)
        const programRequirements = await query(
          `SELECT pr.id, pr.program_id, pr.degree_name, pr.logic_tree
           FROM program_requirements pr
           JOIN programs p ON pr.program_id = p.id
           WHERE p.tenant_id = $1 AND p.document_id = $2 AND pr.logic_tree IS NOT NULL;`,
          [tenantId, catalogId]
        );

        // 5. Fetch faculty, program-faculty mappings, and departments
        const facultyList = await query(
          `SELECT id, name FROM faculty WHERE tenant_id = $1;`,
          [tenantId]
        );
        const programFacultyLinks = await query(
          `SELECT pf.program_id, pf.faculty_id
           FROM program_faculty pf
           JOIN programs p ON pf.program_id = p.id
           WHERE pf.tenant_id = $1 AND p.document_id = $2;`,
          [tenantId, catalogId]
        );
        const departmentsList = await query(
          `SELECT id, name FROM departments WHERE tenant_id = $1;`,
          [tenantId]
        );

        // 6. Fetch pre-computed policy-course semantic mentions
        const policyCourseLinks = await query(
          `SELECT pmc.policy_chunk_id as source, pmc.course_id as target
           FROM policy_mentions_courses pmc
           JOIN semantic_chunks sc ON pmc.policy_chunk_id = sc.id
           JOIN courses c ON pmc.course_id = c.id
           WHERE pmc.tenant_id = $1 AND sc.document_id = $2 AND c.document_id = $2;`,
          [tenantId, catalogId]
        );

        // 7. Fetch pre-computed policy-program semantic mentions
        const policyProgramLinks = await query(
          `SELECT pmp.policy_chunk_id as source, pmp.program_id as target
           FROM policy_mentions_programs pmp
           JOIN semantic_chunks sc ON pmp.policy_chunk_id = sc.id
           JOIN programs p ON pmp.program_id = p.id
           WHERE pmp.tenant_id = $1 AND sc.document_id = $2 AND p.document_id = $2;`,
          [tenantId, catalogId]
        );

        // 8. Fetch all semantic chunks (Policies)
        const semanticChunks = await query(
          `SELECT sc.id, sc.section_header, sc.content, sc.page_number, sc.sequence_order,
                  NULL as quinean_weight, NULL as toulmin_role, NULL as deontic_modality,
                  ct.label as lookup_chunk_type, tr.label as lookup_toulmin_role, 
                  dm.label as lookup_deontic_modality, qw.label as lookup_quinean_class
           FROM semantic_chunks sc 
           LEFT JOIN chunk_types ct ON sc.chunk_type_id = ct.id 
           LEFT JOIN toulmin_roles tr ON sc.toulmin_role_id = tr.id 
           LEFT JOIN deontic_modalities dm ON sc.deontic_modality_id = dm.id 
           LEFT JOIN quinean_web_classifications qw ON sc.quinean_classification_id = qw.id
           WHERE sc.tenant_id = $1 AND sc.document_id = $2;`,
          [tenantId, catalogId]
        );

        // Compile Nodes and Links with color-group attributes
        const nodes: any[] = [];
        const links: any[] = [];

        // Track course maps for quick mentions lookup
        const courseCodeMap = new Map<string, string>(); // courseCode -> node_id
        const courseIdSet = new Set<string>();

        // A. Add Master Course Nodes
        courses.forEach((c: any) => {
          const nodeId = `course_${c.id}`;
          nodes.push({
            id: nodeId,
            label: c.course_code,
            title: c.title,
            description: cleanDescription(c.description),
            group: 'course',
            credits: c.credits,
            prerequisites_raw: c.prerequisites_raw
          });
          courseCodeMap.set(c.course_code.trim().toUpperCase(), nodeId);
          courseIdSet.add(c.id);
        });

        // B. Add Course Prerequisite Links (Reversed for logical progression flow: Prereq -> Subsequent Course)
        // Group links by course to detect bidirectional/mutual co-requisites
        const mutualSet = new Set<string>();
        const coursePrereqMap = new Map<string, Set<string>>();
        prereqLinks.forEach((l: any) => {
          if (!coursePrereqMap.has(l.source)) {
            coursePrereqMap.set(l.source, new Set());
          }
          coursePrereqMap.get(l.source)!.add(l.target);
        });

        const directPrereqLinks: any[] = [];
        const coReqLinks: any[] = [];

        prereqLinks.forEach((l: any) => {
          const hasMutual = coursePrereqMap.get(l.target)?.has(l.source);
          if (hasMutual) {
            const key = [l.source, l.target].sort().join('-');
            if (!mutualSet.has(key)) {
              mutualSet.add(key);
              // Co-requisite link (bi-directional relations merged into a single link)
              coReqLinks.push({
                source: `course_${l.target}`,
                target: `course_${l.source}`,
                type: 'COREQUISITE'
              });
            }
          } else {
            directPrereqLinks.push(l);
          }
        });

        // Build adjacency map for transitive reduction on direct prerequisites
        const adj = new Map<string, string[]>();
        directPrereqLinks.forEach((l: any) => {
          if (!adj.has(l.source)) adj.set(l.source, []);
          adj.get(l.source)!.push(l.target);
        });

        // Helper to check if target is reachable from start without using direct edge start -> target
        const hasLongerPrereqPath = (start: string, target: string): boolean => {
          const queue = [...(adj.get(start) || [])].filter(x => x !== target);
          const visited = new Set<string>(queue);

          while (queue.length > 0) {
            const curr = queue.shift()!;
            if (curr === target) return true;

            const neighbors = adj.get(curr) || [];
            for (const n of neighbors) {
              if (!visited.has(n)) {
                visited.add(n);
                queue.push(n);
              }
            }
          }
          return false;
        }

        // Apply transitive reduction
        const prunedPrereqLinks = directPrereqLinks.filter((l: any) => {
          return !hasLongerPrereqPath(l.source, l.target);
        });

        // Push pruned prerequisites
        prunedPrereqLinks.forEach((l: any) => {
          links.push({
            source: `course_${l.target}`,
            target: `course_${l.source}`,
            type: 'PREREQUISITE'
          });
        });

        // Push co-requisites
        coReqLinks.forEach((l: any) => {
          links.push(l);
        });

        // C. Build Faculty Nodes from Program Links
        const courseIdMap = new Map<string, any>();
        courses.forEach((c: any) => {
          courseIdMap.set(c.id, c);
        });

        const activeFacultyIds = new Set<string>();
        programFacultyLinks.forEach((pf: any) => {
          activeFacultyIds.add(pf.faculty_id);
        });

        // Determine Faculty Departments via Programs
        const facultyDepartmentMap = new Map<string, string>(); // faculty_id -> department_id
        programFacultyLinks.forEach((pf: any) => {
          const program = programs.find((p: any) => p.id === pf.program_id);
          if (program && program.department_id) {
            facultyDepartmentMap.set(pf.faculty_id, program.department_id);
          }
        });

        const activeFacultyList: any[] = [];
        facultyList.forEach((f: any) => {
          if (activeFacultyIds.has(f.id)) {
            nodes.push({
              id: `faculty_${f.id}`,
              label: f.name.length > 30 ? f.name.substring(0, 27) + '...' : f.name,
              title: f.name,
              description: `Faculty member: ${f.name}`,
              group: 'faculty'
            });
            activeFacultyList.push(f);
          }
        });

        // Fetch all semantic chunks once for in-memory page scoping lookup
        const allChunks = await query(
          `SELECT page_number, content 
           FROM semantic_chunks 
           WHERE tenant_id = $1 AND document_id = $2 
           ORDER BY page_number ASC;`,
          [tenantId, catalogId]
        );

        programs.forEach((p: any) => {
          p.cleanName = (p.name || '').split('\n')[0].replace(/(?:The following|courses are required|are required|required|hours|credit|semester)[\s\S]*/i, '').trim();
          p.pageNum = 999;
          for (const c of allChunks) {
            if (c.content.includes(p.cleanName) || c.content.includes(p.name)) {
              if (c.page_number < p.pageNum) p.pageNum = c.page_number;
            }
          }
        });

        const validatedPrograms: any[] = [];
        const departmentPrograms: any[] = [];

        programs.forEach((p: any) => {
          const pName = p.cleanName;
          let degreeType = p.degree_type;
          
          if (!degreeType && pName) {
            const degreeMatch = pName.match(/\b(B\.A\.|B\.S\.|A\.S\.|A\.A\.|M\.S\.|M\.A\.|M\.B\.A\.|M\.S\.M\.|M\.S\.A\.|M\.A\.T|A\.A\.S\.|Associate\b|Minor\b|Concentration\b|Certificate\b|Major\b|Degree\b|Master\b)/i);
            if (degreeMatch) {
              degreeType = degreeMatch[1];
            }
          }

          const isDegreeTitle = /\b(B\.A\.|B\.S\.|A\.S\.|A\.A\.|M\.S\.|M\.A\.|M\.B\.A\.|M\.S\.M\.|M\.S\.A\.|M\.A\.T|A\.A\.S\.|Associate\b|Minor\b|Concentration\b|Certificate\b|Major\b|Degree\b|Master\b)/i.test(pName);
          const justDegreeNameClean = pName.replace(/[^\w\s]/g, '').trim();
          const degreeAbbreviations = ['BA', 'BS', 'AS', 'AA', 'MS', 'MA', 'MBA', 'MSM', 'MSA', 'MAT', 'MINOR', 'CONCENTRATION', 'CERTIFICATE', 'MAJOR', 'DEGREE', 'MASTER'];
          const isSpandrel = degreeAbbreviations.includes(justDegreeNameClean.toUpperCase());

          if (degreeType && isDegreeTitle && !isSpandrel) {
            p.degree_type = degreeType;
            validatedPrograms.push(p);
          } else {
            const lowerName = pName.toLowerCase();
            if (
              !/^\d+\./.test(pName) &&
              !lowerName.includes('faculty') &&
              !lowerName.includes('chairperson') &&
              !lowerName.includes('director') &&
              !lowerName.includes('mission statement') &&
              !lowerName.includes('vision statement') &&
              !lowerName.includes('admission into') &&
              !lowerName.includes('assessments') &&
              !lowerName.includes('continuation') &&
              !lowerName.includes('delivery systems') &&
              !lowerName.includes('dispositions') &&
              !lowerName.includes('outcomes') &&
              !lowerName.includes('eligibility') &&
              !lowerName.includes('enrollment') &&
              !lowerName.includes('licensing') &&
              !lowerName.includes('licensure') &&
              !lowerName.includes('program curriculum') &&
              !lowerName.includes('school of') &&
              !lowerName.includes('second degrees') &&
              !lowerName.includes('academic programs') &&
              !lowerName.includes('laboratory operations') &&
              !isSpandrel && pName.length > 3
            ) {
              departmentPrograms.push(p);
            }
          }
        });

        // D. Add AST Department Nodes and establish supervision mapping
        departmentPrograms.sort((a, b) => a.pageNum - b.pageNum);
        const programToAstDeptMap = new Map<string, string>(); // valid_program_id -> ast_dept_id

        departmentPrograms.forEach((dept: any) => {
          nodes.push({
            id: `department_${dept.id}`,
            label: dept.cleanName.length > 30 ? dept.cleanName.substring(0, 27) + '...' : dept.cleanName,
            title: dept.cleanName,
            description: `Department: ${dept.cleanName}`,
            group: 'department'
          });

          // 1. Substring Matching
          validatedPrograms.forEach((vp: any) => {
            if (
              vp.cleanName.includes(dept.cleanName) || 
              dept.cleanName.includes(vp.cleanName.replace(/\b(B\.A\.|B\.S\.|A\.S\.|A\.A\.|M\.S\.|M\.A\.|Minor|Concentration)\b/ig, '').trim())
            ) {
              if (!programToAstDeptMap.has(vp.id)) {
                programToAstDeptMap.set(vp.id, dept.id);
              }
            }
          });
        });

        // 2. Proximity Matching for Orphans
        validatedPrograms.forEach((vp: any) => {
          if (!programToAstDeptMap.has(vp.id)) {
            // Guard: Do not apply proximity matching to Master's programs as they are globally scoped 
            // and often get falsely tethered to undergraduate departments (e.g. Accounting) by the TOC page numbers.
            const isGraduateProgram = /^(Master|M\.|M\s)/i.test(vp.cleanName) || /^(Master|M\.|M\s)/i.test(vp.degree_type || '');
            
            if (!isGraduateProgram) {
              let bestDept: any = null;
              let minDiff = 9999;
              departmentPrograms.forEach((dept: any) => {
                const diff = vp.pageNum - dept.pageNum;
                if (diff >= 0 && diff < minDiff) {
                  minDiff = diff;
                  bestDept = dept;
                }
              });
              if (bestDept) {
                programToAstDeptMap.set(vp.id, bestDept.id);
              }
            }
          }
        });

        // Add legacy DB departments if they don't duplicate an AST department
        const activeLegacyDepartmentIds = new Set<string>();
        validatedPrograms.forEach((p: any) => {
          if (p.department_id) activeLegacyDepartmentIds.add(p.department_id);
        });

        departmentsList.forEach((d: any) => {
          if (activeLegacyDepartmentIds.has(d.id)) {
            const duplicate = departmentPrograms.find((dp: any) => dp.cleanName.toLowerCase() === d.name.toLowerCase());
            if (!duplicate) {
              nodes.push({
                id: `department_${d.id}`,
                label: d.name.length > 30 ? d.name.substring(0, 27) + '...' : d.name,
                title: d.name,
                description: `Department: ${d.name}`,
                group: 'department'
              });
            }
          }
        });

        const programIdSet = new Set<string>();
        const belongsToLinksSet = new Set<string>(); // subject_id:program_id

        const courseRegex = /\b([A-Z]{2,4})\s*[-]?\s*(\d{3})\b/g;

        validatedPrograms.forEach((p: any) => {
          const nodeId = `program_${p.id}`;
          nodes.push({
            id: nodeId,
            label: p.degree_type ? `${p.degree_type} - ${p.name}` : p.name,
            title: p.name,
            description: p.description || `Curriculum map for ${p.name}.`,
            group: 'program',
            degree_type: p.degree_type,
            total_credits: p.total_credits
          });
          programIdSet.add(p.id);

          // Link Department to Program
          const astDeptId = programToAstDeptMap.get(p.id);
          if (astDeptId) {
            links.push({
              source: `department_${astDeptId}`,
              target: `program_${p.id}`,
              type: 'SUPERVISES'
            });
          } else if (p.department_id) {
            links.push({
              source: `department_${p.department_id}`,
              target: `program_${p.id}`,
              type: 'SUPERVISES'
            });
          }
          
          // Faculty links are now handled in a separate pass below


          // 2. Parse Requirement Blocks dynamically via in-memory page-scoping
          const pReqs = programRequirements.filter((r: any) => r.program_id === p.id);

          let pathSegment = p.name;
          if (pReqs.length > 0 && pReqs[0].logic_tree) {
            const firstLine = pReqs[0].logic_tree.split('\n')[0];
            const match = firstLine.match(/\[Header 1: [^>]+ > (Header 2: [^\]>]+|Header 3: [^\]>]+)/);
            if (match) {
              pathSegment = match[1].trim();
            }
          }

          const matchedPages = new Set<number>();
          allChunks.forEach((c: any) => {
            if (c.content.includes(pathSegment) || c.content.includes(p.name)) {
              matchedPages.add(c.page_number);
            }
          });

          let matchedChunks: any[] = [];
          if (matchedPages.size > 0) {
            matchedChunks = allChunks.filter((c: any) => {
              return Array.from(matchedPages).some(pNum => c.page_number === pNum || c.page_number === pNum + 1);
            });
          }

          const sourcesToProcess: { id: string; content: string }[] = [];
          if (matchedChunks.length > 0) {
            matchedChunks.forEach((c: any, idx: number) => {
              sourcesToProcess.push({ id: `chunk_${c.page_number}_${idx}`, content: c.content });
            });
          } else {
            pReqs.forEach((r: any, idx: number) => {
              sourcesToProcess.push({ id: `req_${r.id.substring(0, 4)}_${idx}`, content: r.logic_tree });
            });
          }

          let blockIdx = 0;
          sourcesToProcess.forEach((src: any) => {
            let cleanText = src.content;
            cleanText = cleanText.replace(/^\[Header\s+\d+[\s\S]*?\](?:\r?\n|$)/i, '').trim();
            const sections = cleanText.split(/(?=\n##\s+|\n###\s+|\n\*\*)/);

            sections.forEach((sec: string, secIdx: number) => {
              const lines = sec.split('\n');
              const headerLine = lines[0] || '';
              let title = headerLine.replace(/^#+\s*/, '').replace(/^\*+\s*/, '').replace(/\*+$/, '').trim();
              if (!title || title.length < 3) {
                title = `Requirement Block ${blockIdx + 1}`;
              }

              if (
                title.toLowerCase().includes('faculty') || 
                title.toLowerCase().includes('mission statement') ||
                title.toLowerCase().includes('vision statement')
              ) {
                return;
              }

              const coursesList: string[] = [];
              let match;
              courseRegex.lastIndex = 0;
              while ((match = courseRegex.exec(sec)) !== null) {
                const prefix = match[1].toUpperCase();
                const num = match[2];
                const cleanCode = `${prefix} ${num}`;
                if (courseCodeMap.has(cleanCode)) {
                  if (!coursesList.includes(cleanCode)) {
                    coursesList.push(cleanCode);
                  }
                }
              }

              if (coursesList.length > 0) {
                blockIdx++;
                const blockNodeId = `block_${p.id}_${blockIdx}`;

                let requiredValue = 0;
                let logicType = 'ALL_OF';
                const hoursMatch = sec.match(/(\d+)\s*(hour|credit|sem)/i);
                if (hoursMatch) {
                  requiredValue = parseInt(hoursMatch[1], 10);
                  logicType = 'CREDITS_FROM';
                }
                if (sec.toLowerCase().includes('elective') || sec.toLowerCase().includes('choose')) {
                  logicType = 'CHOOSE_N';
                  if (requiredValue === 0) requiredValue = 3;
                }
                if (sec.toLowerCase().includes('optional')) {
                  logicType = 'OPTIONAL';
                }

                // Add Block Node (Orange)
                nodes.push({
                  id: blockNodeId,
                  label: title.substring(0, 25) + (title.length > 25 ? '...' : ''),
                  title: title,
                  description: sec.trim(),
                  group: 'block',
                  logic_type: logicType,
                  required_value: requiredValue
                });

                // Program ➔ Block link
                links.push({
                  source: `program_${p.id}`,
                  target: blockNodeId,
                  type: 'GOVERNS',
                  is_required: logicType !== 'OPTIONAL'
                });

                // Block ➔ Course links
                coursesList.forEach((cCode: string) => {
                  const courseNodeId = courseCodeMap.get(cCode)!;
                  links.push({
                    source: blockNodeId,
                    target: courseNodeId,
                    type: 'BELONGS_TO',
                    is_required: logicType === 'ALL_OF'
                  });
                });
              }
            });
          });
        });

        // 3. Independent Faculty Linking Pass
        // Iterate over all program_faculty links to prevent any orphaned faculty, and STRICTLY map them to Departments.
        programFacultyLinks.forEach((pf: any) => {
          // Find if the linked program is a validated degree program
          const isValidated = validatedPrograms.some((vp: any) => vp.id === pf.program_id);
          let targetDeptId = null;

          if (isValidated) {
            // Travese UP to find the supervising AST Department
            targetDeptId = programToAstDeptMap.get(pf.program_id);
            if (!targetDeptId) {
              // Fallback to legacy department if AST Department mapping failed
              const vProg = validatedPrograms.find((vp: any) => vp.id === pf.program_id);
              if (vProg && vProg.department_id) {
                targetDeptId = vProg.department_id;
              }
            }
          } else {
            // The linked program might ALREADY be an AST Department (e.g. "Education: Elementary")
            const isDept = departmentPrograms.some((dp: any) => dp.id === pf.program_id);
            if (isDept) {
              targetDeptId = pf.program_id;
            }
          }

          // Strictly enforce: Faculty only connect to Departments!
          if (targetDeptId) {
            const belongsKey = `${pf.faculty_id}:${targetDeptId}`;
            if (!belongsToLinksSet.has(belongsKey)) {
              links.push({
                source: `faculty_${pf.faculty_id}`,
                target: `department_${targetDeptId}`,
                type: 'BELONGS_TO'
              });
              belongsToLinksSet.add(belongsKey);
            }
          }
        });

        // E. Add Policy Nodes (Policies)
        semanticChunks.forEach((sc: any) => {
          const nodeId = `policy_${sc.id}`;
          const chunkLabel = `Chunk ${sc.sequence_order}`;
          const chunkTitle = sc.section_header && sc.section_header !== 'None'
            ? `Section: ${sc.section_header}`
            : `Narrative Chunk ${sc.sequence_order}`;

          nodes.push({
            id: nodeId,
            label: chunkLabel,
            title: chunkTitle,
            description: sc.content,
            group: 'policy',
            page_number: sc.page_number,
            sequence_order: sc.sequence_order,
            toulmin_role: sc.lookup_toulmin_role || sc.toulmin_role,
            deontic_modality: sc.lookup_deontic_modality || sc.deontic_modality,
            quinean_class: sc.lookup_quinean_class || sc.quinean_weight
          });
        });

        // F. Add Pre-computed Policy Course Mentions Links (Policy -> Course)
        policyCourseLinks.forEach((l: any) => {
          links.push({
            source: `policy_${l.source}`,
            target: `course_${l.target}`,
            type: 'MENTIONS',
            mention_type: 'course'
          });
        });

        // G. Add Pre-computed Policy Program Mentions Links (Policy -> Program)
        policyProgramLinks.forEach((l: any) => {
          links.push({
            source: `policy_${l.source}`,
            target: `program_${l.target}`,
            type: 'MENTIONS',
            mention_type: 'program'
          });
        });

        return NextResponse.json({ nodes, links });
      }

      case 'get_catalogs': {
        console.log("src/app/api/db/route.ts: Running 'get_catalogs' query on documents table...");
        try {
          const res = await query(
            "SELECT id, version, domain_id, created_at, catalog_pdf_url FROM documents ORDER BY created_at DESC;"
          );
          console.log(`src/app/api/db/route.ts: Successfully fetched ${res.length} catalog versions from DB:`, res);
          return NextResponse.json(res);
        } catch (dbErr: any) {
          console.error("src/app/api/db/route.ts: Database query 'get_catalogs' failed:", dbErr);
          throw dbErr;
        }
      }

      case 'delete_catalog': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });
        console.log(`src/app/api/db/route.ts: Deleting catalog with ID ${catalogId}`);
        try {
          const catRes = await query("SELECT version, domain_id FROM documents WHERE id = $1", [catalogId]);
          if (catRes.length === 0) return NextResponse.json({ error: "Catalog not found." }, { status: 404 });
          
          const combinedName = (catRes[0].version + (catRes[0].domain_id || '')).toLowerCase();
          if (!combinedName.includes('draft')) {
             return NextResponse.json({ error: "Only Draft catalogs can be deleted." }, { status: 403 });
          }

          // Manual Cascade Deletion to bypass missing ON DELETE CASCADE constraints in the DB schema
          console.log(`src/app/api/db/route.ts: Clearing cascade dependencies for catalog ${catalogId}...`);

          const deleteQueries = [
            { name: 'policy_mentions_courses', q: `DELETE FROM policy_mentions_courses WHERE course_id IN (SELECT id FROM courses WHERE document_id = $1) OR policy_chunk_id IN (SELECT id FROM semantic_chunks WHERE document_id = $1);` },
            { name: 'policy_mentions_programs', q: `DELETE FROM policy_mentions_programs WHERE program_id IN (SELECT id FROM programs WHERE document_id = $1) OR policy_chunk_id IN (SELECT id FROM semantic_chunks WHERE document_id = $1);` },
            { name: 'course_prerequisite_links', q: `DELETE FROM course_prerequisite_links WHERE course_id IN (SELECT id FROM courses WHERE document_id = $1) OR prereq_course_id IN (SELECT id FROM courses WHERE document_id = $1);` },
            { name: 'program_requirement_courses', q: `DELETE FROM program_requirement_courses WHERE course_id IN (SELECT id FROM courses WHERE document_id = $1) OR requirement_id IN (SELECT id FROM program_requirements WHERE program_id IN (SELECT id FROM programs WHERE document_id = $1));` },
            { name: 'program_requirements', q: `DELETE FROM program_requirements WHERE program_id IN (SELECT id FROM programs WHERE document_id = $1);` },
            { name: 'program_faculty', q: `DELETE FROM program_faculty WHERE program_id IN (SELECT id FROM programs WHERE document_id = $1);` },
            { name: 'corrections', q: `DELETE FROM corrections WHERE (target_table = 'courses' AND target_row_id::uuid IN (SELECT id FROM courses WHERE document_id = $1)) OR (target_table = 'programs' AND target_row_id::uuid IN (SELECT id FROM programs WHERE document_id = $1));` },
            { name: 'improvement_plans', q: `DELETE FROM improvement_plans WHERE catalog_id = $1;` },
            { name: 'semantic_chunks', q: `DELETE FROM semantic_chunks WHERE document_id = $1;` },
            { name: 'courses', q: `DELETE FROM courses WHERE document_id = $1;` },
            { name: 'programs', q: `DELETE FROM programs WHERE document_id = $1;` }
          ];

          for (const dq of deleteQueries) {
            try {
              await query(dq.q, [catalogId]);
            } catch (err: any) {
              console.error(`Error deleting ${dq.name}:`, err.message);
              throw new Error(`[${dq.name}] ` + err.message);
            }
          }
          
          await query("DELETE FROM documents WHERE id = $1;", [catalogId]);
          
          return NextResponse.json({ success: true, message: "Catalog and all its references deleted successfully." });
        } catch (dbErr: any) {
          console.error("src/app/api/db/route.ts: Database query 'delete_catalog' failed:", dbErr);
          return NextResponse.json({ error: `Failed to delete catalog. Error details: ${dbErr.message || dbErr}` }, { status: 500 });
        }
      }

      case 'publish_catalog': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });
        try {
          // Remove the " (Draft)" substring from the version string
          await query("UPDATE documents SET version = REPLACE(version, ' (Draft)', '') WHERE id = $1;", [catalogId]);
          return NextResponse.json({ success: true, message: "Catalog published successfully." });
        } catch (dbErr: any) {
          console.error("src/app/api/db/route.ts: Database query 'publish_catalog' failed:", dbErr);
          return NextResponse.json({ error: `Failed to publish catalog. Error details: ${dbErr.message || dbErr}` }, { status: 500 });
        }
      }

      case 'fix_stuck_state': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required to reset stuck state." }, { status: 400 });
        try {
          // Strip the "(Draft)" tag for THIS catalog only so the UI resets.
          // Scoped by id — must never touch other documents' draft state.
          await query("UPDATE documents SET version = REPLACE(version, ' (Draft)', '') WHERE id = $1 AND version LIKE '%(Draft)%';", [catalogId]);
          
          // Apply missing RLS policies for the subjects table so that future draft clonings won't fail
          try {
            console.log("Applying missing RLS policy for subjects table...");
            await query(`
              ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
              DROP POLICY IF EXISTS "Public Read Access" ON subjects;
              DROP POLICY IF EXISTS "Write Access" ON subjects;
              CREATE POLICY "Public Read Access" ON subjects FOR SELECT USING (auth.uid() IS NOT NULL);
              CREATE POLICY "Write Access" ON subjects FOR ALL USING (
                auth.uid() IN (SELECT user_id FROM user_roles WHERE role IN ('registrar', 'owner'))
              );
            `);
          } catch(e) {
            console.error("Failed to apply subjects RLS:", e);
          }

          return NextResponse.json({ success: true, message: "Stuck state cleared successfully." });
        } catch (dbErr: any) {
          console.error("src/app/api/db/route.ts: Database query 'fix_stuck_state' failed:", dbErr);
          return NextResponse.json({ error: `Failed to fix stuck state. Error details: ${dbErr.message || dbErr}` }, { status: 500 });
        }
      }

      case 'get_courses': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });
        // Fetch courses joined with department subject prefix details
        const res = await query(
          `SELECT c.id, c.course_code, c.title, c.credits, c.description, c.prerequisites, c.section, 
                  s.prefix as subject_prefix, s.department_name 
           FROM courses c 
           LEFT JOIN subjects s ON c.subject_id = s.id 
           WHERE c.tenant_id = $1 AND c.document_id = $2 
           ORDER BY c.course_code;`,
          [tenantId, catalogId]
        );
        const cleanedRes = res.map((course: any) => ({
          ...course,
          description: cleanDescription(course.description)
        }));
        return NextResponse.json(cleanedRes);
      }

      case 'get_programs': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });
        
        // 1. Fetch academic programs joined with degree classifications
        let programsRes;
        try {
          programsRes = await query(
            `SELECT p.id, p.name, p.degree_type, NULL as description, p.total_credits, 
                    p.department_chairperson, p.program_director, p.mission_statement, 
                    p.program_outcome_objectives, p.additional_details,
                    p.markdown_url,
                    dc.label as degree_class_label, dc.education_level 
             FROM programs p 
             LEFT JOIN degree_classifications dc ON p.degree_classification_id = dc.id 
             WHERE p.tenant_id = $1 AND p.document_id = $2 
             ORDER BY p.name;`,
            [tenantId, catalogId]
          );
        } catch (dbErr: any) {
          console.warn("src/app/api/db/route.ts: p.markdown_url column does not exist yet. Falling back.", dbErr.message);
          programsRes = await query(
            `SELECT p.id, p.name, p.degree_type, NULL as description, p.total_credits, 
                    p.department_chairperson, p.program_director, p.mission_statement, 
                    p.program_outcome_objectives, p.additional_details,
                    NULL as markdown_url,
                    dc.label as degree_class_label, dc.education_level 
             FROM programs p 
             LEFT JOIN degree_classifications dc ON p.degree_classification_id = dc.id 
             WHERE p.tenant_id = $1 AND p.document_id = $2 
             ORDER BY p.name;`,
            [tenantId, catalogId]
          );
        }

        // 2. Fetch active courses for this catalog to validate course presence in blocks
        const activeCourses = await query(
          `SELECT course_code FROM courses WHERE tenant_id = $1 AND document_id = $2;`,
          [tenantId, catalogId]
        );
        const activeCourseCodes = new Set(activeCourses.map((c: any) => c.course_code.toUpperCase().trim()));

        // 3. Fetch program requirements plain-text structures (logic_tree strings)
        const programRequirements = await query(
          `SELECT pr.id, pr.program_id, pr.degree_name, pr.logic_tree
           FROM program_requirements pr
           WHERE pr.tenant_id = $1 AND pr.logic_tree IS NOT NULL;`,
          [tenantId]
        );

        // 4. Fetch all semantic chunks for this catalog to query page contents
        const chunks = await query(
          `SELECT page_number, content 
           FROM semantic_chunks 
           WHERE tenant_id = $1 AND document_id = $2 
           ORDER BY page_number ASC;`,
          [tenantId, catalogId]
        );

        const courseRegex = /\b([A-Z]{2,4})\s*[-]?\s*(\d{3})\b/g;

        // 5. In-memory validation of degree programs
        const filteredPrograms = programsRes.filter((program: any) => {
          const pName = (program.name || '').trim();

          // A. Dynamically extract degree type from title if it is null/empty in database using corrected boundary regex
          let degreeType = program.degree_type;
          if (!degreeType && pName) {
            const degreeMatch = pName.match(/\b(B\.A\.|B\.S\.|A\.S\.|A\.A\.|M\.S\.|M\.A\.|M\.B\.A\.|M\.S\.M\.|M\.S\.A\.|M\.A\.T\b|Minor\b|Concentration\b|Certificate\b|Major\b|Degree\b|Master\b)/i);
            if (degreeMatch) {
              degreeType = degreeMatch[1];
            }
          }

          // Enforce that a genuine validated program should have a degree type
          if (!degreeType) {
            return false;
          }

          // Exclude any layouts starting with digits (e.g. "3. 0 hours:") or containing "faculty"
          if (
            /^\d+\./.test(pName) || 
            pName.toLowerCase().includes('faculty') ||
            pName.toLowerCase().includes('chairperson') ||
            pName.toLowerCase().includes('director')
          ) {
            return false;
          }

          // Strictly enforce that the name represents a genuine degree classification title
          const isDegreeTitle = /\b(B\.A\.|B\.S\.|A\.S\.|A\.A\.|M\.S\.|M\.A\.|M\.B\.A\.|M\.S\.M\.|M\.S\.A\.|M\.A\.T\b|Minor\b|Concentration\b|Certificate\b|Major\b|Degree\b|Master\b)/i.test(pName);
          if (!isDegreeTitle) {
            return false;
          }

          // Exclude spandrels that are literally just a degree type abbreviation with no major name
          const cleanPNameFirstLine = pName.split('\n')[0].replace(/(?:The following|courses are required|are required|required|hours|credit|semester)[\s\S]*/i, '').trim();
          const justDegreeNameClean = cleanPNameFirstLine.replace(/[^\w\s]/g, '').trim();
          const degreeAbbreviations = ['BA', 'BS', 'AS', 'AA', 'MS', 'MA', 'MBA', 'MSM', 'MSA', 'MAT', 'MINOR', 'CONCENTRATION', 'CERTIFICATE', 'MAJOR', 'DEGREE', 'MASTER'];
          if (degreeAbbreviations.includes(justDegreeNameClean.toUpperCase())) {
            return false;
          }

          // B. Get all requirements for this program
          const programReqs = programRequirements.filter((r: any) => r.program_id === program.id);

          // C. Match page segment path
          let pathSegment = program.name;
          if (programReqs.length > 0 && programReqs[0].logic_tree) {
            const firstLine = programReqs[0].logic_tree.split('\n')[0];
            const match = firstLine.match(/\[Header 1: [^>]+ > (Header 2: [^\]>]+|Header 3: [^\]>]+)/);
            if (match) {
              pathSegment = match[1].trim();
            }
          }

          // D. Page-scoping chunk lookup: find pages containing program name or segment path
          const matchedPages = new Set<number>();
          chunks.forEach((c: any) => {
            if (c.content.includes(pathSegment) || c.content.includes(program.name)) {
              matchedPages.add(c.page_number);
            }
          });

          let firstPageNumber = null;
          if (matchedPages.size > 0) {
            firstPageNumber = Math.min(...Array.from(matchedPages));
          }
          program.page_number = firstPageNumber;

          let matchedChunks: any[] = [];
          if (matchedPages.size > 0) {
            // Grab all chunks on matched pages (and the next page for contiguous content flow)
            matchedChunks = chunks.filter((c: any) => {
              return Array.from(matchedPages).some(pNum => c.page_number === pNum || c.page_number === pNum + 1);
            });
          }

          // E. Establish sources to process
          const sourcesToProcess: { id: string; content: string }[] = [];
          if (matchedChunks.length > 0) {
            matchedChunks.forEach((c: any, idx: number) => {
              sourcesToProcess.push({
                id: `chunk_${c.page_number}_${idx}`,
                content: c.content
              });
            });
          } else {
            programReqs.forEach((r: any, idx: number) => {
              sourcesToProcess.push({
                id: `req_${r.id.substring(0, 4)}_${idx}`,
                content: r.logic_tree
              });
            });
          }

          // F. Parse and validate blocks
          let validBlocksCount = 0;
          sourcesToProcess.forEach((src: any) => {
            let cleanText = src.content;
            cleanText = cleanText.replace(/^\[Header\s+\d+[\s\S]*?\](?:\r?\n|$)/i, '').trim();
            const sections = cleanText.split(/(?=\n##\s+|\n###\s+|\n\*\*)/);

            sections.forEach((sec: string) => {
              const lines = sec.split('\n');
              const headerLine = lines[0] || '';
              const title = headerLine.replace(/^#+\s*/, '').replace(/^\*+\s*/, '').replace(/\*+$/, '').trim();

              if (
                !title || title.length < 3 ||
                title.toLowerCase().includes('faculty') || 
                title.toLowerCase().includes('mission statement') ||
                title.toLowerCase().includes('vision statement')
              ) {
                return;
              }

              // Extract and validate courses
              const coursesList: string[] = [];
              let match;
              courseRegex.lastIndex = 0;
              while ((match = courseRegex.exec(sec)) !== null) {
                const prefix = match[1].toUpperCase();
                const num = match[2];
                const cleanCode = `${prefix} ${num}`;
                if (activeCourseCodes.has(cleanCode)) {
                  if (!coursesList.includes(cleanCode)) {
                    coursesList.push(cleanCode);
                  }
                }
              }

              // Strict block validation: block must contain specific valid courses!
              if (coursesList.length > 0) {
                validBlocksCount++;
              }
            });
          });

          // Strict program validation: Program must contain at least one valid block with courses!
          if (validBlocksCount > 0) {
            // Attach the extracted degree type and prefixes (empty array is fine, we don't use prefixes)
            program.degree_type = degreeType;
            program.prefixes = [];
            return true;
          }

          return false;
        });

        // Clean names for pristine UX dropdown display (strip newlines and trailing boilerplate text) and sanitize front matter
        const cleanedPrograms = filteredPrograms.map((p: any) => {
          let cleanMission = p.mission_statement;
          if (cleanMission && cleanMission.trim().startsWith('[Header')) {
            cleanMission = null;
          }
          
          let cleanDetails = p.additional_details;
          if (cleanDetails) {
            if (typeof cleanDetails === 'object') {
              if (Object.keys(cleanDetails).length === 0) {
                cleanDetails = null;
              } else {
                cleanDetails = JSON.stringify(cleanDetails, null, 2);
              }
            } else if (String(cleanDetails) === '[object Object]') {
              cleanDetails = null;
            }
          }

          let cleanOutcomes = p.program_outcome_objectives;
          if (cleanOutcomes && cleanOutcomes.trim().startsWith('[Header')) {
            cleanOutcomes = null;
          }

          return {
            ...p,
            name: p.name.split('\n')[0].replace(/(?:The following|courses are required|are required|required|hours|credit|semester)[\s\S]*/i, '').trim(),
            mission_statement: cleanMission,
            program_outcome_objectives: cleanOutcomes,
            additional_details: cleanDetails
          };
        });

        return NextResponse.json(cleanedPrograms);
      }

      case 'get_program_details': {
        if (!targetId) return NextResponse.json({ error: "Program ID required." }, { status: 400 });
        
        // 1. Fetch affiliated faculty
        const facultyList = await query(
          `SELECT f.id, f.name 
           FROM program_faculty pf 
           JOIN faculty f ON pf.faculty_id = f.id 
           WHERE pf.tenant_id = $1 AND pf.program_id = $2 
           ORDER BY f.name;`,
          [tenantId, targetId]
        );

        // 2. Fetch program requirements (logic tree) from DB
        const requirements = await query(
          `SELECT pr.id, pr.degree_name, pr.logic_tree 
           FROM program_requirements pr 
           WHERE pr.tenant_id = $1 AND pr.program_id = $2;`,
          [tenantId, targetId]
        );

        // 3. Fetch linked courses for requirements if any exist in the database
        let reqCourses: any[] = [];
        if (requirements.length > 0) {
          const reqIds = requirements.map(r => r.id);
          reqCourses = await query(
            `SELECT prc.requirement_id, prc.group_name, prc.or_group_id, prc.is_required,
                    c.id as course_id, c.course_code, c.title, c.credits 
             FROM program_requirement_courses prc 
             JOIN courses c ON prc.course_id = c.id 
             WHERE prc.tenant_id = $1 AND prc.requirement_id = ANY($2);`,
            [tenantId, reqIds]
          );
        }

        // DYNAMIC AST HARVESTING FALLBACK:
        // If the database has no compiled requirement courses (empty list), we dynamically compile the AST
        // requirements using our high-fidelity page-scoping parser, bridging the AST into the inspector tabs!
        if (reqCourses.length === 0) {
          console.log(`[Program Details Fallback] No DB relational links for program ${targetId}. Running dynamic AST parser...`);
          
          // A. Fetch program metadata
          const progRes = await query(
            `SELECT document_id, name FROM programs WHERE tenant_id = $1 AND id = $2;`,
            [tenantId, targetId]
          );
          
          if (progRes.length > 0) {
            const program = progRes[0];
            
            // B. Load active courses for catalog to fetch accurate course details
            const activeCourses = await query(
              `SELECT id, course_code, title, credits, description 
               FROM courses 
               WHERE tenant_id = $1 AND document_id = $2;`,
              [tenantId, program.document_id]
            );
            
            const courseDetailsMap = new Map<string, any>();
            activeCourses.forEach((c: any) => {
              const codeUpper = c.course_code.toUpperCase().trim();
              courseDetailsMap.set(codeUpper, {
                id: c.id,
                title: c.title,
                credits: c.credits,
                description: cleanDescription(c.description)
              });
            });

            // C. Find page numbers containing pathSegment
            let pathSegment = program.name;
            const reqsWithTree = requirements.filter(r => r.logic_tree !== null);
            if (reqsWithTree.length > 0 && reqsWithTree[0].logic_tree) {
              const firstLine = reqsWithTree[0].logic_tree.split('\n')[0];
              const match = firstLine.match(/\[Header 1: [^>]+ > (Header 2: [^\]>]+|Header 3: [^\]>]+)/);
              if (match) {
                pathSegment = match[1].trim();
              }
            }

            let matchedPagesRes = await query(
              `SELECT DISTINCT page_number 
               FROM semantic_chunks 
               WHERE tenant_id = $1 AND document_id = $2 AND content LIKE $3;`,
              [tenantId, program.document_id, `%${pathSegment}%`]
            );

            if (matchedPagesRes.length === 0) {
              matchedPagesRes = await query(
                `SELECT DISTINCT page_number 
                 FROM semantic_chunks 
                 WHERE tenant_id = $1 AND document_id = $2 AND content LIKE $3;`,
                [tenantId, program.document_id, `%${program.name}%`]
              );
            }

            let chunks: any[] = [];
            if (matchedPagesRes.length > 0) {
              const pageNumbers = matchedPagesRes.map((r: any) => r.page_number);
              const targetPages = new Set<number>();
              pageNumbers.forEach((p: number) => {
                targetPages.add(p);
                targetPages.add(p + 1);
              });
              
              chunks = await query(
                `SELECT page_number, content 
                 FROM semantic_chunks 
                 WHERE tenant_id = $1 AND document_id = $2 AND page_number = ANY($3)
                 ORDER BY page_number ASC;`,
                [tenantId, program.document_id, Array.from(targetPages)]
              );
            }

            const sourcesToProcess: { id: string; content: string }[] = [];
            if (chunks.length > 0) {
              chunks.forEach((c: any, idx: number) => {
                sourcesToProcess.push({
                  id: `chunk_${c.page_number}_${idx}`,
                  content: c.content
                });
              });
            } else {
              reqsWithTree.forEach((r: any, idx: number) => {
                sourcesToProcess.push({
                  id: `req_${r.id.substring(0, 4)}_${idx}`,
                  content: r.logic_tree
                });
              });
            }

            const parsedBlocks: any[] = [];
            const courseRegex = /\b([A-Z]{2,4})\s*[-]?\s*(\d{3})\b/g;

            sourcesToProcess.forEach((src: any, srcIdx: number) => {
              let cleanText = src.content;
              cleanText = cleanText.replace(/^\[Header\s+\d+[\s\S]*?\](?:\r?\n|$)/i, '').trim();
              const sections = cleanText.split(/(?=\n##\s+|\n###\s+|\n\*\*)/);
              
              sections.forEach((sec: string, secIdx: number) => {
                const lines = sec.split('\n');
                let title = (lines[0] || '').replace(/^#+\s*/, '').replace(/^\*+\s*/, '').replace(/\*+$/, '').trim();
                
                if (!title || title.length < 3) {
                  title = `Requirement Block ${srcIdx + 1}.${secIdx + 1}`;
                }

                if (
                  title.toLowerCase().includes('faculty') || 
                  title.toLowerCase().includes('mission statement') ||
                  title.toLowerCase().includes('vision statement')
                ) {
                  return;
                }

                let requiredValue = 0;
                let logicType = 'ALL_OF';
                const hoursMatch = sec.match(/(\d+)\s*(hour|credit|sem)/i);
                if (hoursMatch) {
                  requiredValue = parseInt(hoursMatch[1], 10);
                  logicType = 'CREDITS_FROM';
                }
                if (sec.toLowerCase().includes('elective') || sec.toLowerCase().includes('choose')) {
                  logicType = 'CHOOSE_N';
                  if (requiredValue === 0) requiredValue = 3;
                }

                const coursesList: string[] = [];
                let match;
                courseRegex.lastIndex = 0;
                while ((match = courseRegex.exec(sec)) !== null) {
                  const prefix = match[1].toUpperCase();
                  const num = match[2];
                  const cleanCode = `${prefix} ${num}`;
                  if (courseDetailsMap.has(cleanCode)) {
                    if (!coursesList.includes(cleanCode)) {
                      coursesList.push(cleanCode);
                    }
                  }
                }

                if (coursesList.length > 0) {
                  parsedBlocks.push({
                    id: `ast_block_${srcIdx}_${secIdx}`,
                    degree_name: title,
                    logic_tree: sec.trim(),
                    courses: coursesList,
                    logic_type: logicType,
                    required_value: requiredValue
                  });
                }
              });
            });

            // Map dynamically parsed blocks into requirements and requirementCourses arrays!
            if (parsedBlocks.length > 0) {
              const dynamicReqs: any[] = [];
              const dynamicReqCourses: any[] = [];

              parsedBlocks.forEach((b: any) => {
                const blockId = b.id;
                dynamicReqs.push({
                  id: blockId,
                  degree_name: b.degree_name,
                  logic_tree: b.logic_tree
                });

                b.courses.forEach((cCode: string) => {
                  const details = courseDetailsMap.get(cCode.toUpperCase().trim()) || {};
                  dynamicReqCourses.push({
                    requirement_id: blockId,
                    group_name: b.degree_name,
                    is_required: b.logic_type === 'ALL_OF',
                    course_id: details.id || `course_${cCode}`,
                    course_code: cCode,
                    title: details.title || `${cCode} requirement`,
                    credits: details.credits || 3
                  });
                });
              });

              return NextResponse.json({
                faculty: facultyList,
                requirements: dynamicReqs,
                requirementCourses: dynamicReqCourses
              });
            }
          }
        }

        return NextResponse.json({
          faculty: facultyList,
          requirements,
          requirementCourses: reqCourses
        });
      }

      case 'get_course_details': {
        if (!targetId) return NextResponse.json({ error: "Course ID required." }, { status: 400 });
        
        // Fetch prerequisites mapping
        const prerequisites = await query(
          `SELECT c.id, c.course_code, c.title, c.credits
           FROM course_prerequisite_links cpl 
           JOIN courses c ON cpl.prereq_course_id = c.id 
           WHERE cpl.tenant_id = $1 AND cpl.course_id = $2 
           ORDER BY c.course_code;`,
          [tenantId, targetId]
        );

        return NextResponse.json({ prerequisites });
      }

      case 'get_semantic_chunks': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });
        // Fetch semantic chunks joined with Toulmin, Deontic, and Quinean lookups with safe markdown_url check
        let res;
        try {
          res = await query(
            `SELECT sc.id, sc.section_header, sc.content, sc.page_number, sc.sequence_order,
                    NULL as quinean_weight, NULL as toulmin_role, NULL as deontic_modality,
                    sc.markdown_url,
                    ct.label as lookup_chunk_type, tr.label as lookup_toulmin_role, 
                    dm.label as lookup_deontic_modality, qw.label as lookup_quinean_class,
                    qw.centrality_index, qw.revisability_score, sc.hypothetical_questions
             FROM semantic_chunks sc 
             LEFT JOIN chunk_types ct ON sc.chunk_type_id = ct.id 
             LEFT JOIN toulmin_roles tr ON sc.toulmin_role_id = tr.id 
             LEFT JOIN deontic_modalities dm ON sc.deontic_modality_id = dm.id 
             LEFT JOIN quinean_web_classifications qw ON sc.quinean_classification_id = qw.id
             WHERE sc.tenant_id = $1 AND sc.document_id = $2 
             ORDER BY sc.sequence_order;`,
            [tenantId, catalogId]
          );
        } catch (dbErr: any) {
          console.warn("src/app/api/db/route.ts: sc.markdown_url column does not exist yet. Falling back.", dbErr.message);
          res = await query(
            `SELECT sc.id, sc.section_header, sc.content, sc.page_number, sc.sequence_order,
                    NULL as quinean_weight, NULL as toulmin_role, NULL as deontic_modality,
                    NULL as markdown_url,
                    ct.label as lookup_chunk_type, tr.label as lookup_toulmin_role, 
                    dm.label as lookup_deontic_modality, qw.label as lookup_quinean_class,
                    qw.centrality_index, qw.revisability_score, sc.hypothetical_questions
             FROM semantic_chunks sc 
             LEFT JOIN chunk_types ct ON sc.chunk_type_id = ct.id 
             LEFT JOIN toulmin_roles tr ON sc.toulmin_role_id = tr.id 
             LEFT JOIN deontic_modalities dm ON sc.deontic_modality_id = dm.id 
             LEFT JOIN quinean_web_classifications qw ON sc.quinean_classification_id = qw.id
             WHERE sc.tenant_id = $1 AND sc.document_id = $2 
             ORDER BY sc.sequence_order;`,
            [tenantId, catalogId]
          );
        }
        return NextResponse.json(res);
      }

      case 'match_policy_chunk': {
        // Returns pgvector cosine similarity between a base policy chunk and every
        // chunk in the comparison catalog, so the client can fuse it with a
        // lexical (Jaccard) score to align chunks across separate ingestions.
        const { baseCatalogId, compareCatalogId, baseChunkId } = body;
        if (!baseCatalogId || !compareCatalogId || !baseChunkId) {
          return NextResponse.json({ error: "baseCatalogId, compareCatalogId and baseChunkId are required." }, { status: 400 });
        }

        // Confirm the base chunk actually carries an embedding before scoring.
        const baseEmb = await query(
          `SELECT (embedding IS NOT NULL) AS has_embedding
           FROM semantic_chunks
           WHERE id = $1 AND tenant_id = $2 AND document_id = $3;`,
          [baseChunkId, tenantId, baseCatalogId]
        );
        const hasEmbeddings = baseEmb.length > 0 && baseEmb[0].has_embedding === true;

        if (!hasEmbeddings) {
          // No vector to compare against — caller falls back to lexical-only.
          return NextResponse.json({ hasEmbeddings: false, scores: [] });
        }

        let scores: any[] = [];
        try {
          scores = await query(
            `SELECT c.id, (1 - (c.embedding <=> b.embedding)) AS cosine
             FROM semantic_chunks c
             CROSS JOIN (
               SELECT embedding FROM semantic_chunks
               WHERE id = $1 AND tenant_id = $2 AND document_id = $3
             ) b
             WHERE c.tenant_id = $2 AND c.document_id = $4 AND c.embedding IS NOT NULL;`,
            [baseChunkId, tenantId, baseCatalogId, compareCatalogId]
          );
        } catch (dbErr: any) {
          console.warn("src/app/api/db/route.ts: pgvector cosine scoring failed:", dbErr.message);
          return NextResponse.json({ hasEmbeddings: false, scores: [] });
        }

        return NextResponse.json({
          hasEmbeddings: true,
          scores: scores.map((r: any) => ({ id: r.id, cosine: Number(r.cosine) })),
        });
      }

      case 'get_diagnostics': {
        if (!catalogId) return NextResponse.json({ error: "Catalog ID required." }, { status: 400 });

        // Credit distribution metrics
        const creditDist = await query(
          `SELECT credits, COUNT(*) as count 
           FROM courses 
           WHERE tenant_id = $1 AND document_id = $2 AND credits IS NOT NULL 
           GROUP BY credits 
           ORDER BY credits;`,
          [tenantId, catalogId]
        );

        // Subject area prefix distribution
        const subjectDist = await query(
          `SELECT s.prefix as subject, COUNT(c.id) as count
           FROM courses c
           JOIN subjects s ON c.subject_id = s.id
           WHERE c.tenant_id = $1 AND c.document_id = $2
           GROUP BY s.prefix
           ORDER BY count DESC;`,
          [tenantId, catalogId]
        );

        // Ghost Nodes calculation (courses linked as prerequisites/requirements but not in master course list)
        const ghostNodes = await query(
          `SELECT DISTINCT cpl.prereq_course_id, c_req.course_code as code, c_req.title 
           FROM course_prerequisite_links cpl
           JOIN courses c_src ON cpl.course_id = c_src.id
           JOIN courses c_req ON cpl.prereq_course_id = c_req.id
           WHERE cpl.tenant_id = $1
             AND c_src.document_id = $2
             AND cpl.prereq_course_id NOT IN (
                 SELECT id FROM courses WHERE tenant_id = $1 AND document_id = $2
             );`,
          [tenantId, catalogId]
        );

        return NextResponse.json({
          creditDistribution: creditDist.map(c => ({ credits: `${c.credits} Credits`, count: Number(c.count) })),
          subjectDistribution: subjectDist.map(s => ({ subject: s.subject, count: Number(s.count) })),
          ghostNodesCount: ghostNodes.length,
          ghostNodes: ghostNodes
        });
      }

      case 'get_program_ast': {
        if (!targetId) return NextResponse.json({ error: "Program ID required." }, { status: 400 });
        
        // 1. Fetch the program details
        const programRes = await query(
          `SELECT id, name, document_id, degree_type, total_credits 
           FROM programs 
           WHERE tenant_id = $1 AND id = $2;`,
          [tenantId, targetId]
        );
        if (programRes.length === 0) return NextResponse.json({ error: "Program not found." }, { status: 404 });
        const program = programRes[0];

        // 2. Retrieve all active courses details for this catalog to map accurate course attributes (title, description, credits)
        const activeCourses = await query(
          `SELECT course_code, title, credits, description 
           FROM courses 
           WHERE tenant_id = $1 AND document_id = $2;`,
          [tenantId, program.document_id]
        );
        
        // Build a lookup details map
        const courseDetailsMap = new Map<string, any>();
        activeCourses.forEach((c: any) => {
          const codeUpper = c.course_code.toUpperCase().trim();
          courseDetailsMap.set(codeUpper, {
            title: c.title,
            credits: c.credits,
            description: cleanDescription(c.description)
          });
        });

        // 3. Fetch corresponding program requirements to extract header path prefix
        const reqs = await query(
          `SELECT pr.id, pr.degree_name, pr.logic_tree 
           FROM program_requirements pr 
           WHERE pr.tenant_id = $1 AND pr.program_id = $2 AND pr.logic_tree IS NOT NULL;`,
          [tenantId, targetId]
        );

        // Extract heading path segment (e.g. "Header 2: B.S. in Accounting (120 hours)")
        let pathSegment = program.name;
        if (reqs.length > 0 && reqs[0].logic_tree) {
          const firstLine = reqs[0].logic_tree.split('\n')[0];
          const match = firstLine.match(/\[Header 1: [^>]+ > (Header 2: [^\]>]+|Header 3: [^\]>]+)/);
          if (match) {
            pathSegment = match[1].trim();
          }
        }

        // 4. Query semantic_chunks table using page-scoping logic
        // Find pages that contain the path segment
        let matchedPagesRes = await query(
          `SELECT DISTINCT page_number 
           FROM semantic_chunks 
           WHERE tenant_id = $1 AND document_id = $2 AND content LIKE $3;`,
          [tenantId, program.document_id, `%${pathSegment}%`]
        );

        // Fallback: Find pages containing the program name
        if (matchedPagesRes.length === 0) {
          matchedPagesRes = await query(
            `SELECT DISTINCT page_number 
             FROM semantic_chunks 
             WHERE tenant_id = $1 AND document_id = $2 AND content LIKE $3;`,
            [tenantId, program.document_id, `%${program.name}%`]
          );
        }

        let chunks: any[] = [];
        if (matchedPagesRes.length > 0) {
          const pageNumbers = matchedPagesRes.map((r: any) => r.page_number);
          // Build a set of page numbers and their next pages (contiguous flow)
          const targetPages = new Set<number>();
          pageNumbers.forEach((p: number) => {
            targetPages.add(p);
            targetPages.add(p + 1);
          });
          
          chunks = await query(
            `SELECT page_number, content 
             FROM semantic_chunks 
             WHERE tenant_id = $1 AND document_id = $2 AND page_number = ANY($3)
             ORDER BY page_number ASC;`,
            [tenantId, program.document_id, Array.from(targetPages)]
          );
        }

        const blocks: any[] = [];
        const courseRegex = /\b([A-Z]{2,4})\s*[-]?\s*(\d{3})\b/g;

        // Establish the data sources to process
        const sourcesToProcess: { id: string; content: string }[] = [];
        if (chunks.length > 0) {
          chunks.forEach((c: any, idx: number) => {
            sourcesToProcess.push({
              id: `chunk_${c.page_number}_${idx}`,
              content: c.content
            });
          });
        } else {
          // Fallback to program requirements logic tree text if no GCS semantic chunks are matched
          reqs.forEach((r: any, idx: number) => {
            sourcesToProcess.push({
              id: `req_${r.id.substring(0, 4)}_${idx}`,
              content: r.logic_tree
            });
          });
        }

        // Parse requirement blocks from text chunks
        sourcesToProcess.forEach((src: any, srcIdx: number) => {
          let cleanText = src.content;
          
          // A. Strip bracketed path prefix [Header 1: ... ]
          cleanText = cleanText.replace(/^\[Header\s+\d+[\s\S]*?\](?:\r?\n|$)/i, '').trim();
          
          // B. Split into logical sections using headers
          const sections = cleanText.split(/(?=\n##\s+|\n###\s+|\n\*\*)/);
          
          sections.forEach((sec: string, secIdx: number) => {
            const lines = sec.split('\n');
            const headerLine = lines[0] || '';
            
            // Clean section title
            let title = headerLine.replace(/^#+\s*/, '').replace(/^\*+\s*/, '').replace(/\*+$/, '').trim();
            if (!title || title.length < 3) {
              title = `Requirement Block ${srcIdx + 1}.${secIdx + 1}`;
            }

            // Filter out non-coursework metadata blocks (like calendars or faculty sections)
            if (
              title.toLowerCase().includes('faculty') || 
              title.toLowerCase().includes('mission statement') ||
              title.toLowerCase().includes('vision statement')
            ) {
              return;
            }

            // C. Detect credit hours or choice values
            let requiredValue = 0;
            let logicType = 'ALL_OF'; // Default logic type
            
            const hoursMatch = sec.match(/(\d+)\s*(hour|credit|sem)/i);
            if (hoursMatch) {
              requiredValue = parseInt(hoursMatch[1], 10);
              logicType = 'CREDITS_FROM';
            }
            
            if (sec.toLowerCase().includes('elective') || sec.toLowerCase().includes('choose')) {
              logicType = 'CHOOSE_N';
              if (requiredValue === 0) requiredValue = 3; // Default elective choices
            }

            // D. Extract valid course codes
            const coursesList: string[] = [];
            let match;
            courseRegex.lastIndex = 0;
            while ((match = courseRegex.exec(sec)) !== null) {
              const prefix = match[1].toUpperCase();
              const num = match[2];
              const cleanCode = `${prefix} ${num}`;
              
              // Validate course presence in current catalog
              if (courseDetailsMap.has(cleanCode)) {
                if (!coursesList.includes(cleanCode)) {
                  coursesList.push(cleanCode);
                }
              }
            }

            if (coursesList.length > 0) {
              blocks.push({
                block_id: `${src.id}-${secIdx}`,
                title,
                logic_type: logicType,
                required_value: requiredValue,
                courses: coursesList,
                content: sec.trim()
              });
            }
          });
        });

        // 5. Compile into graph nodes & links for D3 force exploration
        const nodes: any[] = [];
        const links: any[] = [];

        // Dynamic degree type extraction for root node using corrected regex boundaries
        let degreeType = program.degree_type;
        if (!degreeType && program.name) {
          const match = program.name.match(/\b(B\.A\.|B\.S\.|A\.S\.|A\.A\.|M\.S\.|M\.A\.|M\.B\.A\.|M\.S\.M\.|M\.S\.A\.|M\.A\.T\b|Minor\b|Concentration\b|Certificate\b|Major\b|Degree\b|Master\b)/i);
          if (match) {
            degreeType = match[1];
          }
        }

        // A. Add Root Program Node
        nodes.push({
          id: `root`,
          label: program.name,
          title: program.name,
          group: 'program',
          degree_type: degreeType,
          total_credits: program.total_credits
        });

        // B. Add Block and Course Nodes
        const courseCodeSet = new Set<string>();
        blocks.forEach((b: any) => {
          const blockNodeId = `block_${b.block_id}`;
          nodes.push({
            id: blockNodeId,
            label: b.title.substring(0, 25) + (b.title.length > 25 ? '...' : ''),
            title: b.title,
            group: 'block', // Colored sky blue for requirement block representation
            logic_type: b.logic_type,
            required_value: b.required_value,
            description: b.content
          });

          // Link Program -> Block
          links.push({
            source: 'root',
            target: blockNodeId,
            type: 'GOVERNS',
            is_required: b.logic_type !== 'OPTIONAL'
          });

          b.courses.forEach((cCode: string) => {
            const courseNodeId = `course_${cCode}`;
            if (!courseCodeSet.has(courseNodeId)) {
              const details = courseDetailsMap.get(cCode.toUpperCase().trim()) || {};
              nodes.push({
                id: courseNodeId,
                label: cCode,
                title: details.title || `${cCode} requirement`,
                description: details.description || `This course is required for the program curriculum.`,
                credits: details.credits || 3,
                group: 'course'
              });
              courseCodeSet.add(courseNodeId);
            }

            // Link Block -> Course
            links.push({
              source: blockNodeId,
              target: courseNodeId,
              type: 'BELONGS_TO',
              is_required: b.logic_type === 'ALL_OF'
            });
          });
        });

        return NextResponse.json({ program, blocks, nodes, links });
      }
 
      default:
        return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }
  } catch (e: any) {
    console.error("Database Gateway Error: ", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
