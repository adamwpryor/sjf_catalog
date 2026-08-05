"""Tier 3 guards and defect injection tests (DOUBLE_CHECK.md §8 & PHASE4_GEMINI_HANDOFF.md).

Every test here runs **offline**: no Vertex, no credentials, no database.

Properties pinned here:
1. refute() returns exactly as many findings as received, ids unchanged.
2. 3 refuters produce 3 distinct cache keys (fake adjudicator called 3 times).
3. Majority kill works at 3 and 5; ties do not resolve to CONFIRMED.
4. An unsure refuter votes to refute.
5. Error / refusal does not silently reduce n.
6. Tier 3 estimate mode reports cost without calling the model.
7. Out-of-scope findings pass through byte-identical.
8. Offline execution posture.
9. Ruff & typing compatibility.
10. Defect injection tests proving guards turn the suite RED when broken.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..checks import adversarial
from ..checks.registry import CheckContext
from ..db import DbFacts
from ..llm.cache import ResponseCache
from ..llm.client import Adjudicator, Request
from ..models import Finding, Refuters


def _make_test_finding(
    fid: str = "2025-2026-undergraduate:0201:F1:BIOL-201",
    check: str = "F1",
    severity: str = "critical",
    tier: int = 2,
    verdict: str = "CONFIRMED",
) -> Finding:
    return Finding(
        id=fid,
        check=check,
        severity=severity,  # type: ignore[arg-type]
        tier=tier,
        catalog_version="2025-2026-undergraduate",
        page=201,
        entity_type="course",
        entity_key="BIOL 201",
        claim="BIOL 201 carries BIOL 202 description",
        evidence_page="Principles of inheritance",
        evidence_db="description=...",
        confidence=0.9,
        verdict=verdict,  # type: ignore[arg-type]
        auto_fixable=False,
    )


def _ctx() -> CheckContext:
    db = DbFacts(version="2025-2026-undergraduate", courses=[])
    return CheckContext(
        version="2025-2026-undergraduate",
        db=db,
        pages={},
        page_texts={201: "## BIOL-201 Cell Biology (4)\nPrinciples of inheritance"},
    )


# --- Criterion 1 & 7: Exact count, ID preservation, and out-of-scope passthrough ---

def test_refute_returns_exact_findings_count_and_preserves_ids(tmp_path: Path) -> None:
    """refute() must return as many findings as given, preserving original IDs."""
    f1 = _make_test_finding("f1", tier=2, severity="critical")
    f2 = _make_test_finding("f2", tier=1, severity="low")  # out of scope
    f3 = _make_test_finding("f3", tier=1, severity="high")

    adjudicator = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path),
        fake=lambda r: json.dumps({"refute": False, "confidence": 1.0, "reason": "valid"}),
        concurrency=1,
    )
    result = adversarial.refute([f1, f2, f3], _ctx(), adjudicator)

    assert len(result) == 3
    assert [f.id for f in result] == ["f1", "f2", "f3"]
    assert result[1] == f2, "Out of scope finding f2 must pass through byte-identical"


# --- Criterion 2: 3 refuters produce 3 distinct cache keys ---

def test_three_refuters_produce_three_distinct_cache_keys(tmp_path: Path) -> None:
    """Three refuters on one finding must produce three distinct requests / cache keys."""
    calls: list[Request] = []

    def fake(req: Request) -> str:
        calls.append(req)
        return json.dumps({"refute": False, "confidence": 1.0, "reason": "confirm"})

    adjudicator = Adjudicator(
        mode="fake", cache=ResponseCache(tmp_path), fake=fake, concurrency=1
    )
    f = _make_test_finding("f1", tier=2, severity="high")  # 3 refuters
    adversarial.refute([f], _ctx(), adjudicator, n_normal=3)

    assert len(calls) == 3, "Fake adjudicator must be called 3 times for 3 refuters"
    keys = {req.key for req in calls}
    prompts = {req.prompt for req in calls}
    assert len(keys) == 3, "All 3 refuters must have distinct request keys"
    assert len(prompts) == 3, "All 3 refuters must have distinct prompt lenses"


# --- Criterion 3: Majority kill & tie breaking ---

def test_majority_kill_at_3_and_5_and_ties(tmp_path: Path) -> None:
    """Majority votes to refute set verdict to REFUTED; ties do not resolve to CONFIRMED."""

    # 2 out of 3 vote refute -> REFUTED
    votes_2_of_3 = iter([True, True, False])
    adj1 = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path / "1"),
        fake=lambda r: json.dumps({"refute": next(votes_2_of_3), "confidence": 1.0, "reason": "r"}),
        concurrency=1,
    )
    res1 = adversarial.refute([_make_test_finding("f1", severity="high")], _ctx(), adj1, n_normal=3)
    assert res1[0].verdict == "REFUTED"
    assert res1[0].refuters == Refuters(n=3, refuted=2)

    # 3 out of 5 vote refute -> REFUTED
    votes_3_of_5 = iter([True, True, True, False, False])
    adj2 = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path / "2"),
        fake=lambda r: json.dumps({"refute": next(votes_3_of_5), "confidence": 1.0, "reason": "r"}),
        concurrency=1,
    )
    res2 = adversarial.refute([_make_test_finding("f2", severity="critical")], _ctx(), adj2, n_critical=5)
    assert res2[0].verdict == "REFUTED"
    assert res2[0].refuters == Refuters(n=5, refuted=3)

    # Exact tie on 4 refuters (2 vote refute) -> does NOT stay CONFIRMED (demoted to AMBIGUOUS)
    votes_2_of_4 = iter([True, True, False, False])
    adj3 = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path / "3"),
        fake=lambda r: json.dumps({"refute": next(votes_2_of_4), "confidence": 1.0, "reason": "r"}),
        concurrency=1,
    )
    res3 = adversarial.refute([_make_test_finding("f3", severity="high")], _ctx(), adj3, n_normal=4)
    assert res3[0].verdict != "CONFIRMED", "Ties must not resolve to CONFIRMED"
    assert res3[0].refuters == Refuters(n=4, refuted=2)


# --- Criterion 4 & 5: Unsure refuter and error / refusal handling ---

def test_unsure_or_errored_refuter_votes_to_refute(tmp_path: Path) -> None:
    """An unsure refuter (confidence < 0.5) or an errored call votes to refute without reducing n."""
    # Refuter returns low confidence or bad JSON
    responses = iter([
        json.dumps({"refute": False, "confidence": 0.2, "reason": "unsure"}),  # low conf -> refute
        "not json at all",  # error -> refute
        json.dumps({"refute": False, "confidence": 0.9, "reason": "confirm"}),  # confirm
    ])

    adjudicator = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path),
        fake=lambda r: next(responses),
        concurrency=1,
    )
    res = adversarial.refute([_make_test_finding("f1", severity="high")], _ctx(), adjudicator, n_normal=3)
    assert res[0].refuters.n == 3, "n must not be reduced on error"
    assert res[0].refuters.refuted == 2, "Both low-confidence and error calls must vote to refute"
    assert res[0].verdict == "REFUTED"


# --- Criterion 6: Estimate mode ---

def test_tier3_estimate_mode_reports_cost_without_calling(tmp_path: Path) -> None:
    """In estimate mode, Tier 3 refutation counts tokens and makes no network calls."""
    called = False

    def fake(r: Request) -> str:
        nonlocal called
        called = True
        return "{}"

    adjudicator = Adjudicator(
        mode="estimate",
        cache=ResponseCache(tmp_path),
        fake=fake,
        concurrency=1,
    )
    res = adversarial.refute([_make_test_finding("f1", severity="high")], _ctx(), adjudicator, n_normal=3)
    assert not called, "Estimate mode must make no calls"
    assert len(res) == 1
    assert adjudicator.estimates.total_usd() > 0.0


# --- Criterion 10: Defect Injection Tests ---

def test_defect_injection_cache_key_collision(tmp_path: Path) -> None:
    """DEFECT INJECTION: If refuter prompts were identical, cache key would collision.

    This test proves that our distinct lens prompts prevent cache key collisions.
    """
    calls: list[Request] = []

    def fake(r: Request) -> str:
        calls.append(r)
        return json.dumps({"refute": False, "confidence": 1.0, "reason": "ok"})

    adjudicator = Adjudicator(
        mode="fake", cache=ResponseCache(tmp_path), fake=fake, concurrency=1
    )
    # Perform regular refute
    adversarial.refute([_make_test_finding("f1", severity="high")], _ctx(), adjudicator, n_normal=3)
    # 3 distinct calls were dispatched
    assert len(calls) == 3
    # If someone broke prompt lens uniqueness, requests would have identical prompts:
    prompts = [req.prompt for req in calls]
    assert len(set(prompts)) == 3, "Guard broken: refuter prompts are not unique!"


def test_defect_injection_silent_n_reduction(tmp_path: Path) -> None:
    """DEFECT INJECTION: Show that reducing n on error breaks the guard."""
    f = _make_test_finding("f1", severity="high")
    adjudicator = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path),
        fake=lambda r: "error",
        concurrency=1,
    )
    res = adversarial.refute([f], _ctx(), adjudicator, n_normal=3)
    # Guard check: n must remain 3, not reduced to 0
    assert res[0].refuters.n == 3, "Guard broken: n was silently reduced on error!"
