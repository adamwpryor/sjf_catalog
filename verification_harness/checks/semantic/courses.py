"""Semantic course description and identity adjudication (B3+F1)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from typing import Any

from ... import config
from ...llm.client import Request
from ...models import Finding, PageFacts
from ..coverage import courses_by_code
from ..registry import CheckContext, register
from .core import (
    _MAX_PAGE_CHARS,
    _SEVERITY_GUIDE,
    _TRAPS,
    _VERDICT_GUIDE,
    _clip,
    _entity_schema,
    _failure_finding,
    _issue_to_finding,
)

logger = logging.getLogger(__name__)

# --- B3 / F1 — fused per-page course adjudication ---------------------------------

_COURSE_SYSTEM = f"""\
You audit a university catalog database against the catalog pages it was parsed from. The PAGE is
ground truth: where the page and the database disagree, the page is right.

For each course, judge three things:
- B3: does `description` match the page's prose for THIS course? Report truncation (the page says
  more than the database stored) and bleed (the database's text belongs to an adjacent course).
- F1: does `description` actually describe the course named in the heading, or a different course?

{_TRAPS}
{_SEVERITY_GUIDE}
{_VERDICT_GUIDE}
Return one entry per course code given, with an empty `issues` array when the row is faithful.
"""


def _course_prompt(version: str, page: int, page_text: str, rows: list[dict[str, Any]]) -> str:
    """Build the fused B3/F1 prompt for one page."""
    lines = [
        f"CATALOG: {version}    PAGE: {page}",
        "",
        "--- PAGE MARKDOWN (ground truth) ---",
        page_text[:_MAX_PAGE_CHARS],
        "",
        "--- DATABASE ROWS UNDER TEST ---",
    ]
    for row in rows:
        lines.extend(
            [
                f"course_code: {row.get('course_code')}",
                f"  title: {_clip(row.get('title'), 300)}",
                f"  credits: {row.get('credits')}",
                f"  description: {_clip(row.get('description'))}",
                f"  prerequisites: {_clip(row.get('prerequisites'), 600)}",
                "",
            ]
        )
    return "\n".join(lines)


def _pages_with_courses(
    ctx: CheckContext,
) -> list[tuple[int, PageFacts, list[dict[str, Any]]]]:
    """Return each page that defines courses, paired with the DB rows for those courses.

    Ghost rows are excluded: they carry a synthesized title and no description by construction, so
    asking whether their description matches the page measures the ingest's placeholder, not the
    data. ``A6`` reports the ghost rows that a page *does* define.
    """
    assert ctx.pages is not None and ctx.page_texts is not None
    by_code = {
        c["course_code"].strip(): c for c in ctx.db.courses if c.get("course_code") and not c.get("is_ghost")
    }
    out: list[tuple[int, PageFacts, list[dict[str, Any]]]] = []
    for page_num, facts in sorted(ctx.pages.items()):
        rows = [by_code[code] for code in courses_by_code(facts) if code in by_code]
        if rows:
            out.append((page_num, facts, rows))
    return out


@register(
    "B3",
    tier=2,
    needs_pages=True,
    needs_llm=True,
    title="Semantic: course description and course identity vs the page (B3+F1)",
)
def check_b3_b4_f1(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate description fidelity and course identity in one pass.

    Registered under ``B3`` because the registry keys runs by id, but every emitted finding carries
    its own ``B3``/``F1`` id — the fusion is a batching decision about how many times the page gets
    sent, not a merging of two distinct claims into one.
    """
    assert ctx.page_texts is not None
    targets = _pages_with_courses(ctx)
    if not targets:
        return

    requests: list[Request] = []
    index: list[tuple[int, list[dict[str, Any]], PageFacts]] = []
    for page_num, facts, rows in targets:
        page_text = ctx.page_texts.get(page_num, "")
        for start in range(0, len(rows), config.TIER2_COURSES_PER_CALL):
            batch = rows[start : start + config.TIER2_COURSES_PER_CALL]
            requests.append(
                Request(
                    key=f"{ctx.version}:{page_num}:{start}",
                    system=_COURSE_SYSTEM,
                    prompt=_course_prompt(ctx.version, page_num, page_text, batch),
                    schema=_entity_schema("course_code", ("B3", "F1")),
                )
            )
            index.append((page_num, batch, facts))

    logger.info("B3/F1: %d call(s) over %d page(s)", len(requests), len(targets))
    responses = ctx.adjudicator.map(requests, check="B3+F1")

    for response, (page_num, batch, facts) in zip(responses, index, strict=True):
        page_text = ctx.page_texts.get(page_num, "")
        if not response.ok:
            yield _failure_finding(ctx, "B3", response.key, page_num, response.error or "?")
            continue
        rows_by_code = {r["course_code"].strip(): r for r in batch}
        paths = {c.code: c.ancestor_path for c in facts.courses}
        for result in response.data.get("results", []) or []:
            code = str(result.get("course_code", "")).strip()
            row = rows_by_code.get(code)
            if row is None:
                logger.warning("page %d: adjudicator returned unknown code %r", page_num, code)
                continue
            for issue in result.get("issues", []) or []:
                finding = _issue_to_finding(
                    ctx,
                    issue,
                    allowed=("B3", "F1"),
                    entity_type="course",
                    entity_key=code,
                    entity_id=str(row["id"]),
                    page=page_num,
                    page_text=page_text,
                    ancestor_path=paths.get(code),
                )
                if finding is not None:
                    yield finding
