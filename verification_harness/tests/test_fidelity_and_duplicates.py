"""``B4`` (prerequisites) and ``D8`` (same-page conflicting definitions).

Both checks exist because the first live Tier 2 run went wrong in instructive ways, so the tests pin
the corrections rather than the happy path:

- ``B4`` reports systemic prerequisite loss as **aggregates**. The failure being guarded against is
  a regression to per-row reporting, which produced ~300 findings on a partial pass and would be
  ~6,000 corpus-wide for what is one parser bug.
- ``D8`` reports a page that contradicts itself about a course. The failure being guarded against is
  it going quiet: every existing check passes these green, which is why nobody noticed 213 of them.
"""

from __future__ import annotations

from typing import Any

import pytest

from ..checks import fidelity, headings
from ..checks.registry import CheckContext
from ..db import DbFacts
from ..models import ExtractedCourse, ExtractedHeading, PageFacts

PAGE = """\
# Biology

### BIOL-311 Cell Biology (4)

Structure and function of the eukaryotic cell.

Prerequisite: BIOL-120C D- and BIOL-152 D- or CHEM-409

### BIOL-320 Genetics (3)

Principles of inheritance.
"""


def _ctx(courses: list[dict[str, Any]], page_text: str = PAGE) -> CheckContext:
    facts = PageFacts(
        catalog_version="v", page=311, page_role="content", leading_orphan_text=False,
        headings=[ExtractedHeading(level=1, line=1, text="Biology")],
        courses=[
            ExtractedCourse(code="BIOL 311", title="Cell Biology", credits=4, heading_line=3),
            ExtractedCourse(code="BIOL 320", title="Genetics", credits=3, heading_line=9),
        ],
    )
    return CheckContext(
        version="v",
        db=DbFacts(version="v", courses=courses),
        pages={311: facts},
        page_texts={311: page_text},
    )


def _course(code: str, prereq: str | None, **kw: Any) -> dict[str, Any]:
    return {
        "id": f"uuid-{code}", "course_code": code, "title": kw.get("title", "T"),
        "prerequisites": prereq, "is_ghost": kw.get("is_ghost", False),
        "markdown_url": kw.get("url", "gs://b/catalogs/SJFU/v/pages/page_0311.md"),
    }


# --- B4 ---------------------------------------------------------------------------

def test_grade_qualifier_loss_is_one_aggregate_not_many_findings() -> None:
    """Three rows losing the same qualifier produce ONE finding naming all three.

    This is the C6 correction: the claim is compressed, the scope is not. All three codes must
    survive in the finding so remediation has the full population without re-running the check.
    """
    ctx = _ctx([
        _course("BIOL 311", "BIOL-120C and BIOL-152 or CHEM-409"),
        _course("BIOL 320", "BIOL-120C and BIOL-152 or CHEM-409"),
    ])
    findings = [f for f in fidelity.check_b4(ctx) if f.entity_key == "prerequisites:grade_dropped"]
    assert len(findings) == 1
    assert findings[0].evidence_db is not None and "BIOL 311" in findings[0].evidence_db
    assert "one ingest behaviour" in findings[0].claim


def test_dropped_or_outranks_dropped_grade() -> None:
    """Losing an ``or`` changes what a student must take, so it is a separate, higher class.

    A dropped grade qualifier understates a requirement; a dropped ``or`` turns *one of these* into
    *all of these*. Same parser, different consequence for a student, so they must not share a
    severity or be merged into one class.
    """
    dropped_or = _ctx([_course("BIOL 311", "BIOL-120C D- and BIOL-152 D- and CHEM-409")])
    dropped_grade = _ctx([_course("BIOL 311", "BIOL-120C and BIOL-152 or CHEM-409")])
    or_finding = {f.entity_key: f for f in fidelity.check_b4(dropped_or)}["prerequisites:or_dropped"]
    grade_finding = {f.entity_key: f for f in fidelity.check_b4(dropped_grade)}[
        "prerequisites:grade_dropped"
    ]
    assert or_finding.severity == "high"
    assert grade_finding.severity == "medium"


def test_differing_course_codes_are_reported_per_course() -> None:
    """Where the defect IS the row, it is not aggregated away."""
    ctx = _ctx([_course("BIOL 311", "BIOL-120C D- and PHYS-999 D- or CHEM-409")])
    per_course = [f for f in fidelity.check_b4(ctx) if not f.entity_key.startswith("prerequisites:")]
    assert len(per_course) == 1
    assert per_course[0].severity == "critical"
    assert per_course[0].entity_key == "BIOL 311"
    assert "PHYS 999" in per_course[0].claim


