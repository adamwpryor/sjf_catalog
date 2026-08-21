"""Catalog entity extractor for self-serve ingestion.

Derives courses, programs, and the prerequisite graph from the catalog's own markdown pages.

Design note — why so little of this calls a model. The catalog's course blocks are highly
regular: a heading carrying code/title/credits, prose, then labelled metadata lines. Every field
this module produces is *stated on the page*, so reading it is a parsing problem, not a semantic
one. ``DOUBLE_CHECK.md`` P2 reserves model calls for questions no string comparison can decide, and
paying per token to re-read ``Pre-requisites: ECON-221 D-`` would be exactly the mistake ``B4`` made
before it was moved back to deterministic code. The ``provider`` seam exists for genuinely
ambiguous cases and is passed to :func:`extract_catalog_from_pages`; it is not invoked for the
regular shapes below, and a caller can see from ``ExtractedCatalogData.provider_calls`` that it was
not used.

**Nothing here invents data.** A field the page does not state is left empty and counted, never
filled with a plausible-looking default. An earlier revision of this module manufactured
prerequisite edges from course-code adjacency, wrote ``f"{name} program description."`` as program
overview text, and linked the catalog's first five courses to every program; those rows were
well-formed, passed a non-zero check, and were fiction.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from verification_harness.extract.ast_extractor import extract_facts

from .provider import SelfServeInferenceProvider

#: Labelled metadata lines that follow a course description. These are NOT part of the description
#: — the database has no column for most of them, a known gap owned by check ``B6``. Matching them
#: is what keeps "Attributes: YLIB" out of the prose.
_META_LABEL = re.compile(
    r"^\s*(pre-?requisites?|co-?requisites?|attributes?|typically offered|formerly titled|"
    r"placement|restrictions?|cross-?listed)\s*:",
    re.IGNORECASE,
)

#: Degree suffixes used in program names, in the order the database writes them.
_DEGREE = r"B\.?A\.?|B\.?S\.?|B\.?F\.?A\.?|M\.?A\.?|M\.?S\.?|M\.?B\.?A\.?|Ph\.?D\.?"

#: Headings that look program-shaped but are section or index headings, not programs:
#: "Biology (Minor) Courses" lists courses, "B.A. Degrees with HEGIS Codes" is a table of contents.
_NOT_A_PROGRAM = re.compile(
    r"(\bcourses\b\s*$|\bdegrees\b|\bhegis\b|\bprograms of study\b|\brequirements\b\s*$|"
    r"\bcourse descriptions\b|\bindex\b)",
    re.IGNORECASE,
)

#: A course code as written on the page (``ECON-221``, ``BIOL-131L``, ``AMST-300D``).
_PAGE_CODE = re.compile(r"\b([A-Z]{2,5})-(\d{2,4}[A-Z]?)\b")

#: Minimum-grade tokens that trail a code in a prerequisite expression (``D-``, ``C``, ``B+``).
_GRADE_TOKEN = re.compile(r"^[A-D][+-]?$")


def _normalize_code(raw: str) -> str:
    """Convert a page-form course code to the database form.

    Pages write ``ECON-221``; the ``courses.course_code`` column stores ``ECON 221``.

    Args:
        raw: Course code as it appears in page markdown.

    Returns:
        The code with its separator normalized to a single space.
    """
    return re.sub(r"\s*-\s*", " ", raw.strip(), count=1)


#: Any markdown ATX heading. Used to find where a course block ends.
_ANY_HEADING = re.compile(r"^#{1,6}\s+\S")


def _course_bodies(
    pages: list[tuple[int, str, str]],
    facts_by_page: dict[int, Any],
) -> dict[str, str]:
    """Slice the whole catalog into per-course body text.

    Bodies are sliced from a **catalog-wide** line stream rather than page by page, because course
    blocks routinely run past a page boundary: the corpus is a paginated web scrape, so a heading
    near the foot of one page has its description and ``Pre-requisites:`` line on the next. Slicing
    per page silently truncates those courses — measured at 120 of 474 prerequisite lines lost, and
    the loss is invisible because the truncated course still has a plausible partial description.

    Args:
        pages: ``(page_number, markdown_content, markdown_url)`` in page order.
        facts_by_page: ``PageFacts`` per page number, providing ``heading_line`` per course.

    Returns:
        Mapping of course code to the raw body text beneath its heading. First occurrence wins;
        a repeated code keeps the body that carries the most detail.
    """
    stream: list[str] = []
    page_offset: dict[int, int] = {}
    for page_num, content, _ in pages:
        page_offset[page_num] = len(stream)
        stream.extend(content.splitlines())

    heading_rows = [i for i, line in enumerate(stream) if _ANY_HEADING.match(line)]

    bodies: dict[str, str] = {}
    for page_num, _, _ in pages:
        facts = facts_by_page[page_num]
        for course in facts.courses:
            if not course.heading_line or course.heading_line <= 0:
                continue
            start = page_offset[page_num] + course.heading_line
            later = [r for r in heading_rows if r >= start]
            end = later[0] if later else len(stream)
            body = "\n".join(stream[start:end]).strip()
            # A code can appear on several pages; keep whichever occurrence says more.
            if len(body) > len(bodies.get(course.code, "")):
                bodies[course.code] = body
    return bodies


def _parse_body(body: str) -> tuple[str, dict[str, str]]:
    """Separate a course body into its description and its labelled metadata.

    Args:
        body: Raw text beneath a course heading.

    Returns:
        ``(description, metadata)`` where description is the prose with metadata lines removed and
        metadata maps a lowercased label to its value.
    """
    description_parts: list[str] = []
    metadata: dict[str, str] = {}
    current_label: str | None = None

    for line in body.splitlines():
        match = _META_LABEL.match(line)
        if match:
            current_label = match.group(1).lower().replace("-", "")
            metadata[current_label] = line.split(":", 1)[1].strip()
            continue
        if not line.strip():
            current_label = None
            continue
        if current_label:
            # Continuation of a metadata block, e.g. the value under "Typically offered:".
            metadata[current_label] = f"{metadata[current_label]} {line.strip()}".strip()
            continue
        description_parts.append(line.strip())

    return " ".join(description_parts).strip(), metadata


def _normalize_program_name(text: str) -> str:
    """Render a program heading in the convention the ``programs`` table already uses.

    Catalog pages write ``"B.A. in Biology"`` and ``"AI Literacy (Minor)"``; existing rows are
    stored as ``"Biology B.A."`` and ``"AI Literacy Minor"``. Both ingestion paths write the same
    table, so emitting the page's wording would create a second naming family for the same
    programs — the duplicate-name problem the requirement backfill already has to work around.

    Args:
        text: Heading text as written on the page.

    Returns:
        The program name with its degree designation moved to the end.
    """
    name = text.strip()
    inverted = re.match(rf"^({_DEGREE})\s+in\s+(.+)$", name, re.IGNORECASE)
    if inverted:
        return f"{inverted.group(2).strip()} {inverted.group(1).strip()}"
    parenthesised = re.match(r"^(.+?)\s*\((Minor|Certificate)\)\s*$", name, re.IGNORECASE)
    if parenthesised:
        return f"{parenthesised.group(1).strip()} {parenthesised.group(2).strip()}"
    return name


def _prereq_codes(expression: str) -> list[str]:
    """Pull course codes out of a prerequisite expression.

    Handles the corpus form ``ECON-221 D- OR PSYC-201 D- AND SOCI-120 D-``. Grade thresholds and
    the AND/OR structure are deliberately not modelled: this table stores edges, and the full
    boolean logic lives in the ``course_prereq_blocks`` / ``course_prereq_edges`` model, which is
    out of scope here (see the census in ``loader.py``).

    Args:
        expression: Text following a ``Pre-requisites:`` label.

    Returns:
        Normalized course codes, de-duplicated, in order of appearance.
    """
    seen: list[str] = []
    for subject, number in _PAGE_CODE.findall(expression):
        code = _normalize_code(f"{subject}-{number}")
        if code not in seen:
            seen.append(code)
    return seen


@dataclass
class ExtractedCatalogData:
    """Contract rows derived from a catalog's pages, plus provenance counters."""

    courses: list[dict[str, Any]] = field(default_factory=list)
    programs: list[dict[str, Any]] = field(default_factory=list)
    program_requirements: list[dict[str, Any]] = field(default_factory=list)
    program_requirement_courses: list[dict[str, Any]] = field(default_factory=list)
    course_prerequisite_links: list[dict[str, Any]] = field(default_factory=list)

    #: Counters reported by the CLI so coverage is visible rather than assumed.
    stats: dict[str, int] = field(default_factory=dict)
    #: Prerequisite codes named on a page that match no course in this catalog.
    unresolved_prereqs: list[str] = field(default_factory=list)
    #: Number of model calls made. Zero is expected; see the module docstring.
    provider_calls: int = 0


