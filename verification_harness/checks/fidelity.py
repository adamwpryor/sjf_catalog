"""Class B — field fidelity (``DOUBLE_CHECK.md`` §6).

``B1``/``B5`` are exact comparisons. ``B4`` (prerequisites) is layered the way §5 Risk A layered
``B2``, and for the same reason: the first live Tier 2 run reported ~300 prerequisite defects on a
*partial* flagship pass, and reading them showed they were **one** systemic ingest behaviour restated
per course. Sending that to a model was paying LLM rates to rediscover a parser bug 217 times.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from ..models import Finding
from ..normalize import page_from_url
from .coverage import courses_by_code
from .registry import CheckContext, make_finding, register


@register("B1", tier=1, needs_pages=True, title="Fidelity: Credits mismatch")
def check_b1(ctx: CheckContext) -> Iterator[Finding]:
    db_courses = {c["course_code"].strip(): c for c in ctx.db.courses if c.get("course_code")}

    for page_num, page_facts in ctx.pages.items():
        # Grouped by code: a code repeated on one page is one entity, so one finding — see
        # `courses_by_code`. Differing credits between the occurrences are named in the claim.
        for code, occurrences in courses_by_code(page_facts).items():
            db_c = db_courses.get(code)
            if not db_c:
                continue

            db_credits_str = str(db_c.get("credits")).strip() if db_c.get("credits") is not None else None

            if db_credits_str and db_credits_str.isdigit():
                db_credits = int(db_credits_str)
                page_credits = [c.credits for c in occurrences if c.credits is not None]
                mismatched = sorted({c for c in page_credits if c != db_credits})
                if mismatched:
                    page_says = " or ".join(str(c) for c in mismatched)
                    yield make_finding(
                        ctx,
                        check="B1",
                        severity="high",
                        entity_type="course",
                        entity_key=code,
                        entity_id=db_c["id"],
                        claim=f"Credits mismatch for {code}: page says {page_says}, DB says {db_credits}",
                        page=page_num,
                        evidence_db=str(db_credits),
                        ancestor_path=occurrences[0].ancestor_path
                    )

#: A prerequisite line in a course body: ``Prerequisite: …``, ``**Prerequisites:** …``, ``Prereq …``.
_PREREQ_LINE = re.compile(r"^\s*\**\s*(?:pre-?req(?:uisite)?s?)\b\s*:?\s*\**\s*(.*)$", re.IGNORECASE)

#: A course code anywhere in prose, tolerating ``BIOL-152`` / ``BIOL 152`` / ``BIOL152``.
_CODE_IN_TEXT = re.compile(r"\b([A-Z]{2,5})[\s\-]?(\d{3,4}[A-Z]?)\b")

#: A minimum-grade qualifier. The corpus writes it as a bare token after the code (``MGMT-357 D-``)
#: far more often than in words, which is exactly why the ingest drops it.
_GRADE_QUALIFIER = re.compile(r"\b[A-D][+\-]\B|\bminimum grade|\bgrade of\s+[A-D]|or better", re.IGNORECASE)

#: Trailing letter suffix on a course code (trap T3): ``BIOL 152D`` vs ``BIOL 152``.
_CODE_SUFFIX = re.compile(r"([A-Z]{2,5} \d{3,4})[A-Z]$")


def _course_body(ctx: CheckContext, page: int, heading_line: int) -> str:
    """Return the page text belonging to one course, from its heading to the next.

    Slicing here rather than in ``extract/`` is deliberate: the extractor is Gemini's under P1, and
    the drift guard pins its output shape. A check that needs body text can cut it from the raw page
    without widening the parser contract.

    Args:
        ctx: The version's context (supplies ``page_texts``).
        page: Page number.
        heading_line: 1-based line of the course heading.

    Returns:
        The body text under that heading, empty if the page is unavailable.
    """
    assert ctx.pages is not None and ctx.page_texts is not None
    text = ctx.page_texts.get(page)
    if not text:
        return ""
    facts = ctx.pages[page]
    lines = text.splitlines()
    marks = sorted({c.heading_line for c in facts.courses} | {h.line for h in facts.headings})
    end = next((m for m in marks if m > heading_line), len(lines) + 1)
    return "\n".join(lines[heading_line : end - 1])


def _prereq_statement(body: str) -> str | None:
    """Return the prerequisite statement in a course body, or ``None`` if it states none."""
    for line in body.splitlines():
        match = _PREREQ_LINE.match(line)
        if match:
            return match.group(1).strip()
    return None


def _codes(text: str) -> set[str]:
    """Return normalized course codes mentioned in a prerequisite statement."""
    return {f"{prefix} {number}" for prefix, number in _CODE_IN_TEXT.findall(text or "")}


def _drop_suffix(code: str) -> str:
    """Strip a trailing letter suffix so ``BIOL 152D`` compares equal to ``BIOL 152`` (trap T3)."""
    return _CODE_SUFFIX.sub(r"\1", code)


@register("B4", tier=1, needs_pages=True, title="Fidelity: prerequisites vs the page, by defect class")
def check_b4(ctx: CheckContext) -> Iterator[Finding]:
    """Compare ``courses.prerequisites`` against the claimed page, reporting classes not rows.

    Each row is compared against **the page its own ``markdown_url`` names**, not against every page
    the code appears on. That direction matters: 201 flagship courses are defined on more than one
    page, and comparing against all of them manufactures a defect every time a course is also listed
    in a program's requirements section.

    Four of the five outcomes are *systemic* — one ingest behaviour restated per course — so they are
    reported as **per-catalog aggregates carrying the full affected code list**, exactly as ``C6``
    was redesigned in Phase 1 after it flooded with 4,915 findings. Measured on the flagship:

    - **217 rows drop a minimum-grade qualifier** (``MGMT-357 D-`` → ``MGMT-357``). One parser fix.
    - **17 rows drop an ``OR``** — a student must take *one of* these, not *all* of them. Separate
      class and higher severity than the grade loss, because it changes what the requirement means.
    - **64 rows are NULL where the page states a prerequisite** (coverage gap).
    - **115 rows carry a prerequisite the claimed page does not state.** Emitted ``AMBIGUOUS``, not
      as a defect: the value may have a provenance this check cannot see. This is the residue a Tier
      2 pass should adjudicate, mirroring ``B2``/``B2R``; that check is **not built yet**, so the
      aggregate stands as an open question rather than an answered one.

    Only **code-set differences are per-course** (27 rows), because there the defect *is* the row:
    the database names different courses than the page does. Suffix-only differences are trap T3 and
    are excluded — ``BIOL 152`` vs ``BIOL 152D`` is prose dropping a suffix, not a wrong course.
    """
    assert ctx.pages is not None
    classes: dict[str, list[tuple[str, str]]] = {
        "grade_dropped": [], "or_dropped": [], "db_null": [], "page_silent": [], "t3_suffix": [],
    }

    for row in ctx.db.courses:
        code = (row.get("course_code") or "").strip()
        if not code or row.get("is_ghost"):
            continue
        page = page_from_url(row.get("markdown_url"))
        if page is None or page not in ctx.pages:
            continue  # A4 owns unlinked rows; A2 owns a page that does not define the course
        occurrences = courses_by_code(ctx.pages[page]).get(code)
        if not occurrences:
            continue

        statement = _prereq_statement(_course_body(ctx, page, occurrences[0].heading_line))
        stored = (row.get("prerequisites") or "").strip()
        if not statement and not stored:
            continue
        if not stored:
            classes["db_null"].append((code, (statement or "")[:80]))
            continue
        if not statement:
            classes["page_silent"].append((code, stored[:80]))
            continue

        page_codes, db_codes = _codes(statement), _codes(stored)
        if page_codes != db_codes:
            if {_drop_suffix(c) for c in page_codes} == {_drop_suffix(c) for c in db_codes}:
                classes["t3_suffix"].append((code, f"page={sorted(page_codes)} db={sorted(db_codes)}"))
            else:
                yield make_finding(
                    ctx,
                    check="B4",
                    severity="critical",
                    entity_type="course",
                    entity_key=code,
                    entity_id=str(row["id"]),
                    claim=(
                        f"Prerequisites for {code} name different courses than the page: page "
                        f"requires {sorted(page_codes)}, DB stores {sorted(db_codes)}"
                    ),
                    page=page,
                    evidence_page=statement[:300],
                    evidence_db=stored[:300],
                    ancestor_path=occurrences[0].ancestor_path,
                    suggested_fix="Re-parse the prerequisite line; the stored course set is wrong.",
                )
            continue

        if _GRADE_QUALIFIER.search(statement) and not _GRADE_QUALIFIER.search(stored):
            classes["grade_dropped"].append((code, statement[:80]))
        elif " or " in statement.lower() and " or " not in stored.lower():
            classes["or_dropped"].append((code, statement[:80]))

    yield from _b4_aggregates(ctx, classes)


#: ``(claim, severity, verdict)`` per systemic ``B4`` class. Severity follows §10: dropping an ``OR``
#: changes what a student must take, so it outranks losing a grade qualifier.
_B4_CLASSES: dict[str, tuple[str, str, str]] = {
    "grade_dropped": (
        "the stored prerequisite drops the minimum-grade qualifier the page states",
        "medium", "CONFIRMED",
    ),
    "or_dropped": (
        "the stored prerequisite drops an 'or', turning alternatives into requirements",
        "high", "CONFIRMED",
    ),
    "db_null": (
        "the page states a prerequisite and the stored value is NULL",
        "high", "CONFIRMED",
    ),
    "page_silent": (
        "a prerequisite is stored that the claimed page does not state",
        "medium", "AMBIGUOUS",
    ),
    "t3_suffix": (
        "page and DB prerequisite codes differ only by a letter suffix (trap T3, not a defect)",
        "info", "AMBIGUOUS",
    ),
}


def _b4_aggregates(
    ctx: CheckContext, classes: dict[str, list[tuple[str, str]]]
) -> Iterator[Finding]:
    """Emit one finding per systemic prerequisite class, carrying every affected code.

    The full list travels in ``evidence_db`` rather than being sampled, so remediation has the whole
    population without re-running the check — the aggregate compresses the *claim*, never the scope.
    """
    for name, rows in classes.items():
        if not rows:
            continue
        claim, severity, verdict = _B4_CLASSES[name]
        examples = "; ".join(f"{code}: {detail}" for code, detail in rows[:3])
        yield make_finding(
            ctx,
            check="B4",
            severity=severity,
            entity_type="course",
            entity_key=f"prerequisites:{name}",
            claim=(
                f"{len(rows)} course(s) in {ctx.version}: {claim}. This is one ingest behaviour, "
                f"not {len(rows)} independent defects. Examples — {examples}"
            ),
            evidence_page=examples[:500],
            evidence_db=",".join(code for code, _ in sorted(rows)),
            verdict=verdict,
            confidence=1.0 if verdict == "CONFIRMED" else 0.5,
            suggested_fix=(
                None if verdict == "AMBIGUOUS"
                else "Fix the prerequisite parser, then re-ingest the listed courses."
            ),
        )


@register("B5", tier=1, needs_pages=True, title="Fidelity: Course suffix/prefix anomaly")
def check_b5(ctx: CheckContext) -> Iterator[Finding]:
    db_codes = {c["course_code"].strip() for c in ctx.db.courses if c.get("course_code")}
    db_codes_stripped = {c.replace(" ", ""): c for c in db_codes}

    for page_num, page_facts in ctx.pages.items():
        for code, occurrences in courses_by_code(page_facts).items():
            if code not in db_codes:
                stripped_code = code.replace(" ", "")
                if stripped_code in db_codes_stripped:
                    db_code = db_codes_stripped[stripped_code]
                    yield make_finding(
                        ctx,
                        check="B5",
                        severity="medium",
                        entity_type="course",
                        entity_key=code,
                        claim=f"Course code suffix/prefix anomaly: page says '{code}', DB says '{db_code}'",
                        page=page_num,
                        ancestor_path=occurrences[0].ancestor_path
                    )
