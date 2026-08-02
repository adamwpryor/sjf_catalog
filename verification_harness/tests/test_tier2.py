"""Tier 2 guards — the properties that must hold whether or not a model is reachable.

Every test here runs **offline**: no Vertex, no credentials, no database. That is deliberate and not
merely convenient. The things most likely to go wrong in an LLM tier — a hallucinated excerpt, a
re-run that silently costs money, a budget stop that looks like "nothing found" — are all
observable without a live model, and a guard that only runs when someone has fresh ADC is a guard
that will not run.

What is pinned here:

- **Reproducibility (P3).** A repeated call replays from cache, byte-identical and free.
- **Evidence (P4).** A verdict whose quoted page text is not on the page is demoted, not trusted.
- **Never under-report (P5).** Failed calls, budget stops, and sampling gaps become visible
  findings with distinct ids — never a silently shorter result set.
- **Cost (Q5).** The ceiling stops the run rather than being advisory.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ..checks import semantic
from ..checks.registry import CheckContext
from ..db import DbFacts
from ..llm.budget import Budget, BudgetExceeded, Usage, estimate_cost_usd
from ..llm.cache import CachedResponse, ResponseCache, prompt_key
from ..llm.client import Adjudicator, Request, strip_unsupported_schema
from ..models import ExtractedCourse, PageFacts

PAGE_TEXT = """\
# Biology

## BIOL-201 Cell Biology (4)

An introduction to the structure and function of the eukaryotic cell, including membrane
transport, the cytoskeleton, and organelle biogenesis. Prerequisite: BIOL 101.

## BIOL-202 Genetics (3)

