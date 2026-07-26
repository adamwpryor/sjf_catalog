"""Class D — heading redundancy & duplication checks (``DOUBLE_CHECK.md`` §6).

D2 (duplicate course rows) is pure-DB and runs now. The heading-hierarchy checks (D1, D5, D6, D7)
need Tier 0 ``PageFacts`` with ``ancestor_path`` — the whole point of Risk C — so they are
registered ``needs_pages`` and run once the extractor lands. D3/D4 (duplicate program families /
same course on multiple pages) need care to avoid false positives and are noted for a later pass.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from collections.abc import Iterator

from ..models import Finding
from ..normalize import normalize_course_code, normalize_text
from .registry import CheckContext, make_finding, register

#: Structural, non-entity headings that legitimately recur across pages. Inventoried by D6 and
#: excluded from D1 so a course-list template does not read as a hundred duplicate-entity findings.
_BOILERPLATE: frozenset[str] = frozenset(
    normalize_text(h)
    for h in (
        "Requirements", "Program Requirements", "Course Requirements", "Prerequisites",
        "Prerequisite", "Corequisites", "Typically offered", "Attributes", "Note", "Notes",
        "Learning Outcomes", "Program Learning Outcomes", "Description", "Overview", "Policies",
        "Curriculum", "Electives", "Core Requirements", "Admission Requirements",
    )
)

#: Trailing "Program"/"Programs" — the known-good heading suffix from the backfill (D7 / trap T10).
_TRAILING_PROGRAM = re.compile(r"\s+programs?$")

#: A course code inside a heading (e.g. ``## HIST-301 …``). D1 keys on these so it flags genuine
#: entity duplication rather than the structural headings (``Faculty Listing``, section names) that
#: legitimately recur on many pages.
_CODE_IN_HEADING = re.compile(r"\b[A-Z]{2,6}[- ]\d{3,4}[A-Z]?\b")


@register("D2", title="duplicate course rows for the same code within a catalog")
def d2_duplicate_courses(ctx: CheckContext) -> Iterator[Finding]:
    """Flag course codes with more than one row in the same catalog version.

    Uses normalized codes so ``HIST-301``/``HIST 301`` count as one. One finding per duplicated
    code, listing the row ids.
    """
    by_code: dict[str, list[dict]] = defaultdict(list)
    for course in ctx.db.courses:
        code = normalize_course_code(course.get("course_code"))
        if code:
            by_code[code].append(course)
    for code, rows in by_code.items():
        if len(rows) > 1:
            ids = ", ".join(str(r["id"]) for r in rows)
            yield make_finding(
                ctx,
                "D2",
                severity="medium",
                entity_type="course",
                entity_key=code,
                claim=f"{len(rows)} course rows share code {code} in {ctx.version}",
                evidence_db=f"ids=[{ids}]",
            )


# --- Page-dependent D-checks -------------------------------------------------------------------


@register("D1", needs_pages=True, title="course heading appearing on multiple pages")
def d1_duplicate_headings(ctx: CheckContext) -> Iterator[Finding]:
    """Flag a *course* heading (one bearing a course code) that appears on more than one page.

    Restricted to course-code headings so it surfaces genuine entity duplication / cross-listing
    (a description appearing twice) rather than the structural headings — ``Faculty Listing``,
    section titles — that legitimately recur across a catalog (those are D6's census). Reported
    ``low`` with the page list; ``ancestor_path`` (Risk C) tells a real duplicate from a ToC entry.
    """
    pages_by_code: dict[str, set[int]] = defaultdict(set)
    display: dict[str, str] = {}
    for page, facts in (ctx.pages or {}).items():
        for heading in facts.headings:
            match = _CODE_IN_HEADING.search(heading.text)
            if not match:
                continue
            code = normalize_course_code(match.group(0))
            pages_by_code[code].add(page)
            display.setdefault(code, heading.text)
    for code, pages in pages_by_code.items():
        if len(pages) > 1:
            listed = ", ".join(str(p) for p in sorted(pages)[:10])
            yield make_finding(
                ctx,
                "D1",
                severity="low",
                entity_type="course",
                entity_key=code,
                claim=f"course heading {display[code]!r} ({code}) appears on {len(pages)} pages",
                evidence_page=f"pages: {listed}",
            )


@register("D5", needs_pages=True, title="heading-level anomalies (level jumps, empty headings)")
def d5_heading_level_anomalies(ctx: CheckContext) -> Iterator[Finding]:
    """Flag empty headings and heading-level jumps greater than one within a page.

    A jump (e.g. ``##`` directly to ``####``) breaks the hierarchy that ``ancestor_path`` and every
    path-based check depend on. Reported ``low`` (often a PDF-parse artifact, not user-facing).
    """
    for page, facts in (ctx.pages or {}).items():
        prev_level: int | None = None
        for heading in facts.headings:
            if not heading.text.strip():
                yield make_finding(
                    ctx, "D5", severity="low", entity_type="page",
                    entity_key=f"{page}:L{heading.level}:empty", page=page,
                    claim=f"empty heading at level {heading.level}",
                    evidence_page=f"line {heading.line}",
                )
            if prev_level is not None and heading.level - prev_level > 1:
                yield make_finding(
                    ctx, "D5", severity="low", entity_type="page",
                    entity_key=f"{page}:line{heading.line}:jump", page=page,
                    claim=f"heading level jumps {prev_level} -> {heading.level} (skips a level)",
                    evidence_page=f"{heading.text!r} at line {heading.line}",
                )
            prev_level = heading.level


@register("D6", needs_pages=True, title="census of non-discriminating boilerplate headings")
def d6_boilerplate_heading_census(ctx: CheckContext) -> Iterator[Finding]:
    """Inventory how often each boilerplate heading recurs — ``info`` only, no defect implied.

    These recurring headings are the root of the match ambiguity the harness must reason around
    (spec §6 D6); counting them is the deliverable, not flagging them.
    """
    counts: Counter[str] = Counter()
    for facts in (ctx.pages or {}).values():
        for heading in facts.headings:
            norm = normalize_text(heading.text)
            if norm in _BOILERPLATE:
                counts[norm] += 1
    for norm, count in counts.most_common():
        yield make_finding(
            ctx, "D6", severity="info", entity_type="page", entity_key=norm,
            claim=f"boilerplate heading {norm!r} recurs {count} times across the catalog",
            evidence_page=f"count={count}",
        )


@register("D7", needs_pages=True, title="near-duplicate headings (trailing Program/Programs, emphasis)")
def d7_near_duplicate_headings(ctx: CheckContext) -> Iterator[Finding]:
    """Flag headings that collapse to the same text once a trailing 'Program(s)' is removed.

    Surfaces the exact spelling drift the backfill had to heal (``Nursing B.S.`` vs
    ``Nursing B.S. Program``) so it is visible rather than silently reconciled. Reported ``low``.
    """
    variants: dict[str, set[str]] = defaultdict(set)
    for facts in (ctx.pages or {}).values():
        for heading in facts.headings:
            norm = normalize_text(heading.text)
            canon = _TRAILING_PROGRAM.sub("", norm).strip()
            if canon:
                variants[canon].add(heading.text.strip())
    for canon, spellings in variants.items():
        if len(spellings) > 1:
            yield make_finding(
                ctx, "D7", severity="low", entity_type="page", entity_key=canon[:60],
                claim=f"{len(spellings)} heading spellings differ only by a trailing 'Program': {sorted(spellings)}",
                evidence_page=" | ".join(sorted(spellings)),
            )
