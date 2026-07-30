"""§11 known-answer regression gate — the Phase 2 exit criterion (``DOUBLE_CHECK.md`` §11, P6).

The harness is **untrusted** until it independently rediscovers the defects catalogued in §11. These
tests assert that it does, against the output of a completed 8-catalog sweep::

    python -m verification_harness --all --sync
    pytest verification_harness/tests/test_known_answers.py -v

The distinction that makes this *known-answer* validation rather than circular self-confirmation:
the expected numbers live **here, in the test**, derived from the §3 corpus inventory and the §11
defect list. No check is seeded with them. A check that hard-coded "report 183 unlinked courses"
would pass these tests while auditing nothing — so each assertion additionally verifies the
*classification* the harness produced, which only a working check can generate.

A sweep that reports zero findings means a broken harness, not a clean catalog (spec guardrails).
"""

from __future__ import annotations

import collections
import json
import re
from typing import Any

import pytest

from .. import config, db
from ..checks.integrity import classify_non_program
from ..cli import load_pages

# --- §3 / §11 expectations — the known answers, stated independently of any check ---------------

#: Catalog versions the corpus is supposed to contain (``DOUBLE_CHECK.md`` §3).
EXPECTED_VERSION_COUNT = 8

#: §11.1 — courses whose ``markdown_url IS NULL``.
EXPECTED_UNLINKED_COURSES = 183

#: §11.2 — programs whose ``markdown_url IS NULL``.
EXPECTED_UNLINKED_PROGRAMS = 32

#: §11.2 — non-program rows known to be sitting in ``programs``. The harness is expected to surface
#: *at least* these: it flags the class, so a superset is a better result, not a failure.
MIN_NON_PROGRAM_ROWS = 12

#: §11.3 — library-staff bios pruned 2026-07-13, retained in ``bio_program_prune_backup``.
EXPECTED_PRUNED_BIOS = 9

#: A 4-digit course code — the dual-numbering residue a ``\\d{3}`` regex silently dropped (§11.5).
_FOUR_DIGIT_CODE = re.compile(r"\b[A-Z]{2,6}\s\d{4}\b")

#: Page roles on which a course heading is a *mention*, never a definition (trap T4/T5).
_NON_DEFINITIONAL_ROLES = frozenset({"toc", "index"})