def extract_catalog_from_pages(
    pages: list[tuple[int, str, str]],
    document_id: str,
    catalog_version: str,
    tenant_id: str = "SJFU",
    provider: SelfServeInferenceProvider | None = None,
) -> ExtractedCatalogData:
    """Extract catalog entities from a catalog's markdown pages.

    Args:
        pages: ``(page_number, markdown_content, markdown_url)`` per page.
        document_id: Parent ``documents`` row id.
        catalog_version: Full catalog key, e.g. ``"2025-2026-undergraduate"``.
        tenant_id: Tenant code written to every row; every catalog table declares it NOT NULL.
        provider: Model seam for genuinely ambiguous extractions. Unused by the regular shapes
            handled here; retained so an ambiguous-case path can be added without re-plumbing.

    Returns:
        Populated :class:`ExtractedCatalogData`.
    """
    result = ExtractedCatalogData()
    code_to_id: dict[str, str] = {}
    program_names: set[str] = set()
    pending_prereqs: list[tuple[str, list[str]]] = []
    with_description = 0
    with_prereq_text = 0

    # Parse every page once, then slice course bodies from a catalog-wide stream so blocks that
    # run past a page boundary stay intact.
    facts_by_page = {
        page_num: extract_facts(content, catalog_version, page_num)
        for page_num, content, _ in pages
    }
    bodies = _course_bodies(pages, facts_by_page)

    for page_num, content, url in pages:
        facts = facts_by_page[page_num]

        for course in facts.courses:
            if course.code in code_to_id:
                continue
            course_id = str(uuid.uuid4())
            code_to_id[course.code] = course_id

            description, metadata = _parse_body(bodies.get(course.code, ""))
            prereq_text = metadata.get("prerequisites", "") or metadata.get("prerequisite", "")
            if description:
                with_description += 1
            if prereq_text:
                with_prereq_text += 1
                pending_prereqs.append((course.code, _prereq_codes(prereq_text)))

            result.courses.append(
                {
                    "id": course_id,
                    "tenant_id": tenant_id,
                    "document_id": document_id,
                    "course_code": course.code,
                    "title": course.title,
                    "credits": course.credits,
                    "description": description,
                    "prerequisites": prereq_text,
                    "markdown_url": url,
                    "is_ghost": False,
                }
            )

        for heading in facts.headings:
            text = heading.text.strip()
            if len(text) > 120:
                continue
            if not re.search(rf"\b({_DEGREE}|Minor|Certificate)\b", text, re.IGNORECASE):
                continue
            if _NOT_A_PROGRAM.search(text):
                continue
            name = _normalize_program_name(text)
            if name in program_names:
                continue
            program_names.add(name)
            degree_type = "Minor" if re.search(r"\bMinor\b", text, re.IGNORECASE) else (
                "Certificate" if re.search(r"\bCertificate\b", text, re.IGNORECASE) else (
                    "Graduate" if "graduate" in catalog_version else "Undergraduate"
                )
            )
            result.programs.append(
                {
                    "id": str(uuid.uuid4()),
                    "tenant_id": tenant_id,
                    "document_id": document_id,
                    "name": name,
                    "degree_type": degree_type,
                    # total_credits is left NULL rather than 0: the page does not state it here,
                    # and 0 would read downstream as "this program requires no credits".
                    "total_credits": None,
                    "markdown_url": url,
                }
            )

    # Prerequisite edges, resolved only against courses that exist in this catalog. A code naming
    # a course not in this corpus is recorded as unresolved rather than dropped silently or
    # invented — an unresolved code usually means a cross-catalog reference or a page defect.
    for course_code, prereq_codes in pending_prereqs:
        course_id = code_to_id[course_code]
        for prereq_code in prereq_codes:
            target = code_to_id.get(prereq_code)
            if target is None:
                result.unresolved_prereqs.append(prereq_code)
                continue
            if target == course_id:
                continue
            result.course_prerequisite_links.append(
                {
                    "id": str(uuid.uuid4()),
                    "tenant_id": tenant_id,
                    "course_id": course_id,
                    "prereq_course_id": target,
                }
            )

    # program_requirements / program_requirement_courses are deliberately NOT produced here.
    # Deriving them means matching a program's catalog section to its requirement listings, which
    # `scripts/backfill_program_requirements.mjs` already does from chunk breadcrumbs. Emitting
    # plausible rows instead would defeat the non-zero contract invariant, which exists to detect
    # exactly this table coming back empty. The loader's census reports both as not populated.

    result.stats = {
        "pages": len(pages),
        "courses": len(result.courses),
        "courses_with_description": with_description,
        "courses_with_prereq_text": with_prereq_text,
        "programs": len(result.programs),
        "prereq_edges": len(result.course_prerequisite_links),
        "prereq_codes_unresolved": len(result.unresolved_prereqs),
    }
    return result
