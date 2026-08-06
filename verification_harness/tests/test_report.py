"""Report generator honesty and dynamic coverage unit tests (DOUBLE_CHECK.md & Phase 4 signoff).

Every test here runs offline: no Vertex, no credentials, no database.

Pins the resolution of the two report.py honesty defects:
1. Per-check cap explicitly states findings are OMITTED (not "grouped"), stating where the full set lives.
2. Coverage & Audit Summary is fully computed from the findings data rather than using hardcoded text.
"""

from __future__ import annotations

from typing import Any

from ..report.report import generate_report_markdown


def _sample_finding(
    fid: str = "v:0001:A1:C1",
    check: str = "A1",
    severity: str = "critical",
    tier: int = 1,
    verdict: str = "CONFIRMED",
    page: int = 1,
    n_refuters: int = 0,
    refuted: int = 0,
) -> dict[str, Any]:
    return {
        "id": fid,
        "check": check,
        "severity": severity,
        "tier": tier,
        "verdict": verdict,
        "catalog_version": "2025-2026-undergraduate",
        "page": page,
        "entity_type": "course",
        "entity_key": "MATH 101",
        "claim": "Missing course definition on page",
        "evidence_page": "MATH 101",
        "evidence_db": "MATH 101",
        "suggested_fix": None,
        "refuters": {"n": n_refuters, "refuted": refuted} if n_refuters > 0 else None,
    }


def test_per_check_cap_states_omitted_not_grouped() -> None:
    """Honesty defect 1: >50 findings under one check must be reported as OMITTED, not grouped."""
    findings = [_sample_finding(fid=f"f-{i}", check="D1", severity="high") for i in range(60)]
    report_md = generate_report_markdown(findings)

    assert "OMITTED from this list" in report_md
    assert "not grouped or summarized" in report_md
    assert "10 further `D1` findings are OMITTED" in report_md
    assert "10 findings (`D1` 10)" in report_md


def test_audit_summary_is_dynamically_computed_from_data() -> None:
    """Honesty defect 2: Audit summary metrics must be derived dynamically from findings."""
    findings = [
        # Tier 1 confirmed finding with 0 refuters (unverified)
        _sample_finding(fid="f1", tier=1, severity="critical", verdict="CONFIRMED", n_refuters=0),
        # Tier 2 plausible finding with 3 refuters (none refuted)
        _sample_finding(fid="f2", tier=2, severity="high", verdict="PLAUSIBLE", n_refuters=3, refuted=0),
        # Tier 2 refuted finding with 3 refuters (2 refuted)
        _sample_finding(fid="f3", tier=2, severity="high", verdict="REFUTED", n_refuters=3, refuted=2),
        # Ambiguous finding
        _sample_finding(fid="f4", tier=1, severity="medium", verdict="AMBIGUOUS", n_refuters=0),
    ]

    report_md = generate_report_markdown(findings)

    assert "Every figure here is computed from the findings in this run, not asserted." in report_md
    assert "- **Tier 1 (deterministic):** 2 findings." in report_md
    assert "- **Tier 2 (LLM adjudication):** 2 findings." in report_md
    assert "- **Tier 3 (refutation):** 6 refuter votes cast; 1 findings killed as false positives." in report_md
    assert "- **Not adversarially verified:** 1 actionable findings carry `refuters.n = 0`." in report_md