def test_suffix_only_difference_is_trap_t3_not_a_defect() -> None:
    """``BIOL 152`` vs ``BIOL 152D`` is prose dropping a suffix (T3), never a wrong course."""
    ctx = _ctx([_course("BIOL 311", "BIOL-120C D- and BIOL-152D D- or CHEM-409D")])
    findings = list(fidelity.check_b4(ctx))
    assert not [f for f in findings if f.severity == "critical"]
    t3 = [f for f in findings if f.entity_key == "prerequisites:t3_suffix"]
    assert len(t3) == 1 and t3[0].severity == "info"


def test_stored_prereq_the_page_does_not_state_is_ambiguous_not_confirmed() -> None:
    """The row may have a provenance this check cannot see — so it asks, it does not assert."""
    ctx = _ctx([_course("BIOL 320", "BIOL-311")])
    findings = [f for f in fidelity.check_b4(ctx) if f.entity_key == "prerequisites:page_silent"]
    assert len(findings) == 1
    assert findings[0].verdict == "AMBIGUOUS"
    assert findings[0].suggested_fix is None, "an open question must not carry a fix"


def test_agreeing_prerequisites_produce_nothing() -> None:
    """The check must be capable of saying the data is fine."""
    ctx = _ctx([_course("BIOL 311", "BIOL-120C D- and BIOL-152 D- or CHEM-409")])
    assert list(fidelity.check_b4(ctx)) == []


def test_row_is_compared_against_the_page_it_claims() -> None:
    """A row whose ``markdown_url`` names another page is not judged against this one.

    201 flagship courses are defined on more than one page. Comparing against every page a code
    appears on manufactures a defect each time a course is also listed in a requirements section —
    which is exactly how the first measurement produced 174 phantom findings.
    """
    ctx = _ctx([_course("BIOL 311", "WRONG-101", url="gs://b/catalogs/SJFU/v/pages/page_0999.md")])
    assert list(fidelity.check_b4(ctx)) == []


# --- D8 ---------------------------------------------------------------------------

def _dup_ctx(titles: list[str], db_title: str | None) -> CheckContext:
    facts = PageFacts(
        catalog_version="v", page=139, page_role="content", leading_orphan_text=False,
        courses=[
            ExtractedCourse(code="ARTS 120", title=t, credits=3, heading_line=17 + 6 * i)
            for i, t in enumerate(titles)
        ],
    )
    courses = [_course("ARTS 120", None, title=db_title)] if db_title is not None else []
    return CheckContext(
        version="v", db=DbFacts(version="v", courses=courses),
        pages={139: facts}, page_texts={139: "x"},
    )


def test_conflicting_titles_on_one_page_are_reported() -> None:
    """The real ARTS-120 case: one page, one code, two titles, one surviving row."""
    ctx = _dup_ctx(["Basic Music Theory", "Music Theory"], "Basic Music Theory")
    findings = list(headings.check_d8(ctx))
    assert len(findings) == 1
    assert "'Music Theory'" in findings[0].claim
    assert "dropped" in findings[0].claim
    assert findings[0].auto_fixable is False, "which title is canonical is a human judgment"


def test_identical_repeat_is_layout_not_a_defect() -> None:
    """169 of the 382 same-page repeats are the identical heading twice. None is a defect."""
    assert list(headings.check_d8(_dup_ctx(["Music Theory", "Music Theory"], "Music Theory"))) == []


def test_abbreviation_of_the_same_title_does_not_fire() -> None:
    """D8 reuses B2's alignment, so a banner short form is not a contradiction."""
    ctx = _dup_ctx(["Introduction to Music Theory", "Intro to Music Theory"], "Intro to Music Theory")
    assert list(headings.check_d8(ctx)) == []


def test_d8_fires_even_when_the_db_title_matches_one_occurrence() -> None:
    """The case that is invisible today — 174 of 213 corpus-wide.

    B2 treats the DB title as reconciled when it matches *either* occurrence, which is correct for
    B2's question and is exactly what hides this. If this test ever passes as "no findings", D8 has
    silently acquired B2's blind spot and the class goes unreported again.
    """
    ctx = _dup_ctx(["Effec Prac: LOTE", "Diff Cur,Ins,Assess-LOTE"], "Effec Prac: LOTE")
    found = list(headings.check_d8(ctx))
    assert len(found) == 1
    assert "'Diff Cur,Ins,Assess-LOTE'" in found[0].claim


@pytest.mark.parametrize("db_title", [None, "Something Else Entirely"])
def test_d8_reports_the_conflict_regardless_of_what_the_db_holds(db_title: str | None) -> None:
    """The page contradicting itself is the finding; what the DB kept is context, not the trigger."""
    ctx = _dup_ctx(["Basic Music Theory", "Music Theory"], db_title)
    findings = list(headings.check_d8(ctx))
    assert len(findings) == 1
