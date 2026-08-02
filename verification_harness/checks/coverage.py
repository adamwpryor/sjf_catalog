import re
from collections.abc import Iterator

from ..models import ExtractedCourse, Finding, PageFacts
from ..normalize import page_from_url
from .integrity import classify_non_program
from .registry import CheckContext, make_finding, register


def courses_by_code(page_facts: PageFacts) -> dict[str, list[ExtractedCourse]]:
    """Group a page's extracted courses by code, preserving first-seen order.

    A source page can define the same code twice — ``2022-2023-undergraduate`` page 139 carries both
    ``### ARTS-120 Basic Music Theory (3)`` and ``### ARTS-120 Music Theory (3)``. Iterating raw
    occurrences would emit the *same claim about the same entity* twice, colliding on the
    ``{version}:{page}:{check}:{entity_key}`` finding id (P3). Checks therefore reason per code and
    report the repetition inside the claim, so the conflicting definition is visible rather than
    duplicated.

    Args:
        page_facts: One page's Tier 0 facts.

    Returns:
        Mapping of course code to every occurrence of it on that page, in page order.
    """
    grouped: dict[str, list[ExtractedCourse]] = {}
    for course in page_facts.courses:
        grouped.setdefault(course.code, []).append(course)
    return grouped


def _repeat_note(occurrences: list[ExtractedCourse]) -> str:
    """Return a claim suffix naming the conflicting titles when a code repeats on one page."""
    if len(occurrences) < 2:
        return ""
    titles = ", ".join(repr(c.title) for c in occurrences)
    return f" (defined {len(occurrences)}x on this page as {titles})"


@register("A1", tier=1, needs_pages=True, title="Coverage: Course on page but missing from DB")
def check_a1(ctx: CheckContext) -> Iterator[Finding]:
    db_codes = {c["course_code"].strip() for c in ctx.db.courses if c.get("course_code")}

    for page_num, page_facts in ctx.pages.items():
        for code, occurrences in courses_by_code(page_facts).items():
            if code not in db_codes:
                yield make_finding(
                    ctx,
                    check="A1",
                    severity="critical",
                    entity_type="course",
                    entity_key=code,
                    claim=(
                        f"Course {code} found on page {page_num} but missing from DB"
                        f"{_repeat_note(occurrences)}"
                    ),
                    page=page_num,
                    ancestor_path=occurrences[0].ancestor_path
                )

@register("A2", tier=1, needs_pages=True, title="Coverage: DB course missing from its target page")
def check_a2(ctx: CheckContext) -> Iterator[Finding]:
    for c in ctx.db.courses:
        if not c.get("markdown_url"):
            continue
            
        m = re.search(r'page_(\d+)\.md', c["markdown_url"])
        if not m:
            continue
            
        page_num = int(m.group(1))
        page_facts = ctx.pages.get(page_num)
        
        if not page_facts:
            yield make_finding(
                ctx,
                check="A2",
                severity="critical",
                entity_type="course",
                entity_key=c["course_code"],
                entity_id=c["id"],
                claim=f"Course {c['course_code']} points to page {page_num} which was not parsed",
                page=page_num,
                evidence_db=c["markdown_url"]
            )
            continue
            
        page_codes = {course.code for course in page_facts.courses}
        if c["course_code"] not in page_codes:
            yield make_finding(
                ctx,
                check="A2",
                severity="critical",
                entity_type="course",
                entity_key=c["course_code"],
                entity_id=c["id"],
                claim=f"Course {c['course_code']} missing from its target page {page_num}",
                page=page_num,
                evidence_db=c["markdown_url"]
            )