Principles of inheritance, gene expression, and population genetics.
"""

SCHEMA: dict[str, Any] = {"type": "object", "properties": {"ok": {"type": "boolean"}}}


def _request(prompt: str = "judge this") -> Request:
    return Request(key="k", system="sys", prompt=prompt, schema=SCHEMA)


def _ctx(tmp_path: Path | None = None) -> CheckContext:
    """Build a minimal one-page, two-course context."""
    facts = PageFacts(
        catalog_version="2025-2026-undergraduate",
        page=201,
        page_role="content",
        leading_orphan_text=False,
        courses=[
            ExtractedCourse(code="BIOL 201", title="Cell Biology", credits=4, heading_line=3),
            ExtractedCourse(code="BIOL 202", title="Genetics", credits=3, heading_line=8),
        ],
    )
    db = DbFacts(
        version="2025-2026-undergraduate",
        courses=[
            {
                "id": "uuid-201",
                "course_code": "BIOL 201",
                "title": "Cell Biology",
                "credits": 4,
                "description": "Principles of inheritance, gene expression, and population genetics.",
                "prerequisites": None,
                "is_ghost": False,
                "markdown_url": "gs://sjfu-assets/catalogs/SJFU/2025-2026-undergraduate/pages/page_0201.md",
            },
            {
                "id": "uuid-202",
                "course_code": "BIOL 202",
                "title": "Genetics",
                "credits": 3,
                "description": "Principles of inheritance.",
                "prerequisites": None,
                "is_ghost": False,
                "markdown_url": "gs://sjfu-assets/catalogs/SJFU/2025-2026-undergraduate/pages/page_0201.md",
            },
        ],
    )
    return CheckContext(
        version="2025-2026-undergraduate",
        db=db,
        pages={201: facts},
        page_texts={201: PAGE_TEXT},
    )


# --- P3: reproducibility ----------------------------------------------------------

def test_repeated_call_replays_from_cache_and_costs_nothing(tmp_path: Path) -> None:
    """The second identical call must not reach the model.

    This is what makes Tier 2 diffable across runs. Without it, two runs over an unchanged corpus
    produce differently-worded findings and regression tracking becomes meaningless.
    """
    calls: list[str] = []

    def fake(request: Request) -> str:
        calls.append(request.prompt)
        return json.dumps({"ok": True})

    adjudicator = Adjudicator(
        mode="fake", cache=ResponseCache(tmp_path), fake=fake, concurrency=1
    )
    first = adjudicator.complete(_request())
    second = adjudicator.complete(_request())

    assert len(calls) == 1, "the second call should have been served from cache"
    assert first.data == second.data
    assert second.usage.cached and second.usage.cost_usd == 0.0


def test_changing_the_model_invalidates_the_cache(tmp_path: Path) -> None:
    """A cached answer must not be reused under a configuration that would not have produced it."""
    key_a = prompt_key(model="gemini-2.5-flash", system="s", prompt="p", schema=SCHEMA, params={})
    key_b = prompt_key(model="gemini-2.5-pro", system="s", prompt="p", schema=SCHEMA, params={})
    assert key_a != key_b

    key_c = prompt_key(
        model="gemini-2.5-flash", system="s", prompt="p", schema=SCHEMA, params={"temperature": 1.0}
    )
    assert key_a != key_c


def test_replay_mode_never_calls_the_model(tmp_path: Path) -> None:
    """A cache miss in replay mode is reported, not quietly turned into a billed call.

    A "replay" that falls through to the network is worse than a failure: it spends money while
    claiming to be offline, and its output is no longer the recorded one.
    """
    adjudicator = Adjudicator(mode="replay", cache=ResponseCache(tmp_path, read_only=True))
    response = adjudicator.complete(_request())
    assert not response.ok
    assert "replay-mode cache miss" in (response.error or "")
    assert adjudicator.budget.spent_usd == 0.0


def test_corrupt_cache_entry_is_a_miss_not_an_empty_answer(tmp_path: Path) -> None:
    """A truncated entry must never replay as ``""`` — that reads as "the model found nothing"."""
    cache = ResponseCache(tmp_path)
    key = "a" * 64
    cache.put(key, CachedResponse("{}", "gemini-2.5-flash", 1, 1))
    entry = tmp_path / key[:2] / f"{key}.json"
    entry.write_text("{ truncated", encoding="utf-8")
    assert cache.get(key) is None


def test_seeded_sample_is_identical_across_runs() -> None:
    """Sampling is seeded so a discovery check can be regression-tracked (P3)."""
    population = list(range(500))
    first, skipped = semantic._seeded_sample(population, 13, "F4:2025-2026-undergraduate")
    second, _ = semantic._seeded_sample(population, 13, "F4:2025-2026-undergraduate")
    other, _ = semantic._seeded_sample(population, 13, "F4:2024-2025-graduate")
    assert first == second
    assert first != other, "different versions must not draw the same page numbers"
    assert skipped == 487


# --- P4: evidence is verified, not trusted ----------------------------------------

def test_excerpt_supported_accepts_typographic_drift() -> None:
    """Trap T9: a model that regularizes a dash or smart quote is still quoting the page."""
    assert semantic.excerpt_supported(
        "An introduction to the structure and function of the eukaryotic cell", PAGE_TEXT
    )
    assert semantic.excerpt_supported("## BIOL-201 Cell Biology (4)", PAGE_TEXT)


def test_excerpt_supported_rejects_invented_text() -> None:
    """A fluent excerpt that is not on the page must not verify."""
    assert not semantic.excerpt_supported(
        "This course surveys the history of molecular medicine in the twentieth century.", PAGE_TEXT
    )
    assert not semantic.excerpt_supported("", PAGE_TEXT)


def test_hallucinated_evidence_demotes_the_verdict() -> None:
    """A CONFIRMED finding whose quote is not on the page is demoted to AMBIGUOUS and says so.

    The finding is kept rather than dropped: a model inventing evidence is itself something the run
    needs to surface, and deleting it would hide the failure (P5).
    """
    finding = semantic._issue_to_finding(
        _ctx(),
        {
            "check": "B3",
            "verdict": "CONFIRMED",
            "severity": "critical",
            "confidence": 0.95,
            "claim": "description belongs to BIOL 202",
            "evidence_page": "A survey of marine invertebrate taxonomy and field methods.",
        },
        allowed=("B3", "B4", "F1"),
        entity_type="course",
        entity_key="BIOL 201",
        entity_id="uuid-201",
        page=201,
        page_text=PAGE_TEXT,
    )
    assert finding is not None
    assert finding.verdict == "AMBIGUOUS"
    assert "EVIDENCE UNVERIFIED" in finding.claim
    assert finding.confidence <= 0.3


def test_verified_evidence_keeps_its_verdict() -> None:
    """The demotion must not fire on a genuine quote, or every finding would be neutralized."""
    finding = semantic._issue_to_finding(
        _ctx(),
        {
            "check": "B3",
            "verdict": "CONFIRMED",
            "severity": "critical",
            "confidence": 0.95,
            "claim": "BIOL 201's description is BIOL 202's text",
            "evidence_page": "Principles of inheritance, gene expression, and population genetics.",
        },
        allowed=("B3", "B4", "F1"),
        entity_type="course",
        entity_key="BIOL 201",
        entity_id="uuid-201",
        page=201,
        page_text=PAGE_TEXT,
    )
    assert finding is not None
    assert finding.verdict == "CONFIRMED"
    assert finding.tier == 2
    assert "EVIDENCE UNVERIFIED" not in finding.claim


def test_issue_for_an_unrequested_check_is_discarded() -> None:
    """A B3 call may not emit a C1 finding — the tier boundary is enforced, not requested."""
    assert (
        semantic._issue_to_finding(
            _ctx(),
            {
                "check": "C1",
                "verdict": "CONFIRMED",
                "severity": "high",
                "confidence": 0.9,
                "claim": "page number mismatch",
                "evidence_page": "## BIOL-201 Cell Biology (4)",
            },
            allowed=("B3", "B4", "F1"),
            entity_type="course",
            entity_key="BIOL 201",
            entity_id="uuid-201",
            page=201,
            page_text=PAGE_TEXT,
        )
        is None
    )


# --- Q5: the ceiling stops the run ------------------------------------------------

def test_budget_ceiling_halts_further_calls(tmp_path: Path) -> None:
    """Once spend reaches the ceiling, no further call is dispatched and the stop is visible."""
    budget = Budget(ceiling_usd=0.000_001)
    adjudicator = Adjudicator(
        mode="fake",
        cache=ResponseCache(tmp_path),
        budget=budget,
        fake=lambda r: json.dumps({"ok": True}),
        concurrency=1,
    )
    first = adjudicator.complete(_request("prompt one"))
    assert first.ok, "the first call happens; the ceiling is checked before dispatch"

    second = adjudicator.complete(_request("prompt two"))
    assert not second.ok
    assert "budget ceiling reached" in (second.error or "")
    assert adjudicator.budget_stopped, "a partial run must be reportable as partial"


def test_unknown_model_is_priced_at_the_most_expensive_rate() -> None:
    """A typo'd model id must not read as free and slip past the ceiling."""
    unknown = estimate_cost_usd("gemini-9.9-imaginary", 1_000_000, 1_000_000)
    known_max = estimate_cost_usd("gemini-2.5-pro", 1_000_000, 1_000_000)
    assert unknown >= known_max > 0


