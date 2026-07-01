import { query } from '@/lib/db';

const API_BASE_URL = process.env.NEXT_PUBLIC_SWARM_API_URL || 'http://localhost:8080';

const esc = (s: any): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Strip the duplicated "[Header ...]" bracket preamble ingestion prepends to chunk content. */
function cleanChunk(content: string): string {
  return String(content ?? '').replace(/^\s*\[[\s\S]*?\]\s*/, '').trim();
}

function inline(s: string): string {
  return esc(s)
    .replace(/&lt;br\s*\/?&gt;/gi, '<br/>')                             // literal <br> -> real line break
    .replace(/\$?\\(?:q?quad)\$?/gi, '&emsp;')                          // LaTeX \quad / $\quad$ spacer -> gap
    .replace(/\\([*_~])/g, (_m, c: string) => `&#${c.charCodeAt(0)};`)  // escaped punctuation -> literal (protect from md)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')                 // **bold**
    .replace(/\*([^*\n]+?)\*/g, '<em>$1</em>')                          // *italic* (bold already consumed)
    .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>'); // _italic_
}

/** Minimal, safe markdown -> HTML for catalog prose (headings, bold, bullets, tables, paragraphs). */
function mdToHtml(md: string): string {
  const lines = cleanChunk(md).split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let inOl = false;
  let table: string[][] | null = null;
  let para: string[] = []; // buffered soft-wrapped paragraph lines (joined until a blank/special line)
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeOl = () => { if (inOl) { out.push('</ol>'); inOl = false; } };
  const closeLists = () => { closeList(); closeOl(); };
  // A "structured" line (course code, numbered item, "or …", "N hours:", LaTeX-tab row, footnote
  // marker) is kept on its own line; ordinary prose lines are joined into a flowing paragraph.
  const isStructured = (l: string) =>
    /^[A-Z]{2,4}\s*\d{2,3}[A-Z]?\b/.test(l) || /^\d+\.\s/.test(l) || /^or\b/i.test(l) ||
    /\\q?quad/i.test(l) || /\$\\/.test(l) || /^\d+\s*hours?\b/i.test(l) || /^\\?\*\s/.test(l);
  const flushPara = () => {
    if (!para.length) return;
    let html = inline(para[0]);
    for (let i = 1; i < para.length; i++) {
      html += (isStructured(para[i]) || isStructured(para[i - 1]) ? '<br>' : ' ') + inline(para[i]);
    }
    out.push(`<p>${html}</p>`);
    para = [];
  };
  const isTableRow = (l: string) => /^\|.*\|\s*$/.test(l);
  const parseRow = (l: string) => l.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const isSep = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
  const flushTable = () => {
    if (!table) return;
    const rows = table; table = null;
    if (!rows.length) return;
    let header: string[] | null = null;
    let bodyRows = rows;
    if (rows.length >= 2 && isSep(rows[1])) { header = rows[0]; bodyRows = rows.slice(2); }
    bodyRows = bodyRows.filter((r) => !isSep(r));
    const thead = header ? `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
    const tbody = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    out.push(`<table class="md">${thead}${tbody}</table>`);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (isTableRow(line)) { flushPara(); closeLists(); (table ??= []).push(parseRow(line)); continue; }
    if (table) flushTable();
    if (!line) { flushPara(); closeLists(); continue; }             // blank line ends a paragraph/list
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeLists(); out.push(`<h${Math.min(h[1].length + 2, 6)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`); continue; }
    if (/^[*-]\s+/.test(line)) {                                     // bullet (asterisk/dash + space)
      flushPara(); closeOl();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(line.replace(/^[*-]\s+/, ''))}</li>`);
      continue;
    }
    const ol = line.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {                                                        // numbered item -> ordered list
      flushPara(); closeList();
      if (!inOl) { out.push(`<ol start="${ol[1]}">`); inOl = true; }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    closeLists();
    para.push(line);                                                // soft-wrapped prose -> join into paragraph
  }
  flushPara();
  closeLists();
  flushTable();
  return out.join('\n');
}

const subjectOf = (code: string): string => (String(code).trim().split(/\s|\d/)[0] || '').toUpperCase();

