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

from __future__ import annotations

import logging
import random
from collections.abc import Iterator, Sequence
from typing import Any

from .. import config
from ..llm.client import Request
from ..models import Finding, PageFacts
from ..normalize import normalize_text, strip_content_breadcrumb
from .coverage import courses_by_code
from .registry import CheckContext, make_finding, register

logger = logging.getLogger(__name__)

#: Longest page excerpt handed to the model. Course-description pages run long, and the whole page
#: is the point (``B3`` is specifically about text bleeding in from the *adjacent* course).
_MAX_PAGE_CHARS = 12_000

#: Longest DB text field echoed into a prompt.
_MAX_FIELD_CHARS = 2_000

#: Shingle length for excerpt verification. Five tokens is long enough that matching by chance is
#: implausible and short enough to survive the model tidying up whitespace or punctuation.
_SHINGLE = 5

#: Verdicts Tier 2 may assign. ``REFUTED`` is Tier 3's to give, never Tier 2's.
_VERDICTS = ("CONFIRMED", "PLAUSIBLE", "AMBIGUOUS")

_SEVERITIES = ("critical", "high", "medium", "low", "info")


# --- shared prompt material -------------------------------------------------------

#: The §7 trap list, stated to the model in the terms it will actually encounter. Every one of these
#: has already produced a false-positive flood in Tier 1; a model that does not know them will
#: rediscover each flood at a dollar a time.
_TRAPS = """\
Known-good patterns in this corpus. NONE of these is a defect — do not report them:
- Database titles are abbreviated banner titles: 'P1 Japanese Hist Thru Film' is a faithful
  rendering of 'P1 Japanese History through Film'.
- Both 3-digit and 4-digit course numbers are legitimate: HIST 301 and CRIM 1299 coexist.
- Course codes carry letter suffixes (CHEM 103C, ISPR 100D); prose sometimes drops the suffix.
- A course code inside a requirement list is a MENTION, not a definition. Only a heading defines.
- The same course may legitimately appear under two prefixes (cross-listing).
- Typography differs freely: en/em dashes vs hyphens, *emphasis*, smart quotes, non-breaking spaces.
- Different courses may share an identical title ('Research-based Writing' is four distinct
  courses). The CODE is the identifier; a shared title is not evidence of anything.
- A trailing 'Program' on a program name is a known-good equivalence ('… Certificate' ==
  '… Certificate Program').
- Accreditation statements, navigation, page furniture, and marketing copy are not curriculum data.
- A `Label:` metadata line under a course — `Attributes:`, `Typically offered:`, `Formerly titled:`,
  `PLACEMENT:` — is NOT part of the description. The database has no column for these at all, which
  is a known and already-decided schema gap owned by check B6. Do not report a description as
  incomplete because it omits them; on this corpus that alone would be 1,118 findings.
"""

_SEVERITY_GUIDE = """\
Severity, from the project's model:
- critical: wrong data a student or advisor could act on (wrong prerequisites, a description
  belonging to a different course).
- high: real content missing or mislinked.
- medium: structural or provenance defect with the content intact.
- low: cosmetic, or metadata not captured.
- info: inventory or hypothesis, no defect implied.
"""

_VERDICT_GUIDE = """\
Verdict:
- CONFIRMED: the page and the database plainly disagree, and you can quote the page text proving it.
- PLAUSIBLE: probably a defect, but the page is unclear or the evidence is partial.
- AMBIGUOUS: you cannot tell. This is a valid, expected answer — declining to judge is better than
  guessing, and a guess costs a human more than a shrug does.

Quote `evidence_page` VERBATIM from the page text supplied. Do not paraphrase, reconstruct, or
summarize it: every excerpt is checked back against the page, and one that is not found there
invalidates the finding.
Report only real defects. If a course or program is faithfully represented, return no issues for it.
"""


def _issue_schema(checks: Sequence[str]) -> dict[str, Any]:
    """Return the JSON schema for one adjudicated issue.

    Args:
        checks: The check ids this call is allowed to report against.

    Returns:
        A Vertex-compatible (OpenAPI subset) JSON schema.
    """
    return {
        "type": "object",
        "properties": {
            "check": {"type": "string", "enum": list(checks)},
            "verdict": {"type": "string", "enum": list(_VERDICTS)},
            "severity": {"type": "string", "enum": list(_SEVERITIES)},
            "confidence": {"type": "number"},
            "claim": {"type": "string"},
            "evidence_page": {"type": "string"},
            "evidence_db": {"type": "string"},
        },
        "required": ["check", "verdict", "severity", "confidence", "claim", "evidence_page"],
    }


