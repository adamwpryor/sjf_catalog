"""Class D — heading redundancy & duplication checks (``DOUBLE_CHECK.md`` §6).

D2 (duplicate course rows) is pure-DB and runs now. The heading-hierarchy checks (D1, D5, D6, D7)
need Tier 0 ``PageFacts`` with ``ancestor_path`` — the whole point of Risk C — so they are
registered ``needs_pages`` and run once the extractor lands. D3/D4 (duplicate program families /
same course on multiple pages) need care to avoid false positives and are noted for a later pass.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator

from ..models import Finding
from ..normalize import normalize_course_code
from .registry import CheckContext, make_finding, register


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


# --- Page-dependent D-checks: registered now, skipped until Tier 0 extractor lands ---------------


@register("D1", needs_pages=True, title="identical heading text on multiple pages (disambiguate by ancestor_path)")
def d1_duplicate_headings(ctx: CheckContext) -> Iterator[Finding]:  # pragma: no cover - stub
    """Placeholder: needs PageFacts headings + ancestor_path (Risk C) to tell ToC from content."""
    return iter(())


@register("D5", needs_pages=True, title="heading-level anomalies (level jumps, stray '#', empty headings)")
def d5_heading_level_anomalies(ctx: CheckContext) -> Iterator[Finding]:  # pragma: no cover - stub
    """Placeholder: needs PageFacts heading levels."""
    return iter(())


@register("D6", needs_pages=True, title="census of non-discriminating headings, with full ancestor path")
def d6_boilerplate_heading_census(ctx: CheckContext) -> Iterator[Finding]:  # pragma: no cover - stub
    """Placeholder: inventory 'Requirements'/'Policies'-type headings by ancestor_path (info-level)."""
    return iter(())


@register("D7", needs_pages=True, title="near-duplicate headings (trailing Program/Programs, emphasis, punctuation)")
def d7_near_duplicate_headings(ctx: CheckContext) -> Iterator[Finding]:  # pragma: no cover - stub
    """Placeholder: needs PageFacts headings."""
    return iter(())