# --- Fixtures -----------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def findings() -> list[dict[str, Any]]:
    """Load the findings of a completed full sweep.

    Returns:
        Every finding in ``artifacts/findings.jsonl``.

    Raises:
        pytest.skip.Exception: If no full 8-catalog sweep has been run.
    """
    if not config.FINDINGS_JSONL.exists():
        pytest.skip(
            f"no findings at {config.FINDINGS_JSONL}. "
            f"Run: python -m verification_harness --all --sync"
        )
    loaded = [
        json.loads(line)
        for line in config.FINDINGS_JSONL.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    versions = {f["catalog_version"] for f in loaded}
    if len(versions) < EXPECTED_VERSION_COUNT:
        pytest.skip(
            f"findings cover {len(versions)} catalog(s), not {EXPECTED_VERSION_COUNT}. "
            f"The §11 gate needs a full sweep: python -m verification_harness --all --sync"
        )
    return loaded


def _by_check(findings: list[dict[str, Any]], check: str) -> list[dict[str, Any]]:
    """Return every finding produced by one check."""
    return [f for f in findings if f["check"] == check]


def _aggregate_count(finding: dict[str, Any]) -> int:
    """Read the ``count=N`` an aggregate finding records in its ``evidence_db``."""
    match = re.search(r"count=(\d+)", finding.get("evidence_db") or "")
    assert match, f"aggregate finding {finding['id']} carries no count= in evidence_db"
    return int(match.group(1))


# --- The gate -----------------------------------------------------------------------------------


def test_sweep_is_not_empty(findings: list[dict[str, Any]]) -> None:
    """A run reporting zero findings means a broken harness, not a clean catalog."""
    assert findings, "the sweep produced no findings at all — the harness is broken"


def test_no_harness_error_findings(findings: list[dict[str, Any]]) -> None:
    """No check crashed. The runner converts a crash into a finding rather than hiding it (P4)."""
    crashed = [f for f in findings if f["check"] == "harness-error" or "crashed" in f["claim"]]
    assert not crashed, f"checks crashed during the sweep: {[f['id'] for f in crashed]}"


def test_finding_ids_are_unique(findings: list[dict[str, Any]]) -> None:
    """Ids must be unique so re-runs diff cleanly (P3) and the triage index cannot coalesce rows."""
    counts = collections.Counter(f["id"] for f in findings)
    duplicates = {fid: n for fid, n in counts.items() if n > 1}
    assert not duplicates, f"duplicate finding ids: {duplicates}"


def test_s11_1_unlinked_courses_rediscovered(findings: list[dict[str, Any]]) -> None:
    """§11.1 — the 183 courses with ``markdown_url IS NULL``, enumerated *and* classified.

    §11 asks the open question "genuine gap or matcher failure?". A4 must answer it: ghost courses
    (referenced in requirement lists, never defined) legitimately have no page, while a non-ghost
    unlinked course is a real matcher failure. Both must be accounted for, and their sum must be the
    known 183.
    """
    a4_courses = [f for f in _by_check(findings, "A4") if f["entity_type"] == "course"]
    assert a4_courses, "A4 surfaced no unlinked courses — the check is not running"

    ghost_aggregates = [f for f in a4_courses if f["entity_key"].endswith(":ghost-courses-unlinked")]
    enumerated = [f for f in a4_courses if f not in ghost_aggregates]

    ghost_total = sum(_aggregate_count(f) for f in ghost_aggregates)
    assert ghost_total + len(enumerated) == EXPECTED_UNLINKED_COURSES, (
        f"A4 accounts for {ghost_total} ghost + {len(enumerated)} non-ghost unlinked courses "
        f"= {ghost_total + len(enumerated)}; §11 says {EXPECTED_UNLINKED_COURSES}"
    )
    # The classification is the deliverable: ghosts are expected (info), real gaps are actionable.
    assert all(f["severity"] == "info" for f in ghost_aggregates), (
        "ghost courses have no page by definition — reporting them as defects would be a flood"
    )
    assert all(f["severity"] == "high" for f in enumerated), (
        "a cataloged course with no source page is missing content, not an inventory note"
    )


def test_s11_2_unlinked_programs_and_non_program_rows(findings: list[dict[str, Any]]) -> None:
    """§11.2 — the 32 unlinked programs, and the non-program rows sitting in ``programs``."""
    a4_programs = [f for f in _by_check(findings, "A4") if f["entity_type"] == "program"]
    assert len(a4_programs) == EXPECTED_UNLINKED_PROGRAMS, (
        f"A4 found {len(a4_programs)} unlinked programs; §11 says {EXPECTED_UNLINKED_PROGRAMS}"
    )

    e4 = _by_check(findings, "E4")
    assert len(e4) >= MIN_NON_PROGRAM_ROWS, (
        f"E4 found {len(e4)} non-program rows; §11 documents at least {MIN_NON_PROGRAM_ROWS} "
        f"({', '.join(sorted({f['entity_key'] for f in e4}))})"
    )
    # Surfacing the *class* is the point (P6), not matching a hard-coded row list.
    matches = [re.search(r"looks like a (\w+)", f["claim"]) for f in e4]
    kinds = {m.group(1) for m in matches if m}
    assert "section_header" in kinds, f"E4 classified only {kinds}; the section-header class is §11"


@pytest.mark.parametrize("table", ["bio_program_prune_backup"])
def test_s11_3_staff_bio_class_is_detected(table: str) -> None:
    """§11.3 — the 9 pruned library-staff bios must be caught by the *class* detector.

    The rows were removed from ``programs`` on 2026-07-13, so E4 cannot fire on them in a live run.
    Replaying the retained backup through E4's classifier proves the class is still detected — the
    §11 requirement is "flag the class, not just these rows", so the detector, not the row list, is
    what must be validated.
    """
    with db.read_only_cursor() as cur:
        cur.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=%s",
            (table,),
        )
        if cur.fetchone() is None:
            pytest.skip(f"{table} has been dropped; the §11.3 known answer is no longer replayable")
        cur.execute(f"SELECT name FROM {table}")  # table name is a literal parametrize value
        names = [row["name"] for row in cur.fetchall()]

    assert len(names) == EXPECTED_PRUNED_BIOS, (
        f"{table} holds {len(names)} rows; §11 documents {EXPECTED_PRUNED_BIOS}"
    )
    missed = [n for n in names if classify_non_program(n) != "staff_bio"]
    assert not missed, f"E4's classifier no longer recognizes these staff bios: {missed}"