def test_budget_exceeded_names_the_numbers() -> None:
    """The stop must say where it stopped, not just that it did."""
    budget = Budget(ceiling_usd=0.01)
    budget.charge(Usage("gemini-2.5-flash", 1_000_000, 1_000_000))
    with pytest.raises(BudgetExceeded) as caught:
        budget.check()
    assert "0.01" in str(caught.value)
    assert caught.value.calls == 1


# --- P5: failures are visible -----------------------------------------------------

def test_failed_calls_become_findings_with_distinct_ids(tmp_path: Path) -> None:
    """Two failed batches on one page must not collide on a finding id.

    A dense page splits across calls, so keying the failure on the page alone reproduces the exact
    duplicate-id defect Phase 2 fixed in Tier 1 — and the loader rejects duplicates outright.
    """
    ctx = _ctx()
    first = semantic._failure_finding(ctx, "B3", "v:201:0", 201, "timeout")
    second = semantic._failure_finding(ctx, "B3", "v:201:12", 201, "timeout")
    assert first.id != second.id
    assert first.verdict == "AMBIGUOUS" and first.confidence == 0.0


def test_adjudication_failure_yields_a_finding_per_call(tmp_path: Path) -> None:
    """A tier whose calls all fail reports that, rather than reporting nothing."""
    ctx_with_llm = CheckContext(
        version=_ctx().version,
        db=_ctx().db,
        pages=_ctx().pages,
        page_texts=_ctx().page_texts,
        adjudicator=Adjudicator(
            mode="fake",
            cache=ResponseCache(tmp_path),
            fake=lambda r: "not json at all",
            concurrency=1,
        ),
    )
    findings = list(semantic.check_b3_b4_f1(ctx_with_llm))
    assert len(findings) == 1
    assert "adjudication did not complete" in findings[0].claim
    assert findings[0].tier == 2