def _entity_schema(entity_field: str, checks: Sequence[str]) -> dict[str, Any]:
    """Return the schema for a batched per-entity adjudication response."""
    return {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        entity_field: {"type": "string"},
                        "issues": {"type": "array", "items": _issue_schema(checks)},
                    },
                    "required": [entity_field, "issues"],
                },
            }
        },
        "required": ["results"],
    }


# --- evidence verification --------------------------------------------------------

def _shingles(text: str, size: int = _SHINGLE) -> set[str]:
    """Return the set of ``size``-token shingles in normalized text."""
    tokens = normalize_text(text).split()
    if len(tokens) < size:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[i : i + size]) for i in range(len(tokens) - size + 1)}


def excerpt_supported(excerpt: str, source: str) -> bool:
    """True when a quoted excerpt genuinely occurs in the source text.

    Compares normalized 5-token shingles rather than raw substrings, so a model that regularized
    whitespace, a dash, or a smart quote still verifies (trap T9) while one that *invented* the
    passage does not. A very short excerpt is required to appear in full.

    Args:
        excerpt: The model's quoted page text.
        source: The page markdown it claims to be quoting.

    Returns:
        True if every shingle of the excerpt appears in the source.
    """
    if not excerpt or not excerpt.strip():
        return False
    excerpt_shingles = _shingles(excerpt)
    if not excerpt_shingles:
        return False
    source_shingles = _shingles(source)
    if not source_shingles:
        return False
    hits = len(excerpt_shingles & source_shingles)
    # Tolerate one unmatched shingle at each edge, where a quote is most likely to be clipped
    # mid-phrase; require everything else to be present.
    return hits >= max(1, len(excerpt_shingles) - 2)


def _clip(text: Any, limit: int = _MAX_FIELD_CHARS) -> str:
    """Render a DB value as prompt text, truncating loudly rather than silently."""
    if text is None:
        return "(null)"
    value = str(text)
    if len(value) <= limit:
        return value
    return value[:limit] + f"… [truncated, {len(value)} chars total]"


def _issue_to_finding(
    ctx: CheckContext,
    issue: dict[str, Any],
    *,
    allowed: Sequence[str],
    entity_type: str,
    entity_key: str,
    entity_id: str | None,
    page: int,
    page_text: str,
    ancestor_path: list[str] | None = None,
) -> Finding | None:
    """Convert one adjudicated issue into a :class:`Finding`, verifying its evidence first.

    Args:
        ctx: The version's check context.
        issue: One object from the model's ``issues`` array.
        allowed: Check ids this call may report; anything else is discarded and logged.
        entity_type: ``course``, ``program``, ``chunk``, or ``page``.
        entity_key: Stable key for the entity (course code, program name, chunk id).
        entity_id: Database uuid, when there is one.
        page: Source page number.
        page_text: The page markdown the excerpt is verified against.
        ancestor_path: Heading path for the entity, when known.

    Returns:
        The finding, or ``None`` if the issue was malformed. A finding whose excerpt is not on the
        page is *returned*, demoted to ``AMBIGUOUS`` — dropping it would hide a model failure that
        the run needs to see.
    """
    check = str(issue.get("check", "")).strip()
    if check not in allowed:
        logger.warning("discarding issue for unrequested check %r on %s", check, entity_key)
        return None
    claim = str(issue.get("claim", "")).strip()
    if not claim:
        return None

    verdict = str(issue.get("verdict", "AMBIGUOUS")).upper()
    if verdict not in _VERDICTS:
        verdict = "AMBIGUOUS"
    severity = str(issue.get("severity", "medium")).lower()
    if severity not in _SEVERITIES:
        severity = "medium"
    try:
        confidence = max(0.0, min(1.0, float(issue.get("confidence", 0.5))))
    except (TypeError, ValueError):
        confidence = 0.5

    evidence_page = str(issue.get("evidence_page", "")).strip()
    if verdict != "AMBIGUOUS" and not excerpt_supported(evidence_page, page_text):
        claim = (
            f"{claim} [EVIDENCE UNVERIFIED: the quoted page text was not found on page {page}; "
            "verdict demoted from " + verdict + "]"
        )
        verdict = "AMBIGUOUS"
        confidence = min(confidence, 0.3)

    return make_finding(
        ctx,
        check=check,
        severity=severity,
        entity_type=entity_type,
        entity_key=entity_key,
        entity_id=entity_id,
        claim=claim,
        page=page,
        evidence_page=evidence_page,
        evidence_db=str(issue.get("evidence_db", "")).strip() or None,
        ancestor_path=ancestor_path,
        verdict=verdict,
        confidence=confidence,
        tier=2,
    )


