"""Token accounting and a hard dollar ceiling for Tier 2/3 (``DOUBLE_CHECK.md`` §13 Q5).

Q5 resolved the cost question with a number — **$10 per run** — so the harness enforces it as a
*ceiling that stops the run*, not a figure in a docstring. :meth:`Budget.charge` raises
:class:`BudgetExceeded` the moment a call would take spend past the limit; the caller turns that
into a visible, logged partial result rather than a silently truncated sweep (P5).

Prices are a **configuration constant, not a measurement.** They are checked in so an estimate can
be produced without network access, which means they drift when Google changes list price. Verify
them against current Vertex pricing before quoting a dollar figure to anyone.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

#: USD per 1M tokens, ``(input, output)``, Vertex AI list price for prompts under 200k tokens.
#: Last verified 2026-08-01. See the module docstring: this is config, not truth.
MODEL_PRICES_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-2.5-pro": (1.25, 10.00),
}

#: Ceiling for the **one-time audit** (Adam, ``2026-08-02``). A run that would exceed this stops and
#: reports what it completed.
#:
#: Q5 set $10. That figure was a guard against runaway *recurring* cost in the CI role Q7 says this
#: grows into — but Q7 also says the current pass is a one-time audit, and Tier 2 ($7.96) plus
#: Tier 3 (~$6–8) does not fit in $10 end-to-end. Raised to $25 for the audit; the response cache
#: makes it a one-off rather than a rate. **Restore $10 before this ever runs as a CI gate.**
DEFAULT_CEILING_USD: float = 25.00

#: Q5's original figure, kept so the CI ceiling is not lost to a config edit.
CI_CEILING_USD: float = 10.00


class BudgetExceeded(RuntimeError):
    """Raised when a call would push cumulative spend past the ceiling.

    Carries the spend figures so the caller can report exactly where the run stopped rather than
    just that it did.
    """

    def __init__(self, spent_usd: float, ceiling_usd: float, calls: int) -> None:
        super().__init__(
            f"Tier 2 budget ceiling reached: ${spent_usd:.4f} of ${ceiling_usd:.2f} after "
            f"{calls} call(s). Raise --budget or narrow the scope; no further LLM calls were made."
        )
        self.spent_usd = spent_usd
        self.ceiling_usd = ceiling_usd
        self.calls = calls


@dataclass(frozen=True)
class Usage:
    """Token counts for a single model call.

    Attributes:
        model: The model id the tokens were billed against.
        input_tokens: Prompt tokens.
        output_tokens: Generated tokens (including any thinking tokens Vertex bills as output).
        cached: True when the response came from the local response cache and cost nothing.
    """

    model: str
    input_tokens: int
    output_tokens: int
    cached: bool = False

    @property
    def cost_usd(self) -> float:
        """Return the USD cost of this call (zero for a cache hit).

        An unpriced model is charged at the most expensive known rate rather than free, so an
        unrecognized model id cannot silently defeat the ceiling.
        """
        if self.cached:
            return 0.0
        return estimate_cost_usd(self.model, self.input_tokens, self.output_tokens)


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Return the USD cost of a call at list price.

    Args:
        model: Model id, e.g. ``"gemini-2.5-flash"``.
        input_tokens: Prompt token count.
        output_tokens: Response token count.

    Returns:
        Cost in USD. Unknown models are priced at the most expensive known rate — an unrecognized
        id must never read as free, because that would let a typo bypass the ceiling.
    """
    if model in MODEL_PRICES_USD_PER_MTOK:
        price_in, price_out = MODEL_PRICES_USD_PER_MTOK[model]
    else:
        price_in = max(p[0] for p in MODEL_PRICES_USD_PER_MTOK.values())
        price_out = max(p[1] for p in MODEL_PRICES_USD_PER_MTOK.values())
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


@dataclass
class Budget:
    """Thread-safe cumulative spend meter with a hard ceiling.

    Attributes:
        ceiling_usd: Stop the run once cumulative spend reaches this.
        spent_usd: Cumulative USD charged so far (cache hits contribute nothing).
        calls: Number of billed calls.
        cached_calls: Number of calls served from cache.
        input_tokens: Cumulative billed prompt tokens.
        output_tokens: Cumulative billed response tokens.
    """

    ceiling_usd: float = DEFAULT_CEILING_USD
    spent_usd: float = 0.0
    calls: int = 0
    cached_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def check(self) -> None:
        """Raise if the ceiling has already been reached.

        Called *before* dispatching a request so an over-budget run stops without spending more.

        Raises:
            BudgetExceeded: If cumulative spend is at or past the ceiling.
        """
        with self._lock:
            if self.spent_usd >= self.ceiling_usd:
                raise BudgetExceeded(self.spent_usd, self.ceiling_usd, self.calls)

    def charge(self, usage: Usage) -> float:
        """Record a call's usage and return its cost.

        Cache hits are counted but not billed, which is what makes a replayed run free.

        Args:
            usage: The completed call's token counts.

        Returns:
            The USD cost charged for this call (0.0 for a cache hit).
        """
        cost = usage.cost_usd
        with self._lock:
            if usage.cached:
                self.cached_calls += 1
                return 0.0
            self.calls += 1
            self.input_tokens += usage.input_tokens
            self.output_tokens += usage.output_tokens
            self.spent_usd += cost
        return cost

    def summary(self) -> dict[str, float | int]:
        """Return a JSON-serializable spend summary for the run report."""
        with self._lock:
            return {
                "calls": self.calls,
                "cached_calls": self.cached_calls,
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "spent_usd": round(self.spent_usd, 4),
                "ceiling_usd": self.ceiling_usd,
            }
