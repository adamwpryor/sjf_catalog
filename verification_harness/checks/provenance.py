"""Class C — provenance & structural checks (``DOUBLE_CHECK.md`` §6).

These verify that a row's *claim about where it came from* is internally consistent: that its
``page_number`` agrees with its url, that it points at this catalog's bucket and version, that its
``source_chunk_id`` resolves, and that ``sequence_order`` is sane. The C-checks that need the page's
actual text (C2 verbatim-content, C3 breadcrumb-vs-hierarchy) are registered ``needs_pages`` and run
once Tier 0 lands; the rest are pure-DB and run now.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterator

from .. import config
from ..models import Finding
from ..normalize import (
    bucket_and_version_from_url,
    normalize_text,
    page_from_url,
    strip_content_breadcrumb,
)
from .registry import CheckContext, make_finding, register


@register("C7", title="chunk content_hash actually matches its content")
def check_c7(ctx: CheckContext) -> Iterator[Finding]:
    """Recompute every chunk's ``content_hash`` and report the ones that do not match (``§6`` C7).

    The algorithm was derived from the data, not assumed: ``sha256(content)`` over the raw stored
    string reproduces the checked-in hashes exactly, including the synthetic breadcrumb (trap T8) —
    the hash covers what is stored, not what the page said.

    A mismatch means ``content`` was edited after the hash was written, so any downstream consumer
    trusting the hash for change detection is working from a stale key. That is a provenance defect
    with the content itself intact, hence ``medium`` per §10.

    A missing hash is reported separately and as an aggregate: a NULL is a schema/backfill gap
    affecting whole batches at once, not a per-row corruption, and enumerating thousands of them
    would bury the mismatches that actually indicate tampering.
    """
    import hashlib

    missing: list[str] = []
    for chunk in ctx.db.chunks:
        stored = chunk.get("content_hash")
        content = chunk.get("content")
        if content is None:
            continue
        if not stored:
            missing.append(str(chunk["id"]))
            continue
        actual = hashlib.sha256(str(content).encode("utf-8")).hexdigest()
        if actual != str(stored).strip():
            yield make_finding(
                ctx,
                check="C7",
                severity="medium",
                entity_type="chunk",
                entity_key=str(chunk["id"]),
                entity_id=str(chunk["id"]),
                claim=(
                    f"content_hash does not match content: stored {str(stored)[:16]}…, "
                    f"sha256(content) is {actual[:16]}… — content changed after the hash was written"
                ),
                page=chunk.get("page_number") or page_from_url(chunk.get("markdown_url")) or 0,
                evidence_page=str(content)[:200],
                evidence_db=str(stored),
                suggested_fix="Recompute content_hash, or restore the content the hash describes.",
            )

    if missing:
        yield make_finding(
            ctx,
            check="C7",
            severity="low",
            entity_type="chunk",
            entity_key="content_hash:missing",
            claim=(
                f"{len(missing)} chunk(s) in {ctx.version} have content but no content_hash — a "
                f"backfill gap, not per-row corruption"
            ),
            evidence_page="",
            evidence_db=",".join(missing[:50]),
        )


@register("C1", title="chunk.page_number agrees with the page number in its own markdown_url")
def c1_page_number_matches_url(ctx: CheckContext) -> Iterator[Finding]:
    """Flag chunks whose ``page_number`` disagrees with ``page_NNNN`` in their own url.

    Guards the historical regression where every ``page_number`` was ``1`` while urls pointed
    elsewhere. A disagreement means one of the two provenance fields is wrong.
    """
    for chunk in ctx.db.chunks:
        url_page = page_from_url(chunk.get("markdown_url"))
        db_page = chunk.get("page_number")
        if url_page is None or db_page is None:
            continue  # missing-url coverage is A4's job, not C1's
        if url_page != db_page:
            yield make_finding(
                ctx,
                "C1",
                severity="medium",
                entity_type="chunk",
                entity_id=str(chunk["id"]),
                entity_key=str(chunk["id"]),
                page=url_page,
                claim=f"page_number={db_page} but url points at page {url_page}",
                evidence_db=f"page_number={db_page}, markdown_url=…page_{url_page:04d}.md",
            )


@register("C4", title="sequence_order is unique within a document")
def c4_sequence_order_unique(ctx: CheckContext) -> Iterator[Finding]:
    """Flag duplicate ``sequence_order`` values within a single document.

    Chunk ordering drives ``C3`` neighbour reasoning and any position-based logic; a duplicated
    order breaks the assumption that ``sequence_order`` is a stable key within a document.
    """
    by_doc: dict[object, dict[object, int]] = defaultdict(lambda: defaultdict(int))
    for chunk in ctx.db.chunks:
        by_doc[chunk.get("document_id")][chunk.get("sequence_order")] += 1
    for doc_id, orders in by_doc.items():
        for order, count in orders.items():
            if order is not None and count > 1:
                yield make_finding(
                    ctx,
                    "C4",
                    severity="medium",
                    entity_type="chunk",
                    entity_key=f"{doc_id}:seq{order}",
                    claim=f"sequence_order={order} used by {count} chunks in one document",
                    evidence_db=f"document_id={doc_id}, sequence_order={order}, count={count}",
                )


@register("C5", title="row's markdown_url names this catalog's bucket and version")
def c5_cross_catalog_contamination(ctx: CheckContext) -> Iterator[Finding]:
    """Flag any row whose url points at a different version or a foreign bucket.

    This is the exact defect class from before the backfill (rows pointing at ``ccsj-assets`` and at
    the wrong catalog year). High severity: the row would render another catalog's page.
    """
    expected_bucket = config.GCS_BUCKET
    tables: tuple[tuple[str, list[dict]], ...] = (
        ("course", ctx.db.courses),
        ("program", ctx.db.programs),
        ("chunk", ctx.db.chunks),
    )
    for entity_type, rows in tables:
        for row in rows:
            url = row.get("markdown_url")
            if not url:
                continue
            bucket, version = bucket_and_version_from_url(url)
            if bucket is None:
                continue  # unparseable url is A4/format territory
            if bucket != expected_bucket or version != ctx.version:
                key = row.get("course_code") or row.get("name") or str(row["id"])
                yield make_finding(
                    ctx,
                    "C5",
                    severity="high",
                    entity_type=entity_type,
                    entity_id=str(row["id"]),
                    entity_key=str(key),
                    page=page_from_url(url),
                    claim=(
                        f"row is in {ctx.version} on bucket {expected_bucket}, but its url names "
                        f"bucket={bucket} version={version}"
                    ),
                    evidence_db=url,
                )


#: A source chunk within this many pages of the course's own page is treated as correct — a course
#: description legitimately spans a page boundary. Empirically ~88% of resolvable refs are within ±1;
#: only refs off by more than this are genuine mismatches (measured tail: −128, −199, −382 pages).
_SOURCE_CHUNK_PAGE_TOL = 3


@register("C6", title="course.source_chunk_id resolves to a chunk on ~the same page")
def c6_source_chunk_resolves(ctx: CheckContext) -> Iterator[Finding]:
    """Check the ``source_chunk_id`` provenance ref: existence, then approximate page agreement.

    Two failure shapes, reported at the right granularity to avoid a false-positive flood:

    - **Dangling refs** (``source_chunk_id`` not present in this catalog — largely stale ids left by
      the re-chunk/re-embed history) are a single *systemic* condition, so they are reported as **one
      aggregate finding per catalog**, not one per course.
    - **Wildly-off refs** (resolve, but the source chunk is > ``_SOURCE_CHUNK_PAGE_TOL`` pages from
      the course's own page — i.e. not a boundary-spanning description) are reported per-course.

    Severity is ``low``: ``source_chunk_id`` is internal lineage metadata, not user-facing data.
    """
    chunk_page: dict[str, int | None] = {
        str(chunk["id"]): page_from_url(chunk.get("markdown_url")) for chunk in ctx.db.chunks
    }
    dangling: list[str] = []
    far_off: list[str] = []
    for course in ctx.db.courses:
        src = course.get("source_chunk_id")
        if not src:
            continue
        src = str(src)
        course_page = page_from_url(course.get("markdown_url"))
        if src not in chunk_page:
            dangling.append(str(course.get("course_code")))
            continue
        src_page = chunk_page[src]
        if (
            course_page is not None
            and src_page is not None
            and abs(src_page - course_page) > _SOURCE_CHUNK_PAGE_TOL
        ):
            far_off.append(str(course.get("course_code")))

    # Both conditions are systemic (one root cause: stale ids from the re-chunk/re-embed history),
    # so each is one aggregate finding per catalog, not one per course — the course list stays
    # recoverable from the DB for remediation, without flooding the report (spec severity model).
    if dangling:
        yield make_finding(
            ctx,
            "C6",
            severity="low",
            entity_type="page",
            entity_key=f"{ctx.version}:dangling-source-chunks",
            claim=f"{len(dangling)} courses reference a source_chunk_id absent from this catalog (likely stale ids from re-chunking)",
            evidence_db=f"count={len(dangling)}; examples: {', '.join(dangling[:5])}",
        )
    if far_off:
        yield make_finding(
            ctx,
            "C6",
            severity="low",
            entity_type="page",
            entity_key=f"{ctx.version}:far-off-source-chunks",
            claim=f"{len(far_off)} courses have a source chunk more than {_SOURCE_CHUNK_PAGE_TOL} pages from the course's own page",
            evidence_db=f"count={len(far_off)}; examples: {', '.join(far_off[:5])}",
        )


# --- Page-dependent C-checks -------------------------------------------------------------------

#: A chunk body with fewer distinctive words than this is a heading/label, too short to verify
#: without false positives — skipped by C2.
_C2_MIN_WORDS = 8

#: Fraction of a chunk's distinctive words that must appear on its claimed page. Below this, the
#: chunk almost certainly does not come from that page. Set loose because the chunker reorders and
#: reformats text (degrees, titles), so contiguous matching false-positives; word overlap tolerates it.
_C2_MIN_OVERLAP = 0.5

#: Very common words carry no page signal; excluded from the C2 overlap so boilerplate can't inflate it.
_C2_STOPWORDS = frozenset(
    ["the", "of", "and", "a", "an", "in", "to", "for", "with", "on", "is", "are", "as", "at", "by", "or", "from", "be", "this", "that", "will"]
)


def _chunk_page(chunk: dict) -> int | None:
    """Best available page number for a chunk: its ``page_number``, else parsed from its url."""
    return chunk.get("page_number") if chunk.get("page_number") is not None else page_from_url(
        chunk.get("markdown_url")
    )


def _parse_breadcrumb(section_header: str | None) -> list[str]:
    """Parse ``"Header 1: X > Header 2: Y"`` into ``["X", "Y"]`` (drops ``None`` placeholders)."""
    if not section_header:
        return []
    parts = [seg.split(":", 1)[-1].strip() for seg in section_header.split(" > ")]
    return [p for p in parts if p and p.lower() != "none"]


@register("C2", needs_pages=True, title="chunk content appears verbatim on its claimed page")
def c2_content_verbatim(ctx: CheckContext) -> Iterator[Finding]:
    """Flag chunks whose body text does not appear on the page they claim.

    Strips the synthetic breadcrumb (trap T8), then checks the body's opening shingle against the
    page's raw text (whitespace/markup-normalized). Short heading-only chunks are skipped. Mostly a
    known-answer check: the backfill mapped chunks to pages by content, so hits are genuine
    mismatches (a chunk pointing at the wrong page).
    """
    page_texts = ctx.page_texts or {}
    for chunk in ctx.db.chunks:
        page = _chunk_page(chunk)
        if page is None or page not in page_texts:
            continue
        chunk_words = {
            w for w in normalize_text(strip_content_breadcrumb(chunk.get("content"))).split()
            if w not in _C2_STOPWORDS
        }
        if len(chunk_words) < _C2_MIN_WORDS:
            continue
        page_words = set(normalize_text(page_texts[page]).split())
        overlap = len(chunk_words & page_words) / len(chunk_words)
        if overlap < _C2_MIN_OVERLAP:
            missing = sorted(chunk_words - page_words)[:8]
            yield make_finding(
                ctx,
                "C2",
                severity="medium",
                entity_type="chunk",
                entity_id=str(chunk["id"]),
                entity_key=str(chunk["id"]),
                page=page,
                claim=f"only {overlap:.0%} of the chunk's words appear on its claimed page {page}",
                evidence_db=f"words absent from page: {missing}",
            )


@register("C3", needs_pages=True, title="chunk section_header breadcrumb matches the page hierarchy")
def c3_breadcrumb_matches_hierarchy(ctx: CheckContext) -> Iterator[Finding]:
    """Flag chunks whose breadcrumb ancestors disagree with the page's actual heading hierarchy.

    Parses ``section_header`` into a path, finds the leaf heading on the page (via ``PageFacts``),
    and compares the breadcrumb's ancestors to that heading's ``ancestor_path`` (Risk C). Reported at
    ``low`` severity — the breadcrumb is chunker-derived metadata, and page/chunk come from different
    passes. Only fires when the leaf heading is actually present on the page (so it tests hierarchy,
    not coverage, which is A3/C2's job).
    """
    pages = ctx.pages or {}
    for chunk in ctx.db.chunks:
        crumb = _parse_breadcrumb(chunk.get("section_header"))
        if len(crumb) < 2:
            continue
        page = _chunk_page(chunk)
        page_facts = pages.get(page) if page is not None else None
        if page_facts is None:
            continue
        leaf_norm = normalize_text(crumb[-1])
        expected = [normalize_text(a) for a in crumb[:-1]]
        heading = next((h for h in page_facts.headings if normalize_text(h.text) == leaf_norm), None)
        if heading is None:
            continue  # leaf not on this page — coverage territory, not hierarchy
        actual = [normalize_text(a) for a in heading.ancestor_path]
        # The breadcrumb is a FULL-DOCUMENT path; the page's ancestor_path is truncated at the page
        # boundary. So the page path must be a SUFFIX of the breadcrumb ancestors — comparing them
        # for equality would (wrongly) flag ~85% of chunks. Only a non-suffix is a real disagreement.
        suffix = expected[-len(actual):] if 0 < len(actual) <= len(expected) else None
        if actual and actual != suffix:
            yield make_finding(
                ctx,
                "C3",
                severity="low",
                entity_type="chunk",
                entity_id=str(chunk["id"]),
                entity_key=str(chunk["id"]),
                page=page,
                claim=f"breadcrumb ancestors are not a suffix of the page hierarchy for {crumb[-1]!r}",
                evidence_db=f"breadcrumb={crumb[:-1]} vs page ancestor_path={heading.ancestor_path}",
            )
