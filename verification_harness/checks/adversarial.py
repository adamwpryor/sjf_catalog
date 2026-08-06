"""Phase 4: Tier 3 Adversarial Verification (DOUBLE_CHECK.md §8).

Provides adversarial verification over findings produced by Tiers 1 and 2:
- N independent skeptics per finding, prompted to REFUTE.
- Majority kill (`refuted > n / 2`) updates verdict to REFUTED.
- Default to refuted when unsure (§8) or when refuter errors/refuses.
- Preserves all finding IDs and output counts.
- Uses distinct prompt lenses per refuter to ensure unique cache keys (P3).
"""

from __future__ import annotations

import logging
from typing import Any

from ..llm.client import Adjudicator, Request, Response
from ..models import Finding, Refuters
from .registry import CheckContext

logger = logging.getLogger(__name__)

REFUTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "refute": {"type": "boolean"},
        "confidence": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["refute", "confidence", "reason"],
}

#: 5 distinct refuter lenses ensuring distinct prompts, cache keys, and analytical angles.
LENSES: list[tuple[str, str]] = [
    (
        "evidence",
        (
            "EVIDENCE LENS: Evaluate whether the quoted evidence_page text is verbatim present in the source "
            "page text and directly supports the finding's claim. If the quoted text does not exist or does "
            "not prove the claim, vote to REFUTE."
        ),
    ),
    (
        "trap",
        (
            "TRAP LENS: Evaluate whether this finding matches a known catalog false-positive trap (§7 T1–T11), "
            "such as abbreviated titles, dual course numbering (3-digit vs 4-digit), course code suffixes, "
            "table-of-contents redundancy, cross-listed courses, or typography differences. If it matches a trap, "
            "vote to REFUTE."
        ),
    ),
    (
        "scope",
        (
            "SCOPE LENS: Evaluate whether the claim correctly identifies the exact entity, page number, "
            "and catalog version. Check if the claim misattributes content from a different page or section. "
            "If misscoped, vote to REFUTE."
        ),
    ),
    (
        "severity",
        (
            "SEVERITY LENS: Evaluate whether the claimed issue, even if factually true, is a genuine defect "
            "of the claimed severity. If it is merely an inventory aggregate, cosmetic formatting difference, "
            "or non-defect, vote to REFUTE."
        ),
    ),
    (
        "alternative_reading",
        (
            "ALTERNATIVE READING LENS: Search for any reasonable context or alternative reading of the source "
            "page text under which the database representation is valid. If a valid reading exists, vote to REFUTE."
        ),
    ),
]


def is_in_scope(finding: Finding, *, critical_only: bool = False) -> bool:
    """Return True if a finding is in scope for Tier 3 refutation.

    Default scope (Phase 4 spec):
    1. Every Tier 2 finding (tier == 2).
    2. Tier 1 findings with critical or high severity.
    Out of scope: Tier 1 medium/low/info (inventory & provenance; Phase 1 measured 0% FP there).

    ``critical_only`` narrows to `critical` alone. Adam chose this on `2026-08-06` after the Phase 3
    FP gate measured Tier 2's false-positive rate at ~3%: Tier 3 exists to suppress false positives,
    and at that rate the default scope spends ~9 hours refuting findings that are overwhelmingly
    real. `critical` is where a wrong remediation does the most damage, and it costs about an hour.
    The narrowing is a cost decision, not a claim that the rest were verified — findings outside the
    scope keep ``refuters.n = 0``, and ``report.py`` counts them as reported-but-not-verified.

    Args:
        finding: The finding to test.
        critical_only: Restrict to `critical` severity regardless of tier.

    Returns:
        True if Tier 3 should refute this finding.
    """
    if critical_only:
        return finding.severity == "critical"
    if finding.tier == 2:
        return True
    return finding.tier == 1 and finding.severity in ("critical", "high")


def _build_refuter_request(
    finding: Finding,
    refuter_idx: int,
    lens_name: str,
    lens_instruction: str,
    page_text: str,
) -> Request:
    """Build a structured refuter Request with a distinct lens prompt and cache key."""
    system_prompt = (
        "You are an independent, skeptical catalog auditor (Tier 3 Refuter). Your job is to "
        "critically evaluate a reported catalog finding and determine if it is a FALSE POSITIVE "
        "that should be REFUTED. You must vote to REFUTE whenever there is reasonable doubt, "
        "unsupported evidence, or a false-positive pattern. Output JSON conforming to the schema."
    )

    user_prompt = f"""\
EVALUATE FINDING FOR REFUTATION:

Finding ID: {finding.id}
Check: {finding.check}
Severity: {finding.severity}
Catalog Version: {finding.catalog_version}
Page: {finding.page}
Entity: {finding.entity_type} ({finding.entity_key})
Reported Claim: {finding.claim}
Quoted Evidence (Page): {finding.evidence_page}
Quoted Evidence (DB): {finding.evidence_db or 'N/A'}

SOURCE PAGE TEXT EXCERPT:
\"\"\"
{page_text[:4000]}
\"\"\"

ANALYTICAL LENS ({refuter_idx + 1}):
{lens_instruction}

Does this finding represent a false positive that should be REFUTED?
"""
    return Request(
        key=f"{finding.id}:refuter-{refuter_idx}:{lens_name}",
        system=system_prompt,
        prompt=user_prompt,
        schema=REFUTER_SCHEMA,
    )