def test_end_to_end_with_a_fake_model(tmp_path: Path) -> None:
    """A well-formed adjudication becomes a Tier 2 finding carrying its evidence."""
    def fake(request: Request) -> str:
        return json.dumps(
            {
                "results": [
                    {
                        "course_code": "BIOL 201",
                        "issues": [
                            {
                                "check": "F1",
                                "verdict": "CONFIRMED",
                                "severity": "critical",
                                "confidence": 0.9,
                                "claim": "BIOL 201 carries BIOL 202's description",
                                "evidence_page": (
                                    "Principles of inheritance, gene expression, and population "
                                    "genetics."
                                ),
                                "evidence_db": "description=Principles of inheritance…",
                            }
                        ],
                    },
                    {"course_code": "BIOL 202", "issues": []},
                ]
            }
        )

    base = _ctx()
    ctx = CheckContext(
        version=base.version,
        db=base.db,
        pages=base.pages,
        page_texts=base.page_texts,
        adjudicator=Adjudicator(
            mode="fake", cache=ResponseCache(tmp_path), fake=fake, concurrency=1
        ),
    )
    findings = list(semantic.check_b3_b4_f1(ctx))
    assert len(findings) == 1
    finding = findings[0]
    assert finding.check == "F1" and finding.tier == 2
    assert finding.entity_key == "BIOL 201" and finding.entity_id == "uuid-201"
    assert finding.verdict == "CONFIRMED" and finding.severity == "critical"


def test_ghost_rows_are_not_adjudicated(tmp_path: Path) -> None:
    """A synthesized placeholder has no description to judge; A6 owns that defect instead.

    Sending them anyway would spend money to rediscover, for every ghost row, that a placeholder
    does not match the page.
    """
    base = _ctx()
    ghosted = DbFacts(
        version=base.db.version,
        courses=[{**c, "is_ghost": True} for c in base.db.courses],
    )
    ctx = CheckContext(
        version=base.version,
        db=ghosted,
        pages=base.pages,
        page_texts=base.page_texts,
        adjudicator=Adjudicator(
            mode="fake",
            cache=ResponseCache(tmp_path),
            fake=lambda r: pytest.fail("ghost rows must not reach the model"),
            concurrency=1,
        ),
    )
    assert list(semantic.check_b3_b4_f1(ctx)) == []


# --- F4: the promotion rule is enforced, not requested ----------------------------

def test_discovery_findings_are_capped_at_info(tmp_path: Path) -> None:
    """§5 Risk B: discovery output may never enter the remediation queue.

    The prompt asks for ``info``/hypothesis, but a prompt is not an enforcement mechanism. The cap
    is applied in code, so a model that returns ``critical``/``CONFIRMED`` still cannot promote its
    own hypothesis into a defect.
    """
    def fake(request: Request) -> str:
        return json.dumps(
            {
                "results": [
                    {
                        "page": "201",
                        "issues": [
                            {
                                "check": "F4",
                                "verdict": "CONFIRMED",
                                "severity": "critical",
                                "confidence": 0.99,
                                "claim": "the page states a lab fee the database does not store",
                                "evidence_page": "An introduction to the structure and function",
                            }
                        ],
                    }
                ]
            }
        )

    base = _ctx()
    ctx = CheckContext(
        version=base.version,
        db=base.db,
        pages=base.pages,
        page_texts=base.page_texts,
        adjudicator=Adjudicator(
            mode="fake", cache=ResponseCache(tmp_path), fake=fake, concurrency=1
        ),
    )
    findings = list(semantic.check_f4(ctx))
    assert findings, "the sample should include the single content page"
    for finding in findings:
        assert finding.severity == "info"
        assert finding.verdict != "CONFIRMED"


# --- Vertex schema compatibility ---------------------------------------------------

def test_schema_is_stripped_to_the_openapi_subset() -> None:
    """Vertex rejects ``additionalProperties``; leaving it in is a 400 on every call."""
    cleaned = strip_unsupported_schema(
        {
            "type": "object",
            "additionalProperties": False,
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "properties": {
                "results": {
                    "type": "array",
                    "items": {"type": "object", "additionalProperties": False},
                }
            },
        }
    )
    serialized = json.dumps(cleaned)
    assert "additionalProperties" not in serialized
    assert "$schema" not in serialized
    assert cleaned["properties"]["results"]["items"]["type"] == "object"


def test_real_response_schemas_survive_stripping() -> None:
    """The schemas the checks actually send must stay valid objects after pruning."""
    for schema in (
        semantic._entity_schema("course_code", ("B3", "B4", "F1")),
        semantic._entity_schema("name", ("B7", "F2")),
        semantic._entity_schema("chunk_id", ("F3",)),
    ):
        cleaned = strip_unsupported_schema(schema)
        assert cleaned["type"] == "object"
        assert "results" in cleaned["properties"]
        assert "additionalProperties" not in json.dumps(cleaned)
