"""Tier 2 LLM plumbing: a cached, budgeted, offline-testable Vertex Gemini client.

Nothing in :mod:`verification_harness.checks` talks to Vertex directly. Everything goes through
:class:`~verification_harness.llm.client.Adjudicator`, which exists to make three spec guarantees
survive contact with a nondeterministic model:

- **P3 (reproducibility)** — responses are cached by prompt hash, so a re-run replays byte-identical
  answers for free instead of re-rolling the dice.
- **Q5 (cost ceiling)** — every call is metered against a hard dollar budget that *stops* the run.
- **P5 (never silently drop)** — a refusal, a schema violation, or an exhausted budget becomes a
  logged, visible outcome, never a quietly missing finding.
"""

from .budget import Budget, BudgetExceeded, Usage
from .cache import ResponseCache
from .client import AdjudicationError, Adjudicator, LlmUnavailable

__all__ = [
    "AdjudicationError",
    "Adjudicator",
    "Budget",
    "BudgetExceeded",
    "LlmUnavailable",
    "ResponseCache",
    "Usage",
]
