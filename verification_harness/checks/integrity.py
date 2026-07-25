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


def _classify_non_program(name: str) -> str | None:
    """Return why a ``programs.name`` is not a program, or ``None`` if it looks legitimate.

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
        kind = _classify_non_program(name)
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


# --- E1–E3: pending a DbFacts extension (child tables) -------------------------------------------
# E1  program_requirement_courses.course_code absent from courses (dangling requirement references)
# E2  courses.subject_id -> subjects.prefix disagrees with the course code's prefix
# E3  orphaned child rows (program_requirements / requirement_blocks with no live parent)
# These are pure-DB but need db.py to surface program_requirement_courses + subjects first.
