"""``A3``, ``C7``, ``D3``, ``D4`` — the last four unimplemented spec checks.

Each of these had a naive reading that floods, and each test file section pins the narrower one:

- ``A3`` — "heading contains a credential token" matches 238 flagship headings, most of them ToC
  entries and policy sections. The check keys on how this catalog *names* programs instead.
- ``D3`` — collapsing naming families must not collapse *different degrees*, and must not fire on
  the section-header rows ``E4`` already owns.
- ``D4`` — 177 of 202 multi-page courses are legitimate repetition. Only disagreement is a defect.
- ``C7`` — the hash algorithm was derived from the data (``sha256(content)``), so the test pins the
  algorithm as much as the check.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest

from ..checks import coverage, headings, provenance
from ..checks.registry import CheckContext
from ..db import DbFacts
from ..models import ExtractedCourse, ExtractedHeading, PageFacts


def _pages(headings_: list[tuple[int, str]], courses: list[ExtractedCourse] | None = None):
    return {
        1: PageFacts(
            catalog_version="v", page=1, page_role="content", leading_orphan_text=False,
            headings=[ExtractedHeading(level=2, line=i, text=t) for i, t in headings_],
            courses=courses or [],
        )
    }


def _ctx(**kw: Any) -> CheckContext:
    return CheckContext(
        version="v",
        db=DbFacts(version="v", **{k: v for k, v in kw.items() if k in
                                   ("courses", "programs", "chunks", "requirement_courses")}),
        pages=kw.get("pages"),
        page_texts=kw.get("page_texts", {1: "x"}),
    )


# --- A3 ---------------------------------------------------------------------------

@pytest.mark.parametrize("heading", [
    "Ethics (Minor)",
    "Gender & Sexuality Studies (Minor)",
    "Biology B.A.",
    "B.S. in Nursing",
])
def test_a3_reports_real_program_headings(heading: str) -> None:
    """A credential in parenthetical or trailing position is how this catalog names a program."""
    ctx = _ctx(pages=_pages([(3, heading)]), programs=[])
    high = [f for f in coverage.check_a3(ctx) if f.severity == "high"]
    assert len(high) == 1 and heading in high[0].claim


@pytest.mark.parametrize("heading", [
    "B.A. Degrees with HEGIS Codes",
    "Honors in Major",
    "Earning an Additional Major after Graduation",
    "Minors, Concentrations, and Certificate Programs",
    "Criteria of Program Pursuit and Satisfactory Academic Progress",
])
def test_a3_does_not_report_toc_entries_and_policy_sections(heading: str) -> None:
    """The flood case. Each of these carries a credential token and none is a program.

    A naive ``A3`` reported 172 of these on the flagship at ``high``, roughly half false — outside
    the §12 gate on its own.
    """
    ctx = _ctx(pages=_pages([(3, heading)]), programs=[])
    assert [f for f in coverage.check_a3(ctx) if f.severity == "high"] == []


def test_a3_uncertain_headings_become_an_inventory_not_assertions() -> None:
    """What the check cannot classify is offered as candidates, at low severity and AMBIGUOUS.

    This heading names a credential but not in the position this catalog uses for program names, so
    the check declines to assert and records it as a candidate instead.
    """
    ctx = _ctx(pages=_pages([(3, "Advanced Certificate for Working Professionals")]), programs=[])
    findings = list(coverage.check_a3(ctx))
    inventory = [f for f in findings if f.severity == "low"]
    assert not [f for f in findings if f.severity == "high"]
    assert len(inventory) == 1 and inventory[0].verdict == "AMBIGUOUS"
    assert "CANDIDATES" in inventory[0].claim


def test_a3_repeated_heading_on_one_page_is_one_finding() -> None:
    """A heading repeated on a page must not emit the same claim twice.

    Caught by the loader on the first full sweep, not by review: ``2022-2023-undergraduate`` p106
    carries ``Arts: Interdisciplinary Arts (Minor)`` twice, and two findings collided on the
    ``{version}:{page}:{check}:{entity_key}`` id. ``sqlite_loader`` **raises** on duplicate ids
    rather than coalescing them (P3/P5), so this aborted the whole sweep — which is the guard
    working. Same correction ``courses_by_code`` made for A1/B1/B5 in Phase 2.
    """
    ctx = _ctx(
        pages=_pages([(3, "Arts: Interdisciplinary Arts (Minor)"),
                      (9, "Arts: Interdisciplinary Arts (Minor)")]),
        programs=[],
    )
    findings = [f for f in coverage.check_a3(ctx) if f.severity == "high"]
    assert len(findings) == 1
    assert len({f.id for f in findings}) == 1
    assert "appears 2x" in findings[0].claim, "the repetition must stay visible, not be swallowed"


def test_a3_is_silent_when_the_program_exists() -> None:
    ctx = _ctx(pages=_pages([(3, "Ethics (Minor)")]),
               programs=[{"id": "p1", "name": "Ethics (Minor)", "markdown_url": None}])
    assert list(coverage.check_a3(ctx)) == []


# --- C7 ---------------------------------------------------------------------------

def _chunk(content: str, digest: str | None, cid: str = "c1") -> dict[str, Any]:
    return {"id": cid, "content": content, "content_hash": digest, "page_number": 7,
            "markdown_url": None}


def test_c7_accepts_sha256_of_the_raw_stored_content() -> None:
    """The algorithm was derived from the corpus, so pin it: ``sha256(content)`` as stored.

    Notably the hash covers the synthetic breadcrumb (trap T8) rather than the page text — it
    describes what is stored, not what the page said.
    """
    body = "[Header 1: Biology] Cells are small."
    ctx = _ctx(chunks=[_chunk(body, hashlib.sha256(body.encode()).hexdigest())])
    assert list(provenance.check_c7(ctx)) == []


def test_c7_reports_content_edited_after_the_hash_was_written() -> None:
    ctx = _ctx(chunks=[_chunk("edited text", hashlib.sha256(b"original text").hexdigest())])
    findings = list(provenance.check_c7(ctx))
    assert len(findings) == 1 and findings[0].severity == "medium"
    assert "does not match" in findings[0].claim


def test_c7_missing_hashes_aggregate_rather_than_bury_the_mismatches() -> None:
    """A NULL hash is a backfill gap affecting batches; enumerating thousands hides real tampering."""
    ctx = _ctx(chunks=[_chunk(f"body {i}", None, f"c{i}") for i in range(5)])
    findings = list(provenance.check_c7(ctx))
    assert len(findings) == 1
    assert findings[0].severity == "low" and "5 chunk(s)" in findings[0].claim


# --- D3 ---------------------------------------------------------------------------

def _program(name: str, pid: str) -> dict[str, Any]:
    return {"id": pid, "name": name, "markdown_url": None, "degree_type": None, "total_credits": None}


def test_d3_collapses_the_two_naming_families() -> None:
    """``Biology B.A.`` and ``Bachelor of Arts (B.A.) in Biology`` are one degree, two rows."""
    ctx = _ctx(programs=[_program("Biology B.A.", "p1"),
                         _program("Bachelor of Arts (B.A.) in Biology", "p2")])
    findings = list(headings.check_d3(ctx))
    assert len(findings) == 1
    assert "Biology B.A." in findings[0].claim


def test_d3_does_not_merge_different_degrees_in_one_subject() -> None:
    """``Biology B.A.`` and ``Biology B.S.`` are two real programs. Merging them invents a defect."""
    ctx = _ctx(programs=[_program("Biology B.A.", "p1"), _program("Biology B.S.", "p2")])
    assert list(headings.check_d3(ctx)) == []


def test_d3_ignores_the_non_program_rows_e4_owns() -> None:
    """``Certificates`` and ``Degrees and Certificates`` both reduce to "certificates".

    They are section headers, not degrees. Reusing E4's classifier is what keeps the two checks
    agreeing about what a program is, instead of D3 inventing a second definition.
    """
    ctx = _ctx(programs=[_program("Certificates", "p1"), _program("Degrees and Certificates", "p2")])
    assert list(headings.check_d3(ctx)) == []


# --- D4 ---------------------------------------------------------------------------

def _multi(titles: dict[int, str], credits: dict[int, int] | None = None) -> dict[int, PageFacts]:
    return {
        page: PageFacts(
            catalog_version="v", page=page, page_role="content", leading_orphan_text=False,
            courses=[ExtractedCourse(code="HIST 1077", title=title, heading_line=5,
                                     credits=(credits or {}).get(page))],
        )
        for page, title in titles.items()
    }


def test_d4_reports_pages_that_disagree_about_the_course() -> None:
    """The real case: HIST 1077 is 'Rebellion in Rochester' on one page, 'Activism' on another."""
    ctx = _ctx(pages=_multi({366: "Rebellion in Rochester", 367: "Activism in Rochester"}),
               courses=[{"id": "u1", "course_code": "HIST 1077", "title": "Rebellion in Rochester"}])
    findings = [f for f in headings.check_d4(ctx) if f.severity != "info"]
    assert len(findings) == 1
    assert findings[0].entity_key == "HIST 1077"
    assert "366" in findings[0].claim and "367" in findings[0].claim


def test_d4_agreeing_repetition_is_inventory_not_177_findings() -> None:
    """A catalog repeating a description per program section is correct publishing, not a defect."""
    ctx = _ctx(pages=_multi({10: "Rebellion in Rochester", 20: "Rebellion in Rochester"}),
               courses=[])
    findings = list(headings.check_d4(ctx))
    assert len(findings) == 1 and findings[0].severity == "info"
    assert "HIST 1077(2)" in findings[0].evidence_page


def test_d4_credit_disagreement_outranks_title_disagreement() -> None:
    """Differing credits is data a student acts on, so it escalates above a naming difference."""
    ctx = _ctx(
        pages=_multi({10: "Rebellion in Rochester", 20: "Activism in Rochester"},
                     credits={10: 3, 20: 4}),
        courses=[],
    )
    findings = [f for f in headings.check_d4(ctx) if f.severity != "info"]
    assert len(findings) == 1 and findings[0].severity == "high"
    assert "[3, 4]" in findings[0].claim


def test_d4_single_page_definition_is_never_reported() -> None:
    ctx = _ctx(pages=_multi({10: "Rebellion in Rochester"}), courses=[])
    assert list(headings.check_d4(ctx)) == []
