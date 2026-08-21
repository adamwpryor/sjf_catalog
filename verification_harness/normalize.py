"""Normalization helpers for comparing database values against catalog pages.

These operate on database *field values* (course codes, ``markdown_url`` strings) — not on page
markdown — so they do not touch the parser-independence rule (P1), which concerns how *pages* are
parsed. They centralize the trap handling from ``DOUBLE_CHECK.md`` §7 (code spellings, dual
numbering, typography) so every check normalizes identically.
"""

from __future__ import annotations

import re

#: Separators that appear between a subject prefix and number across the corpus: space, hyphen,
#: en/em dash, underscore. Collapsed to a single space so ``HIST-301`` == ``HIST 301`` (trap T4/B5).
_CODE_SEP = re.compile(r"[\s\-–—_]+")

#: ``.../pages/page_0360.md`` → page number.
_PAGE_IN_URL = re.compile(r"page_(\d+)\.md$")

#: ``gs://bucket/catalogs/SJFU/<version>/...`` → (bucket, version).
_URL_PARTS = re.compile(r"^gs://([^/]+)/catalogs/SJFU/([^/]+)/")

#: The synthetic breadcrumb prefix the chunker prepends to ``content`` (trap T8) — e.g.
#: ``[Header 1: X > Header 2: Y]``. Absent from the actual page, so stripped before any
#: verbatim comparison against page text.
_CONTENT_BREADCRUMB = re.compile(r"^\s*\[[^\]]*\]\s*")

#: Everything that is not a letter or digit — collapsed to single spaces for loose text matching
#: (defeats markdown syntax, typography, and whitespace differences; trap T9).
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def normalize_text(text: str | None) -> str:
    """Lowercase and reduce to alphanumeric words for whitespace/markup-tolerant matching.

    Args:
        text: Any page or chunk text.

    Returns:
        Lowercased text with every non-alphanumeric run collapsed to one space, trimmed.
    """
    if not text:
        return ""
    return _NON_ALNUM.sub(" ", text.lower()).strip()


def strip_content_breadcrumb(content: str | None) -> str:
    """Remove the leading ``[Header 1: … > …]`` breadcrumb the chunker prepends to ``content``.

    Args:
        content: A ``semantic_chunks.content`` value.

    Returns:
        The content with its synthetic breadcrumb prefix removed (empty string if ``content`` falsy).
    """
    if not content:
        return ""
    return _CONTENT_BREADCRUMB.sub("", content, count=1)


def normalize_course_code(code: str | None) -> str:
    """Canonicalize a course code for equality comparison.

    Uppercases and collapses any run of separators to one space, so the database's ``HIST 301`` and
    a page heading's ``HIST-301`` compare equal. A trailing letter suffix is preserved
    (``CHEM 103C`` stays ``CHEM 103C`` — trap T3).

    Args:
        code: Raw code from either side, e.g. ``"hist-301"``.

    Returns:
        The normalized code, e.g. ``"HIST 301"``; empty string if ``code`` is falsy.
    """
    if not code:
        return ""
    return _CODE_SEP.sub(" ", code.upper()).strip()


def page_from_url(url: str | None) -> int | None:
    """Extract the page number encoded in a ``markdown_url``.

    Args:
        url: A ``gs://.../pages/page_NNNN.md`` string, or ``None``.

    Returns:
        The integer page, or ``None`` if the url is absent or not a page url.
    """
    if not url:
        return None
    match = _PAGE_IN_URL.search(url)
    return int(match.group(1)) if match else None


def bucket_and_version_from_url(url: str | None) -> tuple[str | None, str | None]:
    """Extract the GCS bucket and catalog version from a ``markdown_url``.

    Used by the cross-contamination check (C5): a row whose url names a different version — or a
    bucket other than the configured one — points at the wrong source (the exact failure that put
    every row on a ``legacy-bucket``/page 1 before the backfill).

    Args:
        url: A ``gs://<bucket>/catalogs/SJFU/<version>/...`` string, or ``None``.

    Returns:
        ``(bucket, version)``; either element is ``None`` if the url is absent or unparseable.
    """
    if not url:
        return (None, None)
    match = _URL_PARTS.match(url)
    if not match:
        return (None, None)
    return (match.group(1), match.group(2))
