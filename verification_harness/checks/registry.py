"""Check framework: registration, a crash-safe runner, and a P5-safe findings writer.

A *check* is a function ``(CheckContext) -> Iterator[Finding]`` registered with :func:`register`.
The runner (:func:`run`) is deliberately defensive, per the spec guardrails:

- **A crashing check never aborts the run and is never silent.** If a check raises, the runner
  emits a ``critical`` ``harness-error`` finding in its place and continues (P4/P5).
- **Page-dependent checks are skipped, not failed, until Tier 0 lands.** A check declared
  ``needs_pages=True`` yields nothing (logged) when the extractor's ``PageFacts`` are absent.
- **A finding that fails to serialize becomes a finding.** :func:`write_findings` never drops a
  row — under-reporting is the harness's worst failure mode (P5).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from ..db import DbFacts
from ..models import Finding, PageFacts

logger = logging.getLogger(__name__)

Severity = str  # one of the Finding.severity Literals; kept loose so checks read naturally


@dataclass(frozen=True)
class CheckContext:
    """Everything a check may read for one catalog version.

    Attributes:
        version: Catalog key under test, e.g. ``"2025-2026-undergraduate"``.
        db: Version-scoped DERIVED facts (read-only).
        pages: Tier 0 ``PageFacts`` keyed by page number, or ``None`` until the extractor lands.
            Checks that need it declare ``needs_pages=True`` and are skipped while it is ``None``.
        page_texts: Raw page markdown keyed by page number (for verbatim-content checks like C2),
            populated alongside ``pages`` by the pipeline. ``None`` when ``pages`` is ``None``.
    """

    version: str
    db: DbFacts
    pages: dict[int, PageFacts] | None = None
    page_texts: dict[int, str] | None = None


CheckFn = Callable[[CheckContext], Iterator[Finding]]


@dataclass(frozen=True)
class CheckSpec:
    """Registration metadata for a single check."""

    id: str
    fn: CheckFn
    tier: int
    needs_pages: bool
    title: str


REGISTRY: dict[str, CheckSpec] = {}


def register(
    check_id: str,
    *,
    tier: int = 1,
    needs_pages: bool = False,
    title: str = "",
) -> Callable[[CheckFn], CheckFn]:
    """Register a check under a stable id (e.g. ``"C1"``).

    Args:
        check_id: Stable check id from ``DOUBLE_CHECK.md`` §6.
        tier: 1 (deterministic), 2 (LLM), or 3 (adversarial).
        needs_pages: True if the check reads Tier 0 ``PageFacts`` (skipped until the extractor lands).
        title: One-line human description; defaults to the function's first docstring line.

    Returns:
        The unchanged function (decorator form).

    Raises:
        ValueError: If ``check_id`` is already registered (guards silent shadowing).
    """

    def decorator(fn: CheckFn) -> CheckFn:
        if check_id in REGISTRY:
            raise ValueError(f"check {check_id!r} is already registered")
        doc = title or (fn.__doc__ or "").strip().splitlines()[0] if (title or fn.__doc__) else ""
        REGISTRY[check_id] = CheckSpec(check_id, fn, tier, needs_pages, doc)
        return fn

    return decorator


def make_finding(
    ctx: CheckContext,
    check: str,
    *,
    severity: Severity,
    entity_type: str,
    entity_key: str,
    claim: str,
    page: int | None = None,
    entity_id: str | None = None,
    ancestor_path: list[str] | None = None,
    evidence_page: str = "",
    evidence_db: str | None = None,
    suggested_fix: str | None = None,
    auto_fixable: bool = False,
    verdict: str = "CONFIRMED",
    confidence: float = 1.0,
    tier: int = 1,
) -> Finding:
    """Build a :class:`Finding` with a deterministic id so re-runs diff cleanly (P3).

    The id is ``"{version}:{page|----}:{check}:{entity_key}"``. Deterministic Tier 1 findings
    default to ``verdict="CONFIRMED"`` at ``confidence=1.0``.

    Returns:
        A validated :class:`Finding`.
    """
    page_tag = f"{page:04d}" if page is not None else "----"
    return Finding(
        id=f"{ctx.version}:{page_tag}:{check}:{entity_key}",
        check=check,
        severity=severity,
        tier=tier,
        catalog_version=ctx.version,
        page=page if page is not None else 0,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_key=entity_key,
        ancestor_path=ancestor_path,
        claim=claim,
        evidence_page=evidence_page,
        evidence_db=evidence_db,
        confidence=confidence,
        verdict=verdict,
        suggested_fix=suggested_fix,
        auto_fixable=auto_fixable,
    )


def _harness_error_finding(ctx: CheckContext, spec: CheckSpec, exc: Exception) -> Finding:
    """Represent a crashed check as a critical finding, so the failure is never silent."""
    return Finding(
        id=f"{ctx.version}:----:harness-error:{spec.id}",
        check=spec.id,
        severity="critical",
        tier=spec.tier,
        catalog_version=ctx.version,
        page=0,
        entity_type="page",
        entity_key=spec.id,
        claim=f"check {spec.id} crashed: {type(exc).__name__}: {exc}",
        evidence_page="",
        evidence_db=None,
        confidence=1.0,
        verdict="CONFIRMED",
        auto_fixable=False,
    )


def run(ctx: CheckContext, ids: Iterable[str] | None = None) -> Iterator[Finding]:
    """Run registered checks for one version, yielding findings.

    Args:
        ctx: The version's context.
        ids: Restrict to these check ids; ``None`` runs all registered checks.

    Yields:
        Findings, in registration order. A page-dependent check with no pages is skipped
        (logged); a crashing check yields one ``critical`` finding and does not abort the run.
    """
    selected = list(REGISTRY.values()) if ids is None else [REGISTRY[i] for i in ids]
    for spec in selected:
        if spec.needs_pages and ctx.pages is None:
            logger.info("skip %s: needs Tier 0 pages (extractor not yet available)", spec.id)
            continue
        try:
            yield from spec.fn(ctx)
        except Exception as exc:
            logger.exception("check %s crashed", spec.id)
            yield _harness_error_finding(ctx, spec, exc)


def write_findings(findings: Iterable[Finding], path: Path) -> int:
    """Write findings to a JSONL file, guaranteeing none is silently dropped (P5).

    The file is truncated first, so a re-run overwrites rather than double-appending (P3).
    If a finding cannot be serialized, a ``critical`` placeholder recording the failure is
    written in its place — the harness reports its own defect rather than hiding it.

    Args:
        findings: The findings to write.
        path: Destination ``.jsonl`` file.

    Returns:
        The number of lines written.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for finding in findings:
            try:
                line = finding.model_dump_json()
            except Exception as exc:  # noqa: BLE001 — never drop a finding
                fid = getattr(finding, "id", "unknown")
                line = json.dumps(
                    {
                        "id": f"serialize-error:{fid}",
                        "check": "harness-error",
                        "severity": "critical",
                        "tier": 1,
                        "catalog_version": "",
                        "page": 0,
                        "entity_type": "page",
                        "entity_key": str(fid),
                        "claim": f"finding failed to serialize: {type(exc).__name__}: {exc}",
                        "evidence_page": "",
                        "confidence": 1.0,
                        "verdict": "CONFIRMED",
                        "auto_fixable": False,
                    }
                )
            handle.write(line + "\n")
            count += 1
    return count
