"""The single LLM entry point for Tier 2/3 — cached, budgeted, and runnable without a network.

Mirrors ``db.py``'s posture on the other side of the harness: one narrow module owns all access to
an outside system, so the guarantees are enforced in one place instead of being re-argued at every
call site.

Four run modes, because "did the model actually get asked?" must never be ambiguous:

``live``
    Call Vertex; record every response into the cache.
``replay``
    Cache only. A miss **raises** rather than falling through to a live call, so a run claiming to
    be a replay cannot quietly become a billed one. This is the offline test mode.
``estimate``
    Build every prompt exactly as ``live`` would, count tokens, spend nothing, return no
    adjudications. This is how a dollar figure is produced *before* asking for authorization.
``fake``
    Route to an injected callable. For tests that need to control what the model "says".

Authentication is Application Default Credentials — Adam's org disallows API keys
(``.env.example``), so there is no key path here by design.
"""

from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from .budget import Budget, BudgetExceeded, Usage, estimate_cost_usd
from .cache import CachedResponse, ResponseCache, prompt_key

logger = logging.getLogger(__name__)

Mode = Literal["live", "replay", "estimate", "fake"]

#: Tier 2 default. Q5: "Tier 2 runs on flash (cheap, fast)"; Tier 3 may escalate to pro.
DEFAULT_TIER2_MODEL: str = os.environ.get("VERTEX_TIER2_MODEL", "gemini-2.5-flash")

#: Vertex region carrying the Gemini models. Matches ``services/swarm/overrides/vertex.py``.
DEFAULT_LOCATION: str = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-east5")

#: §8: "Cap Tier 2/3 LLM calls at ~8–16 concurrent."
DEFAULT_CONCURRENCY: int = 8

#: Deterministic decoding. Temperature 0 is necessary for P3 but not sufficient — the response
#: cache is what actually makes a re-run byte-identical.
#:
#: ``thinking_budget: 0`` disables Gemini 2.5's extended thinking, and it is the single largest cost
#: lever in the tier. Measured on the first live flagship run *with* thinking on: 3,194 output tokens
#: per call against the ~350 the response JSON actually needs — thinking billed as output at
#: $2.50/M, which put the real cost **5.4× over the projection**. These prompts ask for structured
#: comparison of two supplied texts, not multi-step reasoning, so the thinking budget buys little.
#: Note 2.5 **pro** rejects a 0 budget (128 minimum); :func:`_thinking_budget` handles that, which
#: matters because Q5 escalates Tier 3's critical refuters to pro.
DEFAULT_PARAMS: dict[str, Any] = {
    "temperature": 0.0,
    "max_output_tokens": 8192,
    "thinking_budget": 0,
}


def _thinking_budget(model: str, requested: int) -> int:
    """Return a thinking budget the model will accept.

    Args:
        model: Target model id.
        requested: Desired budget; 0 disables thinking.

    Returns:
        ``requested``, raised to 128 for ``pro`` models, which reject a zero budget.
    """
    if "pro" in model and requested < 128:
        return 128
    return requested

