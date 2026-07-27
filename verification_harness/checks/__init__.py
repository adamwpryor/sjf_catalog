"""Tier 1 — deterministic checks.

Each check consumes ``PageFacts`` (Tier 0) and version-scoped ``db_facts`` (``db.py``) and
emits ``Finding`` records to ``findings.jsonl``. No LLM calls, no database writes; a check
*records* a finding, it never ``assert``s.

Modules by class (see ``DOUBLE_CHECK.md`` §6): ``coverage`` (A), ``fidelity`` (B),
``provenance`` (C), ``headings`` (D), ``integrity`` (E), ``semantic`` (F, Tier 2).
``registry`` provides check registration and the runner.
"""

from . import coverage, fidelity  # noqa: F401