def refute(
    findings: list[Finding],
    ctx: CheckContext,
    adjudicator: Adjudicator,
    *,
    n_normal: int = 3,
    n_critical: int = 5,
    critical_only: bool = False,
) -> list[Finding]:
    """Adversarially verify in-scope findings; return ALL findings, verdicts updated.

    Returns the same number of findings it was given. A finding out of scope is passed through
    untouched. A finding whose refuters could not run keeps its prior verdict and records why.

    Args:
        findings: Input findings from Tier 1 & Tier 2.
        ctx: Verification context (for page texts).
        adjudicator: LLM adjudicator client.
        n_normal: Number of refuters for normal (high / Tier 2 non-critical) findings.
        n_critical: Number of refuters for critical severity findings.
        critical_only: Narrow scope to `critical` findings only (see :func:`is_in_scope`).

    Returns:
        List of findings, same length and order as input, with updated refuter counts & verdicts.
    """
    if not findings:
        return []

    # Map each in-scope finding to its requests
    finding_requests: list[tuple[int, Finding, list[Request]]] = []
    all_requests: list[Request] = []
    unverifiable: list[str] = []

    for i, finding in enumerate(findings):
        if not is_in_scope(finding, critical_only=critical_only):
            continue

        n_wanted = n_critical if finding.severity == "critical" else n_normal
        page_text = ""
        if ctx.page_texts and finding.page in ctx.page_texts:
            page_text = ctx.page_texts[finding.page]

        if not page_text:
            # Nothing to refute *against*. Some in-scope findings are pageless by construction:
            # `A4` reports rows that link to no source page — "there is no page" IS the claim — and
            # the `B4`/`B6` systemic classes are per-catalog aggregates carrying no single page.
            # Handing a refuter an empty excerpt and then applying "default to refuted when unsure"
            # would kill them all: 42 findings on the current sweep, including `DEXL 725`, one of
            # the five matcher failures the §11 known-answer gate exists to catch.
            #
            # So they are left unrefuted rather than refuted. `n=0` records that plainly — "not
            # verified" is honest, "REFUTED" would be a silent kill dressed up as a verdict (P5).
            unverifiable.append(finding.id)
            continue

        requests: list[Request] = []
        for r_idx in range(n_wanted):
            lens_name, lens_instr = LENSES[r_idx % len(LENSES)]
            req = _build_refuter_request(finding, r_idx, lens_name, lens_instr, page_text)
            requests.append(req)
            all_requests.append(req)

        finding_requests.append((i, finding, requests))

    if unverifiable:
        logger.info(
            "tier 3: %d in-scope finding(s) left unrefuted — no page text to refute against "
            "(pageless by construction, e.g. %s)",
            len(unverifiable),
            ", ".join(unverifiable[:3]),
        )

    if not all_requests:
        return list(findings)

    # Execute all requests concurrently via adjudicator
    responses = adjudicator.map(all_requests, check="T3")
    response_map: dict[str, Response] = {resp.key: resp for resp in responses}

    # Process results per finding
    result_findings = list(findings)
    for idx, finding, reqs in finding_requests:
        refuted_count = 0
        n_attempted = len(reqs)

        for req in reqs:
            resp = response_map.get(req.key)
            # Default to refuted when unsure / error / refusal (§8)
            if resp is None or not resp.ok or not resp.data:
                refuted_count += 1
                continue

            refute_vote = bool(resp.data.get("refute", False))
            confidence = float(resp.data.get("confidence", 1.0))
            # Low confidence votes default to refute
            if confidence < 0.5:
                refute_vote = True

            if refute_vote:
                refuted_count += 1

        updated_finding = finding.model_copy(deep=True)
        updated_finding.refuters = Refuters(n=n_attempted, refuted=refuted_count)

        # Majority kill rule
        if refuted_count > n_attempted / 2:
            updated_finding.verdict = "REFUTED"
        elif refuted_count * 2 == n_attempted and updated_finding.verdict == "CONFIRMED":
            # Exact tie: ties do not resolve to CONFIRMED
            updated_finding.verdict = "AMBIGUOUS"

        result_findings[idx] = updated_finding

    return result_findings