#: Gemini finish reasons meaning the model declined. Treated as an outcome, never as "no findings".
_REFUSAL_FINISH_REASONS = {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION", "SPII"}

_MAX_ATTEMPTS = 4


class AdjudicationError(RuntimeError):
    """A model call failed, was refused, or returned unparseable output."""


class LlmUnavailable(RuntimeError):
    """Vertex could not be reached at all — credentials, project, or region are unusable."""


def estimate_tokens(text: str) -> int:
    """Approximate a token count from character length.

    Vertex's exact ``count_tokens`` requires a network round trip, which defeats the purpose of an
    estimate produced *before* authorizing spend. Four characters per token is the usual English
    approximation; treat the resulting dollar figure as an order-of-magnitude bound, not a quote.

    Args:
        text: Prompt or response text.

    Returns:
        Estimated token count (minimum 1 for non-empty text).
    """
    if not text:
        return 0
    return max(1, len(text) // 4)


@dataclass(frozen=True)
class Request:
    """One structured-output model call.

    Attributes:
        key: Caller-chosen label identifying what this call is about (a course code, a page).
            Echoed back on the response so a fan-out result can be re-associated with its subject.
        system: System instruction.
        prompt: User prompt.
        schema: JSON schema the response must satisfy.
        model: Model id, or ``""`` to use the adjudicator's configured model. Left empty by every
            check: a dataclass default would bind at import time, so ``--model`` would silently do
            nothing.
    """

    key: str
    system: str
    prompt: str
    schema: dict[str, Any]
    model: str = ""


@dataclass(frozen=True)
class Response:
    """One completed adjudication.

    Attributes:
        key: The originating :attr:`Request.key`.
        data: The parsed, schema-shaped response object.
        usage: Token accounting for the call.
        error: Populated instead of ``data`` when the call failed, was refused, or the budget ran
            out. A response is never both — and a failed call still returns an object, so the
            caller can report the gap rather than silently producing fewer findings (P5).
    """

    key: str
    data: dict[str, Any] | None
    usage: Usage
    error: str | None = None

    @property
    def ok(self) -> bool:
        """True when the call produced a usable parsed response."""
        return self.error is None and self.data is not None


@dataclass
class EstimateLedger:
    """Prompt-size accounting for ``estimate`` mode.

    Attributes:
        by_check: Per-check ``{calls, input_tokens, output_tokens, cost_usd}`` totals.
    """

    by_check: dict[str, dict[str, float]] = field(default_factory=dict)

    def add(self, check: str, model: str, input_tokens: int, output_tokens: int) -> None:
        """Record one hypothetical call against a check."""
        bucket = self.by_check.setdefault(
            check, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
        )
        bucket["calls"] += 1
        bucket["input_tokens"] += input_tokens
        bucket["output_tokens"] += output_tokens
        bucket["cost_usd"] += estimate_cost_usd(model, input_tokens, output_tokens)

    def total_usd(self) -> float:
        """Return the summed estimated cost across every check."""
        return sum(b["cost_usd"] for b in self.by_check.values())


def strip_unsupported_schema(node: Any) -> Any:
    """Return a JSON schema with keys Vertex's ``responseSchema`` rejects removed.

    Gemini accepts an OpenAPI 3 subset; ``additionalProperties`` and ``$schema`` cause a 400. This
    duplicates the same pruning in ``services/swarm/overrides/vertex.py`` deliberately — importing
    from ``services/`` would couple the harness to application code it is meant to stay clear of.

    Args:
        node: A JSON-schema fragment.

    Returns:
        The same structure with unsupported keys pruned.
    """
    if isinstance(node, dict):
        return {
            k: strip_unsupported_schema(v)
            for k, v in node.items()
            if k not in ("additionalProperties", "$schema", "title", "default")
        }
    if isinstance(node, list):
        return [strip_unsupported_schema(v) for v in node]
    return node


class Adjudicator:
    """Cached, budgeted access to Vertex Gemini for the semantic tiers."""

    def __init__(
        self,
        *,
        mode: Mode = "live",
        cache: ResponseCache | None = None,
        budget: Budget | None = None,
        concurrency: int = DEFAULT_CONCURRENCY,
        params: dict[str, Any] | None = None,
        fake: Callable[[Request], str] | None = None,
        location: str = DEFAULT_LOCATION,
        project: str | None = None,
        model: str = DEFAULT_TIER2_MODEL,
    ) -> None:
        """Initialize the adjudicator.

        Args:
            mode: One of ``live``, ``replay``, ``estimate``, ``fake`` (see module docstring).
            cache: Response cache. Required for ``replay``; strongly recommended for ``live``.
            budget: Spend meter; a default $10 ceiling is created when omitted.
            concurrency: Max in-flight calls (§8 caps this at 8–16).
            params: Generation parameters; merged over :data:`DEFAULT_PARAMS`.
            fake: Callable returning raw response text, used when ``mode="fake"``.
            location: Vertex region.
            project: GCP project; falls back to ``GCP_PROJECT_ID``/``GOOGLE_CLOUD_PROJECT``.
            model: Model id used for any request that does not name one.

        Raises:
            ValueError: If the mode's required collaborator is missing.
        """
        if mode == "replay" and cache is None:
            raise ValueError("replay mode requires a cache — there is nothing to replay from")
        if mode == "fake" and fake is None:
            raise ValueError("fake mode requires a fake callable")
        self.mode: Mode = mode
        self.model = model
        self.cache = cache
        self.budget = budget or Budget()
        self.concurrency = max(1, min(concurrency, 16))
        self.params = {**DEFAULT_PARAMS, **(params or {})}
        self.fake = fake
        self.location = location
        self.project = project or os.environ.get("GCP_PROJECT_ID") or os.environ.get(
            "GOOGLE_CLOUD_PROJECT"
        )
        self.estimates = EstimateLedger()
        self.refusals: list[str] = []
        self._client: Any = None
        self._client_lock = threading.Lock()
        self._budget_stopped = False

    # -- transport -----------------------------------------------------------------

    def _vertex(self) -> Any:
        """Return the lazily-created Vertex client.

        Raises:
            LlmUnavailable: If the SDK is missing or credentials cannot be minted. The message
                names the fix, because the usual cause is an expired ADC refresh token that only a
                human at a browser can renew.
        """
        with self._client_lock:
            if self._client is not None:
                return self._client
            try:
                from google import genai
            except ImportError as exc:  # pragma: no cover - environment problem
                raise LlmUnavailable(
                    "google-genai is not installed. `conda env update -f environment.yml`."
                ) from exc
            if not self.project:
                raise LlmUnavailable(
                    "No GCP project. Set GCP_PROJECT_ID (it is in .env.local) or pass --project."
                )
            try:
                self._client = genai.Client(
                    vertexai=True, project=self.project, location=self.location
                )
            except Exception as exc:  # broad by intent — re-raised with the remedy attached
                raise LlmUnavailable(f"Vertex client could not be created: {exc}") from exc
            return self._client

    def _call_vertex(self, request: Request) -> tuple[str, int, int]:
        """Send one request to Vertex, retrying transient failures.

        Returns:
            ``(text, input_tokens, output_tokens)``.

        Raises:
            AdjudicationError: On a refusal or an empty response.
            LlmUnavailable: On an authentication or configuration failure — not retried, because
                retrying an expired credential just wastes time.
        """
        from google.genai import types

        client = self._vertex()
        config = types.GenerateContentConfig(
            system_instruction=request.system,
            temperature=self.params["temperature"],
            max_output_tokens=self.params["max_output_tokens"],
            response_mime_type="application/json",
            response_schema=strip_unsupported_schema(request.schema),
            thinking_config=types.ThinkingConfig(
                thinking_budget=_thinking_budget(
                    request.model, int(self.params.get("thinking_budget", 0))
                )
            ),
        )

        last_exc: Exception | None = None
        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                response = client.models.generate_content(
                    model=request.model, contents=request.prompt, config=config
                )
            except Exception as exc:  # broad by intent — classified as auth vs transient below
                message = str(exc)
                if _is_auth_failure(message):
                    raise LlmUnavailable(
                        "Vertex rejected Application Default Credentials: "
                        f"{message.splitlines()[0]}\n"
                        "Run `gcloud auth application-default login` (needs a browser) and re-run."
                    ) from exc
                last_exc = exc
                if attempt == _MAX_ATTEMPTS:
                    break
                delay = min(2 ** attempt, 16) + random.random()
                logger.warning(
                    "vertex call %s failed (attempt %d/%d): %s — retrying in %.1fs",
                    request.key, attempt, _MAX_ATTEMPTS, message.splitlines()[0][:160], delay,
                )
                time.sleep(delay)
                continue

            candidate = (getattr(response, "candidates", None) or [None])[0]
            finish = ""
            if candidate is not None and getattr(candidate, "finish_reason", None) is not None:
                finish = str(candidate.finish_reason).split(".")[-1].upper()
            if finish in _REFUSAL_FINISH_REASONS:
                self.refusals.append(f"{request.key}: {finish}")
                raise AdjudicationError(f"model declined to answer ({finish})")

            usage = getattr(response, "usage_metadata", None)
            in_tok = int(getattr(usage, "prompt_token_count", 0) or 0)
            out_tok = int(getattr(usage, "candidates_token_count", 0) or 0)
            # Thinking tokens bill as output but are reported separately.
            out_tok += int(getattr(usage, "thoughts_token_count", 0) or 0)

            try:
                text = response.text or ""
            except Exception:  # noqa: BLE001 - `.text` raises when there is no text part
                text = ""
            if not text.strip():
                raise AdjudicationError(f"empty response (finish_reason={finish or 'unknown'})")
            return text, in_tok, out_tok

        raise AdjudicationError(
            f"vertex call failed after {_MAX_ATTEMPTS} attempts: {last_exc}"
        )

    # -- public API ----------------------------------------------------------------

    def complete(self, request: Request, *, check: str = "?") -> Response:
        """Run one request through cache → budget → transport, and parse the result.

        A failure of any kind returns a :class:`Response` carrying ``error`` rather than raising,
        so one bad batch degrades that batch instead of aborting the tier (the same posture as the
        Tier 1 runner's crash-safe behavior).

        Args:
            request: The call to make.
            check: Check id, for the estimate ledger and logs.

        Returns:
            A :class:`Response`; inspect :attr:`Response.ok` before using ``data``.
        """
        model = request.model or self.model
        request = request if request.model else replace(request, model=model)
        params = {**self.params, "model": model}
        key = prompt_key(
            model=model,
            system=request.system,
            prompt=request.prompt,
            schema=request.schema,
            params=params,
        )

        if self.mode == "estimate":
            in_tok = estimate_tokens(request.system) + estimate_tokens(request.prompt)
            # Measured, not guessed: 101 live B7 calls averaged **132** output tokens with thinking
            # disabled. The original 350 allowance was a guess that made every estimate ~2.6x
            # pessimistic on the output side — which matters because output bills at 8x input.
            # Kept slightly above the measurement so the projection still errs high.
            out_tok = 200
            self.estimates.add(check, model, in_tok, out_tok)
            return Response(
                key=request.key,
                data=None,
                usage=Usage(request.model, in_tok, out_tok, cached=True),
                error="estimate-mode: no call made",
            )

        if self.cache is not None:
            hit = self.cache.get(key)
            if hit is not None:
                usage = Usage(hit.model, hit.input_tokens, hit.output_tokens, cached=True)
                self.budget.charge(usage)
                return _parse(request, hit.text, usage)

        if self.mode == "replay":
            return Response(
                key=request.key,
                data=None,
                usage=Usage(request.model, 0, 0, cached=True),
                error=f"replay-mode cache miss for {request.key} (key {key[:12]})",
            )

        try:
            self.budget.check()
        except BudgetExceeded as exc:
            self._budget_stopped = True
            return Response(
                key=request.key,
                data=None,
                usage=Usage(request.model, 0, 0, cached=True),
                error=str(exc),
            )

        try:
            if self.mode == "fake":
                assert self.fake is not None
                text = self.fake(request)
                in_tok = estimate_tokens(request.system) + estimate_tokens(request.prompt)
                out_tok = estimate_tokens(text)
            else:
                text, in_tok, out_tok = self._call_vertex(request)
        except LlmUnavailable:
            raise
        except AdjudicationError as exc:
            return Response(
                key=request.key,
                data=None,
                usage=Usage(request.model, 0, 0, cached=True),
                error=str(exc),
            )

        usage = Usage(request.model, in_tok, out_tok)
        self.budget.charge(usage)
        if self.cache is not None:
            self.cache.put(key, CachedResponse(text, request.model, in_tok, out_tok))
        return _parse(request, text, usage)

    def map(self, requests: Sequence[Request], *, check: str = "?") -> list[Response]:
        """Run many requests concurrently, preserving input order.

        Args:
            requests: The calls to make.
            check: Check id, for the estimate ledger and logs.

        Returns:
            One :class:`Response` per request, in the same order. Never shorter than the input —
            a dropped request would be an under-report (P5).
        """
        if not requests:
            return []
        if self.mode == "estimate" or self.concurrency == 1:
            return [self.complete(r, check=check) for r in requests]

        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            return list(pool.map(lambda r: self.complete(r, check=check), requests))

    @property
    def budget_stopped(self) -> bool:
        """True if any call was skipped because the ceiling was reached."""
        return self._budget_stopped

    def stats(self) -> dict[str, Any]:
        """Return budget, cache, and refusal counters for the run report."""
        out: dict[str, Any] = {"mode": self.mode, **self.budget.summary()}
        if self.cache is not None:
            out.update(self.cache.stats())
        if self.refusals:
            out["refusals"] = len(self.refusals)
        return out


def _parse(request: Request, text: str, usage: Usage) -> Response:
    """Parse a raw model response into its schema shape.

    Unparseable JSON becomes an ``error`` response rather than an exception or an empty result —
    "the model returned nonsense" and "the model found nothing" must not look the same.
    """
    try:
        data = json.loads(text)
    except ValueError as exc:
        return Response(
            key=request.key,
            data=None,
            usage=usage,
            error=f"response was not valid JSON: {exc}; first 200 chars: {text[:200]!r}",
        )
    if not isinstance(data, dict):
        return Response(
            key=request.key,
            data=None,
            usage=usage,
            error=f"response JSON was {type(data).__name__}, expected an object",
        )
    return Response(key=request.key, data=data, usage=usage)


def _is_auth_failure(message: str) -> bool:
    """True when an exception message indicates a credential problem rather than a transient one."""
    lowered = message.lower()
    return any(
        marker in lowered
        for marker in (
            "reauthentication is needed",
            "could not automatically determine credentials",
            "invalid_grant",
            "invalid_scope",
            "permission denied",
            "403",
            "401",
            "unauthenticated",
        )
    )


def iter_batches(items: Sequence[Any], size: int) -> Iterable[list[Any]]:
    """Yield fixed-size batches from a sequence.

    Args:
        items: Items to batch.
        size: Maximum batch size (§8 suggests 10–25 pages per agent).

    Yields:
        Lists of at most ``size`` items, in order.
    """
    for start in range(0, len(items), max(1, size)):
        yield list(items[start : start + max(1, size)])
