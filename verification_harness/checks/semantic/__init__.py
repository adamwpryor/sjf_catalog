"""Tier 2 — LLM adjudication of the checks no string comparison can decide.

Covers ``B2`` residue, ``B3``, ``B7``, and ``F1``–``F4`` (``DOUBLE_CHECK.md`` §6/§8). Every check
here exists because the question is genuinely semantic: *does this description describe this
course?* is not decidable by comparing strings, and P2 says only such questions get a model.

``B4`` was here and is not any more. The first live run reported ~300 prerequisite defects on a
partial flagship pass, and they were one systemic ingest behaviour restated per course — a model
was being paid to rediscover a parser bug 217 times. It is now deterministic in ``fidelity.py``,
which reports the classes as aggregates and escalates only what it cannot decide. That is the same
correction ``C6`` needed in Phase 1 and ``B2`` was designed with from the start; if a Tier 2 check
starts producing findings in the hundreds, suspect this shape before scaling it.

Three structural decisions shape the module:

**Fused, page-batched calls.** ``B3`` and ``F1`` ask about the same two things — one page and the DB
rows for the courses on it. Asking separately would double the cost to re-send identical context, so
they are one call returning a per-course verdict per dimension. ``B7``/``F2`` fuse the same way over
programs.

**The model's evidence is verified, not trusted.** P4 requires a literal page excerpt on every
finding. A model can produce a fluent excerpt that is not on the page, and that failure is invisible
downstream — it looks exactly like a real finding. So every returned excerpt is checked back against
the source page, and one that is not there is demoted to ``AMBIGUOUS`` with the hallucination named
in the claim. A Tier 2 finding whose evidence does not survive that check has not earned a verdict.

**Sampling is seeded and logged.** ``F4`` runs on a bounded sample (§5 Risk B). The sample is drawn
from a version-seeded RNG so it is identical on every run — a discovery check that wandered between
runs could not be regression-tracked (P3) — and what was left out is counted and logged (P5).
"""

from . import chunks, core, courses, discovery, programs, residue
from .core import (
    _entity_schema,
    _failure_finding,
    _issue_to_finding,
    _seeded_sample,
    excerpt_supported,
)
from .courses import check_b3_b4_f1
from .discovery import check_f4

__all__ = [
    "_entity_schema",
    "_failure_finding",
    "_issue_to_finding",
    "_seeded_sample",
    "check_b3_b4_f1",
    "check_f4",
    "chunks",
    "core",
    "courses",
    "discovery",
    "excerpt_supported",
    "programs",
    "residue",
]
