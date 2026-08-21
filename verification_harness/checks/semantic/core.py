"""Core prompt components, JSON schemas, shingle verification, and finding helpers for Tier 2 checks."""

from __future__ import annotations

import logging
import random
from collections.abc import Sequence
from typing import Any

from ...models import Finding
from ...normalize import normalize_text
from ..registry import CheckContext, make_finding

logger = logging.getLogger(__name__)

#: Longest page excerpt handed to the model. Course-description pages run long, and the whole page
#: is the point (``B3`` is specifically about text bleeding in from the *adjacent* course).
_MAX_PAGE_CHARS = 12_000

#: Longest DB text field echoed into a prompt.
_MAX_FIELD_CHARS = 2_000

#: Shingle length for excerpt verification. Five tokens is long enough that matching by chance is
#: implausible and short enough to survive the model tidying up whitespace or punctuation.
_SHINGLE = 5

#: Verdicts Tier 2 may assign. ``REFUTED`` is Tier 3's to give, never Tier 2's.
_VERDICTS = ("CONFIRMED", "PLAUSIBLE", "AMBIGUOUS")

_SEVERITIES = ("critical", "high", "medium", "low", "info")


# --- shared prompt material -------------------------------------------------------

#: The §7 trap list, stated to the model in the terms it will actually encounter. Every one of these
#: has already produced a false-positive flood in Tier 1; a model that does not know them will
#: rediscover each flood at a dollar a time.
_TRAPS = """\
Known-good patterns in this corpus. NONE of these is a defect — do not report them:
- Database titles are abbreviated banner titles: 'P1 Japanese Hist Thru Film' is a faithful
  rendering of 'P1 Japanese History through Film'.
- Both 3-digit and 4-digit course numbers are legitimate: HIST 301 and CRIM 1299 coexist.
- Course codes carry letter suffixes (CHEM 103C, ISPR 100D); prose sometimes drops the suffix.
- A course code inside a requirement list is a MENTION, not a definition. Only a heading defines.
- The same course may legitimately appear under two prefixes (cross-listing).
- Typography differs freely: en/em dashes vs hyphens, *emphasis*, smart quotes, non-breaking spaces.
- Different courses may share an identical title ('Research-based Writing' is four distinct
  courses). The CODE is the identifier; a shared title is not evidence of anything.
- A trailing 'Program' on a program name is a known-good equivalence ('… Certificate' ==
  '… Certificate Program').
- Accreditation statements, navigation, page furniture, and marketing copy are not curriculum data.
- A `Label:` metadata line under a course — `Attributes:`, `Typically offered:`, `Formerly titled:`,
  `PLACEMENT:` — is NOT part of the description. The database has no column for these at all, which
  is a known and already-decided schema gap owned by check B6. Do not report a description as
  incomplete because it omits them; on this corpus that alone would be 1,118 findings.
"""

_SEVERITY_GUIDE = """\
Severity, from the project's model:
- critical: wrong data a student or advisor could act on (wrong prerequisites, a description
  belonging to a different course).
- high: real content missing or mislinked.
- medium: structural or provenance defect with the content intact.
- low: cosmetic, or metadata not captured.
- info: inventory or hypothesis, no defect implied.
"""

_VERDICT_GUIDE = """\
Verdict:
- CONFIRMED: the page and the database plainly disagree, and you can quote the page text proving it.
- PLAUSIBLE: probably a defect, but the page is unclear or the evidence is partial.
- AMBIGUOUS: you cannot tell. This is a valid, expected answer — declining to judge is better than
  guessing, and a guess costs a human more than a shrug does.

Quote `evidence_page` VERBATIM from the page text supplied. Do not paraphrase, reconstruct, or
summarize it: every excerpt is checked back against the page, and one that is not found there
invalidates the finding.
Report only real defects. If a course or program is faithfully represented, return no issues for it.
"""


def _issue_schema(checks: Sequence[str]) -> dict[str, Any]:
    """Return the JSON schema for one adjudicated issue.

    Args:
        checks: The check ids this call is allowed to report against.

    Returns:
        A Vertex-compatible (OpenAPI subset) JSON schema.
    """
    return {
        "type": "object",
        "properties": {
            "check": {"type": "string", "enum": list(checks)},
            "verdict": {"type": "string", "enum": list(_VERDICTS)},
            "severity": {"type": "string", "enum": list(_SEVERITIES)},
            "confidence": {"type": "number"},
            "claim": {"type": "string"},
            "evidence_page": {"type": "string"},
            "evidence_db": {"type": "string"},
        },
        "required": [
            "check",
            "verdict",
            "severity",
            "confidence",
            "claim",
            "evidence_page",
        ],
    }


def _entity_schema(entity_field: str, checks: Sequence[str]) -> dict[str, Any]:
    """Return the schema for a batched per-entity adjudication response."""
    return {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        entity_field: {"type": "string"},
                        "issues": {"type": "array", "items": _issue_schema(checks)},
                    },
                    "required": [entity_field, "issues"],
                },
            }
        },
        "required": ["results"],
    }


# --- evidence verification --------------------------------------------------------


def _shingles(text: str, size: int = _SHINGLE) -> set[str]:
    """Return the set of ``size``-token shingles in normalized text."""
    tokens = normalize_text(text).split()
    if len(tokens) < size:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[i : i + size]) for i in range(len(tokens) - size + 1)}


