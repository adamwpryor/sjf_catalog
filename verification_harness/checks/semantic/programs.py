"""Semantic program field fidelity and page aboutness adjudication (B7+F2)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

from ...llm.client import Request
from ...models import Finding
from ...normalize import page_from_url
from ..registry import CheckContext, register
from .core import (
    _MAX_PAGE_CHARS,
    _SEVERITY_GUIDE,
    _TRAPS,
    _VERDICT_GUIDE,
    _entity_schema,
    _failure_finding,
    _issue_to_finding,
)

logger = logging.getLogger(__name__)

# --- B7 / F2 — fused per-program adjudication -------------------------------------

_PROGRAM_SYSTEM = f"""\
You audit a university catalog database against the catalog pages it was parsed from. The PAGE is
ground truth.

For each program, judge two things:
- B7: do `total_credits` and `degree_type` match what the page states for THIS program?
- F2: is the linked page actually ABOUT this program, or does it merely mention it? A page that
  lists the program among many, or that is a table of contents entry, is a mislink. This matters:
  the previous pipeline collapsed four distinct graduate programs onto one shared listing page.

{_TRAPS}
{_SEVERITY_GUIDE}
{_VERDICT_GUIDE}
Return one entry per program name given, with an empty `issues` array when the row is faithful.
"""


def _program_prompt(version: str, page: int, page_text: str, rows: list[dict[str, Any]]) -> str:
    """Build the fused B7/F2 prompt for one page's programs."""
    lines = [
        f"CATALOG: {version}    PAGE: {page}",
        "",
        "--- PAGE MARKDOWN (ground truth) ---",
        page_text[:_MAX_PAGE_CHARS],
        "",
        "--- DATABASE PROGRAM ROWS UNDER TEST ---",
    ]
    for row in rows:
        lines.extend(
            [
                f"name: {row.get('name')}",
                f"  degree_type: {row.get('degree_type')}",
                f"  total_credits: {row.get('total_credits')}",
                "",
            ]
        )
    return "\n".join(lines)


@register(
    "B7",
    tier=2,
    needs_pages=True,
    needs_llm=True,
    title="Semantic: program credits/degree type and page aboutness (B7+F2)",
)
def check_b7_f2(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate program field fidelity and whether the linked page is about the program."""
    assert ctx.page_texts is not None

    by_page: dict[int, list[dict[str, Any]]] = {}
    unlinked = 0
    for program in ctx.db.programs:
        page = page_from_url(program.get("markdown_url"))
        if page is None:
            unlinked += 1
            continue
        by_page.setdefault(page, []).append(program)
    if unlinked:
        # Not a silent omission: A4 already enumerates and classifies these rows.
        logger.info("B7/F2: %d program(s) have no linked page — A4 owns them", unlinked)
    if not by_page:
        return

    requests: list[Request] = []
    index: list[tuple[int, list[dict[str, Any]]]] = []
    for page_num, rows in sorted(by_page.items()):
        page_text = ctx.page_texts.get(page_num, "")
        if not page_text:
            continue
        requests.append(
            Request(
                key=f"{ctx.version}:program:{page_num}",
                system=_PROGRAM_SYSTEM,
                prompt=_program_prompt(ctx.version, page_num, page_text, rows),
                schema=_entity_schema("name", ("B7", "F2")),
            )
        )
        index.append((page_num, rows))

    logger.info("B7/F2: %d call(s) over %d program page(s)", len(requests), len(index))
    responses = ctx.adjudicator.map(requests, check="B7+F2")

    for response, (page_num, rows) in zip(responses, index, strict=True):
        page_text = ctx.page_texts.get(page_num, "")
        if not response.ok:
            yield _failure_finding(ctx, "B7", response.key, page_num, response.error or "?")
            continue
        rows_by_name = {(r.get("name") or "").strip(): r for r in rows}
        for result in response.data.get("results", []) or []:
            name = str(result.get("name", "")).strip()
            row = rows_by_name.get(name)
            if row is None:
                logger.warning("page %d: adjudicator returned unknown program %r", page_num, name)
                continue
            for issue in result.get("issues", []) or []:
                finding = _issue_to_finding(
                    ctx,
                    issue,
                    allowed=("B7", "F2"),
                    entity_type="program",
                    entity_key=name[:60],
                    entity_id=str(row["id"]),
                    page=page_num,
                    page_text=page_text,
                )
                if finding is not None:
                    yield finding
