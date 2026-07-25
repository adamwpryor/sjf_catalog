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
    every row on ``ccsj-assets``/page 1 before the backfill).

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