def excerpt_supported(excerpt: str, source: str) -> bool:
    """True when a quoted excerpt genuinely occurs in the source text.

    Compares normalized 5-token shingles rather than raw substrings, so a model that regularized
    whitespace, a dash, or a smart quote still verifies (trap T9) while one that *invented* the
    passage does not. A very short excerpt is required to appear in full.

    Args:
        excerpt: The model's quoted page text.
        source: The page markdown it claims to be quoting.

    Returns:
        True if every shingle of the excerpt appears in the source.
    """
    if not excerpt or not excerpt.strip():
        return False
    excerpt_shingles = _shingles(excerpt)
    if not excerpt_shingles:
        return False
    source_shingles = _shingles(source)
    if not source_shingles:
        return False
    hits = len(excerpt_shingles & source_shingles)
    # Tolerate one unmatched shingle at each edge, where a quote is most likely to be clipped
    # mid-phrase; require everything else to be present.
    return hits >= max(1, len(excerpt_shingles) - 2)


def _clip(text: Any, limit: int = _MAX_FIELD_CHARS) -> str:
    """Render a DB value as prompt text, truncating loudly rather than silently."""
    if text is None:
        return "(null)"
    value = str(text)
    if len(value) <= limit:
        return value
    return value[:limit] + f"… [truncated, {len(value)} chars total]"


def _issue_to_finding(
    ctx: CheckContext,
    issue: dict[str, Any],
    *,
    allowed: Sequence[str],
    entity_type: str,
    entity_key: str,
    entity_id: str | None,
    page: int,
    page_text: str,
    ancestor_path: list[str] | None = None,
) -> Finding | None:
    """Convert one adjudicated issue into a :class:`Finding`, verifying its evidence first.

    Args:
        ctx: The version's check context.
        issue: One object from the model's ``issues`` array.
        allowed: Check ids this call may report; anything else is discarded and logged.
        entity_type: ``course``, ``program``, ``chunk``, or ``page``.
        entity_key: Stable key for the entity (course code, program name, chunk id).
        entity_id: Database uuid, when there is one.
        page: Source page number.
        page_text: The page markdown the excerpt is verified against.
        ancestor_path: Heading path for the entity, when known.

    Returns:
        The finding, or ``None`` if the issue was malformed. A finding whose excerpt is not on the
        page is *returned*, demoted to ``AMBIGUOUS`` — dropping it would hide a model failure that
        the run needs to see.
    """
    check = str(issue.get("check", "")).strip()
    if check not in allowed:
        logger.warning("discarding issue for unrequested check %r on %s", check, entity_key)
        return None
    claim = str(issue.get("claim", "")).strip()
    if not claim:
        return None

    verdict = str(issue.get("verdict", "AMBIGUOUS")).upper()
    if verdict not in _VERDICTS:
        verdict = "AMBIGUOUS"
    severity = str(issue.get("severity", "medium")).lower()
    if severity not in _SEVERITIES:
        severity = "medium"
    try:
        confidence = max(0.0, min(1.0, float(issue.get("confidence", 0.5))))
    except (TypeError, ValueError):
        confidence = 0.5

    evidence_page = str(issue.get("evidence_page", "")).strip()
    if verdict != "AMBIGUOUS" and not excerpt_supported(evidence_page, page_text):
        claim = (
            f"{claim} [EVIDENCE UNVERIFIED: the quoted page text was not found on page {page}; "
            "verdict demoted from " + verdict + "]"
        )
        verdict = "AMBIGUOUS"
        confidence = min(confidence, 0.3)

    return make_finding(
        ctx,
        check=check,
        severity=severity,
        entity_type=entity_type,
        entity_key=entity_key,
        entity_id=entity_id,
        claim=claim,
        page=page,
        evidence_page=evidence_page,
        evidence_db=str(issue.get("evidence_db", "")).strip() or None,
        ancestor_path=ancestor_path,
        verdict=verdict,
        confidence=confidence,
        tier=2,
    )


def _failure_finding(ctx: CheckContext, check: str, key: str, page: int, error: str) -> Finding:
    """Represent a failed adjudication as a visible finding rather than a missing one (P5).

    An LLM tier that returns fewer findings because calls failed is indistinguishable from one that
    found less wrong — unless the failure is itself reported.

    Args:
        ctx: The version's check context.
        key: The **request** key, not the page. A dense page splits into several calls, so keying
            this on the page alone would give two failed batches the same finding id — the exact
            collision class Phase 2 fixed in Tier 1, and the loader rejects it (P3/P5).
        page: Page number for triage ordering.
        error: What went wrong.
    """
    return make_finding(
        ctx,
        check=check,
        severity="info",
        entity_type="page",
        entity_key=f"adjudication-failed:{key}",
        claim=f"Tier 2 adjudication did not complete for {key}: {error}",
        page=page,
        evidence_page="",
        verdict="AMBIGUOUS",
        confidence=0.0,
        tier=2,
    )


def _seeded_sample(items: Sequence[Any], size: int, seed_key: str) -> tuple[list[Any], int]:
    """Draw a reproducible sample and report how much was left out.

    Args:
        items: The population.
        size: Desired sample size; ``<= 0`` or larger than the population returns everything.
        seed_key: Seeds the RNG, so the same version always draws the same sample (P3).

    Returns:
        ``(sample, skipped_count)``.
    """
    if size <= 0 or size >= len(items):
        return list(items), 0
    rng = random.Random(seed_key)
    sample = rng.sample(list(items), size)
    return sample, len(items) - size