/** Top-level header label from an ingestion section_header ("Header 1: X > Header 2: Y" -> "X"). */
const header1Of = (sh: any): string => {
  const s = String(sh ?? '');
  const m = s.match(/Header\s*1:\s*([^>]+)/i);
  return ((m ? m[1] : s.split('>')[0]).split('\n')[0] || '').trim() || 'General';
};

/** Second-level header label ("... > Header 2: Y > ..." -> "Y"), first line only. */
const header2Of = (sh: any): string => {
  const m = String(sh ?? '').match(/Header\s*2:\s*([^>]+)/i);
  return m ? (m[1].split('\n')[0] || '').trim() : '';
};

/** A program Header-2 that names a credential (degree/minor/concentration) rather than a discipline. */
const DEGREE_RE = /^(B\.?\s?[AS]\.?|A\.?\s?[AS]\.?|M\.?\s?[ABS]\.?|M\.?B\.?A\.?|Master\b|Bachelor\b|Associate\b|Minor\b|Certificate\b|Endorsement\b|Second Degree\b|Post[- ]?Bacc|Concentration\b|Concentrations\b|Specialization\b|Doctor\b)/i;
const isDegreeHeader = (h2: string): boolean => DEGREE_RE.test(h2.trim());

/** A program Header-2 that is a continuation subsection of the current discipline, not a new one. */
const CONTINUATION_RE = /^(other\b|program\b|programs\b|concentrations?\b|eligibility\b|requirements?\b|assessments?\b|admissions?\b|outcomes?\b|curriculum\b|curricula\b|prerequisites?\b|general\b|notes?\b|overview\b|electives?\b|core\b|sample\b|suggested\b|recommended\b|additional\b)/i;
// Also catch continuation phrases that appear later in the label (e.g. "… suggested courses:",
// "… Pathway", "Program Outcome Objectives") so they fold into the current discipline instead of
// becoming their own heading/TOC line.
const CONTINUATION_ANY = /\b(?:suggested|recommended)\s+courses|\bpathway\b|program outcome objectives|program curriculum/i;
const isContinuation = (h2: string): boolean => CONTINUATION_RE.test(h2.trim()) || CONTINUATION_ANY.test(h2);

/** The Course Descriptions / Programs top-level sections (rendered specially). */
const isCourseDescLabel = (label: string): boolean => /^course descriptions$/i.test(String(label).trim());
const isProgramsLabel = (label: string): boolean =>
  /undergraduate programs|graduate (studies|programs)|^(academic )?programs$/i.test(String(label).trim());

/**
 * Resolve the academic discipline a program Header-2 belongs to, so degree variants nest under one
 * heading (e.g. "A.S. in Psychology" + "B.S. in Psychology" -> "Psychology"). Bare discipline headers
 * map to themselves; credential headers map to the discipline named after "in", canonicalized to a
 * known bare discipline when one is contained (so concentrations fold into their parent).
 */