def _failure_finding(ctx: CheckContext, check: str, key: str, page: int, error: str) -> Finding:
    """Represent a failed adjudication as a visible finding rather than a missing one (P5).

    An LLM tier that returns fewer findings because calls failed is indistinguishable from one that
    found less wrong — unless the failure is itself reported.

    Args:
        ctx: The version's check context.
        key: The **request** key, not the page. A dense page splits into several calls, so keying
            this on the page alone would give two failed batches the same finding id — the exact
            collision class Phase 2 fixed in Tier 1, and the loader rejects it (P3/P5).
        page: Page number for triage ordering.
        error: What went wrong.
    """
    return make_finding(
        ctx,
        check=check,
        severity="info",
        entity_type="page",
        entity_key=f"adjudication-failed:{key}",
        claim=f"Tier 2 adjudication did not complete for {key}: {error}",
        page=page,
        evidence_page="",
        verdict="AMBIGUOUS",
        confidence=0.0,
        tier=2,
    )


def _seeded_sample(items: Sequence[Any], size: int, seed_key: str) -> tuple[list[Any], int]:
    """Draw a reproducible sample and report how much was left out.

    Args:
        items: The population.
        size: Desired sample size; ``<= 0`` or larger than the population returns everything.
        seed_key: Seeds the RNG, so the same version always draws the same sample (P3).

    Returns:
        ``(sample, skipped_count)``.
    """
    if size <= 0 or size >= len(items):
        return list(items), 0
    rng = random.Random(seed_key)
    sample = rng.sample(list(items), size)
    return sample, len(items) - size


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


def _pages_with_courses(ctx: CheckContext) -> list[tuple[int, PageFacts, list[dict[str, Any]]]]:
    """Return each page that defines courses, paired with the DB rows for those courses.

    Ghost rows are excluded: they carry a synthesized title and no description by construction, so
    asking whether their description matches the page measures the ingest's placeholder, not the
    data. ``A6`` reports the ghost rows that a page *does* define.
    """
    assert ctx.pages is not None and ctx.page_texts is not None
    by_code = {
        c["course_code"].strip(): c
        for c in ctx.db.courses
        if c.get("course_code") and not c.get("is_ghost")
    }
    out: list[tuple[int, PageFacts, list[dict[str, Any]]]] = []
    for page_num, facts in sorted(ctx.pages.items()):
        rows = [by_code[code] for code in courses_by_code(facts) if code in by_code]
        if rows:
            out.append((page_num, facts, rows))
    return out


