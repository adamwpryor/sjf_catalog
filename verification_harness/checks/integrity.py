"""Class E — referential integrity & row-sanity checks (``DOUBLE_CHECK.md`` §6).

E4 (rows in ``programs`` that are not programs) is pure-DB and runs now — it independently
rediscovers the §11 known-defect class (staff bios / section-header rows mis-ingested as programs).
E1–E3 need child tables (``program_requirement_courses``, ``subjects``) that ``db.py`` does not yet
surface; they are documented below and will be added once ``DbFacts`` is extended, rather than
opening ad-hoc connections (``db.py`` stays the single read-only entry point).
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from ..models import Finding
from ..normalize import normalize_course_code
from .registry import CheckContext, make_finding, register

#: A program "name" that is really a person's directory bio — contains a job title AND, usually,
#: their degrees + alma maters. These were ingested as programs and pruned 2026-07-13 (§11).
_STAFF_BIO = re.compile(
    r"\b(Librarian|Library Director|Head of|in Residence|Archivist|Access Services|Dean|Provost)\b",
    re.IGNORECASE,
)
_HAS_INSTITUTION = re.compile(r"\b(University|College)\b", re.IGNORECASE)

#: A program "name" that is really a section/aggregate heading, not a degree program.
_SECTION_HEADER = re.compile(
    r"^(Degrees and Certificates"
    r"|Graduate and Doctoral Degrees and Certificates"
    r"|Minors, Concentrations, and Certificate"
    r"|.*Language Proficiency Requirement)$",
    re.IGNORECASE,
)


def classify_non_program(name: str) -> str | None:
    """Return why a ``programs.name`` is not a program, or ``None`` if it looks legitimate.

    Shared with ``A4``, which must distinguish an unlinked *real* program from an unlinked row that
    was never a program to begin with — the same classification, so it lives in one place.

    Args:
        name: The ``programs.name`` value.

    Returns:
        ``"staff_bio"``, ``"section_header"``, or ``None``.
    """
    if not name:
        return None
    if _STAFF_BIO.search(name) or (_HAS_INSTITUTION.search(name) and "," in name):
        return "staff_bio"
    if _SECTION_HEADER.match(name.strip()):
        return "section_header"
    return None


@register("E4", title="rows in programs that are not academic programs")
def e4_non_program_rows(ctx: CheckContext) -> Iterator[Finding]:
    """Flag ``programs`` rows that are staff bios or section headers, not degree programs.

    Independently rediscovers the §11 defect class; surfacing the *class* (not a hard-coded row
    list) is the point (P6). Medium severity: these render as fake programs in the Program Library.
    """
    for program in ctx.db.programs:
        name = program.get("name") or ""
        kind = classify_non_program(name)
        if kind is None:
            continue
        yield make_finding(
            ctx,
            "E4",
            severity="medium",
            entity_type="program",
            entity_id=str(program["id"]),
            entity_key=name[:60],
            claim=f"'programs' row looks like a {kind}, not an academic program",
            evidence_db=f"name={name!r}, degree_type={program.get('degree_type')!r}",
            suggested_fix="Review for removal from programs (see bio_program_prune_backup precedent).",
        )


@register("E1", title="program requirement references a ghost (non-cataloged) course")
def e1_ghost_requirement_refs(ctx: CheckContext) -> Iterator[Finding]:
    """Report requirement entries pointing at a ``is_ghost`` course — one aggregate per catalog.

    A ghost course is referenced but not fully cataloged, so a requirement built on one cannot be
    satisfied by a real catalog course. This is a soft data-quality signal (``low``), and systemic
    when present, so it is one per-catalog aggregate with example codes (the C6 pattern), not one
    finding per requirement row.
    """
    ghosts = [rc for rc in ctx.db.requirement_courses if rc.get("course_is_ghost")]
    if ghosts:
        codes = sorted({str(rc.get("course_code")) for rc in ghosts if rc.get("course_code")})
        yield make_finding(
            ctx,
            "E1",
            severity="low",
            entity_type="program",
            entity_key=f"{ctx.version}:ghost-requirement-refs",
            claim=f"{len(ghosts)} program-requirement entries reference a ghost (non-cataloged) course",
            evidence_db=f"count={len(ghosts)}; courses: {', '.join(codes[:8])}",
        )


@register("E2", title="course subject_id prefix agrees with the course code prefix")
def e2_subject_prefix_matches_code(ctx: CheckContext) -> Iterator[Finding]:
    """Flag a course whose linked ``subjects.prefix`` disagrees with its own code prefix.

    ``HIST 301`` linked to a subject whose prefix is ``BIOL`` is a mis-linked subject — a
    consistency the database does not enforce. Reported ``medium``.
    """
    for course in ctx.db.courses:
        subject_prefix = course.get("subject_prefix")
        code = course.get("course_code")
        if not subject_prefix or not code:
            continue
        code_prefix = normalize_course_code(code).split(" ")[0]
        if code_prefix != subject_prefix.upper():
            yield make_finding(
                ctx,
                "E2",
                severity="medium",
                entity_type="course",
                entity_id=str(course["id"]),
                entity_key=str(code),
                claim=f"course code prefix {code_prefix!r} != subject prefix {subject_prefix.upper()!r}",
                evidence_db=f"course_code={code!r}, subject_prefix={subject_prefix!r}",
            )


@register("E3", title="program requirement references a course that does not resolve")
def e3_dangling_requirement_course(ctx: CheckContext) -> Iterator[Finding]:
    """Flag a requirement entry whose ``course_id`` resolves to no course row (a broken reference).

    Referential integrity is normally FK-enforced (this should find nothing), but the guard catches
    a future schema/CASCADE change that would silently orphan requirement rows. Reported ``high`` —
    a program requirement pointing at a non-existent course is a real structural break.
    """
    for rc in ctx.db.requirement_courses:
        if rc.get("course_id") is not None and rc.get("course_code") is None:
            yield make_finding(
                ctx,
                "E3",
                severity="high",
                entity_type="program",
                entity_id=str(rc.get("program_id")),
                entity_key=str(rc["id"]),
                claim="requirement references a course_id with no matching course row",
                evidence_db=f"requirement_id={rc.get('requirement_id')}, course_id={rc.get('course_id')}",
            )
# These are pure-DB but need db.py to surface program_requirement_courses + subjects first.