def test_s11_4_toc_ambiguity_is_reproduced_not_guessed(findings: list[dict[str, Any]]) -> None:
    """§11.4 — heading ambiguity must be *surfaced* with hierarchy context, never silently resolved.

    Two halves. First, ``D1`` must still report duplicate course headings together with the pages
    they appear on, so a human can tell a cross-listing from a duplication error. Second, the T5
    mitigation must hold: a course heading on a ToC/index page is a mention, so ``A1`` must not
    treat one as a missing definition. The body-length heuristic that caused the original mislink is
    what these two guards replace.
    """
    d1 = _by_check(findings, "D1")
    assert d1, "D1 reported nothing — the duplicate-heading ambiguity is no longer being surfaced"
    without_pages = [f["id"] for f in d1 if not f["evidence_page"]]
    assert not without_pages, (
        f"{len(without_pages)} D1 findings carry no page list, so the ambiguity they report is not "
        f"actionable: {without_pages[:5]}"
    )

    non_definitional: set[tuple[str, int]] = set()
    for version in sorted({f["catalog_version"] for f in findings}):
        pages, _ = load_pages(version, config.PAGE_CACHE_DIR)
        non_definitional.update(
            (version, num)
            for num, facts in pages.items()
            if facts.page_role in _NON_DEFINITIONAL_ROLES
        )
    assert non_definitional, "no page was classified toc/index — the T5 mitigation is inert"

    leaked = [
        f["id"]
        for f in _by_check(findings, "A1")
        if (f["catalog_version"], f["page"]) in non_definitional
    ]
    assert not leaked, f"A1 treated ToC/index mentions as missing definitions (trap T4/T5): {leaked[:5]}"


def test_s11_5_dual_numbering_residue_is_surfaced(findings: list[dict[str, Any]]) -> None:
    """§11.5 — the ``\\d{3}`` regex dropped 4-digit codes; a permissive parser must surface them."""
    four_digit = {
        f["entity_key"] for f in _by_check(findings, "A1") if _FOUR_DIGIT_CODE.search(f["entity_key"])
    }
    assert four_digit, (
        "A1 surfaced no 4-digit course codes. Either the extractor's code pattern has regressed to "
        "3 digits (the original defect) or the residue is genuinely gone — verify before relaxing."
    )


def test_s11_6_page_number_and_bucket_repairs_held(findings: list[dict[str, Any]]) -> None:
    """§11.6 — every chunk was once on page 1 and pointed at ``ccsj-assets``. C1/C5 guard that."""
    c1 = _by_check(findings, "C1")
    c5 = _by_check(findings, "C5")
    assert not c1, (
        f"{len(c1)} chunks disagree with their own url's page number — the page-1 regression is "
        f"back: {[f['id'] for f in c1[:5]]}"
    )
    assert not c5, (
        f"{len(c5)} rows point at a foreign bucket or the wrong catalog version — the "
        f"ccsj-assets/cross-catalog regression is back: {[f['id'] for f in c5[:5]]}"
    )


def test_x5_corpus_inventory_matches_the_database() -> None:
    """``X5`` — the version list in the database must match the §3 reference expectation.

    An unexplained corpus change between runs is itself a finding (§3), so it is a gate, not a note.
    """
    actual = set(db.list_versions())
    expected = set(config.EXPECTED_VERSIONS)
    assert actual == expected, (
        f"X5: catalog versions drifted. Missing from DB: {sorted(expected - actual)}; "
        f"unexpected in DB: {sorted(actual - expected)}"
    )
