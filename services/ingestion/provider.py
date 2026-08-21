"""Thin provider interface for self-serve ingestion model calls.

Wraps verification_harness/llm/client.py behind a narrow functional seam:
    extract(prompt, schema, *, key="ingestion", system="") -> dict[str, Any]

Enforces:
- Keyless Vertex ADC (via HarnessLLMClient)
- Budget ceiling ($25 USD default)
- Response caching
- Deterministic decoding (temperature=0.0)
- Configurable model (VERTEX_TIER2_MODEL / DEFAULT_TIER2_MODEL)
"""

from __future__ import annotations

import os
from typing import Any, Literal

from verification_harness.llm.budget import Budget
from verification_harness.llm.cache import ResponseCache
from verification_harness.llm.client import (
    DEFAULT_LOCATION,
    DEFAULT_TIER2_MODEL,
    Adjudicator,
    Request,
    Response,
)

Mode = Literal["live", "replay", "estimate", "fake"]


class SelfServeInferenceProvider:
    """Thin provider abstraction for structured extractions in self-serve ingestion."""

    def __init__(
        self,
        mode: Mode = "live",
        model: str | None = None,
        budget_usd: float = 25.0,
        location: str | None = None,
        cache_dir: str | None = None,
    ) -> None:
        from pathlib import Path

        self.mode = mode
        self.model = model or os.environ.get("VERTEX_TIER2_MODEL", DEFAULT_TIER2_MODEL)
        self.location = location or os.environ.get("GOOGLE_CLOUD_LOCATION", DEFAULT_LOCATION)
        self.budget = Budget(ceiling_usd=budget_usd)
        cache_path = Path(cache_dir) if cache_dir else Path("artifacts/llm-cache")
        self.cache = ResponseCache(root=cache_path)
        self.client = Adjudicator(
            mode=self.mode,
            model=self.model,
            location=self.location,
            budget=self.budget,
            cache=self.cache,
        )

    def extract(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        key: str = "ingestion",
        system: str = "",
    ) -> dict[str, Any]:
        """Execute a single structured extraction call against the provider.

        Args:
            prompt: User prompt for extraction.
            schema: JSON schema defining expected output structure.
            key: Caller key for tracking/logging.
            system: Optional system instruction.

        Returns:
            Dict containing the parsed response matching schema, or empty dict on failure/estimate mode.
        """
        req = Request(
            key=key,
            system=system or "You are an expert academic catalog extractor. Output JSON adhering to the schema.",
            prompt=prompt,
            schema=schema,
            model=self.model,
        )
        res: Response = self.client.adjudicate(req)
        if res.error:
            raise RuntimeError(f"Extraction failed for key '{key}': {res.error}")
        return res.data or {}
