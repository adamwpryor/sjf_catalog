"""``B2`` abbreviation resolution — the deterministic layers, pinned by example.

Phase 1b decided this design with a measurement (residue 9.4% raw → **1.7%** once credit ranges are
stripped) and concluded no LLM is justified per title. These tests pin the behaviour that number
described, so a later "simplification" of the alignment cannot quietly re-inflate the residue or,
worse, deflate it by accepting titles it should flag.

The load-bearing case is :func:`test_sibling_course_title_is_flagged`. §5 Risk A rejected embedding
similarity specifically because sibling courses differ by one word, so a row carrying the wrong
sibling's title scores as similar. If that test ever passes as "resolved", the check has acquired
the exact false negative the design was chosen to avoid.
"""

from __future__ import annotations

import pytest

from ..checks.titles import align_titles, strip_credit_range


@pytest.mark.parametrize(
    ("db_title", "page_title"),
    [
        # Identical once normalized.
        ("Japanese History through Film", "Japanese History through Film"),
        ("Research-based Writing", "research-based writing"),
        # Layer 1 — token-prefix abbreviation (§5 Risk A's own examples).
        ("P1 Japanese Hist Thru Film", "P1 Japanese History through Film"),
        ("Intro to Biology", "Introduction to Biology"),
        ("Amer Lit Dev", "American Literature Development"),
        # Layer 2 — the small non-prefix map.
        ("Ethics & Society", "Ethics and Society"),
        ("Statistics w/ R", "Statistics with R"),
        # Dropped connectives.
        ("Intro Discipline Nursing", "Introduction to the Discipline of Nursing"),
        # Credit ranges the DB keeps and the page drops — Phase 1b's dominant residue class, in
        # every spelling the corpus actually uses.
        ("Internship in Accounting (1 TO 3)", "Internship in Accounting"),
        ("Independent Study (.5 TO 3)", "Independent Study"),
        ("Portfolio Review (.5)", "Portfolio Review"),
        ("Care of Children (0 OR 4)", "Care of Children"),
        ("Senior Project (3 credits)", "Senior Project"),
        # …and in the other direction, with a footnote marker attached.
        ("Advanced Research Writing", "Advanced Research Writing (3)**"),
        # A truncation that is still a prefix once `&` stops gluing to its neighbour.
        ("Linguist& 2nd Lang Acq", "Linguistic& 2nd Lang Acq"),
    ],
)
def test_deterministic_layers_resolve(db_title: str, page_title: str) -> None:
    """Layers 1–2 reconcile these without escalating; none should reach Tier 2."""
    alignment = align_titles(db_title, page_title)
    assert alignment.resolved, f"{db_title!r} vs {page_title!r} → {alignment.reason}"


def test_sibling_course_title_is_flagged() -> None:
    """A neighbouring course's title must NOT resolve — §5 Risk A's decisive case.

    ``HIST-301`` and ``HIST-302`` sit on the same page and differ by one word. Cosine similarity
    puts them far above any workable threshold, so a similarity check would pass a row carrying the
    wrong sibling's title: a false negative on a correctness check. Token alignment catches it
    because ``Japanese`` is not a prefix of ``Chinese``.
    """
    alignment = align_titles("P1 Japanese Hist Thru Film", "P1 Chinese History through Film")
    assert not alignment.resolved
    assert "japanese" in alignment.reason and "chinese" in alignment.reason


@pytest.mark.parametrize(
    ("db_title", "page_title", "because"),
    [
        ("Senior Project (3 credits)", "Independent Study", "a different course entirely"),
        ("Spanish Conversation", "Advanced Spanish II", "wrong title for the code"),
        ("may be substituted for dual ACCT", "Career Planning", "body prose captured as a title"),
        ("Modern Physics Lab I", "Modern Physics I Lab", "word order is not interchangeable"),
        ("Childbearing Family", "Care of Children and Families", "different subject"),
        ("Grwng Minds: Und Ch Ad Adv Dev", "Grwng Minds: Und Ch Ad Dev", "an extra word in the DB"),
    ],
)
def test_real_mismatches_become_residue(db_title: str, page_title: str, because: str) -> None:
    """Genuine mismatches escalate rather than being explained away."""
    assert not align_titles(db_title, page_title).resolved, because


def test_credit_range_strip_leaves_real_parentheticals_alone() -> None:
    """Only numeric credit annotations are stripped.

    ``(FR)`` and ``(fall)`` carry meaning — a term or cohort marker. Stripping them would make two
    genuinely different titles compare equal, which is a false negative bought for tidiness.
    """
    assert strip_credit_range("Independent Study (.5 TO 3)") == "Independent Study"
    assert strip_credit_range("Nursing Seminar (FR)") == "Nursing Seminar (FR)"
    assert strip_credit_range("Topics (fall)") == "Topics (fall)"


def test_missing_title_is_residue_not_a_match() -> None:
    """A null on either side is escalated, never silently treated as agreement."""
    assert not align_titles(None, "Introduction to Biology").resolved
    assert not align_titles("Introduction to Biology", None).resolved
    assert not align_titles("", "Introduction to Biology").resolved


def test_two_letter_prefix_is_not_an_abbreviation() -> None:
    """``Ch`` must not align with ``Chemistry``: it fits ``Chinese`` equally well.

    The minimum prefix length is what stops the sibling-collision failure from re-entering through
    very short tokens.
    """
    assert not align_titles("Ch 101 Basics", "Chemistry 101 Basics").resolved
