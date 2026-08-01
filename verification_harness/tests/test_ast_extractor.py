"""Tier 0 drift guard — diff the extractor against the frozen golden oracle.

The fixtures in ``tests/fixtures/`` were hand-verified during Phase 0, but nothing re-ran them, so
an edit to ``extract/`` could silently drift from the oracle and surface only as *changed findings*
three tiers downstream. This module closes that gap: every fixture is replayed against the live
extractor on each ``pytest`` run.

**Cross-authoring (Design Principle P1).** Gemini owns ``extract/ast_extractor.py``; Claude authored
both the fixtures and this test. A parser bug cannot be "confirmed" by a test carrying the same
blind spot.

Unlike the §11 gate, these tests need **no database and no full sweep** — only the cached source
page each fixture names. They skip cleanly when the page cache is absent::

    python -m verification_harness --all --sync     # populates the page cache
    pytest verification_harness/tests/test_ast_extractor.py -v
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from .. import config
from ..extract.ast_extractor import extract_facts

#: Fixture convention: a leading underscore marks provenance/commentary (``_fixture``, ``_source``,
#: ``_encodes``, ``_page_role_note``, …) rather than oracle data. Matched by prefix, not by a fixed
#: list, so a new annotation in a future fixture is not mistaken for a field the extractor must emit.
_META_PREFIX = "_"


def _fixture_paths() -> list[Path]:
    """Return every checked-in golden fixture, sorted for stable test ids."""
    return sorted(config.FIXTURES_DIR.glob("*__page_*.json"))


def _load(path: Path) -> dict[str, Any]:
    """Read one fixture, dropping its commentary keys.

    Args:
        path: Fixture file.

    Returns:
        The oracle ``PageFacts`` mapping.
    """
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in loaded.items() if not k.startswith(_META_PREFIX)}


def _page_source(oracle: dict[str, Any]) -> Path:
    """Return the cached markdown page a fixture describes."""
    return config.version_pages_dir(oracle["catalog_version"]) / f"page_{oracle['page']:04d}.md"


@pytest.fixture(scope="module")
def fixtures() -> list[Path]:
    """All golden fixtures, or skip if none are checked in."""
    paths = _fixture_paths()
    if not paths:
        pytest.skip(f"no golden fixtures in {config.FIXTURES_DIR}")
    return paths


def test_fixtures_are_present(fixtures: list[Path]) -> None:
    """The oracle must cover both shapes Phase 0 signed off: a flat page and a nested one.

    A vanished fixture would make this suite pass by testing nothing — the same under-reporting
    failure the harness exists to prevent (P5).
    """
    names = {p.name for p in fixtures}
    assert len(names) >= 2, f"expected at least the flat + nested Phase 0 fixtures, found {names}"


def _assert_pinned(actual: Any, oracle: Any, path: str) -> None:
    """Assert ``actual`` matches every value ``oracle`` pins, recursively.

    The oracle is authoritative but not necessarily *complete*: it predates ``credits_raw`` and
    ``malformed_headings``, and later model fields will land the same way. Comparing whole dicts
    would fail on those additions and tempt the obvious "fix" — regenerating the fixtures from the
    extractor — which would make the oracle a mirror of the thing it audits and void P1. So a field
    the oracle does not mention is not asserted, while every field it *does* mention must match
    exactly, and a pinned field that disappears is an error. :func:`test_oracle_pins_every_model_field`
    keeps the resulting coverage gap visible instead of silent.

    Args:
        actual: Extractor output at this position.
        oracle: Fixture value at this position.
        path: Dotted location, for the failure message.

    Raises:
        AssertionError: On any mismatch, with the exact field path.
    """
    if isinstance(oracle, dict):
        assert isinstance(actual, dict), f"{path}: expected an object, got {type(actual).__name__}"
        missing = sorted(set(oracle) - set(actual))
        assert not missing, f"{path}: extractor no longer emits oracle field(s) {missing}"
        for key, expected in oracle.items():
            _assert_pinned(actual[key], expected, f"{path}.{key}" if path else key)
    elif isinstance(oracle, list):
        assert isinstance(actual, list), f"{path}: expected a list, got {type(actual).__name__}"
        assert len(actual) == len(oracle), (
            f"{path}: extractor produced {len(actual)} item(s), oracle pins {len(oracle)}"
        )
        for index, expected in enumerate(oracle):
            _assert_pinned(actual[index], expected, f"{path}[{index}]")
    else:
        assert actual == oracle, f"{path}: extractor says {actual!r}, oracle says {oracle!r}"


@pytest.mark.parametrize("fixture_path", _fixture_paths(), ids=lambda p: p.stem)
def test_extractor_matches_golden_fixture(fixture_path: Path) -> None:
    """The extractor's output must match the cross-authored oracle wherever the oracle speaks."""
    oracle = _load(fixture_path)
    source = _page_source(oracle)
    if not source.exists():
        pytest.skip(
            f"page cache missing {source}. Populate it with: "
            f"python -m verification_harness --version {oracle['catalog_version']} --sync"
        )

    actual = extract_facts(
        source.read_text(encoding="utf-8"), oracle["catalog_version"], oracle["page"]
    ).model_dump()
    _assert_pinned(actual, oracle, "")