@register("A4", tier=1, title="Coverage: rows with markdown_url IS NULL, enumerated and classified")
def check_a4(ctx: CheckContext) -> Iterator[Finding]:
    """Enumerate and *classify* rows that link to no source page (``DOUBLE_CHECK.md`` §6 A4).

    The count alone is not a finding — §11 poses the question "genuine gap or matcher failure?", and
    answering it is this check's job. Three classes, reported at the granularity each deserves:

    - **Ghost courses** (``is_ghost``) are referenced in requirement lists but never defined by their
      own heading (trap T4), so having no page of their own is *correct*, not a defect. Reported as
      one ``info`` aggregate per catalog — per-row would be a 178-finding false-positive flood.
    - **Non-ghost unlinked courses** are real, cataloged courses the page matcher failed to link:
      genuine missing content, so ``high`` and enumerated per row.
    - **Unlinked programs** are split by :func:`classify_non_program`. A row that was never a program
      (section header, staff bio) is ``E4``'s to remediate, so A4 records it at ``info`` rather than
      double-reporting the defect; a legitimate program with no page is ``high``.
    """
    ghosts: list[str] = []
    for course in ctx.db.courses:
        if course.get("markdown_url"):
            continue
        code = str(course.get("course_code") or course["id"])
        if course.get("is_ghost"):
            ghosts.append(code)
            continue
        yield make_finding(
            ctx,
            "A4",
            severity="high",
            entity_type="course",
            entity_id=str(course["id"]),
            entity_key=code,
            claim=f"course {code} is cataloged (not a ghost) but links to no source page",
            evidence_db=f"markdown_url IS NULL, is_ghost=false, title={course.get('title')!r}",
            suggested_fix="Locate the course's defining heading and backfill markdown_url.",
        )

    if ghosts:
        yield make_finding(
            ctx,
            "A4",
            severity="info",
            entity_type="course",
            entity_key=f"{ctx.version}:ghost-courses-unlinked",
            claim=(
                f"{len(ghosts)} unlinked courses are ghosts (referenced in requirement lists, never "
                f"defined by a heading) — no source page is expected for these"
            ),
            evidence_db=f"count={len(ghosts)}; examples: {', '.join(sorted(ghosts)[:8])}",
        )

    for program in ctx.db.programs:
        if program.get("markdown_url"):
            continue
        name = str(program.get("name") or "")
        kind = classify_non_program(name)
        yield make_finding(
            ctx,
            "A4",
            severity="info" if kind else "high",
            entity_type="program",
            entity_id=str(program["id"]),
            entity_key=name[:60] or str(program["id"]),
            claim=(
                f"unlinked row is a {kind}, not a program — E4 owns its removal"
                if kind
                else f"program {name!r} links to no source page"
            ),
            evidence_db=f"markdown_url IS NULL, degree_type={program.get('degree_type')!r}",
            suggested_fix=(
                None if kind else "Locate the program's page heading and backfill markdown_url."
            ),
        )


@register("A6", tier=1, needs_pages=True, title="Coverage: is_ghost row that a page heading defines")
def check_a6(ctx: CheckContext) -> Iterator[Finding]:
    """Validate the ``is_ghost`` flag against the pages (``DOUBLE_CHECK.md`` §6 A6).

    A ghost is a course code the ingest saw *mentioned* in a requirement list but never found a
    definition for, so it carries a synthesized title (``"BIOL 322 (referenced; not in catalog)"``)
    and no description. That is correct handling of trap T4 — right up until the course turns out to
    have a heading after all, at which point the row is a placeholder standing in for real catalog
    content that was silently not ingested.

    Only the wrong direction is reported. A ghost with no heading anywhere in the catalog is the
    flag working as designed and yields nothing; A4 already inventories the ghost population.
    """
    defined_on: dict[str, list[int]] = {}
    for page_num, page_facts in sorted(ctx.pages.items()):
        # Definitions only — a code inside a requirement bullet is a mention (T4) and is exactly
        # what a ghost row is supposed to represent.
        for code in courses_by_code(page_facts):
            defined_on.setdefault(code, []).append(page_num)

    for course in ctx.db.courses:
        if not course.get("is_ghost"):
            continue
        code = (course.get("course_code") or "").strip()
        pages = defined_on.get(code)
        if not pages:
            continue
        yield make_finding(
            ctx,
            check="A6",
            severity="high",
            entity_type="course",
            entity_key=code,
            entity_id=str(course["id"]),
            claim=(
                f"{code} is flagged is_ghost (never defined in the catalog) but page "
                f"{pages[0]} defines it with a heading"
                + (f" (also on {pages[1:]})" if len(pages) > 1 else "")
                + " — the row is a placeholder for content that was not ingested"
            ),
            page=pages[0],
            evidence_db=f"is_ghost=true, title={course.get('title')!r}",
            suggested_fix=(
                f"Ingest the definition on page {pages[0]}: set title, description, credits, "
                "markdown_url, and clear is_ghost."
            ),
        )


@register("A5", tier=1, needs_pages=True, title="Coverage: Empty content page")
def check_a5(ctx: CheckContext) -> Iterator[Finding]:
    def _chunk_page(c):
        return c.get("page_number") if c.get("page_number") is not None else page_from_url(c.get("markdown_url"))
    
    chunk_pages = {_chunk_page(c) for c in ctx.db.chunks if _chunk_page(c) is not None}
    for page_num, page_facts in ctx.pages.items():
        if page_facts.page_role == "content" and not page_facts.courses and page_num not in chunk_pages:
            yield make_finding(
                ctx,
                check="A5",
                severity="high",
                entity_type="page",
                entity_key=str(page_num),
                claim=f"Page {page_num} is classified as 'content' but contains no courses or DB rows",
                page=page_num
            )
