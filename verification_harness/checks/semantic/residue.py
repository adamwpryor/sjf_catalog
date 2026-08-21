"""Semantic adjudication of the B2 abbreviation residue (B2R)."""

from __future__ import annotations

import logging
from collections.abc import Iterator

from ... import config
from ...llm.client import Request
from ...models import Finding
from ..registry import CheckContext, register
from .core import (
    _SEVERITY_GUIDE,
    _TRAPS,
    _VERDICT_GUIDE,
    _entity_schema,
    _failure_finding,
    _issue_to_finding,
)

logger = logging.getLogger(__name__)

# --- B2 residue -------------------------------------------------------------------

_TITLE_SYSTEM = f"""\
You adjudicate course titles that a deterministic abbreviation check could not reconcile. It already
handled prefix abbreviations (Hist ⊂ History), a small spelling map (Thru → through, & → and), and
credit-range suffixes, so what remains needs judgment.

For each pair decide, as B2: is the database title a faithful (if abbreviated or reformatted)
rendering of the page title, or does it name something different?

Report an issue ONLY when the database title is wrong. Two cases matter most:
- The database carries a NEIGHBORING course's title. Sibling courses differ by one word
  ('Japanese' vs 'Chinese'), so a near-identical title can still be the wrong one.
- The database title is not a title at all — a fragment of body prose, or a heading of a different
  kind that the parser picked up.
A dropped space, a lost accent, or an unusual contraction is `low` severity, not `critical`.

{_TRAPS}
{_SEVERITY_GUIDE}
{_VERDICT_GUIDE}
Quote `evidence_page` from the page heading line supplied for that course.
"""


def _title_prompt(version: str, items: list[tuple[Finding, str]]) -> str:
    """Build the B2 residue prompt from Tier 1's AMBIGUOUS queue."""
    lines = [f"CATALOG: {version}", "", "--- UNRESOLVED TITLE PAIRS ---"]
    for finding, heading in items:
        lines.extend(
            [
                f"course_code: {finding.entity_key}",
                f"  page: {finding.page}",
                f"  page_heading: {heading}",
                f"  db_title: {finding.evidence_db}",
                "",
            ]
        )
    return "\n".join(lines)


@register(
    "B2R",
    tier=2,
    needs_pages=True,
    needs_llm=True,
    title="Semantic: adjudicate the B2 abbreviation residue",
)
def check_b2_residue(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate the title pairs Layers 1–2 left unresolved (§5 Risk A, Layer 3).

    Consumes Tier 1's ``B2`` ``AMBIGUOUS`` findings rather than recomputing them: Layer 3 is defined
    as running *only* on the residue, and rebuilding the residue here would risk the two layers
    disagreeing about what the residue is.
    """
    assert ctx.page_texts is not None
    residue = [f for f in ctx.tier1_findings if f.check == "B2" and f.verdict == "AMBIGUOUS"]
    if not residue:
        return

    items: list[tuple[Finding, str]] = []
    for finding in residue:
        heading = finding.evidence_page or f"{finding.entity_key}"
        items.append((finding, heading))

    requests: list[Request] = []
    index: list[list[tuple[Finding, str]]] = []
    for start in range(0, len(items), config.TIER2_TITLES_PER_CALL):
        batch = items[start : start + config.TIER2_TITLES_PER_CALL]
        requests.append(
            Request(
                key=f"{ctx.version}:titles:{start}",
                system=_TITLE_SYSTEM,
                prompt=_title_prompt(ctx.version, batch),
                schema=_entity_schema("course_code", ("B2",)),
            )
        )
        index.append(batch)

    logger.info("B2 residue: %d call(s) over %d unresolved title(s)", len(requests), len(items))
    responses = ctx.adjudicator.map(requests, check="B2-residue")

    for response, batch in zip(responses, index, strict=True):
        if not response.ok:
            yield _failure_finding(ctx, "B2", response.key, batch[0][0].page, response.error or "?")
            continue
        by_code = {f.entity_key: (f, h) for f, h in batch}
        for result in response.data.get("results", []) or []:
            code = str(result.get("course_code", "")).strip()
            pair = by_code.get(code)
            if pair is None:
                continue
            tier1, heading = pair
            for issue in result.get("issues", []) or []:
                finding = _issue_to_finding(
                    ctx,
                    issue,
                    allowed=("B2",),
                    entity_type="course",
                    entity_key=code,
                    entity_id=tier1.entity_id,
                    page=tier1.page,
                    # Verify against the heading line, which is what the model was quoting from.
                    page_text=heading,
                    ancestor_path=tier1.ancestor_path,
                )
                if finding is not None:
                    # Tier 2's verdict supersedes Tier 1's AMBIGUOUS for the same entity; the id is
                    # deterministic and identical, so the loader keeps exactly one.
                    yield finding