#: Model fields that *no* fixture pins, so `_assert_pinned` cannot guard them anywhere. Empty as of
#: 2026-07-30: `page_0152` pins the full shape, including `credits_raw` and `malformed_headings`,
#: which the two Phase 0 fixtures predate. Growing this set means accepting a blind spot — shrink it
#: instead, by hand-verifying the value against the source page rather than copying extractor output.
_KNOWN_UNPINNED: frozenset[str] = frozenset()


def test_oracle_pins_every_model_field(fixtures: list[Path]) -> None:
    """Fail when a model field exists that no fixture anywhere pins.

    ``_assert_pinned`` deliberately ignores fields a given oracle omits. That is the right call —
    the alternative regenerates fixtures from the extractor and voids P1 — but it means model growth
    could silently widen a blind spot. A field counts as covered once *some* fixture pins it, so
    this fails only for a field the suite cannot see at all.
    """
    from ..models import ExtractedCourse, PageFacts

    pinned: set[str] = set()
    for path in fixtures:
        oracle = _load(path)
        pinned |= set(oracle)
        for course in oracle.get("courses", []):
            pinned |= {f"courses[].{field}" for field in course}

    expected = set(PageFacts.model_fields) | {
        f"courses[].{field}" for field in ExtractedCourse.model_fields
    }
    unpinned = expected - pinned
    assert unpinned <= _KNOWN_UNPINNED, (
        f"no fixture pins model field(s) {sorted(unpinned - _KNOWN_UNPINNED)}, so the drift guard "
        f"is blind to them. Extend a fixture by hand-verifying the value against its source page, "
        f"or add the field to _KNOWN_UNPINNED with a reason."
    )


@pytest.mark.parametrize("fixture_path", _fixture_paths(), ids=lambda p: p.stem)
def test_ancestor_path_never_includes_the_heading_itself(fixture_path: Path) -> None:
    """B4 non-hallucination: a heading is never its own ancestor, and paths stay page-local.

    This is the invariant behind every hierarchy-based check (C3, D1). Asserted against live
    extractor output rather than the fixture, so it also holds for pages nobody froze.
    """
    oracle = _load(fixture_path)
    source = _page_source(oracle)
    if not source.exists():
        pytest.skip(f"page cache missing {source}")

    facts = extract_facts(
        source.read_text(encoding="utf-8"), oracle["catalog_version"], oracle["page"]
    )
    for heading in facts.headings:
        assert heading.text not in heading.ancestor_path, (
            f"heading {heading.text!r} appears in its own ancestor_path — B4 self-inclusion"
        )
        assert len(heading.ancestor_path) < heading.level, (
            f"heading {heading.text!r} (level {heading.level}) claims "
            f"{len(heading.ancestor_path)} ancestors — a path deeper than its own level means the "
            f"extractor borrowed a parent from the previous page"
        )
