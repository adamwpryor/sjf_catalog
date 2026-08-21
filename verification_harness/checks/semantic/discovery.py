"""Sampled open-ended discovery adjudication (F4)."""

from __future__ import annotations

import logging
from collections.abc import Iterator

from ... import config
from ...llm.client import Request
from ...models import Finding
from ...normalize import page_from_url
from ..registry import CheckContext, register
from .core import (
    _MAX_PAGE_CHARS,
    _TRAPS,
    _clip,
    _entity_schema,
    _failure_finding,
    _issue_to_finding,
    _seeded_sample,
)

logger = logging.getLogger(__name__)

# --- F4 — sampled open-ended discovery --------------------------------------------

_DISCOVERY_SYSTEM = f"""\
You are looking for error CLASSES nobody has anticipated yet. This pipeline has already produced
four unanticipated failure modes, which is why this check exists.

F4: given a catalog page and everything the database stored from it, what curriculum-relevant
information on the page is NOT represented in the database — and what does the database hold that
the page does not support? Describe the *kind* of gap, not just the instance.

Explicitly ignore: accreditation statements, boilerplate, navigation, page furniture, marketing
copy, faculty biographies, and anything already covered by the checks above (missing courses,
credits, titles, descriptions, prerequisites, program credits).

{_TRAPS}
Every finding here is a HYPOTHESIS, not a defect. Use severity `info` and verdict AMBIGUOUS or
PLAUSIBLE only. A hypothesis becomes a defect only when a human encodes it as a deterministic check,
so propose the check you would write. Returning no issues is a good outcome; do not invent gaps.

Quote `evidence_page` VERBATIM from the page supplied.
"""


def _discovery_prompt(version: str, page: int, page_text: str, ctx: CheckContext) -> str:
    """Build the F4 prompt: one page and every DB row derived from it."""
    courses = [c for c in ctx.db.courses if page_from_url(c.get("markdown_url")) == page]
    programs = [p for p in ctx.db.programs if page_from_url(p.get("markdown_url")) == page]
    chunks = [
        c for c in ctx.db.chunks if (c.get("page_number") or page_from_url(c.get("markdown_url"))) == page
    ]

    lines = [
        f"CATALOG: {version}    PAGE: {page}",
        "",
        "--- PAGE MARKDOWN ---",
        page_text[:_MAX_PAGE_CHARS],
        "",
        (
            f"--- DATABASE HOLDS FROM THIS PAGE: {len(courses)} course(s), "
            f"{len(programs)} program(s), {len(chunks)} chunk(s) ---"
        ),
    ]
    for course in courses[:30]:
        lines.append(f"course {course.get('course_code')}: {_clip(course.get('title'), 120)}")
    for program in programs[:30]:
        lines.append(f"program {_clip(program.get('name'), 120)}")
    for chunk in chunks[:20]:
        lines.append(f"chunk {_clip(chunk.get('section_header'), 120)}")
    return "\n".join(lines)


@register(
    "F4",
    tier=2,
    needs_pages=True,
    needs_llm=True,
    title="Semantic: sampled open-ended discovery (info only, promotion rule)",
)
def check_f4(ctx: CheckContext) -> Iterator[Finding]:
    """Run bounded discovery on a seeded page sample (§5 Risk B).

    Severity is forced to ``info`` and the verdict is capped below ``CONFIRMED`` here rather than
    only being requested in the prompt. The promotion rule — a hypothesis becomes a defect only when
    someone encodes it as a deterministic check — is what keeps open-ended discovery from becoming
    the 5,000-unactionable-errors failure it was nearly cut for, and a prompt instruction alone is
    not an enforcement mechanism.
    """
    assert ctx.pages is not None and ctx.page_texts is not None
    candidates = [
        page
        for page, facts in sorted(ctx.pages.items())
        if facts.page_role in ("content", "requirements_list") and ctx.page_texts.get(page)
    ]
    sample, skipped = _seeded_sample(candidates, config.F4_SAMPLE_PAGES_PER_VERSION, f"F4:{ctx.version}")
    if not sample:
        return
    logger.info(
        "F4: sampled %d of %d candidate page(s) for %s — %d not examined (bounded by design)",
        len(sample),
        len(candidates),
        ctx.version,
        skipped,
    )

    requests = [
        Request(
            key=f"{ctx.version}:discover:{page}",
            system=_DISCOVERY_SYSTEM,
            prompt=_discovery_prompt(ctx.version, page, ctx.page_texts[page], ctx),
            schema=_entity_schema("page", ("F4",)),
        )
        for page in sorted(sample)
    ]
    responses = ctx.adjudicator.map(requests, check="F4")

    for response, page in zip(responses, sorted(sample), strict=True):
        if not response.ok:
            yield _failure_finding(ctx, "F4", response.key, page, response.error or "?")
            continue
        page_text = ctx.page_texts.get(page, "")
        for result in response.data.get("results", []) or []:
            for issue in result.get("issues", []) or []:
                issue = {**issue, "severity": "info"}
                if str(issue.get("verdict", "")).upper() == "CONFIRMED":
                    issue["verdict"] = "PLAUSIBLE"
                finding = _issue_to_finding(
                    ctx,
                    issue,
                    allowed=("F4",),
                    entity_type="page",
                    entity_key=f"{page}:{str(issue.get('claim',''))[:40]}",
                    entity_id=None,
                    page=page,
                    page_text=page_text,
                )
                if finding is not None:
                    yield finding
