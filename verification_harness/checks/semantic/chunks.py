"""Semantic chunk content vs section_header adjudication (F3)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

from ... import config
from ...llm.client import Request
from ...models import Finding
from ...normalize import strip_content_breadcrumb
from ..registry import CheckContext, make_finding, register
from .core import (
    _SEVERITY_GUIDE,
    _TRAPS,
    _VERDICT_GUIDE,
    _clip,
    _entity_schema,
    _failure_finding,
    _issue_to_finding,
    _seeded_sample,
)

logger = logging.getLogger(__name__)

# --- F3 — chunk content vs its section_header -------------------------------------

_CHUNK_SYSTEM = f"""\
You audit a university catalog's semantic chunks. Each chunk carries a `section_header` breadcrumb
describing where it came from, and `content` taken from the page.

F3: does the content belong under that section header? Report a chunk whose content is about
something else entirely — a breadcrumb naming one program over text describing another, or a header
from a section the content does not come from. Do NOT report a chunk merely because the content is
broader or narrower than the header, or because it is boilerplate.

{_TRAPS}
{_SEVERITY_GUIDE}
{_VERDICT_GUIDE}
Return one entry per chunk id given, with an empty `issues` array when the chunk is coherent.
For chunks, quote `evidence_page` from the chunk's own content.
"""


def _chunk_prompt(version: str, rows: list[dict[str, Any]]) -> str:
    """Build the F3 prompt for a batch of chunks."""
    lines = [f"CATALOG: {version}", "", "--- CHUNKS UNDER TEST ---"]
    for row in rows:
        lines.extend(
            [
                f"chunk_id: {row['id']}",
                f"  page: {row.get('page_number')}",
                f"  section_header: {_clip(row.get('section_header'), 400)}",
                f"  content: {_clip(strip_content_breadcrumb(row.get('content')), 1500)}",
                "",
            ]
        )
    return "\n".join(lines)


@register(
    "F3",
    tier=2,
    needs_llm=True,
    title="Semantic: chunk content matches its section_header",
)
def check_f3(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate whether each chunk's content belongs under its breadcrumb."""
    chunks = [c for c in ctx.db.chunks if (c.get("content") or "").strip()]
    sample, skipped = _seeded_sample(chunks, config.F3_SAMPLE_CHUNKS_PER_VERSION or 0, f"F3:{ctx.version}")
    if skipped:
        logger.info(
            "F3: sampled %d of %d chunks for %s — %d not adjudicated",
            len(sample),
            len(chunks),
            ctx.version,
            skipped,
        )
        yield make_finding(
            ctx,
            check="F3",
            severity="info",
            entity_type="page",
            entity_key="sample-coverage",
            claim=(
                f"F3 adjudicated a seeded sample of {len(sample)} of {len(chunks)} chunks; "
                f"{skipped} were not examined"
            ),
            evidence_page="",
            verdict="AMBIGUOUS",
            confidence=1.0,
            tier=2,
        )
    if not sample:
        return

    requests: list[Request] = []
    index: list[list[dict[str, Any]]] = []
    for start in range(0, len(sample), config.TIER2_CHUNKS_PER_CALL):
        batch = sample[start : start + config.TIER2_CHUNKS_PER_CALL]
        requests.append(
            Request(
                key=f"{ctx.version}:chunks:{start}",
                system=_CHUNK_SYSTEM,
                prompt=_chunk_prompt(ctx.version, batch),
                schema=_entity_schema("chunk_id", ("F3",)),
            )
        )
        index.append(batch)

    logger.info("F3: %d call(s) over %d chunk(s)", len(requests), len(sample))
    responses = ctx.adjudicator.map(requests, check="F3")

    for response, batch in zip(responses, index, strict=True):
        if not response.ok:
            page = batch[0].get("page_number") or 0
            yield _failure_finding(ctx, "F3", response.key, page, response.error or "?")
            continue
        rows_by_id = {str(r["id"]): r for r in batch}
        for result in response.data.get("results", []) or []:
            chunk_id = str(result.get("chunk_id", "")).strip()
            row = rows_by_id.get(chunk_id)
            if row is None:
                continue
            content = strip_content_breadcrumb(row.get("content"))
            for issue in result.get("issues", []) or []:
                finding = _issue_to_finding(
                    ctx,
                    issue,
                    allowed=("F3",),
                    entity_type="chunk",
                    entity_key=chunk_id,
                    entity_id=chunk_id,
                    page=int(row.get("page_number") or 0),
                    page_text=content,
                )
                if finding is not None:
                    yield finding
