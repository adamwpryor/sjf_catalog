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
from ..normalize import bucket_and_version_from_url, page_from_url
from .registry import CheckContext, make_finding, register


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


# --- Page-dependent C-checks: registered now, skipped until Tier 0 extractor lands ---------------


@register("C2", needs_pages=True, title="chunk content appears verbatim on its claimed page")
def c2_content_verbatim(ctx: CheckContext) -> Iterator[Finding]:  # pragma: no cover - stub
    """Placeholder: needs PageFacts/page text (strip the synthetic breadcrumb first — trap T8)."""
    return iter(())


@register("C3", needs_pages=True, title="chunk section_header breadcrumb matches the AST ancestor_path")
def c3_breadcrumb_matches_hierarchy(ctx: CheckContext) -> Iterator[Finding]:  # pragma: no cover
    """Placeholder: compare parsed ``[Header 1: … > …]`` breadcrumb to the page's ancestor_path."""
    return iter(())