function disciplineOf(h2: string, known: string[]): string {
  // Strip ALL parentheticals — trailing "(120 hours)" and descriptors like "(Master of Arts in
  // Teaching)" that would otherwise mislead the "after in" extraction below.
  let s = String(h2 ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (!isDegreeHeader(s)) return s;
  const m = s.match(/\bin\b\s+(.+)$/i);
  let d = (m ? m[1] : s).trim();
  d = d.replace(/\s+with\s+(a|an|the)\b.*$/i, '').trim();   // drop "with a ... Concentration"
  d = d.replace(/\s*[-–]\s*Fast Track.*$/i, '').trim();
  d = d.replace(/\s+Concentration$/i, '').trim();
  const lower = d.toLowerCase();
  let best = '';
  for (const k of known) {
    // Fold into a known discipline only when its name appears within this credential's phrase
    // (e.g. "Forensic Accounting" -> "Accounting"); the longest such match wins.
    if (lower.includes(k.toLowerCase()) && k.length > best.length) best = k;
  }
  return best || d || 'Programs';
}

/** Some chunks embed their body inside the bracket/section_header; recover the text after the label. */
const headerBody = (sh: any): string => {
  const seg = String(sh ?? '').split('>').pop() || '';
  return seg.replace(/^\s*Header\s*\d+:\s*/i, '').trim();
};

/** Clean a chunk to renderable prose WITHOUT the header-body fallback (returns '' if empty). */
function scrubBody(content: string): string {
  let s = cleanChunk(content);
  s = s.replace(/^[ \t]*updated\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4}[ \t]*$/gim, ''); // footer revision stamps
  s = s.replace(/^[ \t]*[-–—*_]{2,}[ \t]*$/gm, '');                              // separator-only lines
  s = s.replace(/\n[ \t]*\d{1,4}[ \t]*$/, '');                                   // trailing page number
  if (/^\s*\d{1,4}\s*$/.test(s)) s = '';                                         // page-number-only chunk
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render an ordered list of chunks to HTML pieces. Chunks scrubbed empty (footer / page-number /
 * separator only) fall back to the body embedded in their section_header. Substantial blocks are
 * de-duplicated, so a list whose text appears both inline on one chunk and embedded in sibling
 * chunks' headers (an ingestion artifact) renders exactly once.
 */
function renderChunks(
  chunks: { sh: string; content: string }[],
  seen: Set<string> = new Set(),
  suppress?: Set<string>
): string[] {
  const texts: string[] = [];
  for (const c of chunks) {
    let text = scrubBody(c.content) || headerBody(c.sh);
    if (!text) continue;
    // Drop a chunk's own heading/bare line when it duplicates a structural heading we already emit
    // (the section/discipline/program label). Keeps real subheadings; removes the doubled title.
    if (suppress && suppress.size) {
      text = text.split('\n').filter((line) => {
        const m = line.match(/^\s*#{1,4}\s*(.+?)\s*$/);
        const label = (m ? m[1] : line).trim();
        return !(label && suppress.has(normLabel(label)));
      }).join('\n').trim();
      if (!text) continue;
    }
    // De-duplicate any repeated block within a section (the spurious "Honors Program ×3" artifacts).
    const key = text.toLowerCase().replace(/[#*_>`~+-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (key.length > 2) { if (seen.has(key)) continue; seen.add(key); }
    texts.push(text);
  }
  if (!texts.length) return [];

  // Stitch table fragments that page-break artifacts split across chunks back into one table. A
  // non-table line sandwiched between two table fragments is a page-break-orphaned cell — fold it
  // back into the previous row's first column (matching how in-cell lists use <br>).
  const firstLine = (t: string) => (t.split('\n').find((x) => x.trim()) || '').trim();
  const lastLine = (t: string) => { const ls = t.split('\n').map((x) => x.trim()).filter(Boolean); return ls[ls.length - 1] || ''; };
  const endsTable = (t: string) => /^\|.*\|$/.test(lastLine(t));
  const startsTable = (t: string) => /^\|/.test(firstLine(t));
  const dropReHeader = (t: string) => {
    const ls = t.split('\n');
    if (ls.length >= 2 && /^\s*\|/.test(ls[0]) && /^\s*\|[\s:|-]*$/.test(ls[1]) && ls[1].includes('-')) return ls.slice(2).join('\n');
    return t;
  };
  const absorbOrphan = (tableText: string, orphan: string) => {
    const ls = tableText.split('\n');
    for (let i = ls.length - 1; i >= 0; i--) {
      if (/^\s*\|.*\|\s*$/.test(ls[i])) {
        const cells = ls[i].trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const extra = orphan.split('\n').map((s) => s.trim()).filter(Boolean).join('<br>');
        cells[0] = `${cells[0]}<br>${extra}`;
        ls[i] = `| ${cells.join(' | ')} |`;
        break;
      }
    }
    return ls.join('\n');
  };
  const parts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const prev = parts[parts.length - 1];
    if (prev && endsTable(prev) && startsTable(t)) { parts[parts.length - 1] = `${prev}\n${dropReHeader(t)}`; continue; }
    if (prev && endsTable(prev) && !startsTable(t) && i + 1 < texts.length && startsTable(texts[i + 1])) {
      parts[parts.length - 1] = absorbOrphan(prev, t); continue;
    }
    parts.push(t);
  }
  return [mdToHtml(parts.join('\n\n'))];
}

/** A PDF presentation override set by the in-app correction agent (rendering corrections). */
export type PresentationOverride = {
  id?: string;
  type: 'regroup' | 'rename' | 'hide';
  scope?: 'discipline' | 'program' | 'section';
  match: string;
  value?: string;
  note?: string;
};

/** Normalize a heading label for override matching (case/spacing/credit-hour insensitive). */
const normLabel = (s: any): string =>
  String(s ?? '').toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();

/** Normalized label plus a date-stripped variant (so "Board of Trustees, 2025-2026" also matches
 *  a content heading of just "Board of Trustees"). Used to suppress doubled structural headings. */
const labelVariants = (s: any): string[] => {
  const n = normLabel(s);
  const noDate = n.replace(/,?\s*\d{4}(\s*[-–]\s*\d{4})?$/, '').trim();
  return noDate && noDate !== n ? [n, noDate] : [n];
};

/** Build fast lookups from a catalog's presentation overrides. */
function overrideIndex(overrides: PresentationOverride[]) {
  const regroup = new Map<string, string>();
  const rename = new Map<string, string>();
  const hide = new Set<string>();
  for (const o of overrides || []) {
    if (!o || !o.match) continue;
    const m = normLabel(o.match);
    if (o.type === 'regroup' && o.value) regroup.set(m, o.value);
    else if (o.type === 'rename' && o.value) rename.set(`${o.scope || 'program'}|${m}`, o.value);
    else if (o.type === 'hide') hide.add(`${o.scope || 'program'}|${m}`);
  }
  return {
    regroup,
    rename: (scope: string, label: string) => rename.get(`${scope}|${normLabel(label)}`) ?? label,
    hidden: (scope: string, label: string) => hide.has(`${scope}|${normLabel(label)}`),
  };
}

/**
 * Group program Header-2 subgroups into disciplines (forward pass), honoring `regroup` overrides.
 * Returns the discipline order plus, per discipline, the indices of its member subgroups.
 * Shared by the renderer and getProgramStructure so the agent sees exactly what the PDF shows.
 */
function groupPrograms(
  subs: { h2: string }[],
  regroup: Map<string, string>
): { order: string[]; map: Map<string, number[]> } {
  const known = subs
    .map((s) => s.h2.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter((h) => h && !isDegreeHeader(h) && !isContinuation(h));
  const order: string[] = [];
  const map = new Map<string, number[]>();
  // Unify near-identical discipline names (e.g. the source typo "Digital and Studio Arts Arts" vs
  // "Digital and Studio Arts") so they render as ONE heading. Group by a canonical key with adjacent
  // duplicate words collapsed; display the cleaned name.
  const collapse = (s: string) => s.replace(/\b(\w+)(\s+\1\b)+/gi, '$1').replace(/\s+/g, ' ').trim();
  const canonToDisplay = new Map<string, string>();
  const canonicalize = (d0: string): string => {
    const key = normLabel(collapse(d0));
    const existing = canonToDisplay.get(key);
    if (existing) return existing;
    const disp = collapse(d0) || d0;
    canonToDisplay.set(key, disp);
    return disp;
  };
  let current = 'Programs';
  subs.forEach((s, idx) => {
    const clean = s.h2.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const forced = regroup.get(normLabel(s.h2));
    let d: string;
    if (forced) d = canonicalize(forced);                     // explicit regroup override
    else if (/^(concentrations?|specializations?)\b/i.test(clean)) d = current;
    else if (isDegreeHeader(clean)) { d = canonicalize(disciplineOf(s.h2, known) || current); current = d; }
    else if (clean && !isContinuation(clean)) { d = canonicalize(clean); current = d; }
    else d = current;
    if (!map.has(d)) { map.set(d, []); order.push(d); }
    map.get(d)!.push(idx);
  });
  return { order, map };
}

/**
 * Clean an ingested course description/prerequisite for display: strip the "[Header …]" preamble
 * (closed or not), markdown heading lines that duplicate the course title, page-footer artifacts
 * (page numbers, "Updated M-D-YY", "---"), and stray brackets. Truncated/missing text is an
 * ingestion problem and cannot be recovered here.
 */
function cleanCourseDesc(s: any): string {
  let t = String(s ?? '');
  t = t.replace(/^\s*\[Header\b[^\n]*\n?/i, '');          // leading [Header …] line (closed or not)
  t = t.replace(/\[\s*Header\b[^\]\n]*\]/gi, ' ');        // any inline closed [Header …] tag
  t = t.replace(/^\s*#{1,6}\s+.*(?:\n|$)/gm, '');         // markdown heading lines (### CODE. Title)
  t = t.replace(/\bUpdated\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/gi, '');
  t = t.replace(/\s*[-–—]{2,}\s*/g, ' ');                 // --- separators
  t = t.replace(/\s*\]\s*\d{0,4}\s*$/, '');               // trailing "]" / "] 212"
  t = t.replace(/\s+\d{1,3}\s*$/, '');                    // trailing bare page number
  return t.replace(/\s{2,}/g, ' ').trim();
}

/** Resolve a catalog's display version + whether it is a draft (provisional). */
export async function getCatalogMeta(catalogId: string): Promise<{ version: string; isDraft: boolean } | null> {
  const rows = await query('SELECT version FROM documents WHERE id = $1', [catalogId]);
  if (!rows.length) return null;
  const raw = String(rows[0].version || '');
  return { version: raw.replace(/\s*\(Draft\)/i, '').trim() || 'Catalog', isDraft: /\(Draft\)/i.test(raw) };
}

/**
 * Assemble the full branded catalog HTML from the corrected database (catalog-scoped).
 * Pass `draft: true` to mark it as a provisional/not-for-publication preview.
 */
export async function buildCatalogHtml(
  catalogId: string,
  opts: { versionLabel?: string; draft?: boolean } = {}
): Promise<string> {
  let { versionLabel, draft } = opts;
  if (versionLabel === undefined || draft === undefined) {
    const meta = await getCatalogMeta(catalogId);
    versionLabel = versionLabel ?? meta?.version ?? 'Catalog';
    draft = draft ?? meta?.isDraft ?? false;
  }

  // Structured, corrected course descriptions (clean credits/prereqs) — swapped in for the raw
  // course-description chunks at that section's natural position in the document.
  const courses = await query(
    `SELECT DISTINCT ON (course_code) course_code, title, credits, description, prerequisites
       FROM courses WHERE document_id = $1
       ORDER BY course_code, length(coalesce(description,'')) DESC`,
    [catalogId]
  );
  // Every chunk in true document order (sequence_order), minus the original Table of Contents —
  // we generate a fresh one. Document order naturally puts front matter & policies before programs
  // and courses, so we no longer impose an artificial section structure.
  const chunks = await query(
    `SELECT section_header, content FROM semantic_chunks
       WHERE document_id = $1
         AND (section_header IS NULL OR section_header NOT ILIKE '%table of contents%')
       ORDER BY sequence_order NULLS LAST, page_number NULLS LAST`,
    [catalogId]
  );

  // Presentation overrides (rendering corrections from the in-app agent), applied on top of the
  // grouping heuristic — regroup a program under a discipline, rename a heading, or hide a section.
  const ovRaw = (await query('SELECT presentation_overrides FROM documents WHERE id = $1', [catalogId]))[0]?.presentation_overrides;
  const overrides: PresentationOverride[] = Array.isArray(ovRaw) ? ovRaw : (typeof ovRaw === 'string' ? JSON.parse(ovRaw || '[]') : []);
  const ov = overrideIndex(overrides);

  // Structured course descriptions grouped by subject (each subject anchored for the TOC).
  const bySubject = new Map<string, any[]>();
  for (const c of courses) {
    const s = subjectOf(c.course_code);
    if (!bySubject.has(s)) bySubject.set(s, []);
    bySubject.get(s)!.push(c);
  }
  const subjectKeys = Array.from(bySubject.keys()).sort();
  const coursesHtml = subjectKeys.map((subj) => `
    <div class="subject" id="subj-${esc(subj)}">
      <h3>${esc(subj)}</h3>
      ${bySubject.get(subj)!.map((c) => {
        const desc = cleanCourseDesc(c.description);
        const prereq = cleanCourseDesc(c.prerequisites);
        return `<div class="course">
          <p class="course-head"><strong>${esc(c.course_code)}</strong> &mdash; ${esc(cleanCourseDesc(c.title) || c.title)}${c.credits != null ? ` <span class="muted">(${esc(c.credits)} hrs)</span>` : ''}</p>
          ${desc ? `<p class="desc">${esc(desc)}</p>` : ''}
          ${prereq ? `<p class="prereq"><em>Prerequisite:</em> ${esc(prereq)}</p>` : ''}
        </div>`;
      }).join('\n')}
    </div>`).join('\n');

  // Walk chunks in document order, grouping consecutive chunks by top-level header into sections.
  type Sec = { label: string; chunks: { sh: string; content: string }[] };
  const sections: Sec[] = [];
  {
    let label: string | null = null;
    for (const ch of chunks) {
      const h1 = header1Of(ch.section_header);
      if (h1 !== label) { sections.push({ label: h1, chunks: [] }); label = h1; }
      sections[sections.length - 1].chunks.push({ sh: ch.section_header, content: ch.content });
    }
  }

  // Render each section in order; build the TOC from the real sections as we go.
  const tocEntries: { href: string; label: string; lvl: 1 | 2 | 3 }[] = [];
  const body: string[] = [];

  sections.forEach((sec, si) => {
    const secId = `sec-${si}`;
    const isCourse = isCourseDescLabel(sec.label);
    const baseLabel = isCourse ? 'Course Descriptions' : sec.label;
    if (ov.hidden('section', baseLabel)) return;                 // hidden by override
    const secLabel = ov.rename('section', baseLabel);

    // Course Descriptions: render the clean structured data in place of the raw chunks.
    if (isCourse) {
      tocEntries.push({ href: `#${secId}`, label: secLabel, lvl: 1 });
      subjectKeys.forEach((s) => tocEntries.push({ href: `#subj-${esc(s)}`, label: s, lvl: 2 }));
      body.push(`<div class="section" id="${secId}"><h2>${esc(secLabel)}</h2>${coursesHtml}</div>`);
      return;
    }

    tocEntries.push({ href: `#${secId}`, label: secLabel, lvl: 1 });

    // Programs: nest degree variants (A.S./B.S./Minor/Concentration) under their discipline heading.
    if (isProgramsLabel(sec.label)) {
      // 1) Split into Header-2 subgroups (one per program/variant), keeping their chunks so each can
      //    be rendered with the right heading suppression once its discipline is known.
      type Sub = { h2: string; chunks: { sh: string; content: string }[] };
      const subs: Sub[] = [];
      {
        let h2: string | null = null;
        let bufChunks: { sh: string; content: string }[] = [];
        const flush = () => { if (bufChunks.length) subs.push({ h2: h2 || '', chunks: bufChunks }); bufChunks = []; };
        for (const c of sec.chunks) {
          const cur = header2Of(c.sh);
          if (cur !== h2) { flush(); h2 = cur; }
          bufChunks.push({ sh: c.sh, content: c.content });
        }
        flush();
      }
      // 2) Group into disciplines (honoring regroup overrides), then render each discipline (h3,
      //    TOC lvl2); anything that isn't the discipline's own header nests as a subheading (h4).
      const { order: discOrder, map: discMap } = groupPrograms(subs, ov.regroup);
      const parts: string[] = [];
      discOrder.forEach((d, di) => {
        if (ov.hidden('discipline', d)) return;
        const did = `${secId}-d${di}`;
        const dLabel = ov.rename('discipline', d);
        tocEntries.push({ href: `#${did}`, label: dLabel, lvl: 2 });
        const inner: string[] = [];
        let vIdx = 0;
        for (const idx of discMap.get(d)!) {
          const s = subs[idx];
          const rawLabel = s.h2.replace(/\s+$/, '').trim();
          const clean = s.h2.replace(/\s*\([^)]*\)\s*$/, '').trim();
          // Suppress the structural labels we emit (section h2, discipline h3, program h4) from prose.
          const suppress = new Set([secLabel, d, dLabel, rawLabel].flatMap(labelVariants));
          // De-dup PER PROGRAM only — a shared set would wrongly drop blocks (e.g. "1. General
          // Education") that legitimately recur across different programs.
          const html = renderChunks(s.chunks, new Set(), suppress).join('\n');
          if (!rawLabel || clean === d) {
            if (html.trim()) inner.push(html);           // the discipline's own intro prose
          } else {
            if (ov.hidden('program', rawLabel)) continue;
            const label = ov.rename('program', rawLabel);
            const vid = `${did}-v${vIdx++}`;
            // Real degrees/programs get a TOC line; continuation sub-labels don't (keeps the TOC clean).
            if (!isContinuation(clean)) tocEntries.push({ href: `#${vid}`, label, lvl: 3 });
            inner.push(`<div class="program" id="${vid}"><h4>${esc(label)}</h4>${html}</div>`);
          }
        }
        parts.push(`<div class="discipline" id="${did}"><h3>${esc(dLabel)}</h3>${inner.join('\n')}</div>`);
      });
      body.push(`<div class="section" id="${secId}"><h2>${esc(secLabel)}</h2>${parts.join('\n')}</div>`);
      return;
    }

    // Generic narrative/policy section: scrubbed, de-duplicated prose. Suppress the section's own
    // title so a chunk that repeats it as a markdown heading doesn't double the <h2>.
    const prose = renderChunks(sec.chunks, new Set(), new Set([secLabel, sec.label].flatMap(labelVariants))).join('\n');
    body.push(`<div class="section" id="${secId}"><h2>${esc(secLabel)}</h2>${prose}</div>`);
  });

  // Freshly generated Table of Contents (page numbers resolved by WeasyPrint via target-counter).
  const toc = `
    <div class="section toc">
      <h2>Table of Contents</h2>
      ${tocEntries.map((e) => `<div class="lvl${e.lvl}"><a href="${e.href}">${esc(e.label)}</a></div>`).join('\n')}
    </div>`;

  const draftTag = draft ? ' — DRAFT (provisional)' : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 1in 0.85in;
    @top-center { content: "Calumet College of St. Joseph — Academic Catalog ${esc(versionLabel)}${draftTag}"; font-size: 8pt; color: ${draft ? '#b03a4a' : '#7a7a7a'}; }
    @bottom-center { content: counter(page); font-size: 8pt; color: #7a7a7a; }
  }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
  h1, h2, h3, h4 { font-family: Georgia, serif; color: #8C2232; }
  h2 { font-size: 18pt; border-bottom: 2px solid #8C2232; padding-bottom: 4px; }
  h3 { font-size: 13.5pt; margin: 16px 0 4px; border-bottom: 1px solid #d9c3c7; padding-bottom: 2px; }
  h4 { font-size: 11.5pt; margin: 10px 0 3px; color: #65121e; }
  .muted { color: #7a7a7a; font-weight: normal; }
  .meta { font-size: 9pt; color: #555; margin: 2px 0 6px; }
  .section { page-break-before: always; }
  .cover { text-align: center; page-break-after: always; padding-top: 28%; }
  .cover .inst { font-size: 26pt; color: #8C2232; }
  .cover .title { font-size: 18pt; margin-top: 10px; }
  .cover .ver { font-size: 14pt; margin-top: 24px; color: #333; }
  .cover .draft { margin-top: 18px; font-size: 13pt; font-weight: bold; color: #b03a4a; letter-spacing: 0.05em; }
  .toc a { text-decoration: none; color: #1a1a1a; }
  .toc .lvl1 { font-weight: bold; color: #8C2232; margin-top: 8px; font-size: 11pt; }
  .toc .lvl2 { margin-left: 16px; font-size: 9.5pt; }
  .toc .lvl3 { margin-left: 34px; font-size: 9pt; color: #444; }
  .toc a::after { content: " " leader('.') " " target-counter(attr(href url), page); color: #888; }
  .course { margin: 0 0 8px; }
  .course-head { margin: 0; }
  .desc { margin: 2px 0; }
  .prereq { margin: 2px 0; font-size: 9.5pt; color: #444; }
  table.md { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9.5pt; }
  table.md th, table.md td { border: 1px solid #c9b4b8; padding: 4px 7px; text-align: left; vertical-align: top; }
  table.md th { background: #f3e9eb; color: #65121e; font-weight: bold; }
  table.md tr:nth-child(even) td { background: #faf6f7; }
  .discipline { margin-bottom: 16px; }
  .program { margin: 0 0 10px 12px; padding-left: 8px; border-left: 2px solid #eadfe1; }
  ul, ol { margin: 4px 0 8px 22px; padding-left: 4px; }
  ol li, ul li { margin: 2px 0; }
</style></head><body>
  <div class="cover">
    <div class="inst">Calumet College of St. Joseph</div>
    <div class="title">Academic Catalog</div>
    <div class="ver">${esc(versionLabel)}</div>
    ${draft ? `<div class="draft">DRAFT — PROVISIONAL, NOT FOR PUBLICATION</div>` : ''}
  </div>

  ${toc}

  ${body.join('\n')}
</body></html>`;
}

/**
 * Current rendered structure of a catalog — the top-level sections plus, for the programs section,
 * each discipline and the programs nested under it (after presentation overrides). The correction
 * agent uses this so it targets the exact headings the registrar sees in the PDF.
 */
export async function getProgramStructure(catalogId: string): Promise<{
  sections: string[];
  disciplines: { discipline: string; programs: string[] }[];
}> {
  const chunks = await query(
    `SELECT section_header FROM semantic_chunks
       WHERE document_id = $1 AND (section_header IS NULL OR section_header NOT ILIKE '%table of contents%')
       ORDER BY sequence_order NULLS LAST, page_number NULLS LAST`,
    [catalogId]
  );
  const ovRaw = (await query('SELECT presentation_overrides FROM documents WHERE id = $1', [catalogId]))[0]?.presentation_overrides;
  const overrides: PresentationOverride[] = Array.isArray(ovRaw) ? ovRaw : (typeof ovRaw === 'string' ? JSON.parse(ovRaw || '[]') : []);
  const ov = overrideIndex(overrides);

  // Top-level sections, in order (consecutive de-dupe).
  const sections: string[] = [];
  let last: string | null = null;
  for (const ch of chunks) {
    const h1 = header1Of(ch.section_header);
    if (h1 !== last) { sections.push(h1); last = h1; }
  }

  // Program Header-2 subgroups within the programs section, grouped into disciplines.
  const subs: { h2: string }[] = [];
  let h2: string | null = null;
  for (const ch of chunks) {
    if (!isProgramsLabel(header1Of(ch.section_header))) continue;
    const cur = header2Of(ch.section_header);
    if (cur !== h2) { subs.push({ h2: cur || '' }); h2 = cur; }
  }
  const { order, map } = groupPrograms(subs, ov.regroup);
  const disciplines = order
    .filter((d) => !ov.hidden('discipline', d))
    .map((d) => ({
      discipline: ov.rename('discipline', d),
      programs: map.get(d)!
        .map((i) => subs[i].h2.replace(/\s+$/, '').trim())
        .filter((l) => l && normLabel(l) !== normLabel(d) && !ov.hidden('program', l))
        .map((l) => ov.rename('program', l)),
    }));

  return {
    sections: sections.filter((s) => !ov.hidden('section', s)).map((s) => ov.rename('section', s)),
    disciplines,
  };
}

/** Render catalog HTML to PDF bytes via the Cloud Run WeasyPrint endpoint. */
export async function renderCatalogPdf(html: string): Promise<Buffer> {
  const res = await fetch(`${API_BASE_URL}/api/agent/render-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html }),
  });
  if (!res.ok) throw new Error(`PDF render failed: ${res.status} ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('PDF render returned invalid output.');
  }
  return buf;
}