@register(
    "B3", tier=2, needs_pages=True, needs_llm=True,
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
    "B7", tier=2, needs_pages=True, needs_llm=True,
    title="Semantic: program credits/degree type and page aboutness (B7+F2)",
)
def check_b7_f2(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate program field fidelity and whether the linked page is about the program."""
    assert ctx.page_texts is not None
    from ..normalize import page_from_url

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


@register("F3", tier=2, needs_llm=True, title="Semantic: chunk content matches its section_header")
def check_f3(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate whether each chunk's content belongs under its breadcrumb."""
    chunks = [c for c in ctx.db.chunks if (c.get("content") or "").strip()]
    sample, skipped = _seeded_sample(
        chunks, config.F3_SAMPLE_CHUNKS_PER_VERSION or 0, f"F3:{ctx.version}"
    )
    if skipped:
        logger.info(
            "F3: sampled %d of %d chunks for %s — %d not adjudicated",
            len(sample), len(chunks), ctx.version, skipped,
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


# --- B2 residue -------------------------------------------------------------------

_TITLE_SYSTEM = f"""\
You adjudicate course titles that a deterministic abbreviation check could not reconcile. It already
handled prefix abbreviations (Hist ⊂ History), a small spelling map (Thru → through, & → and), and
credit-range suffixes, so what remains needs judgment.

For each pair decide, as B2: is the database title a faithful (if abbreviated or reformatted)
rendering of the page title, or does it name something different?

Report an issue ONLY when the database title is wrong. Two cases matter most:
- The database carries a NEIGHBORING course's title. Sibling courses differ by one word
  ('Japanese' vs 'Chinese'), so a near-identical title can still be the wrong one.
- The database title is not a title at all — a fragment of body prose, or a heading of a different
  kind that the parser picked up.
A dropped space, a lost accent, or an unusual contraction is `low` severity, not `critical`.

{_TRAPS}
{_SEVERITY_GUIDE}
{_VERDICT_GUIDE}
Quote `evidence_page` from the page heading line supplied for that course.
"""


def _title_prompt(version: str, items: list[tuple[Finding, str]]) -> str:
    """Build the B2 residue prompt from Tier 1's AMBIGUOUS queue."""
    lines = [f"CATALOG: {version}", "", "--- UNRESOLVED TITLE PAIRS ---"]
    for finding, heading in items:
        lines.extend(
            [
                f"course_code: {finding.entity_key}",
                f"  page: {finding.page}",
                f"  page_heading: {heading}",
                f"  db_title: {finding.evidence_db}",
                "",
            ]
        )
    return "\n".join(lines)


@register(
    "B2R", tier=2, needs_pages=True, needs_llm=True,
    title="Semantic: adjudicate the B2 abbreviation residue",
)
def check_b2_residue(ctx: CheckContext) -> Iterator[Finding]:
    """Adjudicate the title pairs Layers 1–2 left unresolved (§5 Risk A, Layer 3).

    Consumes Tier 1's ``B2`` ``AMBIGUOUS`` findings rather than recomputing them: Layer 3 is defined
    as running *only* on the residue, and rebuilding the residue here would risk the two layers
    disagreeing about what the residue is.
    """
    assert ctx.page_texts is not None
    residue = [f for f in ctx.tier1_findings if f.check == "B2" and f.verdict == "AMBIGUOUS"]
    if not residue:
        return

    items: list[tuple[Finding, str]] = []
    for finding in residue:
        heading = finding.evidence_page or f"{finding.entity_key}"
        items.append((finding, heading))

    requests: list[Request] = []
    index: list[list[tuple[Finding, str]]] = []
    for start in range(0, len(items), config.TIER2_TITLES_PER_CALL):
        batch = items[start : start + config.TIER2_TITLES_PER_CALL]
        requests.append(
            Request(
                key=f"{ctx.version}:titles:{start}",
                system=_TITLE_SYSTEM,
                prompt=_title_prompt(ctx.version, batch),
                schema=_entity_schema("course_code", ("B2",)),
            )
        )
        index.append(batch)

    logger.info("B2 residue: %d call(s) over %d unresolved title(s)", len(requests), len(items))
    responses = ctx.adjudicator.map(requests, check="B2-residue")

    for response, batch in zip(responses, index, strict=True):
        if not response.ok:
            yield _failure_finding(ctx, "B2", response.key, batch[0][0].page, response.error or "?")
            continue
        by_code = {f.entity_key: (f, h) for f, h in batch}
        for result in response.data.get("results", []) or []:
            code = str(result.get("course_code", "")).strip()
            pair = by_code.get(code)
            if pair is None:
                continue
            tier1, heading = pair
            for issue in result.get("issues", []) or []:
                finding = _issue_to_finding(
                    ctx,
                    issue,
                    allowed=("B2",),
                    entity_type="course",
                    entity_key=code,
                    entity_id=tier1.entity_id,
                    page=tier1.page,
                    # Verify against the heading line, which is what the model was quoting from.
                    page_text=heading,
                    ancestor_path=tier1.ancestor_path,
                )
                if finding is not None:
                    # Tier 2's verdict supersedes Tier 1's AMBIGUOUS for the same entity; the id is
                    # deterministic and identical, so the loader keeps exactly one.
                    yield finding


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
    from ..normalize import page_from_url

    courses = [c for c in ctx.db.courses if page_from_url(c.get("markdown_url")) == page]
    programs = [p for p in ctx.db.programs if page_from_url(p.get("markdown_url")) == page]
    chunks = [c for c in ctx.db.chunks if (c.get("page_number") or page_from_url(c.get("markdown_url"))) == page]

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
    "F4", tier=2, needs_pages=True, needs_llm=True,
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
        page for page, facts in sorted(ctx.pages.items())
        if facts.page_role in ("content", "requirements_list") and ctx.page_texts.get(page)
    ]
    sample, skipped = _seeded_sample(
        candidates, config.F4_SAMPLE_PAGES_PER_VERSION, f"F4:{ctx.version}"
    )
    if not sample:
        return
    logger.info(
        "F4: sampled %d of %d candidate page(s) for %s — %d not examined (bounded by design)",
        len(sample), len(candidates), ctx.version, skipped,
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
