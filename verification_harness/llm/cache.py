"""Content-addressed response cache — the mechanism that makes Tier 2 reproducible (P3).

P3 requires diffable output across runs, and an LLM does not provide that on its own: the same
prompt can yield a differently-worded judgment tomorrow, so a re-run's findings would differ for
reasons unrelated to the database. The harness closes that gap by **caching every response under a
hash of everything that determined it** (model, system instruction, prompt, schema, and generation
parameters). A second run over an unchanged corpus replays the same answers byte-for-byte, costs
nothing, and needs no network — which also makes recorded responses the natural test fixture.

The cache is *not* a performance optimization that may be dropped. Deleting it means the next run's
findings are no longer comparable to the last one's, so the entry records the model and parameters
it was produced under; changing any of them changes the key and forces a real call rather than
silently reusing an answer the new configuration would not have given.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def prompt_key(
    *,
    model: str,
    system: str,
    prompt: str,
    schema: dict[str, Any] | None,
    params: dict[str, Any],
) -> str:
    """Return the cache key for one fully-specified model call.

    Every input that can change the answer is folded in. ``sort_keys`` keeps the digest stable
    across dict ordering, so an unchanged call always lands on the same key.

    Args:
        model: Model id the call will be sent to.
        system: System instruction.
        prompt: The user prompt.
        schema: Structured-output JSON schema, or ``None`` for free text.
        params: Generation parameters that affect the output (temperature, seed, max tokens).

    Returns:
        A hex SHA-256 digest.
    """
    payload = json.dumps(
        {
            "model": model,
            "system": system,
            "prompt": prompt,
            "schema": schema,
            "params": params,
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CachedResponse:
    """One replayed model response.

    Attributes:
        text: The raw response text exactly as the model returned it.
        model: Model that produced it.
        input_tokens: Prompt tokens billed at record time (replayed for reporting, not re-billed).
        output_tokens: Response tokens billed at record time.
    """

    text: str
    model: str
    input_tokens: int
    output_tokens: int


class ResponseCache:
    """A directory of content-addressed model responses, one JSON file per key.

    Entries are written atomically (temp file + ``os.replace``) so a killed run cannot leave a
    truncated response that a later run would replay as though it were real — the same rule
    ``fetch.py`` applies to partially-downloaded pages.
    """

    def __init__(self, root: Path, *, read_only: bool = False) -> None:
        """Initialize the cache.

        Args:
            root: Directory holding the entries; created on first write.
            read_only: When True, never write new entries. Used by the offline replay mode, where a
                miss must surface as an error rather than being papered over by a live call.
        """
        self.root = root
        self.read_only = read_only
        self.hits = 0
        self.misses = 0

    def _path(self, key: str) -> Path:
        # Shard by the first two hex chars: 40k entries in one directory is slow on Windows.
        return self.root / key[:2] / f"{key}.json"

    def get(self, key: str) -> CachedResponse | None:
        """Return the cached response for a key, or ``None`` on a miss.

        A corrupt entry is treated as a miss and logged, never as an empty response — silently
        replaying ``""`` would turn a disk problem into a "the model found nothing" result.

        Args:
            key: A :func:`prompt_key` digest.

        Returns:
            The cached response, or ``None``.
        """
        path = self._path(key)
        if not path.is_file():
            self.misses += 1
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            response = CachedResponse(
                text=raw["text"],
                model=raw["model"],
                input_tokens=int(raw.get("input_tokens", 0)),
                output_tokens=int(raw.get("output_tokens", 0)),
            )
        except (OSError, ValueError, KeyError) as exc:
            logger.warning("cache entry %s is unreadable (%s); treating as a miss", key[:12], exc)
            self.misses += 1
            return None
        self.hits += 1
        return response

    def put(self, key: str, response: CachedResponse) -> None:
        """Store a response atomically.

        Args:
            key: A :func:`prompt_key` digest.
            response: The response to record.
        """
        if self.read_only:
            return
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {
                "text": response.text,
                "model": response.model,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
            },
            ensure_ascii=False,
        )
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise

    def stats(self) -> dict[str, int]:
        """Return hit/miss counters for the run report."""
        return {"cache_hits": self.hits, "cache_misses": self.misses}
