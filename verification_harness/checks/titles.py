"""``B2`` — course title fidelity by layered abbreviation resolution (``DOUBLE_CHECK.md`` §5 Risk A).

Phase 1b settled the design argument with a measurement: raw residue across the flagship's 1,400
matched courses was 9.4%, but almost all of it was a credit-range suffix the DB title kept and the
page dropped (``'Internship in Accounting (1 TO 3)'``). Strip that and residue falls to **1.7%**,
with genuine abbreviation mismatches under 1% — so **no LLM is justified per title**. That decision
was recorded and then never shipped as a check; this module is it.

The layers, exactly as §5 specified them:

1. **Token-prefix alignment** — ``Hist ⊂ History``, ``Intro ⊂ Introduction``, ``Amer ⊂ American``.
2. **A tiny non-prefix map** — ``Thru → through``, ``& → and``, ``w/ → with``. Nine entries, not a
   university dictionary; every one is a spelling difference, never a synonym.
3. **The residue goes to Tier 2**, as ``AMBIGUOUS`` findings, and nowhere else.

Why alignment rather than similarity, restated because it is the load-bearing reason: a page can
carry ``HIST-301 Japanese Hist Thru Film`` and ``HIST-302 Chinese Hist Thru Film`` as neighbors.
If a row carried the *sibling's* title — a real defect — cosine similarity would sit far above any
workable threshold and pass it. Alignment flags ``Japanese`` vs ``Chinese`` because neither is a
prefix of the other. Recall on exactly the error we least want to miss is why this is not embeddings.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

from ..models import Finding
from .coverage import courses_by_code
from .registry import CheckContext, make_finding, register

#: Trailing credit annotation that one side retains and the other drops. Phase 1b identified this as
#: the dominant residue class (7.7 of 9.4 raw points), but its examples covered only ``(1 TO 3)``;
#: the corpus also carries ``(.5)``, ``(.5 TO 3)``, ``(0 OR 6)``, ``(3 credits)``, and trailing
#: footnote asterisks. The interior is matched *exhaustively* — digits, separators, and the words
#: ``to``/``or``/``credit(s)``/``cr`` only — so a parenthetical carrying real title content
#: (``(FR)``, ``(fall)``) is never silently discarded.
_CREDIT_SUFFIX = re.compile(
    r"\s*\(\s*[\d.]+(?:\s*(?:to|or|-|–|—)\s*[\d.]+)*\s*(?:credits?|cr\.?|hours?|hrs?\.?)?\s*\)\s*\**\s*$",
    re.IGNORECASE,
)

#: A DB title the ingest synthesized for a course it never found a definition for. These are not
#: titles, so comparing them to a page title measures nothing — see :func:`check_b2`.
_GHOST_TITLE = re.compile(r"\(\s*referenced;\s*not in catalog\s*\)\s*$", re.IGNORECASE)

#: Connective words a banner abbreviation drops freely. Skipping them on either side is safe: a
#: dropped ``of`` is not a curriculum defect, and no real error hides in one.
_STOPWORDS = frozenset({"a", "an", "and", "at", "for", "from", "in", "into", "of", "on", "the", "to", "with"})

#: Layer 2. Non-prefix spelling differences only — never a synonym, because mapping synonyms would
#: reintroduce exactly the semantic leniency that lets a sibling's title pass.
_ABBREVIATIONS: dict[str, str] = {
    "thru": "through",
    "thro": "through",
    "&": "and",
    "w": "with",
    "w/": "with",
    "wo": "without",
    "ii": "2",
    "iii": "3",
    "iv": "4",
}

#: Shortest prefix accepted as an abbreviation. Two characters would let ``Ch`` align with
#: ``Chemistry`` *or* ``Chinese``, which is the sibling-collision failure in miniature.
_MIN_PREFIX = 3

#: ``&`` is a word (Layer 2 maps it to ``and``), so it tokenizes on its own rather than gluing to a
#: neighbor. Left glued, ``Linguist&`` is not a prefix of ``Linguistic&`` and a plain truncation
#: would be misreported as a title mismatch.
_TOKEN = re.compile(r"[a-z0-9]+|&")

Status = Literal["exact", "abbreviated", "residue"]


@dataclass(frozen=True)
class Alignment:
    """The result of comparing a DB title against a page title.

    Attributes:
        status: ``exact`` (identical once normalized), ``abbreviated`` (resolved by Layers 1–2), or
            ``residue`` (unresolved — Tier 2's input).
        reason: Human-readable account of what failed, empty when the titles aligned.
    """

    status: Status
    reason: str = ""

    @property
    def resolved(self) -> bool:
        """True when the titles are deterministically reconciled and no finding is warranted."""
        return self.status in ("exact", "abbreviated")


def strip_credit_range(title: str) -> str:
    """Remove a trailing credit annotation from a title.

    Args:
        title: A DB or page course title.

    Returns:
        The title without its trailing ``(N)`` / ``(N TO M)`` suffix.
    """
    return _CREDIT_SUFFIX.sub("", title or "").strip()


def _tokens(title: str) -> list[str]:
    """Lowercase, drop the credit range, and split a title into comparable tokens."""
    cleaned = strip_credit_range(title).lower().replace("’", "'").replace("'", "")
    return _TOKEN.findall(cleaned)


def _canonical(token: str) -> str:
    """Apply the Layer 2 map to one token."""
    return _ABBREVIATIONS.get(token, token)


def _aligns(db_token: str, page_token: str) -> bool:
    """True when one token is a valid abbreviation of the other (Layers 1–2)."""
    a, b = _canonical(db_token), _canonical(page_token)
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return len(shorter) >= _MIN_PREFIX and longer.startswith(shorter)


def align_titles(db_title: str | None, page_title: str | None) -> Alignment:
    """Decide whether a DB title is a faithful rendering of the page title.

    Walks both token sequences in order, accepting an exact match, a prefix abbreviation, or a
    Layer 2 spelling difference, and skipping connective stopwords on either side. Order matters:
    two titles built from the same words in a different arrangement are *not* treated as equal.

    Args:
        db_title: ``courses.title``.
        page_title: The title from the course heading on the page.

    Returns:
        An :class:`Alignment`. ``residue`` means Layers 1–2 could not reconcile them — the
        caller escalates, and never guesses.
    """
    if db_title is None or page_title is None:
        return Alignment("residue", "one side has no title")

    db_tokens = _tokens(db_title)
    page_tokens = _tokens(page_title)
    if not db_tokens and not page_tokens:
        return Alignment("exact")
    if not db_tokens or not page_tokens:
        return Alignment("residue", "one side's title is empty after normalization")
    if db_tokens == page_tokens:
        return Alignment("exact")

    i = j = 0
    while i < len(db_tokens) and j < len(page_tokens):
        if _aligns(db_tokens[i], page_tokens[j]):
            i += 1
            j += 1
            continue
        if _canonical(page_tokens[j]) in _STOPWORDS:
            j += 1
            continue
        if _canonical(db_tokens[i]) in _STOPWORDS:
            i += 1
            continue
        return Alignment(
            "residue",
            f"token {i + 1} differs: DB {db_tokens[i]!r} vs page {page_tokens[j]!r}",
        )

    trailing_db = [t for t in db_tokens[i:] if _canonical(t) not in _STOPWORDS]
    trailing_page = [t for t in page_tokens[j:] if _canonical(t) not in _STOPWORDS]
    if trailing_db:
        return Alignment("residue", f"DB title has extra words the page lacks: {trailing_db}")
    if trailing_page:
        return Alignment("residue", f"page title has extra words the DB lacks: {trailing_page}")
    return Alignment("abbreviated")


@register("B2", tier=1, needs_pages=True, title="Fidelity: DB course title vs page title")
def check_b2(ctx: CheckContext) -> Iterator[Finding]:
    """Flag course titles Layers 1–2 cannot reconcile, as Tier 2's adjudication queue.

    Emitted at ``AMBIGUOUS`` rather than ``CONFIRMED`` on purpose. Layers 1–2 prove only that a
    *deterministic* reading failed; the remaining cases are genuinely a judgment call (an unusual
    contraction versus a wrong title), which is precisely the boundary §5 drew between P2's
    deterministic tier and the semantic one. Calling them confirmed defects here would be the
    harness asserting something it has not established.
    """
    db_courses = {c["course_code"].strip(): c for c in ctx.db.courses if c.get("course_code")}

    for page_num, page_facts in sorted(ctx.pages.items()):
        for code, occurrences in courses_by_code(page_facts).items():
            db_course = db_courses.get(code)
            if not db_course:
                continue  # absence is A1's finding, not B2's

            db_title = (db_course.get("title") or "").strip()
            if _GHOST_TITLE.search(db_title) or db_course.get("is_ghost"):
                # The ingest synthesized "CODE (referenced; not in catalog)" for courses it only
                # ever saw mentioned in a requirement list. Comparing that to a page title would
                # report a title defect for a row that has no title — the real defect is that a
                # heading *does* define this course, which is A6's claim, not B2's.
                continue
            # A code defined twice on one page (see `courses_by_code`) is reconciled if the DB
            # title matches *either* occurrence — the page contradicts itself, which is D1/A1's
            # business; B2 only asks whether the DB picked up something the page actually says.
            alignments = [align_titles(db_title, c.title) for c in occurrences]
            if any(a.resolved for a in alignments):
                continue

            first = occurrences[0]
            reason = alignments[0].reason
            yield make_finding(
                ctx,
                check="B2",
                severity="medium",
                entity_type="course",
                entity_key=code,
                entity_id=db_course["id"],
                claim=(
                    f"Title for {code} is not a deterministic abbreviation of the page title "
                    f"({reason}). DB: {db_title!r}; page: {first.title!r}"
                ),
                page=page_num,
                evidence_page=f"{code} {first.title}",
                evidence_db=db_title,
                ancestor_path=first.ancestor_path,
                verdict="AMBIGUOUS",
                confidence=0.5,
            )
